// Find or start a project daemon and exchange one JSON message per socket connection.
import { spawn, type ChildProcess } from "node:child_process";
import { open, readdir } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { Project } from "../project.ts";
import { scriptExtension } from "../runtime.ts";
import type { RequestType } from "../upstream.ts";
import { lockHeld, withStartLock } from "./lock.ts";
import { serverPaths, serverPathsIn, stateParent, type ServerPaths } from "./paths.ts";
import { projectSignature } from "./signature.ts";

export interface ServerConnection {
	project: Project;
	pid: number;
	/** When the server process started, in epoch milliseconds, from `ping`. */
	startedAt: number;
	/** Rendered output, exactly what the CLI prints. */
	query(
		requests: Record<string, unknown>[],
		options: { mode?: "text" | "json" | "raw"; in?: string; color?: boolean; json?: boolean; cwd?: string },
	): Promise<string>;
	/** Upstream values, unchanged, one per request in input order. */
	values(requests: Record<string, unknown>[]): Promise<unknown[]>;
	requestTypes(): Promise<RequestType[]>;
	/** Stop this server, start a fresh one and return a connection to it. */
	restart(): Promise<ServerConnection>;
}

interface Ping {
	signature: string;
	pid: number;
	project: string;
	lastUsed: number;
	startedAt: number;
	active: number;
}

interface Response {
	value?: unknown;
	error?: string;
	full?: boolean;
}

export class ServerRequestError extends Error {
	readonly full: boolean;
	constructor(message: string, full: boolean) {
		super(message);
		this.full = full;
	}
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const timeoutMessage = "server timed out; try sightread stop";
class SocketTimeoutError extends Error {}
class ServerStopError extends Error {}

/** Send one message to a server socket and read its one-line reply. */
export function exchange(socketPath: string, message: object, timeout = 120_000): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;
		let body = "";
		const timer = setTimeout(() => finish(new SocketTimeoutError(timeoutMessage)), timeout);
		function finish(error?: Error, value?: unknown) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(value);
		}
		// Decoded across chunks, so a character split between two isn't corrupted.
		socket.setEncoding("utf8");
		socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
		socket.on("data", (chunk: string) => {
			body += chunk;
			const end = body.indexOf("\n");
			if (end < 0) return;
			try {
				const response = JSON.parse(body.slice(0, end)) as Response;
				if (typeof response.error === "string") finish(new ServerRequestError(response.error, response.full === true));
				else finish(undefined, response.value);
			} catch (error) {
				finish(error as Error);
			}
		});
		socket.on("error", (error) => finish(error));
		socket.on("end", () => finish(new Error("server connection closed")));
	});
}

// Whether a server answers at a socket: it does, nothing is there, or something is there but doesn't answer, which
// can be a live server that's stuck.
type Probe = { live: Ping } | { absent: true } | { unresponsive: true };
async function probe(paths: ServerPaths): Promise<Probe> {
	try {
		const response = await exchange(paths.socket, { type: "ping" }, 1_000);
		if (!response || typeof response !== "object" || !("pid" in response)) return { absent: true };
		return { live: response as Ping };
	} catch (error) {
		return error instanceof SocketTimeoutError ? { unresponsive: true } : { absent: true };
	}
}

async function ping(paths: ServerPaths): Promise<Ping | undefined> {
	const found = await probe(paths);
	return "live" in found ? found.live : undefined;
}

// Whether the project's daemon, which holds its lock until it exits, is gone within five seconds.
async function gone(paths: ServerPaths): Promise<boolean> {
	for (let index = 0; index < 50 && (await lockHeld(paths.lock)); index++) await pause(100);
	return !(await lockHeld(paths.lock));
}

// Stop a project's server. One that holds its lock without answering, past the moment it takes to finish stopping, is
// reported, not taken for stopped.
async function stopAt(paths: ServerPaths, quietOnly = false): Promise<void> {
	const found = await probe(paths);
	if (!("live" in found)) {
		if (await gone(paths)) return;
		throw new ServerStopError(
			"unresponsive" in found ? `server is not responding; see ${paths.log}` : "server is still starting; retry",
		);
	}
	try {
		if ((await exchange(paths.socket, { type: "stop", quietOnly }, 5_000)) === false) return;
	} catch (error) {
		if (error instanceof SocketTimeoutError) throw new ServerStopError(`server did not stop; see ${paths.log}`);
		/* It may have exited already. */
	}
	if (!(await gone(paths))) throw new ServerStopError(`server did not stop; see ${paths.log}`);
}

async function allServerPaths(): Promise<ServerPaths[]> {
	try {
		const entries = await readdir(stateParent(), { withFileTypes: true });
		return entries
			.filter((entry) => entry.isDirectory())
			.map((entry) => serverPathsIn(join(stateParent(), entry.name)));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

const startTimeout = 30_000;

let announceStart: ((project: Project) => void) | undefined;
/** Say when a request has to start a server first, since that request takes much longer than the rest. */
export function onServerStart(announce: (project: Project) => void): void {
	announceStart = announce;
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

// Each graph server holds a whole program in memory (400–900 MB on large repositories), so keep few running.
// Only quiet servers make room: agents in parallel worktrees never stop each other's servers or wait for a slot,
// and servers over the limit stop once they're quiet and another starts, or when they idle out.
async function evictQuiet(current: string): Promise<void> {
	const maximum = Math.max(1, Number(process.env.SIGHTREAD_MAX_SERVERS) || 2);
	const configured = Number(process.env.SIGHTREAD_QUIET_MS);
	const quiet = process.env.SIGHTREAD_QUIET_MS && Number.isFinite(configured) ? configured : 5 * 60_000;
	const servers: { paths: ServerPaths; lastUsed: number; active: number }[] = [];
	let starting = 0;
	for (const paths of await allServerPaths()) {
		if (paths.directory === current) continue;
		const live = await ping(paths);
		if (live) servers.push({ paths, lastUsed: live.lastUsed, active: live.active });
		// One that holds its lock but doesn't answer yet is starting.
		else if (await lockHeld(paths.lock)) starting++;
	}
	const need = Math.max(0, servers.length + starting - maximum + 1);
	const idle = servers.filter((server) => server.active === 0 && Date.now() - server.lastUsed >= quiet);
	for (const server of idle.toSorted((a, b) => a.lastUsed - b.lastUsed).slice(0, need))
		await stopAt(server.paths, true);
}

// Wait for the project's server to answer with `signature`: one `child` is starting, or one already holding the lock.
// There's none once nothing holds the lock and `child`, if any, has exited.
async function answer(paths: ServerPaths, signature: string, child?: ChildProcess): Promise<Ping | undefined> {
	const deadline = Date.now() + startTimeout;
	while (Date.now() < deadline) {
		const live = await ping(paths);
		if (live?.signature === signature) return live;
		if (!(await lockHeld(paths.lock)) && (!child || exited(child))) return undefined;
		await pause(100);
	}
	return undefined;
}

async function start(paths: ServerPaths, project: Project, signature: string): Promise<Ping> {
	announceStart?.(project);
	// Starts are counted against the limit once their daemons hold their locks, so each waits for that before the
	// next start counts.
	const daemon = await withStartLock(join(paths.parent, "client.lock"), async () => {
		await evictQuiet(paths.directory);
		const log = await open(paths.log, "a");
		try {
			const child = spawn(
				process.execPath,
				[join(import.meta.dirname, `../cli${scriptExtension}`), "--daemon", project.root, project.tsconfig],
				{
					cwd: project.root,
					detached: true,
					stdio: ["ignore", log.fd, log.fd],
				},
			);
			await new Promise<void>((resolve, reject) => {
				child.once("error", reject);
				child.once("spawn", resolve);
			});
			child.unref();
			const until = Date.now() + 10_000;
			while (!exited(child) && !(await lockHeld(paths.lock)) && Date.now() < until) await pause(25);
			return child;
		} finally {
			await log.close();
		}
	});
	const live = await answer(paths, signature, daemon);
	if (!live) throw new Error(`server did not start; see ${paths.log}`);
	return live;
}

function connection(project: Project, live: Ping, paths: ServerPaths): ServerConnection {
	const retry = async <T>(message: object): Promise<T> => {
		try {
			return (await exchange(paths.socket, message)) as T;
		} catch (error) {
			if (error instanceof ServerRequestError || error instanceof SocketTimeoutError) throw error;
			await connect(project);
			return exchange(serverPaths(project).socket, message) as Promise<T>;
		}
	};
	return {
		project,
		pid: live.pid,
		startedAt: live.startedAt,
		query: (requests, options) => retry<string>({ type: "query", requests, ...options }),
		values: (requests) => retry<unknown[]>({ type: "values", requests }),
		requestTypes: () => retry<RequestType[]>({ type: "help" }),
		restart: async () => {
			await withStartLock(paths.start, () => stopAt(paths));
			return connect(project);
		},
	};
}

/** Find a live server with the current signature, or start one. */
export async function connect(project: Project): Promise<ServerConnection> {
	const paths = serverPaths(project);
	const signature = await projectSignature(project);
	const matches = (live?: Ping) => live?.signature === signature && live.project === project.root;
	const existing = await ping(paths);
	if (matches(existing)) return connection(project, existing!, paths);
	const live = await withStartLock(paths.start, async () => {
		const found = await ping(paths);
		if (matches(found)) return found!;
		if (found) await stopAt(paths);
		else if (await lockHeld(paths.lock)) {
			// One that holds the lock without answering is starting, as one whose client was stopped, or stopping.
			const answered = await answer(paths, signature);
			if (answered) return answered;
		}
		return start(paths, project, signature);
	});
	return connection(project, live, paths);
}

export async function listServers(): Promise<Array<{ pid: number; project: string; lastUsed: number }>> {
	const result: Array<{ pid: number; project: string; lastUsed: number }> = [];
	for (const paths of await allServerPaths()) {
		const live = await ping(paths);
		if (live) result.push({ pid: live.pid, project: live.project, lastUsed: live.lastUsed });
	}
	return result.toSorted((a, b) => a.project.localeCompare(b.project));
}

export async function stopServer(project: Project): Promise<void> {
	const paths = serverPaths(project);
	await withStartLock(paths.start, () => stopAt(paths));
}

export async function stopAllServers(): Promise<void> {
	for (const paths of await allServerPaths()) await withStartLock(paths.start, () => stopAt(paths));
}

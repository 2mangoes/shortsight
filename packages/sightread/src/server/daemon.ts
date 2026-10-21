// Hold the graph and range cache behind a Unix socket.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, rename, stat, writeFile, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join, relative, sep } from "node:path";
import { nestedProjects, projectFiles, type Project } from "../project.ts";
import { createPaths } from "../paths.ts";
import { runQuery } from "../query.ts";
import { createRangeIndex } from "../ranges.ts";
import { createReferenceIndex } from "../references.ts";
import { RequestError, startGraphClient } from "../upstream.ts";
import { serverPaths } from "./paths.ts";
import { projectSignature } from "./signature.ts";

interface Message {
	type: "ping" | "stop" | "help" | "query" | "values";
	requests?: Record<string, unknown>[];
	json?: boolean;
	mode?: "text" | "json" | "raw";
	in?: string;
	color?: boolean;
	cwd?: string;
	quietOnly?: boolean;
}

function duration(name: string, fallback: number): number {
	const number = Number(process.env[name]);
	return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Run until stopped, idle, or the project disappears. */
// A file's device and inode, which a new file at the same path doesn't share.
const identity = (path: string) =>
	stat(path).then(
		(found) => `${found.dev}:${found.ino}`,
		() => undefined,
	);

export async function runDaemon(project: Project): Promise<void> {
	if (process.env.SIGHTREAD_DAEMON_FAIL === "1") throw new Error("test daemon startup failure");
	if (process.env.SIGHTREAD_DAEMON_START_DELAY_MS) await Bun.sleep(duration("SIGHTREAD_DAEMON_START_DELAY_MS", 0));
	const startedAt = Date.now();
	const paths = serverPaths(project);
	const signature = await projectSignature(project);
	const client = await startGraphClient(project, { stderr: 2, cacheDirectory: join(paths.directory, "ttsc-cache") });
	// The graph covers sibling packages in the same repository, so their ranges are read too.
	const ranges = createRangeIndex(project.root, { within: createPaths(project.root).repository });
	const fileCount = projectFiles(project).then((files) => files.size);
	const references = createReferenceIndex(project);
	const nested = nestedProjects(project);
	let lastUsed = startedAt;
	let active = 0;
	let closing = false;
	let finishActive: (() => void) | undefined;
	const idle = duration("SIGHTREAD_IDLE_MS", 20 * 60_000);
	const check = Math.min(duration("SIGHTREAD_MISSING_MS", 30_000), idle);
	const server = createServer((socket) => {
		// A daemon shutting down takes no more requests.
		if (closing) {
			socket.destroy();
			return;
		}
		let input = "";
		socket.on("error", () => undefined);
		// Decoded across chunks, so a character split between two isn't corrupted.
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => {
			input += chunk;
			const end = input.indexOf("\n");
			if (end < 0) return;
			socket.removeAllListeners("data");
			const raw = input.slice(0, end);
			if (raw.includes('"type":"query"') && process.env.SIGHTREAD_DAEMON_SOCKET_ERROR_ON_RESET === "1")
				setTimeout(() => socket.emit("error", new Error("ECONNRESET")), 25);
			void handle(socket, raw);
		});
	});

	// The socket this daemon listens on, by device and inode: a replacement started while this one finishes its last
	// queries listens on a new file at the same path, which isn't this daemon's to remove.
	let socketIdentity: string | undefined;
	async function removeOwnFiles(): Promise<void> {
		if (socketIdentity && (await identity(paths.socket)) === socketIdentity)
			await unlink(paths.socket).catch(() => undefined);
		const state = await readFile(paths.state, "utf8")
			.then((text) => JSON.parse(text) as { pid?: number })
			.catch(() => undefined);
		if (state?.pid === process.pid) await unlink(paths.state).catch(() => undefined);
	}

	// State writes still in flight, which shutdown waits for before a replacement can start.
	const writing = new Set<Promise<void>>();
	function writeState(): Promise<void> {
		const write = publishState().finally(() => writing.delete(write));
		writing.add(write);
		return write;
	}
	async function publishState(): Promise<void> {
		// Once closing, the state path may soon be a replacement's.
		if (closing) return;
		const temporary = `${paths.state}.${randomUUID()}`;
		await writeFile(
			temporary,
			JSON.stringify({
				project: project.root,
				tsconfig: project.tsconfig,
				pid: process.pid,
				lastUsed,
				startedAt,
				signature,
			}),
		);
		if (process.env.SIGHTREAD_DAEMON_STATE_DELAY_MS) await Bun.sleep(duration("SIGHTREAD_DAEMON_STATE_DELAY_MS", 0));
		// Checked again with nothing awaited before the rename, so a write that began before shutdown either lands
		// before it releases the socket or not at all.
		if (closing) {
			await unlink(temporary).catch(() => undefined);
			return;
		}
		await rename(temporary, paths.state);
	}

	async function shutdown(): Promise<void> {
		if (closing) return;
		closing = true;
		clearInterval(interval);
		await Promise.allSettled(writing);
		// Bun's close removes whatever file is at the socket's path. A socket a replacement has put there is left alone:
		// nothing reaches this daemon through it, so the listener only stops keeping the process alive.
		if ((await identity(paths.socket)) === socketIdentity) server.close();
		else server.unref();
		// Running queries finish first, for up to half a minute: one stuck on a process that has stopped answering
		// doesn't keep the daemon from stopping.
		if (active > 0) {
			let timer: ReturnType<typeof setTimeout> | undefined;
			await new Promise<void>((resolve) => {
				finishActive = resolve;
				timer = setTimeout(resolve, 30_000);
			});
			// Cleared, so a timer left running doesn't keep the process alive after the queries finish.
			clearTimeout(timer);
		}
		try {
			await client.close();
		} finally {
			await ranges.close();
			await references.close();
			await removeOwnFiles();
		}
	}

	async function handle(socket: Socket, raw: string): Promise<void> {
		active++;
		let stop = false;
		try {
			const message = JSON.parse(raw) as Message;
			if (message.type !== "ping" && message.type !== "stop") {
				lastUsed = Date.now();
				await writeState();
			}
			let value: unknown;
			switch (message.type) {
				case "ping":
					value = { signature, pid: process.pid, project: project.root, lastUsed, startedAt, active: active - 1 };
					break;
				case "stop":
					value = message.quietOnly && active > 1 ? false : null;
					stop = value !== false;
					if (!stop) break;
					if (process.env.SIGHTREAD_DAEMON_STOP_DELAY_MS)
						await Bun.sleep(duration("SIGHTREAD_DAEMON_STOP_DELAY_MS", 0));
					break;
				case "help":
					value = [
						...client.requestTypes(),
						{
							type: "references",
							fields: [
								{ name: "symbol", required: true, description: "Symbol name or handle." },
								{
									name: "includeDeclaration",
									required: false,
									description: "Include the declaration itself (default: false).",
								},
							],
						},
					].toSorted((a, b) => a.type.localeCompare(b.type));
					break;
				case "query":
					if (process.env.SIGHTREAD_DAEMON_QUERY_DELAY_MS)
						await Bun.sleep(duration("SIGHTREAD_DAEMON_QUERY_DELAY_MS", 0));
					value = await runQuery(
						{
							client,
							ranges,
							references,
							root: project.root,
							tsconfig: relative(project.root, project.tsconfig).replaceAll(sep, "/"),
							projectFileCount: await fileCount,
							nestedProjects: nested
								.map((directory) => relative(message.cwd ?? project.root, directory).replaceAll(sep, "/"))
								.slice(0, 5),
						},
						message.requests ?? [],
						{
							mode: message.mode ?? (message.json ? "json" : "text"),
							in: message.in,
							color: message.color,
						},
					);
					break;
				case "values":
					value = (await client.batch(message.requests ?? [])).map((result) => result.value);
					break;
				default:
					throw new Error("unknown server message");
			}
			if (message.type !== "ping" && message.type !== "stop") {
				lastUsed = Date.now();
				await writeState();
			}
			if (!socket.destroyed) socket.end(`${JSON.stringify({ value })}\n`);
		} catch (error) {
			if (!socket.destroyed)
				socket.end(
					`${JSON.stringify({ error: error instanceof Error ? error.message : String(error), full: error instanceof RequestError })}\n`,
				);
		} finally {
			active--;
			if (active === 0) finishActive?.();
			if (stop) void shutdown();
		}
	}

	const interval = setInterval(() => {
		if (active === 0 && (!existsSync(project.root) || Date.now() - lastUsed >= idle)) void shutdown();
	}, check);
	server.on("error", (error) => {
		console.error(error);
		process.exitCode = 1;
	});
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(paths.socket, () => {
				server.off("error", reject);
				resolve();
			});
		});
		socketIdentity = await identity(paths.socket);
		// Published only once listening: a daemon that finds another already on the socket mustn't have replaced its
		// state, which its cleanup would then remove.
		await writeState();
	} catch (error) {
		clearInterval(interval);
		await client.close();
		await ranges.close();
		await references.close();
		await removeOwnFiles();
		throw error;
	}
}

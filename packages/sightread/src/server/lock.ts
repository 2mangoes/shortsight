// Locks that end with their holder, however it exits. A holder listens on a Unix socket at the lock's path, which any
// runtime can check: one left by a holder that crashed refuses connections, and the next to take it removes it. Two
// taking it at that moment could both remove it, leaving one holding a lock nobody else can see, so under Bun a holder
// first takes an OS file lock beside it, which the OS releases however its holder exits. Node can't take those, so a
// Node process taking a lock just after a crash, while another takes it too, can be that unseen holder.
import { closeSync, openSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { createConnection, createServer, type Server } from "node:net";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;

const bun = typeof process.versions.bun === "string";

let libc: { flock(fd: number, operation: number): number } | undefined;
// Loaded with require, which Bun answers at once, so a lock is taken in the order it's asked for; Node never loads it.
function flock(fd: number, operation: number): number {
	if (!libc) {
		const { dlopen, FFIType } = createRequire(import.meta.url)("bun:ffi") as typeof import("bun:ffi");
		libc = dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
			flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
		}).symbols;
	}
	return libc.flock(fd, operation);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// What's answering at a socket path: a listener, nothing (no file, or one left by a holder that has gone), or a
// listener that doesn't accept in time, which is still a holder.
function answers(path: string): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection(path);
		const timer = setTimeout(() => finish(true), 1_000);
		function finish(held: boolean) {
			clearTimeout(timer);
			socket.destroy();
			resolve(held);
		}
		socket.once("connect", () => finish(true));
		socket.once("error", () => finish(false));
	});
}

function listen(path: string): Promise<Server | undefined> {
	return new Promise((resolve) => {
		const server = createServer((socket) => socket.destroy());
		server.once("error", () => resolve(undefined));
		server.listen(path, () => {
			// A lock doesn't keep its holder running.
			server.unref();
			resolve(server);
		});
	});
}

// Take a socket lock if nothing holds it, removing one whose holder has gone.
async function listenLock(path: string): Promise<Server | undefined> {
	const server = await listen(path);
	if (server || (await answers(path))) return server;
	rmSync(path, { force: true });
	return listen(path);
}

// Take the lock at `path` if nothing holds it, returning how to release it.
async function tryLock(path: string): Promise<(() => void) | undefined> {
	let unlock: (() => void) | undefined;
	if (bun) {
		// A lock's file stays: removing it while another process waits on it would let a third lock a new file there.
		const fd = openSync(`${path}.flock`, "a");
		if (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
			closeSync(fd);
			return undefined;
		}
		unlock = () => closeSync(fd);
	}
	const server = await listenLock(path);
	if (!server) {
		unlock?.();
		return undefined;
	}
	return () => {
		// Closing removes the socket's file.
		server.close();
		unlock?.();
	};
}

/** Take the lock at `path` for the rest of this process's life, if nothing else holds it. */
export async function holdLock(path: string): Promise<boolean> {
	const release = await tryLock(path);
	// Released as the process exits, so a clean exit leaves no socket for the next holder to remove.
	if (release) process.once("exit", release);
	return release !== undefined;
}

/** Run `action` holding the lock at `path`, waiting up to 15 seconds for it. */
export async function withStartLock<T>(path: string, action: () => Promise<T>): Promise<T> {
	const until = Date.now() + 15_000;
	await mkdir(dirname(path), { recursive: true });
	let release: (() => void) | undefined;
	while (!(release = await tryLock(path))) {
		if (Date.now() >= until) throw new Error("server start lock timed out; retry");
		await pause(50);
	}
	try {
		return await action();
	} finally {
		release();
	}
}

/** Whether another process, or another take of the lock in this one, holds the lock at `path`. */
export function lockHeld(path: string): Promise<boolean> {
	return answers(path);
}

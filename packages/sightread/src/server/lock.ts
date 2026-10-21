// Serialize server starts with an OS file lock. The OS releases it when its holder exits, however it exits, so a lock
// is never left stale and none has to be reclaimed: reclaiming one, by checking its holder and then removing it, can
// always race with a holder that has just taken it.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync, rmSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const LOCK_EX = 2;
const LOCK_NB = 4;
const LOCK_UN = 8;

let libc: { flock(fd: number, operation: number): number } | undefined;
function flock(fd: number, operation: number): number {
	libc ??= dlopen(process.platform === "darwin" ? "libc.dylib" : "libc.so.6", {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	}).symbols;
	return libc.flock(fd, operation);
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The lock's file, which stays: removing it while another process waits on it would let a third lock a new file at
// the same path. An earlier version kept a directory there, which is removed first.
function openLock(path: string): number {
	try {
		if (statSync(path).isDirectory()) rmSync(path, { recursive: true, force: true });
	} catch {
		// Not there yet.
	}
	return openSync(path, "a");
}

/** Run `action` holding the lock at `path`, waiting up to 15 seconds for it. */
export async function withStartLock<T>(path: string, action: () => Promise<T>): Promise<T> {
	const until = Date.now() + 15_000;
	await mkdir(dirname(path), { recursive: true });
	const fd = openLock(path);
	try {
		while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
			if (Date.now() >= until) throw new Error("server start lock timed out; retry");
			await pause(50);
		}
		return await action();
	} finally {
		// Closing the file releases the lock.
		closeSync(fd);
	}
}

/** Whether another process, or another open of the file in this one, holds the lock at `path`. */
export function lockHeld(path: string): boolean {
	let fd: number;
	try {
		if (statSync(path).isDirectory()) return false;
		fd = openSync(path, "a");
	} catch {
		return false;
	}
	try {
		if (flock(fd, LOCK_EX | LOCK_NB) !== 0) return true;
		flock(fd, LOCK_UN);
		return false;
	} finally {
		closeSync(fd);
	}
}

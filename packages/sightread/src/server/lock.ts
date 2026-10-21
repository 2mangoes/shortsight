// Serialize server starts with an OS file lock. The OS releases it when its holder exits, however it exits, so a lock
// is never left stale and none has to be reclaimed: reclaiming one, by checking its holder and then removing it, can
// always race with a holder that has just taken it.
import { dlopen, FFIType } from "bun:ffi";
import { closeSync, openSync, readFileSync, rmdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

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

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

// An earlier version locked with a directory holding its holder's pid. One whose holder has gone is taken apart, its
// file and then itself, which can fail but never remove a lock file another process has just made in its place.
// Returns whether the path is free of a live one.
function clearLegacy(path: string): boolean {
	try {
		if (!statSync(path).isDirectory()) return true;
	} catch {
		return true;
	}
	let pid = 0;
	try {
		pid = Number(readFileSync(join(path, "pid"), "utf8"));
	} catch {
		// Its holder may not have written it.
	}
	if (pid > 0 && running(pid)) return false;
	try {
		unlinkSync(join(path, "pid"));
	} catch {
		// Already gone.
	}
	try {
		rmdirSync(path);
	} catch {
		// Not empty, or already a file: left as it is.
	}
	return true;
}

// The lock's file, which stays: removing it while another process waits on it would let a third lock a new file at
// the same path. Undefined while an earlier version's lock is still held there.
function openLock(path: string): number | undefined {
	if (!clearLegacy(path)) return undefined;
	try {
		return openSync(path, "a");
	} catch {
		// A directory that couldn't be removed yet.
		return undefined;
	}
}

/** Run `action` holding the lock at `path`, waiting up to 15 seconds for it. */
export async function withStartLock<T>(path: string, action: () => Promise<T>): Promise<T> {
	const until = Date.now() + 15_000;
	await mkdir(dirname(path), { recursive: true });
	let fd = openLock(path);
	try {
		while (fd === undefined || flock(fd, LOCK_EX | LOCK_NB) !== 0) {
			if (Date.now() >= until) throw new Error("server start lock timed out; retry");
			await pause(50);
			fd ??= openLock(path);
		}
		return await action();
	} finally {
		// Closing the file releases the lock.
		if (fd !== undefined) closeSync(fd);
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

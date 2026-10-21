// Serialize server starts with a directory lock and remove locks left by dead holders.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function running(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

const holder = (directory: string) =>
	readFile(join(directory, "pid"), "utf8").then(
		(text) => Number(text),
		() => 0,
	);

// Remove a dead holder's lock, one reclaimer at a time. Two that both saw it dead would otherwise race: the second
// could remove the lock the first has just taken. Under the guard, the holder is checked again before removal. A
// guard is removed in turn only once its own reclaimer is dead, whatever its age, or if after a few seconds it still
// names none, since one that died before writing its pid can't. Returns whether it ran.
async function reclaim(directory: string): Promise<boolean> {
	const guard = `${directory}.reclaim`;
	try {
		await mkdir(guard);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const reclaimer = await holder(guard);
		const age = await stat(guard).then(
			(found) => Date.now() - found.mtimeMs,
			() => 0,
		);
		if ((reclaimer > 0 && !running(reclaimer)) || (reclaimer === 0 && age > 5_000))
			await rm(guard, { recursive: true, force: true });
		return false;
	}
	try {
		await writeFile(join(guard, "pid"), String(process.pid));
		const pid = await holder(directory);
		const held = await stat(directory).catch(() => undefined);
		if (held && ((pid > 0 && !running(pid)) || (pid === 0 && Date.now() - held.mtimeMs > 1_000)))
			await rm(directory, { recursive: true, force: true });
		return true;
	} finally {
		await rm(guard, { recursive: true, force: true });
	}
}

export async function withStartLock<T>(directory: string, action: () => Promise<T>): Promise<T> {
	const until = Date.now() + 15_000;
	await mkdir(join(directory, ".."), { recursive: true });
	while (true) {
		try {
			await mkdir(directory);
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			// A competing process may still be writing the holder file.
			const pid = await holder(directory);
			// A lock released since `mkdir` failed is free to take.
			const held = await stat(directory).catch((reason: NodeJS.ErrnoException) => {
				if (reason.code === "ENOENT") return undefined;
				throw reason;
			});
			if (!held) continue;
			const age = Date.now() - held.mtimeMs;
			if ((pid > 0 && !running(pid)) || (pid === 0 && age > 1_000)) {
				if (!(await reclaim(directory))) await pause(20);
				continue;
			}
			if (Date.now() >= until) throw new Error("server start lock timed out; retry", { cause: error });
			await pause(100);
		}
	}
	try {
		await writeFile(join(directory, "pid"), String(process.pid));
		return await action();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

// Keep a TypeScript API request from waiting forever on a process that has gone.
import type { ChildProcess } from "node:child_process";
import type { API } from "typescript/unstable/async";

export class APIExitError extends Error {}

/** The process an API client talks to, once it has started one. */
export function processOf(api: API): ChildProcess | undefined {
	return (api as unknown as { client?: { process?: ChildProcess } }).client?.process;
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

/**
 * Settle with `work`, or reject once the API's process has exited: the API leaves a request it sent waiting forever
 * when its process exits. The process starts on the first request, after this is called, so it's checked as it runs.
 * One that's still running but hasn't answered within `timeout` is stopped, which rejects the request the same way.
 */
export function untilExit<T>(api: API, work: Promise<T>, timeout = 120_000): Promise<T> {
	const deadline = Date.now() + timeout;
	return new Promise<T>((resolve, reject) => {
		const timer = setInterval(() => {
			const child = processOf(api);
			if (child && exited(child)) {
				clearInterval(timer);
				reject(new APIExitError("TypeScript API process exited"));
			} else if (Date.now() > deadline) {
				clearInterval(timer);
				child?.kill("SIGKILL");
				reject(new APIExitError(`TypeScript API process didn't answer in ${Math.round(timeout / 1000)}s`));
			}
		}, 100);
		work.then(
			(value) => {
				clearInterval(timer);
				resolve(value);
			},
			(error: unknown) => {
				clearInterval(timer);
				reject(error);
			},
		);
	});
}

/**
 * Close an API, and stop its process if closing doesn't finish within `timeout`: closing first asks the process to
 * release its snapshots, which a process that has stopped answering never does.
 */
export async function closeAPI(api: API, timeout = 2_000): Promise<void> {
	// Taken first: closing forgets it.
	const child = processOf(api);
	let timer: ReturnType<typeof setTimeout> | undefined;
	const closed = await Promise.race([
		api.close().then(
			() => true,
			() => true,
		),
		new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), timeout);
		}),
	]);
	clearTimeout(timer);
	if (!child) return;
	// Closing can fail at once, as well as never finish, with the process still running: one that hasn't exited
	// shortly after is stopped either way.
	if (closed)
		for (let waited = 0; waited < 1_000 && !exited(child); waited += 50)
			await new Promise((resolve) => setTimeout(resolve, 50));
	if (!exited(child)) child.kill("SIGKILL");
}

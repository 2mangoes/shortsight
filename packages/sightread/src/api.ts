// Keep a TypeScript API request from waiting forever on a process that has gone.
import type { ChildProcess } from "node:child_process";
import type { API } from "typescript/unstable/async";

export class APIExitError extends Error {}

/** The process an API client talks to, once it has started one. */
export function processOf(api: API): ChildProcess | undefined {
	return (api as unknown as { client?: { process?: ChildProcess } }).client?.process;
}

/**
 * Settle with `work`, or reject once the API's process has exited: the API leaves a request it sent waiting forever
 * when its process exits. The process starts on the first request, after this is called, so it's checked as it runs.
 */
export function untilExit<T>(api: API, work: Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setInterval(() => {
			const child = processOf(api);
			if (child && (child.exitCode !== null || child.signalCode !== null)) {
				clearInterval(timer);
				reject(new APIExitError("TypeScript API process exited"));
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

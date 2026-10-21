// Exercise daemon lifecycle and socket requests against disposable projects and the real graph.
import { afterAll, afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { connect, exchange, listServers, stopAllServers, stopServer } from "../src/server/client.ts";
import { withStartLock } from "../src/server/lock.ts";
import { serverPaths, stateParent } from "../src/server/paths.ts";
import { projectSignature } from "../src/server/signature.ts";

const originalRuntime = process.env.XDG_RUNTIME_DIR;
const originalTmp = process.env.TMPDIR;
const environment = [
	"SIGHTREAD_IDLE_MS",
	"SIGHTREAD_MISSING_MS",
	"SIGHTREAD_MAX_SERVERS",
	"SIGHTREAD_QUIET_MS",
	"SIGHTREAD_DAEMON_FAIL",
	"SIGHTREAD_DAEMON_START_DELAY_MS",
	"SIGHTREAD_DAEMON_QUERY_DELAY_MS",
	"SIGHTREAD_DAEMON_STOP_DELAY_MS",
	"SIGHTREAD_DAEMON_STATE_DELAY_MS",
	"SIGHTREAD_DAEMON_SOCKET_ERROR_ON_RESET",
] as const;
const originals = new Map(environment.map((name) => [name, process.env[name]]));
const runtime = mkdtempSync(join(realpathSync("/tmp"), "sr-"));
process.env.XDG_RUNTIME_DIR = runtime;
const component = [
	"type Row<T> = { id: string; value: T };",
	"export function View<T>({ rows }: { rows: Row<T>[] }) {",
	"  return <main><h1>Rows</h1><section>{rows.map((row) =>",
	"    <article key={row.id}><header>{row.id}</header><p>{String(row.value)}</p></article>",
	"  )}</section></main>;",
	"}",
].join("\n");
function fixture(files: Record<string, string>) {
	const repository = mkdtempSync("/tmp/sightread-repository-");
	const root = join(repository, "client");
	mkdirSync(root);
	writeFileSync(join(root, "tsconfig.json"), "{}");
	for (const [name, contents] of Object.entries(files)) {
		const file = join(root, name);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, contents);
	}
	return { root, cleanup: () => rmSync(repository, { recursive: true, force: true }) };
}

const first = fixture({
	"src/model.ts": "export function greet() { return 1; }\n",
	"src/View.tsx": component,
});
const second = fixture({
	"src/other.ts": "export function other() { return 2; }\n",
	"src/View.tsx": component,
});
const project = (root: string) => ({ root, tsconfig: join(root, "tsconfig.json") });
const lookup = (query: string) => [{ type: "lookup", query }];

// What a CLI request that has to start the project's server prints to stderr, and nothing else.
const announced = (root: string) => `sightread: starting a server for ${root}; the first request may take a while\n`;

async function cli(...args: string[]) {
	const child = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
		env: { ...Bun.env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [code, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { code, out, err };
}

async function until(check: () => Promise<boolean>, timeout = 5_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!(await check())) {
		if (Date.now() >= deadline) throw new Error("condition did not become true");
		await Bun.sleep(25);
	}
}

afterEach(() => {
	for (const name of environment) {
		const value = originals.get(name);
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

afterAll(async () => {
	await stopAllServers();
	first.cleanup();
	second.cleanup();
	rmSync(runtime, { recursive: true, force: true });
	if (originalRuntime === undefined) delete process.env.XDG_RUNTIME_DIR;
	else process.env.XDG_RUNTIME_DIR = originalRuntime;
	if (originalTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmp;
});

test("a short XDG runtime directory is used", () => {
	expect(stateParent()).toBe(join(runtime, `sightread-${process.getuid?.() ?? 0}`));
	expect(statSync(stateParent()).mode & 0o777).toBe(0o700);
});

test("an owned state parent with mode 0755 is tightened to 0700", () => {
	const parent = stateParent();
	chmodSync(parent, 0o755);
	expect(stateParent()).toBe(parent);
	expect(statSync(parent).mode & 0o777).toBe(0o700);
});

test("a graph query leaves a clean nested git checkout without node_modules or cache files", async () => {
	const disposable = fixture({
		"src/model.ts": "export function cachedSymbol() { return 1; }\n",
		"src/View.tsx": component,
	});
	const repository = dirname(disposable.root);
	const current = project(disposable.root);
	const originalCache = process.env.TTSC_CACHE_DIR;
	const git = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repository, stdout: "pipe", stderr: "pipe" });
	try {
		for (const args of [
			["init", "-q"],
			["add", "-A"],
			["-c", "user.name=test", "-c", "user.email=test@test", "commit", "-qm", "init"],
		]) {
			const result = git(args);
			expect(result.exitCode).toBe(0);
		}
		delete process.env.TTSC_CACHE_DIR;
		const result = await cli("--cwd", disposable.root, JSON.stringify({ type: "lookup", query: "cachedSymbol" }));
		expect(result.code).toBe(0);
		expect(result.out).toContain("cachedSymbol  exported function  client/src/model.ts:1-1");
		const status = git(["status", "--short", "--ignored"]);
		expect(status.exitCode).toBe(0);
		expect(status.stdout.toString()).toBe("");
	} finally {
		await stopServer(current);
		if (originalCache === undefined) delete process.env.TTSC_CACHE_DIR;
		else process.env.TTSC_CACHE_DIR = originalCache;
		disposable.cleanup();
	}
}, 30_000);

test("an existing TTSC_CACHE_DIR is kept for the upstream graph child", async () => {
	const disposable = fixture({
		"src/model.ts": "export function customCacheSymbol() { return 1; }\n",
		"src/View.tsx": component,
	});
	const current = project(disposable.root);
	const cache = join(runtime, `custom-cache-${crypto.randomUUID()}`);
	const originalCache = process.env.TTSC_CACHE_DIR;
	try {
		process.env.TTSC_CACHE_DIR = cache;
		const result = await cli("--cwd", disposable.root, JSON.stringify({ type: "lookup", query: "customCacheSymbol" }));
		expect(result.code).toBe(0);
		expect(result.out).toContain("customCacheSymbol  exported function  src/model.ts:1-1");
		expect(existsSync(cache)).toBe(true);
	} finally {
		await stopServer(current);
		if (originalCache === undefined) delete process.env.TTSC_CACHE_DIR;
		else process.env.TTSC_CACHE_DIR = originalCache;
		disposable.cleanup();
	}
}, 30_000);

test("a long XDG runtime directory falls back for query, ps, and stop", async () => {
	const disposable = fixture({
		"src/View.tsx": component,
		"src/model.ts": "export function fallback() { return 1; }\n",
	});
	process.env.XDG_RUNTIME_DIR = join(runtime, "x".repeat(110));
	const current = project(disposable.root);
	try {
		expect(stateParent()).toBe(join(tmpdir(), `sightread-${process.getuid?.() ?? 0}`));
		const query = await cli("--cwd", disposable.root, JSON.stringify({ type: "lookup", query: "fallback" }));
		expect(query.code).toBe(0);
		expect(query.err).toBe(announced(disposable.root));
		expect(query.out).toContain("fallback  exported function  src/model.ts:1-1");
		const listed = await cli("ps");
		expect(listed.code).toBe(0);
		expect(listed.out).toContain(disposable.root);
		const stopped = await cli("--cwd", disposable.root, "stop");
		expect(stopped.code).toBe(0);
		expect(stopped.out).toBe("stopped\n");
		expect((await cli("ps")).out).not.toContain(disposable.root);
	} finally {
		await stopServer(current);
		process.env.XDG_RUNTIME_DIR = runtime;
		disposable.cleanup();
	}
}, 30_000);

test("an owned fallback parent is tightened", async () => {
	const base = mkdtempSync("/tmp/sightread-unsafe-base-");
	const unsafeParent = join(base, `sightread-${process.getuid?.() ?? 0}`);
	const disposable = fixture({
		"src/View.tsx": component,
		"src/model.ts": "export function safeFallback() { return 1; }\n",
	});
	mkdirSync(unsafeParent, { mode: 0o700 });
	chmodSync(unsafeParent, 0o777);
	process.env.XDG_RUNTIME_DIR = join(runtime, "x".repeat(110));
	process.env.TMPDIR = base;
	try {
		expect(stateParent()).toBe(unsafeParent);
		expect(statSync(unsafeParent).mode & 0o777).toBe(0o700);
		const query = await cli("--cwd", disposable.root, JSON.stringify({ type: "lookup", query: "safeFallback" }));
		expect(query.code).toBe(0);
		expect(query.err).toBe(announced(disposable.root));
		expect(query.out).toContain("safeFallback  exported function  src/model.ts:1-1");
	} finally {
		await stopServer(project(disposable.root));
		process.env.XDG_RUNTIME_DIR = runtime;
		if (originalTmp === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = originalTmp;
		disposable.cleanup();
		rmSync(base, { recursive: true, force: true });
	}
}, 30_000);

test("a symlinked state parent is never followed", () => {
	const base = mkdtempSync(join(realpathSync("/tmp"), "sr-link-"));
	const target = join(base, "target");
	mkdirSync(target);
	const originalMode = statSync(target).mode & 0o777;
	symlinkSync(target, join(base, `sightread-${process.getuid?.() ?? 0}`));
	process.env.XDG_RUNTIME_DIR = base;
	try {
		expect(stateParent()).not.toBe(join(base, `sightread-${process.getuid?.() ?? 0}`));
		expect(statSync(target).mode & 0o777).toBe(originalMode);
	} finally {
		process.env.XDG_RUNTIME_DIR = runtime;
		rmSync(base, { recursive: true, force: true });
	}
});

test("reuses one daemon for sequential callers", async () => {
	const one = await connect(project(first.root));
	const output = await one.query(lookup("greet"), { json: false });
	expect(output).toContain("greet  exported function  src/model.ts:1-1");
	const two = await connect(project(first.root));
	const warm = await two.query(lookup("greet"), { json: false });
	expect(two.pid).toBe(one.pid);
	expect(warm).toContain("greet  exported function  src/model.ts:1-1");
}, 30_000);

test("concurrent callers share one daemon", async () => {
	const callers = await Promise.all(Array.from({ length: 3 }, () => connect(project(first.root))));
	expect(new Set(callers.map(({ pid }) => pid)).size).toBe(1);
}, 30_000);

test("returns raw graph values", async () => {
	const one = await connect(project(first.root));
	const values = await one.values(lookup("greet"));
	expect(values).toHaveLength(1);
	expect((values[0] as { result: { hits: { name: string }[] } }).result.hits.some(({ name }) => name === "greet")).toBe(
		true,
	);
}, 30_000);

test("returns request types", async () => {
	const one = await connect(project(first.root));
	expect((await one.requestTypes()).some(({ type }) => type === "lookup")).toBe(true);
}, 30_000);

test("restart replaces the daemon", async () => {
	const one = await connect(project(first.root));
	const restarted = await one.restart();
	expect(restarted.pid).not.toBe(one.pid);
}, 30_000);

test("values retries once after its server exits", async () => {
	const projectPath = project(first.root);
	const connection = await connect(projectPath);
	await stopServer(projectPath);
	const values = await connection.values(lookup("greet"));
	expect(values).toHaveLength(1);
	expect((values[0] as { result: { hits: unknown[] } }).result.hits.length).toBeGreaterThan(0);
}, 30_000);

test("requestTypes retries once after its server exits", async () => {
	const projectPath = project(first.root);
	const connection = await connect(projectPath);
	await stopServer(projectPath);
	expect((await connection.requestTypes()).some(({ type }) => type === "trace")).toBe(true);
}, 30_000);

test("concurrent CLI processes start one server", async () => {
	await stopServer(project(first.root));
	const args = [
		process.execPath,
		join(import.meta.dir, "../src/cli.ts"),
		"--cwd",
		first.root,
		JSON.stringify({ type: "lookup", query: "greet" }),
	];
	const calls = Array.from({ length: 2 }, () =>
		Bun.spawn(args, { cwd: first.root, env: { ...Bun.env, XDG_RUNTIME_DIR: runtime }, stdout: "pipe", stderr: "pipe" }),
	);
	const outputs = await Promise.all(
		calls.map(async (child) => ({
			code: await child.exited,
			out: await new Response(child.stdout).text(),
			err: await new Response(child.stderr).text(),
		})),
	);
	// Either may find no server and say it's starting one; neither says anything else.
	expect(outputs.some((output) => output.err === announced(first.root))).toBe(true);
	for (const output of outputs) {
		expect(output.code).toBe(0);
		expect(["", announced(first.root)]).toContain(output.err);
		expect(output.out).toContain("greet  exported function  src/model.ts:1-1");
	}
	expect((await listServers()).filter(({ project: root }) => root === first.root)).toHaveLength(1);
}, 30_000);

test("replaces a stale socket", async () => {
	await stopServer(project(first.root));
	const paths = serverPaths(project(first.root));
	mkdirSync(paths.directory, { recursive: true });
	writeFileSync(paths.socket, "stale");
	const one = await connect(project(first.root));
	expect(await one.query(lookup("greet"), {})).toContain("greet  exported function  src/model.ts:1-1");
}, 30_000);

test("refreshes source without restarting", async () => {
	const one = await connect(project(first.root));
	writeFileSync(
		join(first.root, "src/model.ts"),
		"export function greet() { return 1; }\nexport function freshSymbol() { return greet(); }\n",
	);
	const output = await one.query(lookup("freshSymbol"), { json: false });
	expect(output).toContain("freshSymbol  exported function  src/model.ts:2-2");
	expect((await connect(project(first.root))).pid).toBe(one.pid);
}, 30_000);

test("config change restarts only its project", async () => {
	const one = await connect(project(first.root));
	const other = await connect(project(second.root));
	const config = join(first.root, "tsconfig.json");
	const stamp = new Date(Date.now() + 2_000);
	utimesSync(config, stamp, stamp);
	const refreshed = await connect(project(first.root));
	expect(refreshed.pid).not.toBe(one.pid);
	expect((await connect(project(second.root))).pid).toBe(other.pid);
}, 45_000);

test("server limit evicts the least recently used quiet server", async () => {
	await stopAllServers();
	process.env.SIGHTREAD_MAX_SERVERS = "1";
	process.env.SIGHTREAD_QUIET_MS = "0";
	try {
		const limited = await connect(project(first.root));
		await connect(project(second.root));
		expect((await listServers()).map(({ pid }) => pid)).not.toContain(limited.pid);
		expect(await listServers()).toHaveLength(1);
	} finally {
		delete process.env.SIGHTREAD_MAX_SERVERS;
		delete process.env.SIGHTREAD_QUIET_MS;
	}
}, 45_000);

test("server limit never stops a server in recent use", async () => {
	await stopAllServers();
	process.env.SIGHTREAD_MAX_SERVERS = "1";
	try {
		const busy = await connect(project(first.root));
		const other = await connect(project(second.root));
		expect((await listServers()).map(({ pid }) => pid).toSorted()).toEqual([busy.pid, other.pid].toSorted());
	} finally {
		delete process.env.SIGHTREAD_MAX_SERVERS;
	}
}, 45_000);

test("a quiet timestamp cannot evict a server during a query", async () => {
	await stopAllServers();
	process.env.SIGHTREAD_MAX_SERVERS = "1";
	process.env.SIGHTREAD_QUIET_MS = "0";
	process.env.SIGHTREAD_DAEMON_QUERY_DELAY_MS = "3000";
	try {
		const firstServer = await connect(project(first.root));
		const state = serverPaths(project(first.root)).state;
		const before = (JSON.parse(await Bun.file(state).text()) as { lastUsed: number }).lastUsed;
		await Bun.sleep(50);
		const query = firstServer.query(lookup("greet"), {});
		await until(async () => {
			const live = JSON.parse(await Bun.file(state).text()) as { lastUsed: number };
			return live.lastUsed > before;
		});
		const secondServer = await connect(project(second.root));
		expect((await listServers()).map(({ pid }) => pid).toSorted()).toEqual(
			[firstServer.pid, secondServer.pid].toSorted(),
		);
		expect(await query).toContain("greet  exported function");
	} finally {
		await stopAllServers();
	}
}, 45_000);

test("concurrent cold starts over the limit don't wait for each other", async () => {
	await stopAllServers();
	const module = new URL("../src/server/client.ts", import.meta.url).href;
	const projects = JSON.stringify([project(first.root), project(second.root)]);
	const code = `import { connect, listServers, stopAllServers } from ${JSON.stringify(module)};
const projects = ${projects};
try {
	const starts = await Promise.allSettled(projects.map(connect));
	console.log(JSON.stringify({ starts: starts.map((entry) => entry.status === "fulfilled" ? "fulfilled" : String(entry.reason)), count: (await listServers()).length }));
} finally { await stopAllServers(); }`;
	const child = Bun.spawn([process.execPath, "-e", code], {
		env: {
			...Bun.env,
			XDG_RUNTIME_DIR: runtime,
			SIGHTREAD_MAX_SERVERS: "1",
			SIGHTREAD_DAEMON_START_DELAY_MS: "1000",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exit, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	expect({ exit, stderr, result: JSON.parse(stdout) }).toEqual({
		exit: 0,
		stderr: "",
		result: { starts: ["fulfilled", "fulfilled"], count: 2 },
	});
}, 45_000);

test("an extended config outside the project changes the signature", async () => {
	const disposable = fixture({ "src/View.tsx": component });
	const base = join(dirname(disposable.root), "tsconfig.base.json");
	writeFileSync(base, '{"compilerOptions":{"strict":true}}\n');
	writeFileSync(join(disposable.root, "tsconfig.json"), '{"extends":"../tsconfig.base.json"}\n');
	try {
		const before = await projectSignature(project(disposable.root));
		writeFileSync(base, '{"compilerOptions":{"strict":false}}\n');
		expect(await projectSignature(project(disposable.root))).not.toBe(before);
	} finally {
		disposable.cleanup();
	}
});

test("a package-style extended config changes the signature", async () => {
	const disposable = fixture({
		"src/View.tsx": component,
		"node_modules/@test/config/package.json": '{"name":"@test/config","tsconfig":"tsconfig.json"}\n',
		"node_modules/@test/config/tsconfig.json": '{"compilerOptions":{"strict":true}}\n',
	});
	writeFileSync(join(disposable.root, "tsconfig.json"), '{"extends":"@test/config"}\n');
	try {
		const before = await projectSignature(project(disposable.root));
		writeFileSync(
			join(disposable.root, "node_modules/@test/config/tsconfig.json"),
			'{"compilerOptions":{"strict":false}}\n',
		);
		expect(await projectSignature(project(disposable.root))).not.toBe(before);
	} finally {
		disposable.cleanup();
	}
});

test("idle daemon shuts down", async () => {
	await stopAllServers();
	process.env.SIGHTREAD_IDLE_MS = "250";
	try {
		const one = await connect(project(first.root));
		await until(async () => (await listServers()).length === 0);
		const restarted = await connect(project(first.root));
		expect(restarted.pid).not.toBe(one.pid);
	} finally {
		delete process.env.SIGHTREAD_IDLE_MS;
	}
}, 45_000);

test("daemon shuts down after project disappears", async () => {
	await stopAllServers();
	process.env.SIGHTREAD_MISSING_MS = "50";
	const disposable = fixture({ "src/View.tsx": component });
	try {
		await connect(project(disposable.root));
		disposable.cleanup();
		await until(async () => !(await listServers()).some(({ project: root }) => root === disposable.root));
		expect((await listServers()).some(({ project: root }) => root === disposable.root)).toBe(false);
	} finally {
		disposable.cleanup();
		delete process.env.SIGHTREAD_MISSING_MS;
	}
}, 45_000);

test("startup failure names the daemon log", async () => {
	await stopAllServers();
	process.env.SIGHTREAD_DAEMON_FAIL = "1";
	try {
		await expect(connect(project(first.root))).rejects.toThrow(
			`server did not start; see ${serverPaths(project(first.root)).log}`,
		);
	} finally {
		delete process.env.SIGHTREAD_DAEMON_FAIL;
	}
}, 10_000);

test("a cold start in one project does not block a warm query in another", async () => {
	await stopAllServers();
	await connect(project(second.root));
	process.env.SIGHTREAD_DAEMON_START_DELAY_MS = "3000";
	let started = false;
	const cold = connect(project(first.root)).then((value) => {
		started = true;
		return value;
	});
	try {
		await until(async () => existsSync(serverPaths(project(first.root)).lock));
		const start = performance.now();
		const output = await (await connect(project(second.root))).query(lookup("other"), {});
		expect(output).toContain("other  exported function  src/other.ts:1-1");
		expect(performance.now() - start).toBeLessThan(1500);
		expect(started).toBe(false);
		await cold;
	} finally {
		delete process.env.SIGHTREAD_DAEMON_START_DELAY_MS;
		await cold.catch(() => undefined);
	}
}, 20_000);

test("a reset query socket does not kill the daemon", async () => {
	await stopServer(project(first.root));
	process.env.SIGHTREAD_DAEMON_QUERY_DELAY_MS = "500";
	process.env.SIGHTREAD_DAEMON_SOCKET_ERROR_ON_RESET = "1";
	try {
		const current = await connect(project(first.root));
		const socketPath = serverPaths(project(first.root)).socket;
		await Promise.all(
			Array.from(
				{ length: 30 },
				() =>
					new Promise<void>((resolve, reject) => {
						const socket = createConnection(socketPath);
						socket.once("error", reject);
						socket.once("connect", () => {
							socket.write(`${JSON.stringify({ type: "query", requests: lookup("greet") })}\n`, () => {
								setTimeout(() => {
									socket.resetAndDestroy();
									resolve();
								}, 5);
							});
						});
					}),
			),
		);
		const start = performance.now();
		const output = await current.query(lookup("greet"), {});
		expect(output).toContain("greet  exported function  src/model.ts:1-1");
		expect(performance.now() - start).toBeGreaterThanOrEqual(450);
		expect((await connect(project(first.root))).pid).toBe(current.pid);
	} finally {
		delete process.env.SIGHTREAD_DAEMON_QUERY_DELAY_MS;
		delete process.env.SIGHTREAD_DAEMON_SOCKET_ERROR_ON_RESET;
		await stopServer(project(first.root));
	}
}, 20_000);

test("touching sightread source replaces a stale daemon", async () => {
	const current = await connect(project(first.root));
	const source = join(import.meta.dir, "../src/server/signature.ts");
	const old = statSync(source);
	const touched = new Date(old.mtimeMs + 10_000);
	try {
		utimesSync(source, touched, touched);
		expect((await connect(project(first.root))).pid).not.toBe(current.pid);
	} finally {
		utimesSync(source, old.atime, old.mtime);
	}
}, 20_000);

test("a hung stop reports the stop timeout and log path", async () => {
	const current = project(first.root);
	await stopServer(current);
	process.env.SIGHTREAD_DAEMON_STOP_DELAY_MS = "6500";
	try {
		await connect(current);
		await expect(stopServer(current)).rejects.toThrow(`server did not stop; see ${serverPaths(current).log}`);
	} finally {
		delete process.env.SIGHTREAD_DAEMON_STOP_DELAY_MS;
		await until(async () => !(await listServers()).some(({ project: root }) => root === current.root), 10_000);
	}
}, 15_000);

test("a reply split inside a character is decoded whole", async () => {
	const socketPath = join(mkdtempSync(join(realpathSync("/tmp"), "sr-utf8-")), "s");
	const reply = Buffer.from(`${JSON.stringify({ value: "café ✓" })}\n`);
	// Split inside "é", whose two bytes come first in the reply after "caf".
	const split = reply.indexOf(Buffer.from("é")) + 1;
	const server = createServer((socket) =>
		socket.once("data", () => {
			socket.write(reply.subarray(0, split));
			setTimeout(() => socket.end(reply.subarray(split)), 20);
		}),
	);
	await new Promise<void>((resolve) => server.listen(socketPath, resolve));
	try {
		expect(await exchange(socketPath, { type: "ping" })).toBe("café ✓");
	} finally {
		server.close();
	}
});

test("a stopping daemon leaves a replacement's socket and state alone", async () => {
	await stopAllServers();
	const current = project(first.root);
	const paths = serverPaths(current);
	const retiring = await connect(current);
	// A replacement takes the paths while the old daemon is still finishing: its socket is moved aside, so it can
	// still be told to stop.
	const aside = `${paths.socket}.old`;
	renameSync(paths.socket, aside);
	const replacement = createServer(() => undefined);
	await new Promise<void>((resolve) => replacement.listen(paths.socket, resolve));
	const state = JSON.stringify({
		project: current.root,
		tsconfig: current.tsconfig,
		pid: 1,
		lastUsed: 0,
		startedAt: 0,
	});
	writeFileSync(paths.state, state);
	try {
		await exchange(aside, { type: "stop" });
		await until(async () => {
			try {
				process.kill(retiring.pid, 0);
				return false;
			} catch {
				return true;
			}
		}, 15_000);
		expect(existsSync(paths.socket)).toBe(true);
		expect(readFileSync(paths.state, "utf8")).toBe(state);
	} finally {
		replacement.close();
		rmSync(aside, { force: true });
		rmSync(paths.state, { force: true });
	}
}, 45_000);

test("starters reclaiming a dead holder's lock never hold it together", async () => {
	const directory = join(mkdtempSync(join(realpathSync("/tmp"), "sr-lock-")), "start.lock");
	let holding = 0;
	let most = 0;
	for (let round = 0; round < 5; round++) {
		mkdirSync(directory);
		// A process id that isn't running.
		writeFileSync(join(directory, "pid"), "2147483646");
		await Promise.all(
			Array.from({ length: 20 }, () =>
				withStartLock(directory, async () => {
					most = Math.max(most, ++holding);
					await new Promise((resolve) => setTimeout(resolve, 5));
					holding--;
				}),
			),
		);
	}
	expect(most).toBe(1);
	expect(existsSync(directory)).toBe(false);
}, 30_000);

test("a state write still in flight when a daemon stops doesn't replace a replacement's state", async () => {
	await stopAllServers();
	process.env.SIGHTREAD_DAEMON_STATE_DELAY_MS = "500";
	const current = project(first.root);
	const paths = serverPaths(current);
	try {
		const retiring = await connect(current);
		// A query starts a state write that pauses before it lands.
		const pending = retiring.query(lookup("greet"), {}).catch(() => undefined);
		await new Promise((resolve) => setTimeout(resolve, 100));
		const aside = `${paths.socket}.old`;
		renameSync(paths.socket, aside);
		const replacement = createServer(() => undefined);
		await new Promise<void>((resolve) => replacement.listen(paths.socket, resolve));
		const state = JSON.stringify({
			project: current.root,
			tsconfig: current.tsconfig,
			pid: 1,
			lastUsed: 0,
			startedAt: 0,
		});
		writeFileSync(paths.state, state);
		try {
			await exchange(aside, { type: "stop" });
			await pending;
			await until(async () => {
				try {
					process.kill(retiring.pid, 0);
					return false;
				} catch {
					return true;
				}
			}, 15_000);
			expect(readFileSync(paths.state, "utf8")).toBe(state);
		} finally {
			replacement.close();
			rmSync(aside, { force: true });
			rmSync(paths.state, { force: true });
		}
	} finally {
		delete process.env.SIGHTREAD_DAEMON_STATE_DELAY_MS;
	}
}, 45_000);

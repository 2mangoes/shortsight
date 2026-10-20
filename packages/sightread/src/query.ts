// Run graph batches and choose raw, model, or text output.
import { isAbsolute, normalize, relative, sep } from "node:path";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
	fromHandle,
	inheritRequest,
	normalizeResult,
	object,
	traceBound,
	traceCut,
	type GraphResult,
} from "./model.ts";
import { resolveNamesSettled } from "./names.ts";
import { createPaths } from "./paths.ts";
import type { RangeIndex } from "./ranges.ts";
import type { ReferenceIndex } from "./references.ts";
import { renderText } from "./render.ts";
import { traceRefusal, unindexed, withUnindexed } from "./unindexed.ts";
import type { GraphClient } from "./upstream.ts";

export interface QueryContext {
	client: GraphClient;
	ranges: RangeIndex;
	references?: ReferenceIndex;
	root?: string;
	tsconfig?: string;
	projectFileCount?: number;
	nestedProjects?: string[];
}

export interface QueryOptions {
	mode?: "text" | "json" | "raw";
	in?: string;
	color?: boolean;
	json?: boolean;
}

function filterIn(result: GraphResult, directory: string): GraphResult {
	const prefix = normalize(directory).replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/$/, "").replace(/^\.$/, "");
	const keep = (file: string) => !prefix || file === prefix || file.startsWith(`${prefix}/`);
	const nodes = result.nodes.filter((node) => keep(node.file));
	const handles = new Set(nodes.map((node) => node.handle));
	const allHandles = new Set(result.nodes.map((node) => node.handle));
	const edges = result.edges.filter((edge) => handles.has(edge.from) && handles.has(edge.to));
	const indices = new Map<number, number>();
	result.edges.forEach((edge, index) => {
		const next = edges.indexOf(edge);
		if (next >= 0) indices.set(index, next);
	});
	const filter = (value: unknown, edgeList = false): unknown => {
		if (typeof value === "string" && allHandles.has(value)) return handles.has(value) ? value : undefined;
		if (Array.isArray(value)) {
			const entries = value.map((item) => filter(item, edgeList)).filter((item) => item !== undefined);
			return entries.length ? entries : undefined;
		}
		if (typeof value === "number" && edgeList) return indices.get(value);
		if (value && typeof value === "object") {
			const entries = Object.entries(value)
				.map(([key, item]) => [key, filter(item, key === "hops" || key === "steps")] as const)
				.filter(([, item]) => item !== undefined);
			return entries.length ? Object.fromEntries(entries) : undefined;
		}
		return value;
	};
	// Trace hops and tour steps refer to edges by index, and so does each of details' neighbour lists.
	const edgeList = (key: string, value: unknown) =>
		key === "hops" ||
		key === "steps" ||
		(result.type === "details" && Array.isArray(value) && value.every((item) => typeof item === "number"));
	const sections = Object.fromEntries(
		Object.entries(result.sections)
			.map(([key, value]) => [key, filter(value, edgeList(key, value))])
			.filter(([, value]) => value !== undefined),
	);
	const primary = ["hits", "entrypoints", "nodes", "reached", "hops", "files", "tests"].find((key) =>
		Array.isArray(result.sections[key]),
	);
	return inheritRequest(result, {
		...result,
		nodes,
		edges,
		sections,
		shown:
			result.type === "references"
				? nodes.length
				: primary && Array.isArray(sections[primary])
					? sections[primary].length
					: 0,
	});
}

// A reverse trace answers "what does changing this affect?", so it asks the graph for far more symbols than the
// graph's default of 12. It goes three levels deep by default, and at most eight: unlimited, it reaches most of a
// large codebase through its central classes.
const TRACE_LIMIT = 1000;
const TRACE_DEPTH = 3;
const TRACE_MAX_DEPTH = 8;
// A start with more direct users than this reaches much of the codebase within a few levels, which is too long to
// read, so without an explicit depth its direct users answer.
const HUB_USERS = 32;
// The graph traces that follow a start's direct users, when it has no node, run this many at a time.
const SUB_TRACES = 8;
// The graph walks breadth first, so a smaller budget only cuts the same walk sooner. Asking for at least the full
// limit and cutting it here keeps every hop between the symbols kept, and shows when more were left.
const budgetFor = (limit: number) => Math.max(limit, TRACE_LIMIT);

interface TraceAnswer {
	value: unknown;
	note?: string;
	raise?: string;
}

const records = (value: unknown): Record<string, unknown>[] =>
	Array.isArray(value) ? value.flatMap((item) => (object(item) ? [object(item)!] : [])) : [];
const traceOf = (value: unknown) => object(object(value)?.result) ?? object(value);
const rawSymbol = (handle: string) => {
	const parsed = fromHandle(handle);
	return parsed ? { id: handle, ...parsed } : undefined;
};
// Sub-traces start at different depths, so the same hop is matched without its depth.
const hopKey = ({ depth: _depth, ...hop }: Record<string, unknown>) => JSON.stringify(hop);
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

// Run `run` on each item, at most `limit` at a time, keeping their order.
async function eachLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
	const results: R[] = [];
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const index = next++;
				results[index] = await run(items[index]!);
			}
		}),
	);
	return results;
}

// Ask the graph for a reverse trace sightread completes: as many symbols and levels as it allows, cut to direct users
// for a hub. It reports truncation only where a budget cut the walk, not where the depth asked for ended it, and says
// when the graph withheld a dispatch fanout, which only `complete` follows.
async function reverseTrace(
	context: QueryContext,
	request: Record<string, unknown>,
	paths: ReturnType<typeof createPaths> | undefined,
): Promise<TraceAnswer | undefined> {
	if (request.type !== "trace" || request.direction !== "reverse" || request.to !== undefined) return undefined;
	const nodeless = await unindexed(context.ranges, request.from);
	const complete = request.complete === true;
	// The graph exhausts a complete trace itself, from a start it has a node for.
	if (complete && !nodeless) return undefined;
	const limit = complete ? Infinity : traceBound(request.maxNodes, TRACE_LIMIT);
	const depthAsked = typeof request.maxDepth === "number";
	const maxDepth = complete ? Infinity : Math.min(TRACE_MAX_DEPTH, traceBound(request.maxDepth, TRACE_DEPTH));
	let start: Record<string, unknown> | undefined;
	let walk: Walk;
	let rest: Record<string, unknown> = {};
	if (nodeless) {
		if (!context.references || !paths) return undefined;
		start = rawSymbol(String(request.from));
		walk = await fromReferences(context, request, paths, { limit, maxDepth, depthAsked, complete });
	} else {
		const budget = budgetFor(limit);
		const { value } = await context.client.query({ ...request, maxNodes: budget, maxDepth });
		const trace = traceOf(value);
		if (!trace || !Array.isArray(trace.reached)) return { value };
		const { reached: found, hops: walked, start: from, steps: _steps, truncated: _truncated, ...other } = trace;
		start = object(from);
		rest = other;
		const why = traceCut(trace, budget, maxDepth);
		walk = cut(records(found), records(walked), String(start?.id), limit, why === "maxNodes");
		walk.withheld = why === "complete";
	}
	let { reached, hops, capped } = walk;
	const hub =
		!complete && !depthAsked && maxDepth > 1 && reached.filter((symbol) => symbol.depth === 1).length > HUB_USERS;
	if (hub) {
		capped = walk.directCapped;
		reached = reached.filter((symbol) => symbol.depth === 1);
		hops = hops.filter((hop) => hop.depth === 1);
	}
	// A hub shows only its direct users, which the graph finds before any fanout past them.
	const withheld = walk.withheld && !hub;
	const notes = [
		nodeless
			? `${fromHandle(String(request.from))?.name} has no graph node, so its direct users come from its references`
			: "",
		capped ? `stopped at ${plural(limit, "symbol")}; trace from a narrower symbol` : "",
		hub
			? `only direct users are shown, since there are more than ${HUB_USERS}; pass maxDepth to follow their users too`
			: "",
		withheld && !capped
			? "the graph left out a dispatch to 12 or more implementations; pass complete to follow it"
			: "",
		walk.skipped ? `${plural(walk.skipped, "symbol")} skipped` : "",
	].filter(Boolean);
	return {
		value: { result: { ...rest, type: "trace", start, direction: "reverse", hops, reached, truncated: capped } },
		...(notes.length ? { note: notes.join("; ") } : {}),
		...(capped ? {} : hub ? { raise: "trace.maxDepth" } : withheld ? { raise: "trace.complete" } : {}),
	};
}

interface Walk {
	reached: Record<string, unknown>[];
	hops: Record<string, unknown>[];
	/** Symbols were left out, by the limit or the graph's budget. */
	capped: boolean;
	/** Direct users were left out. */
	directCapped: boolean;
	/** The graph withheld a dispatch fanout of 12 or more implementations. */
	withheld: boolean;
	/** Direct users whose own users couldn't be traced, or references that couldn't be read. */
	skipped: number;
}

// Keep the nearest symbols up to the limit, as the graph's own walk would, and the hops between them. A walk the
// graph's budget cut found every direct user unless they alone filled it, since it finds them first.
function cut(
	found: Record<string, unknown>[],
	walked: Record<string, unknown>[],
	start: string,
	limit: number,
	budgetCut: boolean,
): Walk {
	const reached = found.toSorted((a, b) => Number(a.depth) - Number(b.depth)).slice(0, limit);
	const ids = new Set([start, ...reached.map((symbol) => String(symbol.id))]);
	const direct = found.filter((symbol) => symbol.depth === 1).length;
	return {
		reached,
		hops: walked.filter((hop) => ids.has(String(hop.from)) && ids.has(String(hop.to))),
		capped: budgetCut || found.length > limit,
		directCapped: direct > limit || (budgetCut && direct >= budgetFor(limit)),
		withheld: false,
		skipped: 0,
	};
}

// A symbol the graph has no node for, such as an enum's member, gets its direct users from its references,
// as the graph's trace would list them: what each sits in. Their own users come from graph traces, which keep the
// request's options, such as its focus.
async function fromReferences(
	context: QueryContext,
	request: Record<string, unknown>,
	paths: ReturnType<typeof createPaths>,
	bounds: { limit: number; maxDepth: number; depthAsked: boolean; complete: boolean },
): Promise<Walk> {
	const { limit, maxDepth, depthAsked, complete } = bounds;
	const start = String(request.from);
	const depth = new Map<string, number>();
	const symbols = new Map<string, Record<string, unknown>>();
	const hops = new Map<string, Record<string, unknown>>();
	const lines = new Map<string, string[] | undefined>();
	let skipped = 0;
	let refs: Awaited<ReturnType<NonNullable<QueryContext["references"]>["query"]>>;
	try {
		refs = await context.references!.query({ type: "references", symbol: start }, paths);
	} catch {
		return { ...cut([], [], start, limit, false), skipped: 1 };
	}
	// The graph's trace follows every kind of use, type references and JSX included, so this does too.
	for (const node of refs.nodes) {
		if (!node.in) continue;
		const caller = paths.inputToProjectHandle(node.in.handle);
		const file = paths.inputToProjectPath(node.file);
		if (!lines.has(file))
			lines.set(
				file,
				await readFile(resolve(paths.project, file), "utf8").then(
					(text) => text.split(/\r\n|\n|\r/),
					() => undefined,
				),
			);
		const content = lines.get(file);
		if (!content) {
			skipped++;
			continue;
		}
		const byte = (column: number) =>
			Buffer.byteLength((content[node.line! - 1] ?? "").slice(0, column - 1), "utf8") + 1;
		depth.set(caller, 1);
		if (!symbols.has(caller)) symbols.set(caller, { ...(rawSymbol(caller) ?? { id: caller }), depth: 1 });
		const hop = {
			from: caller,
			to: start,
			// A member or a local is read and written, unless it's called or named in a type.
			kind: !node.call
				? node.inType
					? "type_ref"
					: "accesses"
				: node.call.line === node.line && node.text?.slice(node.call.col - 1).startsWith("new ")
					? "instantiates"
					: "calls",
			depth: 1,
			evidence: {
				file,
				startLine: node.line,
				startCol: byte(node.col!),
				endLine: node.line,
				endCol: byte(node.endCol!),
			},
		};
		hops.set(hopKey(hop), hop);
	}
	const callers = [...symbols.keys()];
	const budget = budgetFor(limit);
	let budgetCut = false;
	let withheld = false;
	if (maxDepth > 1 && (complete || depthAsked || callers.length <= HUB_USERS)) {
		const {
			type: _type,
			from: _from,
			direction: _direction,
			maxNodes: _maxNodes,
			maxDepth: _maxDepth,
			complete: _complete,
			...options
		} = request;
		const traces = await eachLimited(callers, SUB_TRACES, (caller) =>
			context.client
				.query({
					...options,
					type: "trace",
					from: caller,
					direction: "reverse",
					...(complete ? { complete: true } : { maxDepth: maxDepth - 1, maxNodes: budget }),
				})
				.then(({ value, isError }) => (isError ? undefined : traceOf(value)))
				.catch(() => undefined),
		);
		for (const trace of traces) {
			if (!trace) {
				skipped++;
				continue;
			}
			const why = complete ? undefined : traceCut(trace, budget, maxDepth - 1);
			if (why === "maxNodes") budgetCut = true;
			if (why === "complete") withheld = true;
			for (const symbol of records(trace.reached)) {
				const level = Number(symbol.depth) + 1;
				if (typeof symbol.id !== "string" || symbol.id === start || (depth.get(symbol.id) ?? Infinity) <= level)
					continue;
				depth.set(symbol.id, level);
				symbols.set(symbol.id, { ...symbol, depth: level });
			}
			for (const hop of records(trace.hops)) hops.set(hopKey(hop), hop);
		}
	}
	// A hop is one level past the symbol it reaches, as in the graph's walk.
	const walked = [...hops.values()].map((hop) => ({ ...hop, depth: (depth.get(String(hop.to)) ?? 0) + 1 }));
	// Its direct users come from references, which the graph's budget can't cut.
	return {
		...cut([...symbols.values()], walked, start, limit, budgetCut),
		directCapped: callers.length > limit,
		withheld,
		skipped,
	};
}

/** Run one request or a batch and return exactly what the CLI prints. */
export async function runQuery(
	context: QueryContext,
	requests: Record<string, unknown>[],
	options: QueryOptions,
): Promise<string> {
	const mode = options.mode ?? (options.json ? "json" : "text");
	const paths = context.root ? createPaths(context.root) : undefined;
	const references = context.references;
	const reexport =
		references && paths
			? async (file: string, name: string) => {
					const declared = await references.reexport(paths.inputToProjectPath(file), name);
					if (!declared) return undefined;
					return "namespace" in declared
						? { namespace: paths.toRepositoryPath(declared.namespace) }
						: { file: paths.toRepositoryPath(declared.file), name: declared.name };
				}
			: undefined;
	const resolved = await resolveNamesSettled(context.client, requests, paths, reexport, (file) =>
		context.ranges.declarations(file),
	);
	const results = await Promise.all(
		resolved.map(async (item) => {
			if ("error" in item) return { error: item.error };
			try {
				if (item.request.type === "references") {
					if (!context.references || !paths) throw new Error("references require a project server");
					return { value: await context.references.query(item.request, paths), local: true as const };
				}
				if (item.request.type === "trace") {
					const refusal = await traceRefusal(context.ranges, item.request);
					if (refusal) throw new Error(refusal);
					// Raw output is the graph's own answer.
					const traced = mode === "raw" ? undefined : await reverseTrace(context, item.request, paths);
					if (traced) return traced;
				}
				const { value } = await context.client.query(item.request);
				return item.request.type === "details" ? await withUnindexed(context.ranges, value) : { value };
			} catch (error) {
				return { error: error instanceof Error ? error.message : String(error), cause: error };
			}
		}),
	);
	if (requests.length === 1 && "error" in results[0]) throw results[0].cause ?? new Error(results[0].error);
	if (mode === "raw")
		return results
			.map((result) =>
				JSON.stringify(
					"error" in result ? { type: requests[results.indexOf(result)].type, error: result.error } : result.value,
				),
			)
			.join("\n");
	const models = await Promise.all(
		results.map((result, index) =>
			"error" in result
				? ({ type: String(requests[index].type), error: result.error, tsconfig: context.tsconfig } as GraphResult)
				: "local" in result
					? (result.value as GraphResult)
					: normalizeResult(requests[index], result.value, context.ranges, paths),
		),
	);
	for (const [index, result] of results.entries()) {
		if ("note" in result && result.note) models[index].note = result.note;
		if ("raise" in result && typeof result.raise === "string") models[index].raise = result.raise;
	}
	for (const model of models) if (context.tsconfig) model.tsconfig = context.tsconfig;
	for (const model of models) model.nestedProjects = context.nestedProjects ?? [];
	const filtered = options.in
		? models.map((model) => {
				if (model.error) return model;
				const directory = paths
					? paths.inputToRepositoryPath(options.in!)
					: context.root && isAbsolute(options.in!)
						? relative(context.root, options.in!)
						: options.in!;
				return filterIn(
					model,
					directory === ".." || directory.startsWith(`..${sep}`) || isAbsolute(directory) ? "\0" : directory,
				);
			})
		: models;
	if (mode === "json") return JSON.stringify(filtered);
	const formatted = filtered.map((result) =>
		result.error ? `error: ${result.error}` : renderText(result, { color: options.color === true }),
	);
	const output =
		formatted.length === 1
			? formatted[0]
			: formatted.map((value, index) => `=== ${index + 1}: ${models[index].type} ===\n${value}`).join("\n\n");
	return context.nestedProjects?.length
		? `${output}\n\nnote: graphed ${context.tsconfig ?? "tsconfig.json"} (${context.projectFileCount ?? 0} ${context.projectFileCount === 1 ? "file" : "files"}); nested projects: ${context.nestedProjects.slice(0, 5).join(", ")}. Run from one of those for its code.`
		: output;
}

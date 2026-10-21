// Run one working-tree diff with one parser and the existing graph daemon.
import { programFiles, type Project } from "../project.ts";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createPaths } from "../paths.ts";
import { createDeclarationParser } from "../ranges.ts";
import { matchChanges } from "./changes.ts";
import { readGitChanges } from "./git.ts";
import { collectImpact, importPaths, importsFile } from "./impact.ts";
import { formatDiffNotes, renderDiffText, type DiffResult } from "./render.ts";

const realOrSelf = (file: string) => {
	try {
		return realpathSync(file);
	} catch {
		return file;
	}
};

/** Compare the chosen commit with disk and return complete text or JSON output. */
export async function runDiff(
	project: Project,
	base: string | undefined,
	options: { json: boolean; color: boolean },
): Promise<string> {
	const git = await readGitChanges(project.root, base);
	const paths = createPaths(project.root, git.repository);
	const parser = createDeclarationParser();
	try {
		// Every file the compiler loads for the project, not only its config's roots: an imported file is in it too, a
		// sibling package's included.
		const files = await programFiles(project);
		// Git names files by their real paths; the program may name them through a symlink, as /tmp on macOS.
		const real = new Set([...files].map((file) => realOrSelf(file)));
		// A deleted file isn't in the program any more; it was if something the program holds still imports it, by a
		// relative path or through the config's paths.
		const config = await importPaths(project);
		const root = realOrSelf(project.root);
		const sources = await Promise.all(
			[...files].map(async (file) => ({
				importer: relative(root, realOrSelf(file)).split(sep).join("/"),
				text: await readFile(file, "utf8").catch(() => ""),
			})),
		);
		const importedBefore = new Map<string, boolean>();
		const importedFile = (absolute: string) => {
			const target = relative(root, absolute).split(sep).join("/");
			let found = importedBefore.get(target);
			if (found === undefined) {
				found = sources.some(({ importer, text }) => importsFile(text, importer, target, config));
				importedBefore.set(target, found);
			}
			return found;
		};
		const matched = await matchChanges(
			git,
			project.root,
			parser,
			(absolute) => real.has(realOrSelf(absolute)) || importedFile(absolute),
		);
		const inProject = ({ node, file }: (typeof matched.changed)[number]) =>
			(files.has(resolve(project.root, node.file)) && !/\.d\.[cm]?ts$/.test(node.file)) ||
			// A deleted file isn't on disk to check against the config, so count it if it was inside the project, or
			// something the program holds still imports it, as a sibling package's file.
			(file.status === "deleted" &&
				!isAbsolute(node.file) &&
				!node.file.split("/").includes("node_modules") &&
				(!node.file.startsWith("../") || importedFile(resolve(root, node.file))));
		const outside = matched.changed.filter((change) => !inProject(change));
		matched.changed = matched.changed.filter(inProject);
		if (outside.length)
			matched.notes.push(
				`${outside.length} changed declarations outside the graphed project (${project.tsconfig.slice(project.root.length + 1).replaceAll("\\", "/")})`,
			);
		const impact = matched.changed.length ? await collectImpact(git, project, parser, matched) : undefined;
		const result: DiffResult = {
			base: git.base,
			baseRef: git.baseRef,
			project: git.project,
			tsconfig: project.tsconfig.slice(project.root.length + 1).replaceAll("\\", "/"),
			...(impact && impact.totalChanged > impact.changed.length ? { totalChanged: impact.totalChanged } : {}),
			changed: (impact?.changed ?? []).map(({ node }) => ({
				...node,
				file: paths.toRepositoryPath(node.file),
				handle: paths.toRepositoryHandle(node.handle),
			})),
			callers: (impact?.callers ?? []).map((node) => ({
				...node,
				file: paths.toRepositoryPath(node.file),
				handle: paths.toRepositoryHandle(node.handle),
			})),
			chains: (impact?.chains ?? []).map((chain) => ({
				...chain,
				handles: chain.handles.map(paths.toRepositoryHandle),
				hops: chain.hops.map((hop) => ({
					...hop,
					from: paths.toRepositoryHandle(hop.from),
					to: paths.toRepositoryHandle(hop.to),
				})),
			})),
			tests: (impact?.tests ?? []).map((node) => ({
				...node,
				file: paths.toRepositoryPath(node.file),
				handle: paths.toRepositoryHandle(node.handle),
			})),
			notes: [...(git.baseNote ? [git.baseNote] : []), ...(impact?.notes ?? matched.notes)],
		};
		return options.json
			? JSON.stringify({ ...result, notes: formatDiffNotes(result.notes) })
			: renderDiffText(
					result,
					new Map([...matched.files].map(([file, info]) => [paths.toRepositoryPath(file), info])),
					options.color,
				);
	} finally {
		await parser.close();
	}
}

// Name a file's declarations in one walk: each its full qualified name, and the graph's name for the ones it has a
// node for, so ranges, references and containers agree with the graph and with each other.
import {
	SyntaxKind,
	isArrowFunction,
	isClassDeclaration,
	isClassExpression,
	isConstructorDeclaration,
	isEnumDeclaration,
	isExportAssignment,
	isExportDeclaration,
	isFunctionDeclaration,
	isFunctionExpression,
	isGetAccessorDeclaration,
	isIdentifier,
	isInterfaceDeclaration,
	isMethodDeclaration,
	isMethodSignatureDeclaration,
	isModuleBlock,
	isModuleDeclaration,
	isNamedExports,
	isObjectLiteralExpression,
	isParameterDeclaration,
	isPropertyAssignment,
	isPropertyDeclaration,
	isPropertySignatureDeclaration,
	isSetAccessorDeclaration,
	isShorthandPropertyAssignment,
	isSourceFile,
	isTypeAliasDeclaration,
	isVariableDeclaration,
	isVariableStatement,
	type Node,
	type SourceFile,
} from "typescript/unstable/ast";

export type DeclarationKind = "function" | "class" | "method" | "property" | "variable" | "interface" | "type" | "enum";

export type Unindexed = "local" | "member";

export interface Declared {
	node: Node;
	/** Qualified by everything it's declared in: `Lit.onChange`, `NS.helper`, `render.format`. */
	name: string;
	kind: DeclarationKind;
	/** The graph's name for it: `default` for a default-exported function or class. */
	graphName?: string;
	/**
	 * Why the graph has no node of its own for it: it's a local holding no function, or a member the graph keeps on
	 * its owner: an enum's, or a literal's or class expression's that nothing with a node holds.
	 */
	unindexed?: Unindexed;
	/** Declared inside a function. */
	local: boolean;
	/** A top-level declaration its module exports, by an `export` modifier or its own export list. */
	exported: boolean;
	/** The node whose lines are the declaration's: a variable's whole statement, so its keyword and docs come too. */
	extent: Node;
}

export interface DeclarationIndex {
	declarations: Declared[];
	/** The declaration `node` is, if it is one. */
	of(node: Node): Declared | undefined;
}

/** Use the graph's kind for a declaration: it calls a property a variable. */
export function graphKind(kind: DeclarationKind): DeclarationKind {
	return kind === "property" ? "variable" : kind;
}

export function hasModifier(node: Node, kind: SyntaxKind): boolean {
	return (
		"modifiers" in node &&
		Array.isArray(node.modifiers) &&
		node.modifiers.some((modifier: Node) => modifier.kind === kind)
	);
}

/** Names a module exports through its own `export { a, b as c }` or `export default a`. */
export function listedExports(sourceFile: SourceFile): Set<string> {
	const listed = new Set<string>();
	for (const statement of sourceFile.statements) {
		if (
			isExportDeclaration(statement) &&
			!statement.moduleSpecifier &&
			statement.exportClause &&
			isNamedExports(statement.exportClause)
		)
			for (const element of statement.exportClause.elements) listed.add((element.propertyName ?? element.name).text);
		else if (isExportAssignment(statement) && isIdentifier(statement.expression)) listed.add(statement.expression.text);
	}
	return listed;
}

/** A member of an object literal, which is a reference to whatever its type declares as much as a declaration. */
export function inObjectLiteral(node: Node): boolean {
	return !!node.parent && isObjectLiteralExpression(node.parent);
}

// What a node's children are members of. A class's or an interface's members are nodes when it is one, and so are a
// type or object literal's or a class expression's when what holds it is; an enum's are named but never nodes, and
// a literal nothing holds names none.
type Members = "nodes" | "named";

interface Context {
	names: string[];
	/** The graph's names for the same scopes, which call a default-exported function or class `default`. */
	graphNames: string[];
	local: boolean;
	/** The nearest function is one the graph has a node for, so a local holding a function gets one too. */
	functionNode: boolean;
	members?: Members;
	/** The enclosing class's names and graph names, which own its constructor's parameter properties. */
	className?: string[];
	classGraphName?: string[];
	/** The enclosing class has a node, so its constructor's parameter properties do too. */
	classNode?: boolean;
	/** A type or object literal here belongs to the declaration above it: an alias, a variable, or a named member. */
	held: boolean;
	/** A function here is what a variable with a node holds. */
	heldByNode: boolean;
	/** A literal here is what a declaration with a node holds, so its members get nodes too. */
	literalNodes: boolean;
}

const wrappers = new Set([
	SyntaxKind.IntersectionType,
	SyntaxKind.UnionType,
	SyntaxKind.ParenthesizedType,
	SyntaxKind.ParenthesizedExpression,
	SyntaxKind.AsExpression,
	SyntaxKind.SatisfiesExpression,
]);

const parameterProperty = [
	SyntaxKind.PublicKeyword,
	SyntaxKind.PrivateKeyword,
	SyntaxKind.ProtectedKeyword,
	SyntaxKind.ReadonlyKeyword,
	SyntaxKind.OverrideKeyword,
];

const isFunctionLike = (node: Node) =>
	isFunctionDeclaration(node) ||
	isMethodDeclaration(node) ||
	isConstructorDeclaration(node) ||
	isGetAccessorDeclaration(node) ||
	isSetAccessorDeclaration(node) ||
	isArrowFunction(node) ||
	isFunctionExpression(node);

const holdsFunction = (node: Node) =>
	isVariableDeclaration(node) &&
	!!node.initializer &&
	(isArrowFunction(node.initializer) || isFunctionExpression(node.initializer));

const extentOf = (node: Node) =>
	isVariableDeclaration(node) && node.parent?.parent && isVariableStatement(node.parent.parent)
		? node.parent.parent
		: node;

// A statement of a file, a namespace or `declare module`.
const atTop = (node: Node) => {
	const parent = extentOf(node).parent;
	return !!parent && (isSourceFile(parent) || isModuleBlock(parent));
};

// A namespace adds its name to what it contains; `declare global` and `declare module "x"` add nothing.
const namespaceName = (node: Node) =>
	isModuleDeclaration(node) &&
	isIdentifier(node.name) &&
	(node.keyword === SyntaxKind.NamespaceKeyword || node.name.text !== "global")
		? node.name.text
		: undefined;

/** A function or class the file exports as its default, which the graph names `default` whatever its own name. */
function defaultExport(node: Node): boolean {
	return (
		(isFunctionDeclaration(node) || isClassDeclaration(node)) &&
		hasModifier(node, SyntaxKind.DefaultKeyword) &&
		isSourceFile(node.parent)
	);
}

// A declaration's own name and kind, with whether the graph has a node for it.
function declare(
	node: Node,
	context: Context,
	source: SourceFile,
): { name: string; kind: DeclarationKind; node: boolean } | undefined {
	const statement = (name: string | undefined, kind: DeclarationKind) =>
		name === undefined
			? undefined
			: {
					name,
					kind,
					// A local is a node when it holds a function and the function it's in has one.
					node: atTop(node) || ((isFunctionDeclaration(node) || holdsFunction(node)) && context.functionNode),
				};
	if (isFunctionDeclaration(node) || isClassDeclaration(node))
		return statement(
			node.name?.text ?? (hasModifier(node, SyntaxKind.DefaultKeyword) ? "default" : undefined),
			isFunctionDeclaration(node) ? "function" : "class",
		);
	if (isInterfaceDeclaration(node)) return statement(node.name.text, "interface");
	if (isTypeAliasDeclaration(node)) return statement(node.name.text, "type");
	if (isEnumDeclaration(node)) return statement(node.name.text, "enum");
	if (isVariableDeclaration(node)) return statement(isIdentifier(node.name) ? node.name.text : undefined, "variable");
	if (
		isParameterDeclaration(node) &&
		isConstructorDeclaration(node.parent) &&
		isIdentifier(node.name) &&
		parameterProperty.some((kind) => hasModifier(node, kind))
	)
		return { name: node.name.text, kind: "property", node: !!context.classNode };
	if (!context.members) return undefined;
	const member = (name: string, kind: DeclarationKind) => ({ name, kind, node: context.members === "nodes" });
	if (isConstructorDeclaration(node)) return member("__constructor", "method");
	if (
		isMethodDeclaration(node) ||
		isMethodSignatureDeclaration(node) ||
		isGetAccessorDeclaration(node) ||
		isSetAccessorDeclaration(node)
	)
		return member(node.name.getText(source), "method");
	if (
		isPropertyDeclaration(node) ||
		isPropertySignatureDeclaration(node) ||
		isPropertyAssignment(node) ||
		isShorthandPropertyAssignment(node) ||
		node.kind === SyntaxKind.EnumMember
	)
		return member((node as unknown as { name: Node }).name.getText(source), "property");
	return undefined;
}

/** Name every declaration in a file, in one walk. */
export function indexDeclarations(source: SourceFile): DeclarationIndex {
	const declarations: Declared[] = [];
	const listed = listedExports(source);
	const visit = (node: Node, context: Context): void => {
		const own = declare(node, context, source);
		if (own) {
			const extent = extentOf(node);
			// A parameter property is the class's, not its constructor's.
			const property = isParameterDeclaration(node);
			const local = context.local && !property;
			declarations.push({
				node,
				name: [...(property ? (context.className ?? context.names) : context.names), own.name].join("."),
				kind: own.kind,
				...(own.node
					? {
							graphName: [
								...(property ? (context.classGraphName ?? context.graphNames) : context.graphNames),
								defaultExport(node) ? "default" : own.name,
							].join("."),
						}
					: { unindexed: local ? ("local" as const) : ("member" as const) }),
				local,
				exported:
					!!extent.parent &&
					isSourceFile(extent.parent) &&
					(hasModifier(extent, SyntaxKind.ExportKeyword) || listed.has(own.name)),
				extent,
			});
		}
		const segment = own?.name ?? namespaceName(node);
		const names = segment === undefined ? context.names : [...context.names, segment];
		const graphNames =
			segment === undefined ? context.graphNames : [...context.graphNames, defaultExport(node) ? "default" : segment];
		const functionLike = isFunctionLike(node);
		const literal = node.kind === SyntaxKind.TypeLiteral || isObjectLiteralExpression(node) || isClassExpression(node);
		const members: Members | undefined =
			isClassDeclaration(node) || isInterfaceDeclaration(node)
				? own?.node
					? "nodes"
					: "named"
				: isEnumDeclaration(node) || (literal && context.held)
					? literal && context.literalNodes
						? "nodes"
						: "named"
					: undefined;
		const holds =
			isTypeAliasDeclaration(node) ||
			isVariableDeclaration(node) ||
			((isPropertySignatureDeclaration(node) || isPropertyAssignment(node)) && !!own);
		node.forEachChild((child) =>
			visit(child, {
				names,
				graphNames,
				local: context.local || functionLike,
				functionNode: !functionLike
					? context.functionNode
					: isArrowFunction(node) || isFunctionExpression(node)
						? context.heldByNode
						: !!own?.node,
				members,
				className: isClassDeclaration(node) || isClassExpression(node) ? names : context.className,
				classGraphName: isClassDeclaration(node) || isClassExpression(node) ? graphNames : context.classGraphName,
				classNode: isClassDeclaration(node)
					? !!own?.node
					: isClassExpression(node)
						? members === "nodes"
						: context.classNode,
				held: holds || (context.held && wrappers.has(node.kind)),
				heldByNode: !!own?.node && isVariableDeclaration(node) && child === node.initializer,
				literalNodes:
					(!!own?.node &&
						(((isVariableDeclaration(node) || isPropertyAssignment(node)) && child === node.initializer) ||
							((isTypeAliasDeclaration(node) || isPropertySignatureDeclaration(node) || isVariableDeclaration(node)) &&
								child === node.type))) ||
					(context.literalNodes && wrappers.has(node.kind)),
			}),
		);
	};
	const root: Context = {
		names: [],
		graphNames: [],
		local: false,
		functionNode: false,
		held: false,
		heldByNode: false,
		literalNodes: false,
	};
	source.forEachChild((child) => visit(child, root));
	const byPlace = new Map(declarations.map((declaration) => [place(declaration.node), declaration]));
	return { declarations, of: (node) => byPlace.get(place(node)) };
}

// A node found by another walk of the same file is a different object, so match nodes by where they are.
const place = (node: Node) => `${node.pos}:${node.end}:${node.kind}`;

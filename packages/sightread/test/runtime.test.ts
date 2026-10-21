// The runtime shim reads tsconfigs as both runtimes would.
import { expect, test } from "bun:test";
import { parseJSONC } from "../src/runtime.ts";

test("JSON with comments and trailing commas parses, and strings that look like either are kept", () => {
	const text = `{
		// a line comment
		"extends": "./base.json", /* a block
		comment */
		"compilerOptions": { "paths": { "@/*": ["./src/*",], }, },
		"include": ["a//b", "c/*d*/", "e,}", "f\\"g,]"],
	}`;
	expect(parseJSONC(text)).toEqual({
		extends: "./base.json",
		compilerOptions: { paths: { "@/*": ["./src/*"] } },
		include: ["a//b", "c/*d*/", "e,}", 'f"g,]'],
	});
	expect(parseJSONC(text)).toEqual(Bun.JSONC.parse(text) as object);
	expect(() => parseJSONC("{ not json }")).toThrow();
});

// What sightread needs from its runtime that Node and Bun don't provide alike. Its server locks are in
// server/lock.ts.
import { extname } from "node:path";

/** Its own modules' extension: `.ts` when run from source, `.js` once built. */
export const scriptExtension = extname(import.meta.filename);

/** Parse JSON with comments and trailing commas, as a tsconfig may have. */
export function parseJSONC(text: string): unknown {
	let json = "";
	// A byte-order mark, as some editors save, isn't JSON.
	for (let index = text.startsWith("\uFEFF") ? 1 : 0; index < text.length; index++) {
		const character = text[index];
		const next = text[index + 1];
		if (character === '"') {
			const start = index;
			for (index++; index < text.length && text[index] !== '"'; index++) if (text[index] === "\\") index++;
			json += text.slice(start, index + 1);
		} else if (character === "/" && next === "/") {
			while (index < text.length && text[index] !== "\n") index++;
			json += "\n";
		} else if (character === "/" && next === "*") {
			const end = text.indexOf("*/", index + 2);
			index = end < 0 ? text.length : end + 1;
			json += " ";
		} else {
			// A comma before a closing bracket is dropped. Strings are copied whole, so one ending in a comma isn't.
			if (character === "}" || character === "]") json = json.replace(/,(\s*)$/, "$1");
			json += character;
		}
	}
	return JSON.parse(json);
}

// Whether built source loads zod: a static import, an export-from, a dynamic import(), or a require().
// Whitespace around the keywords, braces, and specifier is optional (minified output has none), and
// either quote works. The statement forms need the keyword in front of the specifier, so the text
// "from 'zod/v3'" inside a string literal, like the schema-check reasons in registry.ts, doesn't match.
const specifier = String.raw`["']zod(?:\/[^"']*)?["']`;
const statement = String.raw`\b(?:import|export)\b[^;"'\x60]*?\bfrom\s*${specifier}`;
const bare = String.raw`\bimport\s*${specifier}`;
const call = String.raw`\b(?:import|require)\s*\(\s*${specifier}`;
const zodImport = new RegExp(`${statement}|${bare}|${call}`);

export function importsZod(source) {
  return zodImport.test(source);
}

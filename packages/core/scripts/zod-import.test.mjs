import { describe, expect, it } from 'vitest';
import { importsZod } from './zod-import.mjs';

describe('importsZod', () => {
  it.each([
    ['spaced named import', 'import { z } from "zod";'],
    ['compact named import', 'import{z}from"zod";'],
    ['half-compact import', 'import {z} from"zod";'],
    ['single quotes', "import { z } from 'zod';"],
    ['default import', 'import z from "zod";'],
    ['namespace import', 'import * as z from "zod/v4";'],
    ['side-effect import', 'import "zod";'],
    ['compact side-effect import', 'import"zod/v4";'],
    ['multiline named import', 'import {\n  z,\n  ZodError\n} from\n  "zod";'],
    ['export-from', 'export { z } from "zod";'],
    ['compact export star', 'export * from"zod";'],
    ['require', 'const { z } = require("zod");'],
    ['spaced require', "const zod = require( 'zod/v4' );"],
    ['dynamic import', 'const zod = await import("zod");'],
    ['spaced dynamic import', "const zod = await import ( 'zod' );"],
    ['import after other statements', 'var a = 1;\nimport{z}from"zod";'],
  ])('finds %s', (_label, source) => {
    expect(importsZod(source)).toBe(true);
  });

  it.each([
    // The reasons and message from registry.ts as they appear in dist/index.js and dist/index.cjs.
    ['Zod 3 reason', `return "it is a Zod 3 schema (from zod 3, or from 'zod/v3')";`],
    ['Zod 4 mini reason', `if (zod4) return "it is a Zod 4 schema without a toJSONSchema method (from 'zod/mini', or from zod before 4.2)";`],
    ['not-a-schema reason', `return "it is not a Zod schema";`],
    [
      'the message',
      "`The schema for ${name} can't be used: ${problem}. ironbird needs zod 4.2 or later, with schemas from 'zod' or 'zod/v4'; see docs/migrating-from-zod-3.md`,",
    ],
    ['a module that mentions zod in a comment', '// schemas come from zod\nexport { defineCommands };'],
    ['an import of another package', 'import { x } from "other";'],
    ['an identifier ending in import', 'const reimport = "zod"; exports.a = 1;'],
  ])('ignores %s', (_label, source) => {
    expect(importsZod(source)).toBe(false);
  });
});

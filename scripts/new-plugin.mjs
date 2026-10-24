#!/usr/bin/env node
// Scaffold a new pi package from templates/pi-plugin:
//   npm run new <name> [-- "One line description"]
import { cpSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const name = process.argv[2];
const descIdx = process.argv.indexOf("--") + 1;
const description = (descIdx > 1 ? process.argv[descIdx] : process.argv[3]) ?? `TODO: describe ${name}`;

if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
  console.error("Usage: npm run new <lowercase-name> [-- \"description\"]");
  process.exit(1);
}
const dest = join(root, "packages", name);
if (existsSync(dest)) {
  console.error(`packages/${name} already exists`);
  process.exit(1);
}

cpSync(join(root, "templates", "pi-plugin"), dest, { recursive: true });
renameSync(join(dest, "gitignore"), join(dest, ".gitignore"));

for (const file of ["package.json", "README.md"]) {
  const p = join(dest, file);
  writeFileSync(p, readFileSync(p, "utf8").replaceAll("__NAME__", name).replaceAll("__DESCRIPTION__", description));
}

console.log(`Created packages/${name}.
Next steps:
  1. Edit packages/${name}/src/index.ts and README.md
  2. npm install (links the workspace)
  3. npm run build && pi -e ./packages/${name}
  4. Add the command/tool names to the registry table in AGENTS.md`);

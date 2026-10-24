#!/usr/bin/env node
// Monorepo consistency checks:
//  - every package: name/version/license, README.md + CHANGELOG.md, build entry exists
//  - pi packages: "pi" manifest, "pi-package" keyword, host packages only in peerDependencies "*",
//    no runtime dependencies (none are approved yet)
//  - command and tool names registered via pi.registerCommand / registerTool are unique monorepo-wide
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HOST = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-tui", "typebox"];
let failed = false;
const fail = (msg) => { console.error(`  ✗ ${msg}`); failed = true; };
const ok = (msg) => console.log(`  ✓ ${msg}`);

const commands = new Map(); // name -> package
const tools = new Map();
const packagesDir = join(root, "packages");

for (const dir of readdirSync(packagesDir).sort()) {
  const pkgDir = join(packagesDir, dir);
  if (!statSync(pkgDir).isDirectory()) continue;
  const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
  console.log(`\n${pkg.name} (${dir})`);

  if (!pkg.version) fail("missing version");
  if (pkg.license !== "MIT") fail(`license is ${pkg.license}, expected MIT`);
  for (const f of ["README.md", "CHANGELOG.md"]) if (!existsSync(join(pkgDir, f))) fail(`missing ${f}`);

  const cfg = pkg.coedit ?? {};
  if (!cfg.entry || !existsSync(join(pkgDir, cfg.entry))) fail(`coedit.entry missing or not found: ${cfg.entry}`);

  const isPi = dir !== "coedit-gutter" && dir !== "core";
  if (isPi) {
    if (!pkg.pi || !Array.isArray(pkg.pi.extensions) || pkg.pi.extensions.length === 0) fail('pi packages need a "pi": { "extensions": [...] } manifest');
    if (!(pkg.keywords ?? []).includes("pi-package")) fail('pi packages need the "pi-package" keyword');
    for (const depType of ["dependencies", "optionalDependencies"]) {
      const deps = pkg[depType] ?? {};
      if (Object.keys(deps).length > 0) fail(`${depType} must be empty (no approved runtime deps)`);
    }
    for (const [dep, range] of Object.entries(pkg.peerDependencies ?? {})) {
      if (HOST.includes(dep) && range !== "*") fail(`host package ${dep} must use peerDependencies range "*"`);
    }
    for (const ext of pkg.pi?.extensions ?? []) {
      if (!existsSync(join(pkgDir, ext))) fail(`pi extension entry not built: ${ext} (run npm run build)`);
    }
  }
  if (dir === "coedit-gutter" && !pkg.publisher) fail("vscode extension needs a publisher");

  // Collect command/tool names from source
  const srcDir = join(pkgDir, "src");
  if (existsSync(srcDir)) {
    const walk = (d) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|js)$/.test(f)) {
          const src = readFileSync(p, "utf8");
          for (const m of src.matchAll(/registerCommand\(\s*["'`]([^"'`]+)["'`]/g)) {
            const [cmd] = m[1].split(" ");
            if (commands.has(cmd)) fail(`command "${cmd}" registered in both ${commands.get(cmd)} and ${dir}`);
            commands.set(cmd, dir);
          }
          for (const m of src.matchAll(/name:\s*["'`]([a-z][a-z0-9_]*)["'`]\s*,\s*\n\s*label:/g)) {
            if (tools.has(m[1])) fail(`tool "${m[1]}" registered in both ${tools.get(m[1])} and ${dir}`);
            tools.set(m[1], dir);
          }
        }
      }
    };
    walk(srcDir);
  }
  ok("checked");
}

console.log(`\nRegistry: ${commands.size} command(s): ${[...commands.keys()].map((c) => "/" + c).join(", ")}`);
console.log(`Registry: ${tools.size} tool(s): ${[...tools.keys()].join(", ")}`);
if (failed) {
  console.error("\ncheck-packages: FAILED");
  process.exit(1);
}
console.log("\ncheck-packages: OK");

#!/usr/bin/env node
// Shared esbuild bundler. Reads the "coedit" block of the calling package.json:
//   "coedit": { "entry": "src/index.ts", "outfile": "dist/index.js",
//               "format": "esm" | "cjs",
//               "extraEntries": [{ "entry": "src/cli.ts", "outfile": "dist/cli.js", "banner": "#!/usr/bin/env node" }] }
// Core (@coedit/core) is always bundled in; host packages stay external.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const pkgDir = process.argv[2] ?? process.cwd();
const pkg = JSON.parse(readFileSync(resolve(pkgDir, "package.json"), "utf8"));
const cfg = pkg.coedit;
if (!cfg?.entry) {
  console.error(`[build] ${pkg.name}: no "coedit.entry" in package.json`);
  process.exit(1);
}

const HOST_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-tui",
  "typebox",
];

const external = [...HOST_PACKAGES, "vscode", ...(cfg.external ?? [])];

const jobs = [
  {
    entryPoints: [resolve(pkgDir, cfg.entry)],
    outfile: resolve(pkgDir, cfg.outfile ?? "dist/index.js"),
  },
  ...(cfg.extraEntries ?? []).map((e) => ({
    entryPoints: [resolve(pkgDir, e.entry)],
    outfile: resolve(pkgDir, e.outfile),
    banner: e.banner ? { js: e.banner } : undefined,
  })),
];

for (const job of jobs) {
  await build({
    ...job,
    bundle: true,
    format: cfg.format ?? "esm",
    platform: "node",
    target: "node22",
    external,
    sourcemap: true,
    minify: false,
    legalComments: "none",
    logLevel: "info",
  });
}

// Snapshot benchmark: 10k files, cold + warm (mtime pre-filter).
// Run: npm run benchmark -w @coedit/core   (or: node test/benchmark.mjs)
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { takeSnapshot } from "../src/snapshot.ts";

const COUNT = Number(process.env.COEDIT_BENCH_FILES ?? 10_000);

const repo = mkdtempSync(join(tmpdir(), "coedit-bench-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
execFileSync("git", ["config", "user.email", "bench@example.com"], { cwd: repo });
execFileSync("git", ["config", "user.name", "bench"], { cwd: repo });

const dirs = 100;
for (let i = 0; i < COUNT; i++) {
	const d = join(repo, `pkg${i % dirs}`);
	mkdirSync(d, { recursive: true });
	writeFileSync(join(d, `file${i}.ts`), `export const v${i} = ${i};\n`);
}
execFileSync("git", ["add", "."], { cwd: repo });
execFileSync("git", ["commit", "-qm", "bench"], { cwd: repo });

function bench(label, prev) {
	const t0 = process.hrtime.bigint();
	return takeSnapshot(repo, prev).then((snap) => {
		const ms = Number(process.hrtime.bigint() - t0) / 1e6;
		console.log(`${label}: ${ms.toFixed(0)} ms for ${snap.files.size} files`);
		return { snap, ms };
	});
}

const cold = await bench("cold  (first snapshot, hashes everything)", undefined);
// touch 5% of files
for (let i = 0; i < COUNT / 20; i++) {
	writeFileSync(join(repo, `pkg${i % dirs}`, `file${i}.ts`), `export const v${i} = ${i * 2};\n`);
}
const warm = await bench("warm  (mtime pre-filter, ~5% changed)", cold.snap);

console.log(`\nResult: cold=${cold.ms.toFixed(0)}ms warm=${warm.ms.toFixed(0)}ms files=${COUNT}`);
rmSync(repo, { recursive: true, force: true });

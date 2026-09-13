#!/usr/bin/env node
// Runs every tests/*.test.mjs with node:test, one file at a time (the integration test owns a
// local server and the smoke test runs Claude Code). Works on Node 20, which has no --test globs.
//   node tools/run-tests.mjs [name-filter...]
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const filters = process.argv.slice(2);
const files = readdirSync(join(repo, 'tests'))
  .filter((f) => f.endsWith('.test.mjs') && (!filters.length || filters.some((x) => f.includes(x))))
  .sort()
  .map((f) => join('tests', f));
if (!files.length) {
  console.error('run-tests: no test files matched');
  process.exit(1);
}
const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=spec', ...files], { cwd: repo, stdio: 'inherit' });
process.exit(r.status ?? 1);

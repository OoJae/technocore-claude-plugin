#!/usr/bin/env node
// Runs `claude plugin validate --strict --json` on the marketplace root, each plugin, and each
// plugin's skills directory (frontmatter). Exit 1 if any run fails or Claude Code is missing.
// Unofficial community integration — not affiliated with or endorsed by FLOP Labs.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const TARGETS = ['.', 'plugins/technocore', 'plugins/technocore-hosted', 'plugins/technocore/skills', 'plugins/technocore-hosted/skills'];

export function validate(target) {
  const r = spawnSync('claude', ['plugin', 'validate', join(repo, target), '--strict', '--json'], { encoding: 'utf8', timeout: 120_000 });
  let report = null;
  try {
    report = JSON.parse(r.stdout);
  } catch {
    report = null;
  }
  return { target, status: r.status, error: r.error, report, stderr: r.stderr };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let bad = 0;
  for (const t of TARGETS) {
    const v = validate(t);
    const ok = v.status === 0 && v.report?.success === true;
    console.log(`claude plugin validate --strict ${t}: ${ok ? 'passed' : `FAILED (exit ${v.status}${v.error ? `, ${v.error.message}` : ''})`}`);
    if (!ok) {
      bad++;
      if (v.report) console.log(JSON.stringify(v.report, null, 2));
      else if (v.stderr) console.log(v.stderr);
    }
  }
  process.exit(bad ? 1 : 0);
}

// The real Claude Code validator: `claude plugin validate --strict` on the marketplace root, both
// plugins and their skills directories. Requires the `claude` CLI on PATH; the test fails (it is
// not skipped) when it is missing, so a green run always means the validator actually ran.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { PLUGIN, tempDir } from './harness/run.mjs';
import { TARGETS, validate } from '../tools/validate.mjs';

const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
});

describe('claude plugin validate --strict', { timeout: 300_000 }, () => {
  it('claude CLI is available', () => {
    const r = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    assert.equal(r.status, 0, 'install Claude Code (`npm i -g @anthropic-ai/claude-code`) to run the validator');
    console.log(`# ${r.stdout.trim()}`);
  });

  for (const t of TARGETS) {
    it(`passes: ${t}`, () => {
      const v = validate(t);
      assert.equal(v.status, 0, JSON.stringify(v.report ?? v.stderr, null, 2));
      assert.equal(v.report?.success, true);
      assert.equal(v.report?.strict, true);
      const warnings = [v.report?.manifest?.warnings ?? [], ...(v.report?.contents ?? []).map((c) => c.warnings)].flat();
      assert.deepEqual(warnings, []);
    });
  }

  it('negative control: the same validator rejects a broken copy', async () => {
    const d = await tempDir('tcp validate neg ');
    cleanups.push(d.cleanup);
    const copy = join(d.path, 'technocore');
    await cp(PLUGIN, copy, { recursive: true });
    const pj = join(copy, '.claude-plugin', 'plugin.json');
    const m = JSON.parse(await readFile(pj, 'utf8'));
    m.userConfig.signing_key.sensitve = true; // typo'd field
    await writeFile(pj, JSON.stringify(m));
    const hj = join(copy, 'hooks', 'hooks.json');
    const h = JSON.parse(await readFile(hj, 'utf8'));
    h.hooks.PreToolUse[0].hooks[0].type = 'shell';
    await writeFile(hj, JSON.stringify(h));
    const r = spawnSync('claude', ['plugin', 'validate', copy, '--strict'], { encoding: 'utf8', timeout: 120_000 });
    assert.equal(r.status, 1, r.stdout + r.stderr);
  });
});

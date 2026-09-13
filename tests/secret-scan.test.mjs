// The secret scanner and the pre-commit hook that runs it. Test values are generated at runtime
// so no seed-shaped literal ever exists in this file.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { REPO, tempDir } from './harness/run.mjs';
import { scanText } from '../tools/secret-scan.mjs';

const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
});

describe('secret scan', () => {
  it('flags 64-hex runs and seed-shaped base64, honours the allow-list', () => {
    const hex = randomBytes(32).toString('hex');
    assert.equal(scanText(`const seed = "${hex}";`, new Set()).length, 1);
    assert.equal(scanText(`SIGN_SEED=${hex.toUpperCase()}`, new Set()).length, 1);
    assert.equal(scanText(`sha1 ${randomBytes(20).toString('hex')} and 63 ${hex.slice(1)}`, new Set()).length, 0, '40-hex commits and shorter runs are fine');
    assert.equal(scanText(`x${hex}${hex}`, new Set()).length, 0, 'a 128-hex run is not a 64-hex string');
    assert.equal(scanText(hex, new Set([hex])).length, 0, 'allow-listed test vector');
    const b64 = Buffer.from('A1b2' + randomBytes(28).toString('hex').slice(0, 28)).toString('base64url');
    assert.equal(b64.length, 43);
    assert.equal(scanText(`TECHNOCORE_SIGNING_KEY=${b64}`, new Set()).length, 1);
  });

  it('the working tree is clean', () => {
    const r = spawnSync(process.execPath, [join(REPO, 'tools', 'secret-scan.mjs')], { cwd: REPO, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  });

  it('the pre-commit hook refuses a staged 64-hex string and does not echo it', async () => {
    const d = await tempDir('tcp precommit ');
    cleanups.push(d.cleanup);
    const repo = join(d.path, 'repo');
    await mkdir(join(repo, 'tools'), { recursive: true });
    await cp(join(REPO, 'tools', 'secret-scan.mjs'), join(repo, 'tools', 'secret-scan.mjs'));
    await cp(join(REPO, 'tools', 'secret-allowlist.txt'), join(repo, 'tools', 'secret-allowlist.txt'));
    await cp(join(REPO, '.githooks'), join(repo, '.githooks'), { recursive: true });
    const git = (...args) => spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(git('init', '-q').status, 0);
    assert.equal(git('config', 'core.hooksPath', '.githooks').status, 0);
    const hex = randomBytes(32).toString('hex');
    await writeFile(join(repo, 'leak.txt'), `seed: ${hex}\n`);
    git('add', '.');
    const refused = git('commit', '-q', '-m', 'leak');
    assert.notEqual(refused.status, 0, 'commit refused');
    assert.match(refused.stderr, /64-hex string .* is not an allow-listed test vector/);
    assert.ok(!(refused.stdout + refused.stderr).includes(hex), 'the value is never printed');
    await writeFile(join(repo, 'leak.txt'), 'nothing secret\n');
    git('add', '.');
    assert.equal(git('commit', '-q', '-m', 'clean').status, 0);
  });
});

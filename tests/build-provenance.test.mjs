// tools/build.mjs names the core commit in the bundle banners. It must be the last commit that changed
// what the bundles are built from (src/ and package.json), so a core commit that changes only docs or
// CI does not make the committed bundles stale, while any change to those inputs still does.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { after, describe, it } from 'node:test';
import { tempDir } from './harness/run.mjs';
import { CORE_INPUTS, coreProvenance } from '../tools/build.mjs';

const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
});

const gitIn = (cwd) => (...args) => {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

describe('build: core provenance', () => {
  it('names the last commit that changed src/ or package.json, marks uncommitted input changes, refuses a shallow clone', async () => {
    const d = await tempDir('tcp provenance ');
    cleanups.push(d.cleanup);
    const core = join(d.path, 'core checkout');
    await mkdir(join(core, 'src', 'cli'), { recursive: true });
    const git = gitIn(core);
    git('init', '-q');
    await writeFile(join(core, 'package.json'), '{"name":"technocore-watch-core","version":"0.1.0"}\n');
    await writeFile(join(core, 'src', 'cli', 'main.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('commit', '-q', '-m', 'src');
    const srcCommit = git('rev-parse', 'HEAD');
    assert.deepEqual(CORE_INPUTS, ['src', 'package.json']);
    assert.deepEqual(coreProvenance(core), { name: 'technocore-watch-core', version: '0.1.0', commit: srcCommit });

    // Docs-only commit: HEAD moves, the provenance does not.
    await writeFile(join(core, 'README.md'), 'docs\n');
    git('add', '.');
    git('commit', '-q', '-m', 'docs');
    assert.notEqual(git('rev-parse', 'HEAD'), srcCommit);
    assert.equal(coreProvenance(core).commit, srcCommit);

    // A package.json commit moves it.
    await writeFile(join(core, 'package.json'), '{"name":"technocore-watch-core","version":"0.1.1"}\n');
    git('add', '.');
    git('commit', '-q', '-m', 'version');
    const pkgCommit = git('rev-parse', 'HEAD');
    assert.deepEqual(coreProvenance(core), { name: 'technocore-watch-core', version: '0.1.1', commit: pkgCommit });

    // Uncommitted src change: marked dirty. An untracked or edited file outside the inputs is not.
    await writeFile(join(core, 'README.md'), 'more docs\n');
    assert.equal(coreProvenance(core).commit, pkgCommit);
    await writeFile(join(core, 'src', 'cli', 'main.ts'), 'export const a = 2;\n');
    assert.equal(coreProvenance(core).commit, `${pkgCommit}+dirty`);
    git('checkout', '--', 'src');

    // Shallow clone: its oldest commit would look like it changed every file, so the build refuses.
    const shallow = join(d.path, 'shallow clone');
    gitIn(d.path)('clone', '-q', '--depth', '1', pathToFileURL(core).href, shallow);
    assert.equal(gitIn(shallow)('rev-parse', '--is-shallow-repository'), 'true');
    assert.throws(() => coreProvenance(shallow), /shallow clone; fetch its full history/);
  });
});

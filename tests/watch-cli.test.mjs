// The shipped technocore-watch wrapper (bin/technocore-watch -> scripts/technocore-watch.mjs):
// plugin defaults for origin and scope, the `start` command's argument handling, and that the
// bundled core CLI runs exactly once per invocation. No network: only offline/local commands.
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { cleanEnv, PLUGIN, runProcess, tempDir } from './harness/run.mjs';

const BIN = join(PLUGIN, 'bin', 'technocore-watch');
const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
});
async function data(config) {
  const d = await tempDir('tcp watch cli ');
  cleanups.push(d.cleanup);
  if (config) {
    await mkdir(join(d.path, 'hooks-v1'), { recursive: true });
    await writeFile(join(d.path, 'hooks-v1', 'plugin-config.json'), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return d.path;
}
const tw = (args, env = {}) => runProcess(BIN, args, { env: cleanEnv(env) });
const statusLine = (origin, n = 0) => `scope "${origin}" origin "${origin}" subscriptions ${n} unread 0 errors 0\n`;

async function scopeOrigins(d) {
  const out = [];
  for (const n of await readdir(join(d, 'v1')).catch(() => [])) {
    if (!/^[0-9a-f]{16}$/.test(n)) continue;
    const s = JSON.parse(await readFile(join(d, 'v1', n, 'state.json'), 'utf8'));
    out.push([s.scopeKey, s.origin, Object.keys(s.subscriptions)]);
  }
  return out.sort();
}

describe('technocore-watch wrapper', () => {
  it('defaults: production origin without config; plugin origin with config; flags and env win', async () => {
    const bare = await data();
    const r1 = await tw(['status', '--data', bare]);
    assert.equal(r1.code, 0, r1.stderr);
    assert.equal(r1.stdout, statusLine('https://technocore.chat'), 'core CLI ran exactly once');

    const cfg = await data({ v: 1, origin: 'http://127.0.0.1:1/', watchRooms: ['lobby'] });
    assert.equal((await tw(['status', '--data', cfg])).stdout, statusLine('http://127.0.0.1:1'));
    assert.equal((await tw(['status', '--data', cfg, '--origin', 'http://127.0.0.1:2'])).stdout, statusLine('http://127.0.0.1:2'));
    assert.equal((await tw(['status', '--data', cfg], { TECHNOCORE_URL: 'http://127.0.0.1:3' })).stdout, statusLine('http://127.0.0.1:3'));
    assert.equal((await tw(['status', '--data', cfg, '--scope', 'mine'])).stdout, 'scope "mine" origin "http://127.0.0.1:1" subscriptions 0 unread 0 errors 0\n');
    assert.equal((await tw(['status', `--data=${cfg}`])).stdout, statusLine('http://127.0.0.1:1'), '--data=value form');
    assert.equal((await tw(['status'], { TECHNOCORE_WATCH_DATA: cfg })).stdout, statusLine('http://127.0.0.1:1'), '$TECHNOCORE_WATCH_DATA');

  });

  it('an invalid origin option or an unreadable config refuses instead of falling back to production', async () => {
    const invalid = { v: 1, origin: null, error: 'invalid-origin', watchRooms: ['p-7f3k2secretroom'] };
    const broken = ['{"v":1,"origin":"javascript:alert(1)"}', '{"v":1,"origin":"localhost:8080","watchRooms":["lobby"]}', 'not json', JSON.stringify({ v: 2, origin: 'http://127.0.0.1:9' }), '[]', 'x'.repeat(20000)];
    for (const cfg of [invalid, ...broken]) {
      const label = (typeof cfg === 'string' ? cfg : JSON.stringify(cfg)).slice(0, 40);
      const d = await data(cfg);
      // Kept hermetic even if the refusal regressed: no command here would make a request (start only
      // subscribes watch_rooms, and the start run below uses a config without rooms; run and monitor
      // have no subscriptions to poll; subscribe is --offline).
      for (const args of [['status'], ['subscribe', 'p-7f3k2secretroom', '--offline'], ['unsubscribe', 'lobby'], ['inbox'], ['monitor'], ['run']]) {
        const r = await tw([...args, '--data', d]);
        assert.equal(r.code, 2, `${args[0]} with ${label}: exit 2 (${r.stderr})`);
        assert.equal(r.stdout, '', `${args[0]} with ${label}: no output`);
        assert.match(r.stderr, /Refusing to fall back to https:\/\/technocore\.chat/, `${args[0]} with ${label}`);
        assert.match(r.stderr, cfg === invalid || label.includes('localhost') ? /origin option is not a usable http\(s\) URL|unreadable or invalid/ : /unreadable or invalid/);
        assert.ok(!r.stderr.includes('p-7f3k2secretroom'), 'room names are not echoed');
      }
      assert.deepEqual(await scopeOrigins(d), [], `${label}: no scope was created, nothing subscribed`);
      // an explicit origin is still honoured
      assert.equal((await tw(['status', '--data', d, '--origin', 'http://127.0.0.1:7'])).stdout, statusLine('http://127.0.0.1:7'));
      assert.equal((await tw(['status', '--data', d], { TECHNOCORE_URL: 'http://127.0.0.1:8' })).stdout, statusLine('http://127.0.0.1:8'));
    }
    for (const cfg of [{ ...invalid, watchRooms: [] }, 'not json']) {
      const d = await data(cfg);
      const inv = await tw(['start', '--data', d]);
      assert.equal(inv.code, 2);
      assert.equal(inv.stdout, '');
      assert.match(inv.stderr, typeof cfg === 'string' ? /unreadable or invalid/ : /the technocore plugin's origin option is not a usable http\(s\) URL/);
      assert.deepEqual(await scopeOrigins(d), [], 'start subscribed nothing and created no scope');
    }
    // no config file at all (SessionStart has not run): the documented default still applies
    assert.equal((await tw(['status', '--data', await data()])).stdout, statusLine('https://technocore.chat'));
  });

  it('subscribe --offline records the plugin origin as the scope; changing origin uses a new scope', async () => {
    const d = await data({ v: 1, origin: 'http://127.0.0.1:4', watchRooms: [] });
    const s = await tw(['subscribe', 'lobby', '--offline', '--data', d]);
    assert.equal(s.code, 0, s.stderr);
    assert.deepEqual(JSON.parse(s.stdout), { subscribed: 'lobby', headSeq: 0, generation: null, pendingStart: 'now' });
    await writeFile(join(d, 'hooks-v1', 'plugin-config.json'), JSON.stringify({ v: 1, origin: 'http://127.0.0.1:5', watchRooms: [] }));
    assert.equal((await tw(['subscribe', 'dev', '--offline', '--data', d])).code, 0);
    assert.deepEqual(await scopeOrigins(d), [
      ['http://127.0.0.1:4', 'http://127.0.0.1:4', ['lobby']],
      ['http://127.0.0.1:5', 'http://127.0.0.1:5', ['dev']],
    ]);
    const inbox = await tw(['inbox', '--data', d]);
    assert.equal(inbox.code, 0, inbox.stderr);
    assert.equal(inbox.stdout, '(no unread Technocore messages)\n');
    const sep = await tw(['unsubscribe', '--data', d, '--', 'dev']);
    assert.equal(sep.code, 0, sep.stderr);
    assert.deepEqual((await scopeOrigins(d))[1], ['http://127.0.0.1:5', 'http://127.0.0.1:5', []], 'flags are inserted before --');
  });

  it('usage errors, start without --data, help', async () => {
    assert.equal((await tw(['start'])).code, 2);
    assert.equal((await tw(['subscribe', 'Bad Name', '--offline', '--data', await data()])).code, 2);
    const missing = await tw(['inbox', '--data']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--data needs a value/);
    const help = await tw(['--help']);
    assert.equal(help.code, 2);
    assert.match(help.stdout, /^technocore-watch — read-only Technocore room watcher/);
    assert.match(help.stdout, /plugin additions: `technocore-watch start --data <dir>`/);
    const unknown = await tw(['post', 'lobby', 'hi']);
    assert.equal(unknown.code, 2, 'there is no write command');
  });
});

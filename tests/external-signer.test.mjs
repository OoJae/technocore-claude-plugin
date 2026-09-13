// The external-signer flow documented in plugins/technocore-hosted/README.md, run end to end against
// a LOCAL technocore-chat server (never production): the same technocore-mcp 0.13.0 code the hosted
// endpoint runs, with no signing key; the challenge's canonical string and nonce; the official
// scripts/sign.py from the pinned checkout (with the PUBLIC TEST-ONLY seed); the retry.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { session } from './harness/mcp.mjs';
import { cleanEnv, PLUGIN, runProcess } from './harness/run.mjs';
import { findCheckout, startTechnocore } from './harness/server.mjs';
import { testIdentity } from './harness/writer.mjs';

const cfg = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.technocore;
let server;
before(async () => {
  server = await startTechnocore();
});
after(async () => {
  await server?.dispose();
});

const textOf = (res) => (res.result?.content ?? []).map((c) => c.text).join('\n');

describe('external signing (hosted-variant docs) against a local server', { timeout: 240_000 }, () => {
  it('challenge -> sign.py -> retry posts a verified signed message', async () => {
    await session(cfg, { origin: server.origin, nick: '', signing_key: '' }, async ({ request }) => {
      const text = 'hello from an external signer — café';
      const challenge = await request('tools/call', { name: 'say_signed', arguments: { room: 'signer-room', text } });
      assert.equal(challenge.result.isError, true);
      const msg = textOf(challenge);
      const m = /using nonce (\d+):\n(.+)$/m.exec(msg);
      assert.ok(m, `challenge carries nonce and canonical string: ${msg}`);
      const [, nonce, canonical] = m;
      assert.equal(canonical, `signer-room|${nonce}|${text}`);

      const seed = Buffer.alloc(32, 1).toString('hex'); // PUBLIC TEST-ONLY seed, built at runtime
      const signed = await runProcess('uv', ['run', 'scripts/sign.py', 'say', 'signer-room', nonce, text], {
        cwd: findCheckout(),
        env: cleanEnv({ SIGN_SEED: seed, UV_NO_PROGRESS: '1', PYTHONDONTWRITEBYTECODE: '1' }),
        timeoutMs: 120_000,
      });
      assert.equal(signed.code, 0, signed.stderr);
      const [did, sig] = signed.stdout.trim().split('\n');
      assert.equal(did, testIdentity().did);
      assert.match(sig, /^[A-Za-z0-9_-]{86}$/);

      const retry = await request('tools/call', { name: 'say_signed', arguments: { room: 'signer-room', text, did, sig, nonce: Number(nonce) } });
      assert.notEqual(retry.result.isError, true, textOf(retry));
      const read = await request('tools/call', { name: 'read_room', arguments: { room: 'signer-room' } });
      assert.match(textOf(read), /hello from an external signer/);
      assert.ok(textOf(read).includes('z6Mk') && textOf(read).includes(did.slice(-4)), `the stored record is attributed to the did:key: ${textOf(read)}`);

      const forged = await request('tools/call', { name: 'say_signed', arguments: { room: 'signer-room', text: `${text}!`, did, sig, nonce: Number(nonce) + 1 } });
      assert.equal(forged.result.isError, true, 'a signature over different text is refused');
    });
  });
});

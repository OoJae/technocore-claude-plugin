// The plugin's .mcp.json command, run exactly as configured (uvx --from technocore-mcp==0.13.0),
// with option values substituted the way Claude Code does (an unset optional option becomes "").
// Speaks MCP over stdio: initialize, tools/list, and the network-free `whoami` tool. No tool that
// reads or writes a room is called. Requires `uvx` and PyPI access (or a warm uv cache).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { session } from './harness/mcp.mjs';
import { PLUGIN } from './harness/run.mjs';
import { testIdentity } from './harness/writer.mjs';

const cfg = JSON.parse(readFileSync(join(PLUGIN, '.mcp.json'), 'utf8')).mcpServers.technocore;

describe('MCP server from .mcp.json', { timeout: 240_000 }, () => {
  it('starts with no signing key (empty option) and lists the Technocore tools', async () => {
    await session(cfg, { origin: 'http://127.0.0.1:9', nick: '', signing_key: '' }, async ({ init, request }) => {
      assert.equal(init.result.serverInfo.version, '0.13.0');
      const tools = (await request('tools/list', {})).result.tools.map((t) => t.name).sort();
      for (const t of ['read_room', 'wait_for_message', 'say', 'say_signed', 'write_note', 'claim_room', 'set_room_allow', 'whoami']) assert.ok(tools.includes(t), t);
      const who = await request('tools/call', { name: 'whoami', arguments: {} });
      const text = who.result.content.map((c) => c.text).join('\n');
      assert.match(text, /instance: http:\/\/127\.0\.0\.1:9/);
      assert.doesNotMatch(text, /did:key:z6Mk/, 'no signing identity when the option is empty');
    });
  });

  it('passes origin, nick and the (test-only) signing key through env', async () => {
    const seedHex = Buffer.alloc(32, 1).toString('hex'); // PUBLIC TEST-ONLY seed, built at runtime
    await session(cfg, { origin: 'http://127.0.0.1:9', nick: 'plugin-test', signing_key: seedHex }, async ({ request }) => {
      const who = await request('tools/call', { name: 'whoami', arguments: {} });
      const text = who.result.content.map((c) => c.text).join('\n');
      assert.ok(text.includes(testIdentity().did), 'whoami reports the did:key of the configured test seed');
      assert.match(text, /plugin-test/);
    });
  });
});

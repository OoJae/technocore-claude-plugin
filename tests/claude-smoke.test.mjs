// Non-interactive smoke test with the real Claude Code CLI: `claude --init-only --plugin-dir`, which
// loads the plugin, runs SessionStart (and SessionEnd) hooks, connects MCP servers and exits without
// a conversation (no model call, no login needed). Everything runs under a throwaway
// CLAUDE_CONFIG_DIR, so the user's real Claude Code configuration is never read or changed and
// nothing is installed. The debug-log phrases asserted here were observed with Claude Code 2.1.263
// and 2.1.285. From 2.1.285 the plugin totals also count Claude Code's own built-in plugins (3 plugins
// where 2.1.263 said 1), so those two lines are matched by shape; the 9 hooks are all this plugin's.
//
// Requirements: `claude` on PATH. Claude Code may also start the plugin's MCP server (uvx); it is
// pointed at a closed local port and makes no requests.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appendNotice, notice, noticeRoom, sub, writeScope } from './harness/fixtures.mjs';
import { cleanEnv, PLUGIN, runProcess, tempDir } from './harness/run.mjs';

const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
});

describe('claude --init-only --plugin-dir (real Claude Code, isolated config)', { timeout: 180_000 }, () => {
  it('loads the plugin, runs the hooks with real option values and validates their JSON', async () => {
    assert.equal(spawnSync('claude', ['--version']).status, 0, 'claude CLI on PATH');
    const t = await tempDir('tcp claude smoke ');
    cleanups.push(t.cleanup);
    const config = join(t.path, 'config dir');
    const project = join(t.path, 'project dir');
    const plugin = join(t.path, 'plugin copy', 'technocore');
    const log = join(t.path, 'debug.log');
    await mkdir(project, { recursive: true });
    await cp(PLUGIN, plugin, { recursive: true });

    const origin = 'http://127.0.0.1:9'; // closed port: nothing here ever reaches a real server
    const data = join(config, 'plugins', 'data', 'technocore-inline');
    await writeScope(data, origin, origin, [sub('smoke-room', { headSeq: 7, acceptedSeq: 2 })]);
    await appendNotice(data, origin, notice(origin, origin, [noticeRoom('smoke-room', 5, 3, 7)]));

    const settings = {
      enabledPlugins: { 'technocore@inline': true },
      pluginConfigs: { 'technocore@inline': { options: { origin, watch_rooms: ['smoke-room', 'dev', 'Not Valid'], inject_on_prompt: true } } },
    };
    const env = cleanEnv({ CLAUDE_CONFIG_DIR: config });
    delete env.ANTHROPIC_API_KEY;
    const res = await runProcess('claude', ['--init-only', '--plugin-dir', plugin, '--settings', JSON.stringify(settings), '--debug-file', log], { env, cwd: project, timeoutMs: 120_000 });
    assert.equal(res.code, 0, res.stderr);
    const text = await readFile(log, 'utf8');
    const has = (s) => assert.ok(text.includes(s), `debug log mentions: ${s}`);
    has('Loaded inline plugin from path: technocore');
    assert.match(text, /Found (\d+) plugins \(\1 enabled, 0 disabled\)/, 'every plugin found is enabled');
    assert.match(text, /Registered 9 hooks from \d+ plugins/, 'the 9 hooks of this plugin are registered');
    has('Loaded 4 skills from plugin technocore');
    has('Successfully parsed and validated hook JSON output');
    assert.match(text, /Hook SessionStart \(node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hooks\.mjs session-start\) provided additionalContext \(\d+ chars\)/);
    assert.match(text, /SessionEnd:\w+ \[node \$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/hooks\.mjs session-end\] completed with status 0/);
    // --init-only exits without waiting for MCP connections, so only the start is guaranteed here;
    // tests/mcp-server.test.mjs performs the full handshake with the same command line.
    has('MCP server "plugin:technocore:technocore": Starting connection');
    assert.ok(!/hook error|Failed with non-blocking status/i.test(text), 'no hook errors');

    assert.deepEqual(JSON.parse(await readFile(join(data, 'hooks-v1', 'plugin-config.json'), 'utf8')), { v: 1, origin, watchRooms: ['smoke-room', 'dev'] });
    assert.deepEqual(await readdir(join(data, 'hooks-v1', 'sessions')), [], 'SessionEnd removed the session marker');
  });
});

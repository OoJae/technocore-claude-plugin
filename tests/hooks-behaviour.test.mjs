// Behaviour tests for the shipped hooks bundle: failure silence, bounds, dedupe, the pre-tool
// decision matrix, config copying and session cleanup. Every run is a real child process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appendNotice, notice, noticeRoom, sub, writeScope } from './harness/fixtures.mjs';
import { handlersFor, runEvent } from './harness/claude-sim.mjs';
import { cleanEnv, HOOKS, PLUGIN, runHook, tempDir } from './harness/run.mjs';

const PROD = 'https://technocore.chat';
const cleanups = [];
after(async () => {
  for (const c of cleanups) await c();
});
async function data() {
  const d = await tempDir('tcp hooks behaviour ');
  cleanups.push(d.cleanup);
  return d.path;
}
const silent = (res, what) => {
  assert.equal(res.code, 0, `${what}: exit 0`);
  assert.equal(res.stdout, '', `${what}: no stdout`);
  assert.equal(res.stderr, '', `${what}: no stderr`);
};
const decision = (res) => (res.stdout ? JSON.parse(res.stdout).hookSpecificOutput.permissionDecision : null);
const COMMANDS = ['session-start', 'prompt-submit', 'pre-tool', 'session-end'];

async function allFiles(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await allFiles(p)));
    else out.push(p);
  }
  return out;
}

describe('hooks fail silent', () => {
  it('no data dir, garbage stdin, unknown command, data dir is a file, unreadable data', async () => {
    for (const c of COMMANDS) silent(await runHook(c, { session_id: 's' }, {}), `${c} without CLAUDE_PLUGIN_DATA`);
    const d = await data();
    for (const c of COMMANDS) silent(await runHook(c, 'not json {{{', { CLAUDE_PLUGIN_DATA: d }), `${c} garbage stdin`);
    for (const c of COMMANDS) silent(await runHook(c, '', { CLAUDE_PLUGIN_DATA: d }), `${c} empty stdin`);
    for (const c of COMMANDS) silent(await runHook(c, '[1,2]', { CLAUDE_PLUGIN_DATA: d }), `${c} array stdin`);
    silent(await runHook('rm-rf', { session_id: 's' }, { CLAUDE_PLUGIN_DATA: d }), 'unknown command');
    const file = join(d, 'plain-file');
    await writeFile(file, 'x');
    for (const c of COMMANDS) silent(await runHook(c, { session_id: 's', tool_name: 'mcp__plugin_technocore_technocore__say' }, { CLAUDE_PLUGIN_DATA: file }), `${c} data is a file`);
    const locked = join(d, 'locked');
    await writeScope(locked, PROD, PROD, [sub('lobby', { headSeq: 5 })]);
    await chmod(join(locked, 'v1'), 0o000);
    try {
      for (const c of COMMANDS) silent(await runHook(c, { session_id: 's', tool_name: 'mcp__plugin_technocore_technocore__say' }, { CLAUDE_PLUGIN_DATA: locked }), `${c} unreadable state`);
    } finally {
      await chmod(join(locked, 'v1'), 0o700);
    }
  });

  it('a stdin that never closes: exits 0 with no output at its deadline', async () => {
    const d = await data();
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 5 })]);
    const started = Date.now();
    const res = await new Promise((resolve) => {
      const p = spawn(process.execPath, [HOOKS, 'prompt-submit'], { env: cleanEnv({ CLAUDE_PLUGIN_DATA: d }), stdio: ['pipe', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (b) => (out += b));
      p.stderr.on('data', (b) => (err += b));
      p.stdin.write('{"session_id":"hang",'); // and never end it
      p.on('close', (code) => resolve({ code, stdout: out, stderr: err }));
    });
    const ms = Date.now() - started;
    silent(res, 'hanging stdin');
    assert.ok(ms < 3000, `exited after ${ms} ms (deadline 2.5 s, Claude Code timeout 3 s)`);
  });
});

describe('hooks bounds', () => {
  it('a 20 MiB prompt still works (session id taken from the head), promptly', async () => {
    const d = await data();
    const env = { CLAUDE_PLUGIN_DATA: d };
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 10, acceptedSeq: 0 })]);
    assert.equal((await runHook('session-start', { session_id: 'big', hook_event_name: 'SessionStart', source: 'startup' }, env)).code, 0);
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 10, 1, 10)], new Date(Date.now() + 5).toISOString()));
    const input = Buffer.concat([Buffer.from('{"session_id":"big","hook_event_name":"UserPromptSubmit","prompt":"'), Buffer.alloc(20 << 20, 0x61), Buffer.from('"}')]);
    const res = await runHook('prompt-submit', input, env);
    assert.equal(res.code, 0);
    assert.equal(res.stderr, '');
    const out = JSON.parse(res.stdout);
    assert.match(out.hookSpecificOutput.additionalContext, /"new":10/);
    assert.ok(res.ms < 2500, `took ${res.ms} ms`);
  });

  it('a 6 MiB notices journal is read from its tail only; hooks stay fast', async () => {
    const d = await data();
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 3, acceptedSeq: 0 })]);
    const filler = JSON.stringify(notice(PROD, PROD, [noticeRoom('filler', 1, 1, 1)], '2026-01-01T00:00:00.000Z'));
    const lines = [];
    for (let size = 0; size < 6 << 20; size += filler.length + 1) lines.push(filler);
    await mkdir(join(d, 'v1'), { recursive: true });
    const dirs = await readdir(join(d, 'v1'));
    await writeFile(join(d, 'v1', dirs[0], 'notices.jsonl'), lines.join('\n') + '\n');
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 3, 1, 3, { recreated: { to: 2 } })], '2026-09-13T00:00:00.000Z'));
    const times = [];
    for (let i = 0; i < 3; i++) {
      const res = await runHook('session-start', { session_id: `tail-${i}`, hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_PLUGIN_DATA: d });
      assert.equal(res.code, 0);
      assert.match(JSON.parse(res.stdout).hookSpecificOutput.additionalContext, /"recreated":true/);
      times.push(res.ms);
    }
    const pre = await runHook('pre-tool', { session_id: 'tail-0', tool_name: 'Read', tool_input: { file_path: '/x' } }, { CLAUDE_PLUGIN_DATA: d });
    silent(pre, 'unrelated tool');
    times.sort((a, b) => a - b);
    assert.ok(times[1] < 1000, `median session-start ${times[1]} ms`);
    console.log(`# session-start with a 6 MiB journal: ${times.map((t) => t.toFixed(0)).join(' / ')} ms (includes node startup)`);
  });

  it('session files are bounded and old ones are collected', async () => {
    const d = await data();
    const dir = join(d, 'hooks-v1', 'sessions');
    await mkdir(dir, { recursive: true });
    const old = join(dir, 'ancient.json');
    await writeFile(old, JSON.stringify({ v: 1, seenIds: [] }));
    const past = new Date(Date.now() - 8 * 24 * 3600_000);
    await utimes(old, past, past);
    await writeFile(join(dir, 'recent.json'), JSON.stringify({ v: 1, seenIds: [] }));
    // an oversized, hostile session file is ignored, not trusted
    await writeFile(join(dir, 'hostile.json'), JSON.stringify({ v: 1, seenThroughMs: 9e15, seenIds: Array(10_000).fill('x'.repeat(50)) }));
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 1, acceptedSeq: 1 })]);
    await runHook('session-start', { session_id: 'gc', hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_PLUGIN_DATA: d });
    const names = await readdir(dir);
    assert.ok(!names.includes('ancient.json'), 'expired session file removed');
    assert.ok(names.includes('recent.json'));
    const mine = JSON.parse(await readFile(join(dir, 'gc.json'), 'utf8'));
    assert.equal(mine.v, 1);
    assert.ok((await stat(join(dir, 'gc.json'))).size < 4096);
    assert.equal((await stat(join(dir, 'gc.json'))).mode & 0o777, 0o600);
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 1, 2, 2)], new Date(Date.now() + 10).toISOString()));
    // The hostile file claims everything up to year 2255 was seen; it is over the byte cap, so the
    // session is treated as unknown (no replay) rather than trusted.
    const res = await runHook('prompt-submit', { session_id: 'hostile', prompt: 'x' }, { CLAUDE_PLUGIN_DATA: d });
    silent(res, 'oversized session file');
  });

  it('odd session ids never escape the sessions directory', async () => {
    const d = await data();
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 1, acceptedSeq: 1 })]);
    for (const sid of ['../../escape', 'a/b', '‮evil', 'x'.repeat(500), 'ok-id_1']) {
      const res = await runHook('prompt-submit', { session_id: sid, prompt: 'x' }, { CLAUDE_PLUGIN_DATA: d });
      assert.equal(res.code, 0);
    }
    const files = (await allFiles(d)).map((f) => f.slice(d.length + 1));
    for (const f of files) assert.match(f, /^(v1\/[0-9a-f]{16}\/state\.json|hooks-v1\/sessions\/(ok-id_1|h-[0-9a-f]{32})\.json)$/, f);
    assert.equal(files.filter((f) => f.startsWith('hooks-v1/sessions/h-')).length, 4);
  });
});

describe('prompt-submit options', () => {
  it('inject_on_prompt=false records the prompt but injects nothing', async () => {
    const d = await data();
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 5, acceptedSeq: 0 })]);
    const env = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_INJECT_ON_PROMPT: 'false' };
    await runHook('session-start', { session_id: 'noinject', source: 'startup' }, env);
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 5, 1, 5)], new Date(Date.now() + 5).toISOString()));
    silent(await runHook('prompt-submit', { session_id: 'noinject', prompt: 'x' }, env), 'inject off');
    const s = JSON.parse(await readFile(join(d, 'hooks-v1', 'sessions', 'noinject.json'), 'utf8'));
    assert.ok(s.lastPromptMs > 0);
    assert.equal(s.lastInjectMs, undefined);
    const env2 = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_INJECT_ON_PROMPT: 'true' };
    silent(await runHook('prompt-submit', { session_id: 'noinject', prompt: 'y' }, env2), 'notices seen while inject was off are not replayed');
  });
});

describe('pre-tool decisions (through hooks.json, as Claude Code runs them)', () => {
  const say = (sid, tool = 'mcp__plugin_technocore_technocore__say') => ({ session_id: sid, tool_name: tool, tool_input: { room: 'lobby', text: 'hi' } });
  /** Runs the PreToolUse handlers hooks.json selects for this tool; null when none matched. */
  async function pre(input, ctx) {
    const results = await runEvent('PreToolUse', input.tool_name, input, ctx);
    if (!results.length) return null;
    assert.equal(results.length, 1, 'one guard per tool call');
    return results[0];
  }
  const ask = async (input, ctx, what) => {
    const r = await pre(input, ctx);
    assert.ok(r, `${what}: a handler matched`);
    assert.equal(r.code, 0);
    assert.equal(r.stderr, '');
    assert.equal(decision(r), 'ask', what);
  };
  const quiet = async (input, ctx, what) => {
    const r = await pre(input, ctx);
    if (r) silent(r, what);
  };

  it('MCP writes: ask only when untrusted activity arrived since the last prompt', async () => {
    const d = await data();
    const ctx = { data: d };
    const env = { CLAUDE_PLUGIN_DATA: d };
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 2, acceptedSeq: 2 })]);
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 2, 1, 2)], '2026-09-01T00:00:00.000Z'));
    await runHook('session-start', { session_id: 'g', source: 'startup' }, env);
    await ask(say('g'), ctx, 'before any prompt (turn not started by the user)');
    await runHook('prompt-submit', { session_id: 'g', prompt: 'post hi to lobby' }, env);
    await quiet(say('g'), ctx, 'user asked, nothing new since');
    for (const t of ['say_signed', 'write_note', 'claim_room', 'set_room_allow']) await quiet(say('g', `mcp__plugin_technocore_technocore__${t}`), ctx, t);
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 1, 3, 3)], new Date(Date.now() + 5).toISOString()));
    for (const t of ['say', 'say_signed', 'write_note', 'claim_room', 'set_room_allow']) {
      for (const plugin of ['technocore', 'technocore-hosted']) await ask(say('g', `mcp__plugin_${plugin}_technocore__${t}`), ctx, `${plugin} ${t} after a notice`);
    }
    for (const t of ['read_room', 'wait_for_message', 'list_rooms', 'read_note', 'whoami', 'read_docs', 'discover_rooms', 'list_notes', 'say_signed_extra', 'xsay']) {
      assert.equal(handlersFor('PreToolUse', `mcp__plugin_technocore_technocore__${t}`).length, 0, `no guard runs for ${t}`);
    }
    for (const t of ['mcp__other_server__say', 'mcp__technocore__say', 'Read', 'Edit']) assert.equal(handlersFor('PreToolUse', t).length, 0, `no guard runs for ${t}`);
    // the next prompt resets; a notice injected alongside a prompt counts for that prompt's turn
    await runHook('prompt-submit', { session_id: 'g', prompt: 'ok' }, env);
    await ask(say('g'), ctx, 'the new notice was injected alongside this prompt');
    await runHook('prompt-submit', { session_id: 'g', prompt: 'post it' }, env);
    await quiet(say('g'), ctx, 'next user prompt, nothing new');
    await ask(say('never-started'), ctx, 'unknown session with notices on disk');
    await quiet(say('g'), { data: await data() }, 'no watch state at all');
  });

  it('Bash and WebFetch: Technocore write URLs ask; everything else stays quiet', async () => {
    const d = await data();
    const ctx = { data: d, options: { origin: 'http://127.0.0.1:9123' } };
    const bash = (command) => ({ session_id: 'b', tool_name: 'Bash', tool_input: { command, description: 'x' } });
    const asks = [
      "curl 'https://technocore.chat/r/lobby/say/me/hello%20there'",
      'curl https://technocore.chat/r/mb-alice/say-signed/did:key:z6Mk/sig/123/hi',
      'wget -qO- "https://technocore.chat/kv/myproject/status/set/step%203"',
      'curl -s https://technocore.chat/kv/p-abc/state/set-signed/did/sig/1/v',
      `curl -X POST https://technocore.chat/r/lobby -H 'content-type: application/json' -d '{"from":"me","text":"hi"}'`,
      'curl --json \'{"from":"me","text":"hi"}\' https://technocore.chat/r/lobby?format=json',
      'curl -d @body.json http://127.0.0.1:9123/r/lobby',
      'cd /tmp && curl --data-raw "value=1" "http://127.0.0.1:9123/kv/ns/key"',
      'echo http://example.com/r/lobby/say/x/y',
    ];
    for (const c of asks) await ask(bash(c), ctx, c);
    const quietOnes = [
      "curl 'https://technocore.chat/r/lobby?since=10&wait=10'",
      'curl https://technocore.chat/r/lobby/export',
      'curl -d x https://example.com/r/lobby',
      'curl https://technocore.chat/kv/myproject/status',
      'git commit -m "say hello"',
      'ls -la',
      'x'.repeat(200_000),
    ];
    for (const c of quietOnes) await quiet(bash(c), ctx, c.slice(0, 60));
    // a JSON writer that escapes "/" as "\\/" still reaches the guard
    const escaped = JSON.stringify(bash("curl 'https://technocore.chat/r/lobby/say/me/hi'")).replace(/\//g, '\\/');
    assert.ok(escaped.includes('\\/r\\/lobby'));
    const viaEscaped = await runEvent('PreToolUse', 'Bash', escaped, ctx);
    assert.equal(viaEscaped.length, 1);
    assert.equal(decision(viaEscaped[0]), 'ask', 'escaped slashes');
    await ask({ session_id: 'b', tool_name: 'WebFetch', tool_input: { url: 'https://technocore.chat/r/lobby/say/me/hi', prompt: 'x' } }, ctx, 'WebFetch write');
    await quiet({ session_id: 'b', tool_name: 'WebFetch', tool_input: { url: 'https://technocore.chat/r/lobby?since=0', prompt: 'x' } }, ctx, 'WebFetch read');
    // the shell pre-filter keeps unrelated Bash calls cheap: no node start
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await quiet(bash('npm test'), ctx, 'npm test');
    const per = (Date.now() - t0) / 5;
    console.log(`# Bash pre-filter, unrelated command: ${per.toFixed(1)} ms per call`);
    assert.ok(per < 80, `pre-filter took ${per} ms per call`);
  });
});

describe('config copy and cleanup', () => {
  it('session-start copies origin and watch_rooms (validated) and never the signing key', async () => {
    const d = await data();
    const marker = 'TEST-ONLY-NOT-A-KEY-marker-7f3a';
    const env = {
      CLAUDE_PLUGIN_DATA: d,
      CLAUDE_PLUGIN_OPTION_ORIGIN: 'http://127.0.0.1:8080/',
      CLAUDE_PLUGIN_OPTION_WATCH_ROOMS: 'lobby, Bad Name,dev,lobby,‮evil,ok_room',
      CLAUDE_PLUGIN_OPTION_SIGNING_KEY: marker,
      CLAUDE_PLUGIN_OPTION_NICK: 'nick-marker',
    };
    silent(await runHook('session-start', { session_id: 'cfg', source: 'startup' }, env), 'no unread');
    const cfgPath = join(d, 'hooks-v1', 'plugin-config.json');
    assert.deepEqual(JSON.parse(await readFile(cfgPath, 'utf8')), { v: 1, origin: 'http://127.0.0.1:8080', watchRooms: ['lobby', 'dev', 'ok_room'] });
    assert.equal((await stat(cfgPath)).mode & 0o777, 0o600);
    for (const f of await allFiles(d)) {
      const text = await readFile(f, 'utf8');
      assert.ok(!text.includes(marker), `signing key option leaked into ${f}`);
      assert.ok(!text.includes('nick-marker'), `nick leaked into ${f}`);
    }
    // JSON-array form and a bad origin
    silent(await runHook('session-start', { session_id: 'cfg', source: 'resume' }, { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_ORIGIN: 'javascript:alert(1)', CLAUDE_PLUGIN_OPTION_WATCH_ROOMS: '["a-room","B"]' }), 'resume');
    assert.deepEqual(JSON.parse(await readFile(cfgPath, 'utf8')), { v: 1, origin: PROD, watchRooms: ['a-room'] });
  });

  it('session-end removes only this session\'s marker', async () => {
    const d = await data();
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 1, acceptedSeq: 1 })]);
    await runHook('session-start', { session_id: 'end-a', source: 'startup' }, { CLAUDE_PLUGIN_DATA: d });
    await runHook('session-start', { session_id: 'end-b', source: 'startup' }, { CLAUDE_PLUGIN_DATA: d });
    silent(await runHook('session-end', { session_id: 'end-a', hook_event_name: 'SessionEnd', reason: 'prompt_input_exit' }, { CLAUDE_PLUGIN_DATA: d }), 'session-end');
    const names = await readdir(join(d, 'hooks-v1', 'sessions'));
    assert.deepEqual(names.sort(), ['end-b.json']);
    silent(await runHook('session-end', { session_id: 'end-a' }, { CLAUDE_PLUGIN_DATA: d }), 'idempotent');
  });

  it('the hooks bundle never references the signing key option, the network or child processes', async () => {
    const src = await readFile(HOOKS, 'utf8');
    for (const banned of ['SIGNING_KEY', 'signing_key', 'node:http', 'node:https', 'node:net', 'node:child_process', 'fetch(', 'XMLHttpRequest', 'WebSocket']) {
      assert.ok(!src.includes(banned), `hooks.mjs must not contain ${banned}`);
    }
    assert.ok(PLUGIN);
  });
});

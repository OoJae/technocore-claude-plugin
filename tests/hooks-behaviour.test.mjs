// Behaviour tests for the shipped hooks bundle: failure silence, bounds, dedupe, the pre-tool
// decision matrix, config copying and session cleanup. Every run is a real child process.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readdir, readFile, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { appendNotice, journalPath, notice, noticeRoom, rewriteJournal, scopeHash, setJournalTime, sub, writeScope } from './harness/fixtures.mjs';
import { handlersFor, runEvent } from './harness/claude-sim.mjs';
import { cleanEnv, HOOKS, PLUGIN, runHook, tempDir } from './harness/run.mjs';

const NOTICE_GRACE_MS = 2000; // src/hooks.mjs

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
    await writeFile(old, JSON.stringify({ v: 2, journals: {} }));
    const past = new Date(Date.now() - 8 * 24 * 3600_000);
    await utimes(old, past, past);
    await writeFile(join(dir, 'recent.json'), JSON.stringify({ v: 2, journals: {} }));
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 1, acceptedSeq: 1 })]);
    await runHook('session-start', { session_id: 'gc', hook_event_name: 'SessionStart', source: 'startup' }, { CLAUDE_PLUGIN_DATA: d });
    const names = await readdir(dir);
    assert.ok(!names.includes('ancient.json'), 'expired session file removed');
    assert.ok(names.includes('recent.json'));
    const mine = JSON.parse(await readFile(join(dir, 'gc.json'), 'utf8'));
    assert.equal(mine.v, 2);
    assert.ok((await stat(join(dir, 'gc.json'))).size < 4096);
    assert.equal((await stat(join(dir, 'gc.json'))).mode & 0o777, 0o600);
  });

  it('an oversized session file is not trusted: the session is treated as unknown and rewritten small', async () => {
    const d = await data();
    const dir = join(d, 'hooks-v1', 'sessions');
    await mkdir(dir, { recursive: true });
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 2, acceptedSeq: 1 })]);
    const n1 = notice(PROD, PROD, [noticeRoom('lobby', 1, 2, 2)]);
    await appendNotice(d, PROD, n1);
    const journalSize = (await stat(journalPath(d, PROD))).size;
    // A session file that has seen nothing. Trusted, it makes the notice above "new", so the
    // prompt gets it injected; that is the observable difference between trusting and ignoring.
    const honest = { v: 2, journals: {} };
    const hostileJournals = {};
    for (let i = 0; i < 5000; i++) hostileJournals[i.toString(16).padStart(16, '0')] = { ino: '1', offset: 0, lastId: 'x'.repeat(90) };
    const hostile = { v: 2, journals: hostileJournals, pad: 'p'.repeat(70_000) };
    await writeFile(join(dir, 'small.json'), JSON.stringify(honest));
    await writeFile(join(dir, 'big.json'), JSON.stringify({ ...honest, ...hostile, journals: {} }));
    await writeFile(join(dir, 'hostile.json'), JSON.stringify(hostile));
    assert.ok((await stat(join(dir, 'big.json'))).size > 64 << 10);

    const trusted = await runHook('prompt-submit', { session_id: 'small', prompt: 'x' }, { CLAUDE_PLUGIN_DATA: d });
    assert.match(JSON.parse(trusted.stdout).hookSpecificOutput.additionalContext, /"room":"lobby"/, 'control: the same content under the byte cap is trusted');
    for (const sid of ['big', 'hostile']) {
      silent(await runHook('prompt-submit', { session_id: sid, prompt: 'x' }, { CLAUDE_PLUGIN_DATA: d }), `${sid}: over the cap, so unknown (no replay)`);
      const text = await readFile(join(dir, `${sid}.json`), 'utf8');
      assert.ok(text.length < 4096, `${sid}: rewritten small (${text.length} bytes)`);
      const rewritten = JSON.parse(text);
      assert.equal(rewritten.pad, undefined);
      assert.deepEqual(Object.keys(rewritten.journals), [scopeHash(PROD)], `${sid}: only real scopes are kept`);
      assert.equal(rewritten.journals[scopeHash(PROD)].lastId, n1.id, `${sid}: seen through the real journal`);
      assert.equal(rewritten.journals[scopeHash(PROD)].offset, journalSize);
      silent(await runHook('prompt-submit', { session_id: sid, prompt: 'y' }, { CLAUDE_PLUGIN_DATA: d }), `${sid}: nothing new afterwards`);
    }
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
    const longAgo = new Date(Date.now() - 60_000);
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 2, acceptedSeq: 2 })]);
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 2, 1, 2)], '2026-09-01T00:00:00.000Z'));
    await setJournalTime(d, PROD, longAgo);
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
    await setJournalTime(d, PROD, longAgo);
    await runHook('prompt-submit', { session_id: 'g', prompt: 'ok' }, env);
    await ask(say('g'), ctx, 'the new notice was injected alongside this prompt');
    await runHook('prompt-submit', { session_id: 'g', prompt: 'post it' }, env);
    await quiet(say('g'), ctx, 'next user prompt, nothing new');
    await ask(say('never-started'), ctx, 'unknown session with notices on disk');
    await quiet(say('g'), { data: await data() }, 'no watch state at all');
  });

  it('MCP writes: guarded by append order, not by notice timestamps (inject_on_prompt off)', async () => {
    const d = await data();
    const ctx = { data: d, options: { inject_on_prompt: false } };
    const env = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_INJECT_ON_PROMPT: 'false' };
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 2, acceptedSeq: 0 })]);
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 1, 1, 1)], '2026-09-01T00:00:00.000Z'));
    await setJournalTime(d, PROD, new Date(Date.now() - 60_000));
    await runHook('session-start', { session_id: 'ord', source: 'startup' }, env);
    await runHook('prompt-submit', { session_id: 'ord', prompt: 'hi' }, env);
    await quiet(say('ord'), ctx, 'quiet after the prompt');
    // flushed (createdAt) long before the prompt, but appended after it: the monitor prints it now
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 1, 2, 2)], new Date(Date.now() - 30_000).toISOString()));
    await ask(say('ord'), ctx, 'appended after the prompt with an old createdAt');
    // appended just before the prompt: a follower monitor may still print it after the prompt
    await setJournalTime(d, PROD, new Date(Date.now() - 800));
    await runHook('prompt-submit', { session_id: 'ord', prompt: 'next' }, env);
    await ask(say('ord'), ctx, `appended within ${NOTICE_GRACE_MS} ms before the prompt`);
    await setJournalTime(d, PROD, new Date(Date.now() - 60_000));
    await quiet(say('ord'), ctx, 'appended long before the prompt');
  });

  it('MCP writes: reading room or note text in this turn arms the guard (PostToolUse)', async () => {
    const d = await data();
    const ctx = { data: d, options: { origin: 'http://127.0.0.1:9124' } };
    const env = { CLAUDE_PLUGIN_DATA: d };
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 2, acceptedSeq: 2 })]);
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 2, 1, 2)], '2026-09-01T00:00:00.000Z'));
    await setJournalTime(d, PROD, new Date(Date.now() - 60_000));
    const post = async (event, input) => {
      const results = await runEvent(event, input.tool_name, input, ctx);
      for (const r of results) silent(r, `${event} ${input.tool_name} is silent`);
      return results.length;
    };
    const mcp = (sid, t, extra = {}) => ({ session_id: sid, tool_name: `mcp__plugin_technocore_technocore__${t}`, tool_input: { room: 'lobby' }, tool_response: 'x', ...extra });
    const bash = (sid, command) => ({ session_id: sid, tool_name: 'Bash', tool_input: { command, description: 'x' }, tool_response: { stdout: 'x' } });
    const webfetch = (sid, url) => ({ session_id: sid, tool_name: 'WebFetch', tool_input: { url, prompt: 'x' }, tool_response: 'x' });
    const turn = async (sid, prompt) => {
      await runHook('prompt-submit', { session_id: sid, prompt }, env);
      await quiet(say(sid, 'mcp__plugin_technocore_technocore__say_signed'), ctx, `${sid}: quiet right after "${prompt}"`);
    };
    await runHook('session-start', { session_id: 'rd', source: 'startup' }, env);

    // reads through the MCP server (both plugins), then a signed post in the same turn
    for (const [i, t] of ['read_room', 'wait_for_message', 'read_note', 'list_rooms', 'discover_rooms', 'list_notes', 'read_docs'].entries()) {
      await turn('rd', `check ${i}`);
      assert.equal(await post('PostToolUse', mcp('rd', t)), 1);
      for (const w of ['say', 'say_signed', 'write_note', 'claim_room', 'set_room_allow']) await ask(say('rd', `mcp__plugin_technocore_technocore__${w}`), ctx, `${w} after ${t}`);
    }
    await turn('rd', 'hosted read');
    assert.equal(await post('PostToolUse', mcp('rd', 'read_room', { tool_name: 'mcp__plugin_technocore-hosted_technocore__read_room' })), 1);
    await ask(say('rd', 'mcp__plugin_technocore-hosted_technocore__say_signed'), ctx, 'hosted say_signed after a hosted read');
    // a failed conditional write echoes the stored (third-party) value
    await turn('rd', 'cas');
    assert.equal(await post('PostToolUseFailure', mcp('rd', 'write_note', { error: 'conflict: value is ...' })), 1);
    await ask(say('rd'), ctx, 'say after a failed write_note');

    // /technocore-inbox runs `technocore-watch inbox` through the Bash tool
    await turn('rd', '/technocore:technocore-inbox');
    assert.equal(await post('PostToolUse', bash('rd', `technocore-watch inbox --max 5 --format framed --data "${d}"`)), 1);
    await ask(say('rd', 'mcp__plugin_technocore_technocore__say_signed'), ctx, 'say_signed after the inbox printed messages');
    // Bash or WebFetch reads of room text
    for (const [what, input] of [
      ['curl read', bash('rd', "curl -s 'https://technocore.chat/r/lobby?since=0'")],
      ['configured origin', bash('rd', 'curl -s http://127.0.0.1:9124/kv/ns/key')],
      ['encoded path', bash('rd', 'curl -s http://127.0.0.1:9999/%72/lobby')],
      ['WebFetch', webfetch('rd', 'https://technocore.chat/r/lobby')],
      ['failed Bash read', bash('rd', 'curl -sf https://technocore.chat/r/p-missing')],
    ]) {
      await turn('rd', what);
      assert.equal(await post(what === 'failed Bash read' ? 'PostToolUseFailure' : 'PostToolUse', input), 1);
      await ask(say('rd'), ctx, `say after ${what}`);
    }

    // things that bring no third-party text do not arm it
    await turn('rd', 'unrelated');
    for (const input of [mcp('rd', 'whoami'), mcp('rd', 'say'), mcp('rd', 'say_signed'), mcp('rd', 'write_note'), mcp('rd', 'claim_room'), mcp('rd', 'set_room_allow')]) {
      assert.equal(handlersFor('PostToolUse', input.tool_name).length, 0, `no recorder for ${input.tool_name}`);
    }
    await post('PostToolUse', bash('rd', 'npm test'));
    await post('PostToolUse', bash('rd', 'technocore-watch status --data /tmp/x'));
    await post('PostToolUse', webfetch('rd', 'https://example.com/docs'));
    await post('PostToolUse', { session_id: 'rd', tool_name: 'Read', tool_input: { file_path: '/r/lobby' } });
    await quiet(say('rd'), ctx, 'nothing untrusted was read in this turn');

    // the marker lasts until the next prompt only
    await turn('rd', 'read it');
    await post('PostToolUse', mcp('rd', 'read_room'));
    await ask(say('rd'), ctx, 'same turn');
    await turn('rd', 'now post my reply');

    // a session first seen by PostToolUse starts its notice bookkeeping from now (no replay later)
    assert.equal(await post('PostToolUse', mcp('fresh', 'read_room')), 1);
    await ask(say('fresh'), ctx, 'no prompt recorded yet, text was read');
    silent(await runHook('prompt-submit', { session_id: 'fresh', prompt: 'x' }, env), 'old notices are not replayed into a session first seen by PostToolUse');
    await quiet(say('fresh'), ctx, 'after the prompt');
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
      // combined short options, attached values, other data options (review finding 0/10)
      `curl -sd '{"from":"a","text":"hi"}' https://technocore.chat/r/lobby`,
      `curl -fsSd '{"from":"a","text":"hi"}' https://technocore.chat/r/lobby`,
      `curl -d'{"from":"a","text":"hi"}' https://technocore.chat/r/lobby`,
      `curl --data-ascii '{"from":"a","text":"hi"}' https://technocore.chat/r/lobby`,
      `curl --form-string text=hi https://technocore.chat/r/lobby`,
      `wget --method=POST --body-data='{"from":"a","text":"hi"}' https://technocore.chat/r/lobby`,
      `wget --body-file=m.json -O- https://technocore.chat/r/lobby`,
      'curl -sXPOST http://127.0.0.1:9123/r/lobby',
      'curl --request=post http://127.0.0.1:9123/r/lobby',
      'curl -sd x https://technocore.chat/kv/ns/key',
      // host case, trailing slash (307 to the same POST), shell quoting splits
      'curl -d x https://TechnoCore.chat/r/lobby',
      `curl -L -d '{"from":"a","text":"hi"}' 'https://technocore.chat/r/lobby/?format=json'`,
      `curl -d x 'https://technocore.chat/r/'lobby`,
      // percent-encoding and dot segments, which the server and curl resolve
      "curl 'https://technocore.chat/r/lobby/%73ay/me/hi'",
      'curl https://technocore.chat/r%2Flobby%2Fsay%2Fme%2Fhi',
      'curl https://technocore.chat/r%252Flobby%252Fsay%252Fme%252Fhi',
      'curl https://technocore.chat/%72/lobby/say/me/hi',
      'curl https://technocore.chat/kv/ns/k/%73et/v',
      'curl https://technocore.chat/r/x/../lobby/say/me/hi',
      'curl https://technocore.chat/r/lobby/./say/me/hi',
      "curl 'https://technocore.chat/r/lob''by/say/me/hi'",
      'curl -d x https://technocore.chat/r/%6cobby',
      // other clients named by method
      `python3 -c "import requests; requests.post('https://technocore.chat/r/lobby', json={'from': 'a', 'text': 'hi'})"`,
      `node -e "fetch('https://technocore.chat/r/lobby', {method: 'POST', body: '{}'})"`,
      'http POST https://technocore.chat/r/lobby from=a text=hi',
      'https technocore.chat/r/lobby from=a text=hi',
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
      'curl -D - https://technocore.chat/r/lobby',
      "curl -sSfL 'https://technocore.chat/r/lobby?since=3&limit=5'",
      "curl -s -w '%{http_code}' https://technocore.chat/rooms",
      'curl https://technocore.chat/r/post',
      'curl https://technocore.chat/r/lobby/export?format=json',
      "date +%s && printf '%s' ok",
    ];
    for (const c of quietOnes) await quiet(bash(c), ctx, c.slice(0, 60));
    // a JSON writer that escapes "/" as "\\/" still reaches the guard
    const escaped = JSON.stringify(bash("curl 'https://technocore.chat/r/lobby/say/me/hi'")).replace(/\//g, '\\/');
    assert.ok(escaped.includes('\\/r\\/lobby'));
    const viaEscaped = await runEvent('PreToolUse', 'Bash', escaped, ctx);
    assert.equal(viaEscaped.length, 1);
    assert.equal(decision(viaEscaped[0]), 'ask', 'escaped slashes');
    await ask({ session_id: 'b', tool_name: 'WebFetch', tool_input: { url: 'https://technocore.chat/r/lobby/say/me/hi', prompt: 'x' } }, ctx, 'WebFetch write');
    for (const url of ['https://technocore.chat/r/lobby/%73ay/me/hi', 'https://technocore.chat/r%2Flobby%2Fsay%2Fme%2Fhi', 'https://technocore.chat/kv/ns/k/%73et/v', 'https://technocore.chat/r/x/%2e%2e/lobby/say/me/hi']) {
      await ask({ session_id: 'b', tool_name: 'WebFetch', tool_input: { url, prompt: 'x' } }, ctx, `WebFetch ${url}`);
    }
    await quiet({ session_id: 'b', tool_name: 'WebFetch', tool_input: { url: 'https://technocore.chat/r/lobby?since=0', prompt: 'x' } }, ctx, 'WebFetch read');
    // the shell pre-filter keeps unrelated Bash calls cheap: no node start
    const t0 = Date.now();
    for (let i = 0; i < 5; i++) await quiet(bash('npm test'), ctx, 'npm test');
    const per = (Date.now() - t0) / 5;
    console.log(`# Bash pre-filter, unrelated command: ${per.toFixed(1)} ms per call`);
    assert.ok(per < 80, `pre-filter took ${per} ms per call`);
    // only the tool input is checked: a working directory named like a Technocore path does not
    // start node for every command (PreToolUse and PostToolUse)
    const project = { ...ctx, project: '/Users/me/technocore/r/kv/say' };
    const inCwd = JSON.stringify({ session_id: 'b', transcript_path: '/Users/me/.claude/projects/technocore/r/x.jsonl', cwd: '/Users/me/technocore/r/kv/say', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'run tests' } });
    const t1 = Date.now();
    for (let i = 0; i < 5; i++) {
      for (const e of ['PreToolUse', 'PostToolUse']) {
        const r = await runEvent(e, 'Bash', inCwd, project);
        assert.equal(r.length, 1);
        silent(r[0], `${e} in a technocore-named cwd`);
      }
    }
    const perCwd = (Date.now() - t1) / 10;
    console.log(`# Bash pre-filter, technocore-named cwd: ${perCwd.toFixed(1)} ms per call`);
    assert.ok(perCwd < 80, `pre-filter took ${perCwd} ms per call with a technocore-named cwd`);
  });

  it('Bash write guard: a scheme-less origin option still guards its host', async () => {
    const d = await data();
    const ctx = { data: d, options: { origin: 'localhost:8080' } };
    const bash = (command) => ({ session_id: 'b', tool_name: 'Bash', tool_input: { command, description: 'x' } });
    await ask(bash('curl -sd x http://localhost:8080/r/lobby'), ctx, 'scheme-less origin host');
    await quiet(bash('curl -sd x http://localhost:9090/r/lobby'), ctx, 'another host');
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
    // JSON-array form; an unset or empty origin means the public default
    for (const origin of [undefined, '', '   ']) {
      silent(await runHook('session-start', { session_id: 'cfg', source: 'resume' }, { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_ORIGIN: origin, CLAUDE_PLUGIN_OPTION_WATCH_ROOMS: '["a-room","B"]' }), `origin ${JSON.stringify(origin)}`);
      assert.deepEqual(JSON.parse(await readFile(cfgPath, 'utf8')), { v: 1, origin: PROD, watchRooms: ['a-room'] });
    }
  });

  it('session-start: a set but unusable origin is recorded as an error (never production) and warned about', async () => {
    for (const origin of ['localhost:8080', '127.0.0.1:8080', 'http://127.0.0.1:8080?x=1', 'https://me:pw@chat.internal', 'https://chat.internal/?x=1', 'javascript:alert(1)', 'ftp://chat.internal']) {
      const d = await data();
      const env = { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_ORIGIN: origin, CLAUDE_PLUGIN_OPTION_WATCH_ROOMS: '["p-7f3k2secretroom"]' };
      const res = await runHook('session-start', { session_id: 'bad-origin', source: 'startup' }, env);
      assert.equal(res.code, 0);
      assert.equal(res.stderr, '');
      const cfg = JSON.parse(await readFile(join(d, 'hooks-v1', 'plugin-config.json'), 'utf8'));
      assert.deepEqual(cfg, { v: 1, origin: null, error: 'invalid-origin', watchRooms: ['p-7f3k2secretroom'] }, origin);
      const text = JSON.parse(res.stdout).hookSpecificOutput.additionalContext;
      assert.match(text, /^\[TECHNOCORE PLUGIN WARNING — plugin configuration\]\n/);
      assert.match(text, /refuses to start rather than fall back to https:\/\/technocore\.chat/);
      assert.ok(!text.includes(origin.slice(0, 8)) || origin.startsWith('https://'), 'the raw option value is not echoed');
      // with unread rooms the warning follows the summary, still within the cap
      await writeScope(d, 'http://127.0.0.1:1', 'http://127.0.0.1:1', [sub('lobby', { headSeq: 4, acceptedSeq: 0 })]);
      const both = JSON.parse((await runHook('session-start', { session_id: 'bad-origin', source: 'resume' }, env)).stdout).hookSpecificOutput.additionalContext;
      assert.ok(both.startsWith('[TECHNOCORE UNREAD SUMMARY'));
      assert.match(both, /\n\n\[TECHNOCORE PLUGIN WARNING/);
      assert.ok(both.length <= 1500);
    }
    // fixing the option replaces the error
    const d = await data();
    await runHook('session-start', { session_id: 'fix', source: 'startup' }, { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_ORIGIN: 'localhost:8080' });
    silent(await runHook('session-start', { session_id: 'fix', source: 'resume' }, { CLAUDE_PLUGIN_DATA: d, CLAUDE_PLUGIN_OPTION_ORIGIN: 'http://localhost:8080' }), 'fixed');
    assert.deepEqual(JSON.parse(await readFile(join(d, 'hooks-v1', 'plugin-config.json'), 'utf8')), { v: 1, origin: 'http://localhost:8080', watchRooms: [] });
  });

  it('merged notices never mix seq numbers across generations; stale gaps of an old generation are not counted', async () => {
    const d = await data();
    const env = { CLAUDE_PLUGIN_DATA: d };
    await writeScope(d, PROD, PROD, [sub('lobby', { generation: 2, headSeq: 3, notifiedSeq: 3, acceptedSeq: 0 })]);
    await runHook('session-start', { session_id: 'gen', source: 'startup' }, env);
    const t = Date.now();
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 11, 500, 510, { generation: 1 })], new Date(t + 1).toISOString()));
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 3, 1, 3, { generation: 2, recreated: { from: 510, to: 3 } })], new Date(t + 2).toISOString()));
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 2, 505, 506, { generation: 1 })], new Date(t + 3).toISOString()));
    const text = JSON.parse((await runHook('prompt-submit', { session_id: 'gen', prompt: 'x' }, env)).stdout).hookSpecificOutput.additionalContext;
    assert.match(text, /^notices: 3 {3}total_new: 3$/m);
    const rooms = JSON.parse(text.split('\n').find((l) => l.startsWith('rooms_json: ')).slice('rooms_json: '.length));
    assert.deepEqual(rooms, [{ origin: PROD, room: 'lobby', generation: 2, new: 3, seq: [1, 3], gaps: 0, recreated: true, unread: 3 }]);

    const d2 = await data();
    await writeScope(d2, PROD, PROD, [
      sub('lobby', { generation: 2, headSeq: 8, notifiedSeq: 8, acceptedSeq: 3, gaps: [{ from: 91, to: 100, reason: 'seq-regression', generation: 1, detectedAt: '2026-09-13T11:00:00.000Z' }] }),
      sub('dev', { generation: 2, headSeq: 20, notifiedSeq: 20, acceptedSeq: 3, gaps: [{ from: 5, to: 6, reason: 'ring-dropped', generation: 2, detectedAt: '2026-09-13T11:00:00.000Z' }] }),
    ]);
    await appendNotice(d2, PROD, notice(PROD, PROD, [noticeRoom('dev', 99, 1, 99, { generation: 1, recreated: { to: 99 } })], '2026-09-12T00:00:00.000Z'));
    const summary = JSON.parse((await runHook('session-start', { session_id: 'gaps', source: 'startup' }, { CLAUDE_PLUGIN_DATA: d2 })).stdout).hookSpecificOutput.additionalContext;
    const sroom = JSON.parse(summary.split('\n').find((l) => l.startsWith('rooms_json: ')).slice('rooms_json: '.length));
    assert.deepEqual(sroom.map((r) => [r.room, r.unread, r.seq, r.gaps, r.recreated]), [
      ['dev', 15, [4, 20], 1, false],
      ['lobby', 5, [4, 8], 0, false],
    ]);
  });

  it('prompt-submit dedupes by journal position: late appends from another scope and ring rewrites', async () => {
    const d = await data();
    const env = { CLAUDE_PLUGIN_DATA: d };
    const A = 'http://127.0.0.1:1';
    await writeScope(d, PROD, PROD, [sub('lobby', { headSeq: 9, acceptedSeq: 0 })]);
    await writeScope(d, A, A, [sub('dev', { headSeq: 9, acceptedSeq: 0 })]);
    await runHook('session-start', { session_id: 'pos', source: 'startup' }, env);
    const t = Date.now();
    const rooms = (out) => JSON.parse(JSON.parse(out).hookSpecificOutput.additionalContext.split('\n').find((l) => l.startsWith('rooms_json: ')).slice('rooms_json: '.length)).map((r) => [r.room, r.new]);
    // scope B (production) flushes a notice stamped t+50 and the user prompts...
    await appendNotice(d, PROD, notice(PROD, PROD, [noticeRoom('lobby', 2, 1, 2)], new Date(t + 50).toISOString()));
    assert.deepEqual(rooms((await runHook('prompt-submit', { session_id: 'pos', prompt: '1' }, env)).stdout), [['lobby', 2]]);
    // ...then scope A's notice, stamped earlier (t+20), finishes appending
    await appendNotice(d, A, notice(A, A, [noticeRoom('dev', 1, 1, 1)], new Date(t + 20).toISOString()));
    assert.deepEqual(rooms((await runHook('prompt-submit', { session_id: 'pos', prompt: '2' }, env)).stdout), [['dev', 1]], 'not hidden by the newer-stamped notice');
    silent(await runHook('prompt-submit', { session_id: 'pos', prompt: '3' }, env), 'each once');

    // the ring is rewritten (new inode) keeping the last seen notice plus two new ones
    const seen = notice(PROD, PROD, [noticeRoom('lobby', 1, 3, 3)], new Date(t + 60).toISOString());
    await appendNotice(d, PROD, seen);
    await runHook('prompt-submit', { session_id: 'pos', prompt: '4' }, env);
    const n5 = notice(PROD, PROD, [noticeRoom('lobby', 2, 4, 5)], new Date(t + 70).toISOString());
    const n6 = notice(PROD, PROD, [noticeRoom('lobby', 3, 6, 8)], new Date(t + 10).toISOString());
    await rewriteJournal(d, PROD, [seen, n5, n6]);
    assert.deepEqual(rooms((await runHook('prompt-submit', { session_id: 'pos', prompt: '5' }, env)).stdout), [['lobby', 5]], 'resumes after the last seen notice');
    silent(await runHook('prompt-submit', { session_id: 'pos', prompt: '6' }, env), 'nothing new after the rewrite');
    // a rewrite in which the last seen notice rotated out: everything retained is newer
    const n7 = notice(PROD, PROD, [noticeRoom('lobby', 1, 9, 9)], new Date(t + 5).toISOString());
    await rewriteJournal(d, PROD, [n7]);
    assert.deepEqual(rooms((await runHook('prompt-submit', { session_id: 'pos', prompt: '7' }, env)).stdout), [['lobby', 1]]);
    // a torn (still being written) last line is picked up once complete
    const torn = JSON.stringify(notice(PROD, PROD, [noticeRoom('lobby', 4, 10, 13)], new Date(t + 80).toISOString()));
    await writeFile(journalPath(d, PROD), torn.slice(0, 40), { flag: 'a' });
    silent(await runHook('prompt-submit', { session_id: 'pos', prompt: '8' }, env), 'torn line not yet a notice');
    await writeFile(journalPath(d, PROD), torn.slice(40) + '\n', { flag: 'a' });
    assert.deepEqual(rooms((await runHook('prompt-submit', { session_id: 'pos', prompt: '9' }, env)).stdout), [['lobby', 4]]);
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

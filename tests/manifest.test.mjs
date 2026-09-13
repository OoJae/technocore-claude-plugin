// Static checks of the marketplace and plugin files against the plan and the Claude Code plugin
// reference (plugins-reference.md, plugin-marketplaces.md, hooks.md, skills.md as of 2026-09-13).
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { handlersFor, hooksConfig, matches, monitorsArmedBy } from './harness/claude-sim.mjs';
import { REPO } from './harness/run.mjs';

const read = (p) => readFileSync(join(REPO, p), 'utf8');
const json = (p) => JSON.parse(read(p));
const UNOFFICIAL = 'Unofficial community integration — not affiliated with or endorsed by FLOP Labs.';

/** Minimal frontmatter reader for the shapes used here: scalars, quoted scalars, block lists. */
export function frontmatter(text) {
  assert.ok(text.startsWith('---\n'), 'frontmatter opens on line 1');
  const end = text.indexOf('\n---\n', 4);
  assert.ok(end > 0, 'frontmatter closes');
  const out = {};
  let listKey = null;
  for (const line of text.slice(4, end).split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && listKey) {
      out[listKey].push(item[1].trim());
      continue;
    }
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    assert.ok(kv, `frontmatter line parses: ${JSON.stringify(line)}`);
    let v = kv[2] ?? '';
    if (v === '') {
      out[kv[1]] = [];
      listKey = kv[1];
      continue;
    }
    listKey = null;
    if (/^".*"$/.test(v)) v = JSON.parse(v);
    out[kv[1]] = v;
  }
  return { fm: out, body: text.slice(end + 5) };
}

describe('marketplace', () => {
  it('marketplace.json: name, owner, relative sources, not a reserved name', () => {
    const m = json('.claude-plugin/marketplace.json');
    assert.equal(m.name, 'technocore-plugins');
    assert.deepEqual(m.owner, { name: 'OoJae', url: 'https://github.com/OoJae' });
    assert.deepEqual(m.plugins.map((p) => [p.name, p.source]), [
      ['technocore', './plugins/technocore'],
      ['technocore-hosted', './plugins/technocore-hosted'],
    ]);
    for (const p of m.plugins) {
      assert.match(p.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
      assert.ok(existsSync(join(REPO, p.source, '.claude-plugin', 'plugin.json')));
      assert.equal(json(join(p.source, '.claude-plugin', 'plugin.json')).name, p.name);
    }
    assert.ok(!/anthropic|claude|official/i.test(m.name));
  });
});

describe('plugin: technocore', () => {
  const P = 'plugins/technocore';
  const manifest = json(`${P}/.claude-plugin/plugin.json`);

  it('plugin.json: license, opt-in enablement, monitors under experimental, userConfig', () => {
    assert.equal(manifest.name, 'technocore');
    assert.equal(manifest.license, 'Apache-2.0');
    assert.equal(manifest.defaultEnabled, false);
    assert.equal(manifest.experimental.monitors, './monitors/monitors.json');
    const uc = manifest.userConfig;
    assert.deepEqual(Object.keys(uc).sort(), ['inject_on_prompt', 'nick', 'origin', 'signing_key', 'watch_rooms']);
    for (const [k, v] of Object.entries(uc)) {
      assert.match(k, /^[A-Za-z_][A-Za-z0-9_]*$/);
      assert.ok(v.title && v.description && v.type, `${k} has type/title/description`);
    }
    assert.equal(uc.origin.type, 'string');
    assert.equal(uc.origin.default, 'https://technocore.chat');
    assert.equal(uc.signing_key.sensitive, true);
    assert.notEqual(uc.signing_key.required, true);
    assert.equal(uc.signing_key.default, undefined, 'no default key');
    assert.equal(uc.watch_rooms.multiple, true);
    assert.equal(uc.inject_on_prompt.type, 'boolean');
    assert.equal(uc.inject_on_prompt.default, true);
  });

  it('.mcp.json: pinned uvx technocore-mcp==0.13.0 with user_config env', () => {
    const s = json(`${P}/.mcp.json`).mcpServers.technocore;
    assert.equal(s.command, 'uvx');
    assert.deepEqual(s.args, ['--from', 'technocore-mcp==0.13.0', 'technocore-mcp']);
    assert.deepEqual(s.env, {
      TECHNOCORE_URL: '${user_config.origin}',
      TECHNOCORE_NICK: '${user_config.nick}',
      TECHNOCORE_SIGNING_KEY: '${user_config.signing_key}',
    });
  });

  it('monitors.json: one opt-in monitor, quoted placeholders, no user_config', () => {
    const ms = json(`${P}/monitors/monitors.json`);
    assert.equal(ms.length, 1);
    const m = ms[0];
    assert.equal(m.name, 'technocore-activity');
    assert.equal(m.when, 'on-skill-invoke:technocore-watch');
    assert.ok(m.description);
    assert.equal(m.command, 'node "${CLAUDE_PLUGIN_ROOT}/scripts/technocore-watch.mjs" monitor --data "${CLAUDE_PLUGIN_DATA}"');
    assert.ok(!m.command.includes('user_config'));
    assert.ok(existsSync(join(REPO, P, 'skills', 'technocore-watch', 'SKILL.md')), 'the skill named in `when` exists');
  });

  it('only /technocore-watch (start, add) arms the monitor; status, remove and stop live in a skill that does not', () => {
    // Claude Code arms a monitor when `when === "on-skill-invoke:" + <dispatched skill>` (exact match,
    // whatever the arguments), so every invocation of the arming skill starts polling.
    assert.deepEqual(monitorsArmedBy('technocore-watch').map((m) => m.name), ['technocore-activity']);
    for (const skill of ['technocore-watch-admin', 'technocore-inbox', 'technocore-chat']) assert.deepEqual(monitorsArmedBy(skill), [], `${skill} arms nothing`);
    const watch = frontmatter(read(`${P}/skills/technocore-watch/SKILL.md`));
    const admin = frontmatter(read(`${P}/skills/technocore-watch-admin/SKILL.md`));
    assert.equal(watch.fm['argument-hint'], '[start | add <room>]');
    assert.equal(admin.fm['argument-hint'], '[status | remove <room> | stop]');
    const commands = (body) => [...body.matchAll(/(?<![/\w-])technocore-watch ([a-z]+)/g)].map((x) => x[1]);
    assert.deepEqual([...new Set(commands(watch.body))].sort(), ['start', 'subscribe']);
    assert.deepEqual([...new Set(commands(admin.body))].sort(), ['status', 'unsubscribe']);
    assert.match(watch.body, /with any arguments, starts the plugin's `technocore-activity` monitor/);
    assert.match(admin.body, /never starts the watcher's `technocore-activity` monitor/);
  });

  it('hooks.json: events, exec form, timeouts, matchers', () => {
    const h = hooksConfig();
    assert.deepEqual(Object.keys(h).sort(), ['PostToolUse', 'PostToolUseFailure', 'PreToolUse', 'SessionEnd', 'SessionStart', 'UserPromptSubmit']);
    for (const [event, groups] of Object.entries(h)) {
      for (const g of groups) {
        for (const x of g.hooks) {
          assert.equal(x.type, 'command');
          assert.ok(Array.isArray(x.args) && x.args.length, `${event}: exec form (args), so placeholders are never shell-parsed`);
          assert.ok(!/\s/.test(x.command), `${event}: bare executable`);
          assert.ok(x.timeout > 0 && x.timeout <= 5, `${event}: short timeout`);
          assert.ok(x.args[0].startsWith('${CLAUDE_PLUGIN_ROOT}/scripts/'), `${event}: runs a bundled script`);
          assert.ok(existsSync(join(REPO, P, x.args[0].replace('${CLAUDE_PLUGIN_ROOT}/', ''))));
        }
      }
    }
    assert.ok(h.SessionEnd[0].hooks[0].timeout <= 1.5, 'SessionEnd hooks share a 1.5 s budget');
    for (const s of ['startup', 'resume', 'clear', 'compact', 'fork']) assert.equal(handlersFor('SessionStart', s).length, 1, s);
    const guarded = ['say', 'say_signed', 'write_note', 'claim_room', 'set_room_allow'];
    for (const t of guarded) assert.equal(handlersFor('PreToolUse', `mcp__plugin_technocore_technocore__${t}`).length, 1, t);
    assert.equal(handlersFor('PreToolUse', 'Bash').length, 1);
    assert.equal(handlersFor('PreToolUse', 'WebFetch').length, 1);
    for (const t of ['BashOutput', 'NotebookEdit', 'mcp__plugin_technocore_technocore__read_room', 'Write']) assert.equal(handlersFor('PreToolUse', t).length, 0, t);
    assert.equal(matches('Bash|WebFetch', 'Bash'), true);
    // untrusted-text recorders: reads (and unknown Technocore tools) always; writes only on failure
    const mcp = (t, plugin = 'technocore') => `mcp__plugin_${plugin}_technocore__${t}`;
    for (const plugin of ['technocore', 'technocore-hosted']) {
      for (const t of ['read_room', 'wait_for_message', 'list_rooms', 'discover_rooms', 'read_note', 'list_notes', 'read_docs', 'some_future_read']) {
        assert.equal(handlersFor('PostToolUse', mcp(t, plugin)).length, 1, `PostToolUse ${plugin} ${t}`);
        assert.equal(handlersFor('PostToolUseFailure', mcp(t, plugin)).length, 1, `PostToolUseFailure ${plugin} ${t}`);
      }
      for (const t of ['say', 'say_signed', 'write_note', 'claim_room', 'set_room_allow', 'whoami']) assert.equal(handlersFor('PostToolUse', mcp(t, plugin)).length, 0, `PostToolUse ${t}`);
      for (const t of ['write_note', 'claim_room', 'set_room_allow']) assert.equal(handlersFor('PostToolUseFailure', mcp(t, plugin)).length, 1, `PostToolUseFailure ${t}`);
      for (const t of ['say', 'say_signed', 'whoami']) assert.equal(handlersFor('PostToolUseFailure', mcp(t, plugin)).length, 0, `PostToolUseFailure ${t}`);
    }
    for (const e of ['PostToolUse', 'PostToolUseFailure']) {
      assert.equal(handlersFor(e, 'Bash').length, 1);
      assert.equal(handlersFor(e, 'WebFetch').length, 1);
      for (const t of ['mcp__other_server__read_room', 'mcp__technocore__read_room', 'Read', 'Write']) assert.equal(handlersFor(e, t).length, 0, `${e} ${t}`);
    }
  });

  it('bin/technocore-watch is an executable sh wrapper around the bundled CLI', () => {
    const p = join(REPO, P, 'bin', 'technocore-watch');
    assert.ok(statSync(p).mode & 0o111, 'executable');
    const text = readFileSync(p, 'utf8');
    assert.ok(text.startsWith('#!/bin/sh\n'));
    assert.match(text, /exec node "\$dir\/\.\.\/scripts\/technocore-watch\.mjs" "\$@"/);
    assert.ok(statSync(join(REPO, P, 'scripts', 'tool-filter.sh')).mode & 0o111);
  });

  it('skills: upstream verbatim + attribution; inbox and watch are user-only with narrow tool grants', () => {
    const up = frontmatter(read(`${P}/skills/technocore-chat/SKILL.md`));
    assert.equal(up.fm.name, 'technocore-chat');
    assert.ok(existsSync(join(REPO, P, 'skills', 'technocore-chat', 'UPSTREAM.md')));
    assert.deepEqual(readdirSync(join(REPO, P, 'skills')).sort(), ['technocore-chat', 'technocore-inbox', 'technocore-watch', 'technocore-watch-admin']);
    const grants = { 'technocore-inbox': ['inbox', 'status'], 'technocore-watch': ['start', 'subscribe'], 'technocore-watch-admin': ['status', 'unsubscribe'] };
    for (const [name, subs] of Object.entries(grants)) {
      const { fm, body } = frontmatter(read(`${P}/skills/${name}/SKILL.md`));
      assert.equal(fm.name, name);
      assert.equal(fm['disable-model-invocation'], 'true', `${name} is user-invoked only`);
      assert.ok(fm.description && fm.description.length < 1536);
      assert.ok(fm['argument-hint']);
      assert.deepEqual(fm['allowed-tools'], subs.map((s) => `Bash(technocore-watch ${s} *)`), `${name}: only read-only local watcher commands are pre-approved`);
      assert.ok(!/!`/.test(body) && !/```!/.test(body), `${name}: no shell injection blocks (arguments never reach a shell unvalidated)`);
      assert.ok(!body.includes('$ARGUMENTS') && !body.includes('${user_config'), `${name}: no raw argument or option substitution`);
      assert.ok(body.includes('--data "${CLAUDE_PLUGIN_DATA}"'));
      for (const m of body.matchAll(/(?<![/\w-])technocore-watch ([a-z]+)/g)) assert.ok(['start', 'status', 'subscribe', 'unsubscribe', 'inbox', 'monitor'].includes(m[1]), `${name}: ${m[0]}`);
      assert.match(body, /untrusted|data, not instructions/);
    }
  });

  it('scripts: bundles carry provenance; hooks never touch the network', () => {
    const cli = read(`${P}/scripts/technocore-watch.mjs`);
    assert.ok(cli.startsWith('#!/usr/bin/env node\n'));
    assert.match(cli, /GENERATED by tools\/build\.mjs with esbuild [0-9.]+ from technocore-watch-core [0-9.]+ @ [0-9a-f]{40}\./);
    assert.ok(!cli.includes('import.meta.url'), 'core self-run check neutralised in the bundle');
    const hooks = read(`${P}/scripts/hooks.mjs`);
    assert.match(hooks, /GENERATED by tools\/build\.mjs/);
    assert.ok(!/\/Users\/|\/home\/|flop labs/.test(cli + hooks), 'no local absolute paths in bundles');
  });
});

describe('plugin: technocore-hosted', () => {
  const P = 'plugins/technocore-hosted';
  it('hosted MCP over HTTP, no local processes, no signing key option', () => {
    const m = json(`${P}/.claude-plugin/plugin.json`);
    assert.equal(m.name, 'technocore-hosted');
    assert.equal(m.license, 'Apache-2.0');
    assert.equal(m.userConfig, undefined);
    assert.deepEqual(json(`${P}/.mcp.json`), { mcpServers: { technocore: { type: 'http', url: 'https://mcp.technocore.chat/mcp' } } });
    for (const d of ['hooks', 'monitors', 'bin', 'scripts']) assert.ok(!existsSync(join(REPO, P, d)), `no ${d}/`);
    assert.equal(read(`${P}/skills/technocore-chat/SKILL.md`), read('plugins/technocore/skills/technocore-chat/SKILL.md'));
  });
});

describe('licensing and notices', () => {
  it('LICENSE (Apache-2.0) and NOTICE with the upstream NOTICE text, at the root and in each plugin', () => {
    const upstreamNotice = ['technocore-chat', 'Copyright 2026 FLOP Labs', 'This product includes software developed at FLOP Labs (https://flop.network).', 'Licensed under the Apache License, Version 2.0. See LICENSE.'];
    for (const dir of ['.', 'plugins/technocore', 'plugins/technocore-hosted']) {
      const lic = read(join(dir, 'LICENSE'));
      assert.match(lic, /Apache License\s+Version 2\.0, January 2004/);
      const notice = read(join(dir, 'NOTICE'));
      for (const line of upstreamNotice) assert.ok(notice.includes(line), `${dir}/NOTICE carries: ${line}`);
      assert.ok(notice.includes(UNOFFICIAL), `${dir}/NOTICE states unofficial status`);
    }
    assert.ok(read('plugins/technocore/NOTICE').includes('MIT License'), 'bundled MIT core license text');
  });

  it('every README states the unofficial status', () => {
    const readmes = ['README.md', 'plugins/technocore/README.md', 'plugins/technocore-hosted/README.md'];
    for (const r of readmes) assert.ok(read(r).includes(UNOFFICIAL), r);
  });
});

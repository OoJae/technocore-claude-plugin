// A small simulation of how Claude Code runs this plugin's hooks and monitors, following
// code.claude.com/docs/en/hooks.md and plugins-reference.md (checked 2026-09-13, Claude Code 2.1.263):
//   * matcher: "*", "" or absent match all; only [A-Za-z0-9_| ,-] means an exact list split on | or ,;
//     anything else is an unanchored JavaScript RegExp.
//   * exec form (args present): no shell; ${CLAUDE_PLUGIN_ROOT}, ${CLAUDE_PLUGIN_DATA} and
//     ${user_config.KEY} are substituted into command and each arg as plain strings.
//   * shell form / monitors: the command runs through `sh -c` with path placeholders substituted.
//   * hook processes get CLAUDE_PLUGIN_ROOT, CLAUDE_PLUGIN_DATA and CLAUDE_PLUGIN_OPTION_<KEY>;
//     monitors get neither user_config substitution nor the option variables.
// It is not Claude Code; tests/validate.test.mjs runs the real validator on the same files.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanEnv, PLUGIN, runProcess } from './run.mjs';

export function matches(matcher, value) {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_|, -]+$/.test(matcher)) return matcher.split(/[|,]/).map((s) => s.trim()).includes(value);
  return new RegExp(matcher).test(value);
}

function substitute(s, ctx, { userConfig }) {
  let out = s.split('${CLAUDE_PLUGIN_ROOT}').join(ctx.root).split('${CLAUDE_PLUGIN_DATA}').join(ctx.data);
  if (userConfig) out = out.replace(/\$\{user_config\.([^}]+)\}/g, (_, k) => String(ctx.options?.[k] ?? ''));
  else if (/\$\{user_config\./.test(out)) throw new Error('user_config in a shell-run command is rejected by Claude Code');
  return out;
}

export function hooksConfig(root = PLUGIN) {
  return JSON.parse(readFileSync(join(root, 'hooks', 'hooks.json'), 'utf8')).hooks;
}

export function handlersFor(event, matchValue, root = PLUGIN) {
  const groups = hooksConfig(root)[event] ?? [];
  return groups.filter((g) => matches(g.matcher, matchValue)).flatMap((g) => g.hooks);
}

function optionEnv(options = {}) {
  const env = {};
  for (const [k, v] of Object.entries(options)) env[`CLAUDE_PLUGIN_OPTION_${k.toUpperCase()}`] = Array.isArray(v) ? v.join(',') : String(v);
  return env;
}

/**
 * Run every handler Claude Code would run for `event` (matched on `matchValue`) with `input` on
 * stdin. Returns the list of results (empty when no handler matched).
 */
export async function runEvent(event, matchValue, input, ctx) {
  const root = ctx.root ?? PLUGIN;
  const env = cleanEnv({ CLAUDE_PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: ctx.data, CLAUDE_PROJECT_DIR: ctx.project ?? root, ...optionEnv(ctx.options) });
  const body = typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify({ hook_event_name: event, ...input });
  const results = [];
  for (const h of handlersFor(event, matchValue, root)) {
    if (h.type !== 'command') throw new Error(`unexpected handler type ${h.type}`);
    const c = { root, data: ctx.data, options: ctx.options };
    const res = h.args
      ? await runProcess(substitute(h.command, c, { userConfig: true }), h.args.map((a) => substitute(a, c, { userConfig: true })), { input: body, env, timeoutMs: (h.timeout ?? 600) * 1000 })
      : await runProcess('sh', ['-c', substitute(h.command, c, { userConfig: false })], { input: body, env, timeoutMs: (h.timeout ?? 600) * 1000 });
    results.push({ ...res, handler: h });
  }
  return results;
}

/** Spawn a monitor from monitors.json the way Claude Code does: `sh -c <command>` in the project dir. */
export function spawnMonitor(name, ctx) {
  const root = ctx.root ?? PLUGIN;
  const monitors = JSON.parse(readFileSync(join(root, 'monitors', 'monitors.json'), 'utf8'));
  const m = monitors.find((x) => x.name === name);
  if (!m) throw new Error(`no monitor ${name}`);
  const command = substitute(m.command, { root, data: ctx.data }, { userConfig: false });
  const env = cleanEnv({ CLAUDE_PROJECT_DIR: ctx.project ?? root, ...(ctx.env ?? {}) });
  const p = spawn('sh', ['-c', command], { cwd: ctx.project ?? root, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  const state = { out: '', err: '' };
  p.stdout.on('data', (d) => (state.out += d.toString('utf8')));
  p.stderr.on('data', (d) => (state.err += d.toString('utf8')));
  const exited = new Promise((r) => p.on('close', (code, signal) => r({ code, signal })));
  return { p, state, exited, monitor: m, command };
}

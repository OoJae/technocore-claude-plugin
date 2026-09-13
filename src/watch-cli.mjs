// technocore-watch as shipped in the Claude Code plugin: the technocore-watch-core CLI, unmodified,
// plus plugin defaults. Unofficial community integration — not affiliated with or endorsed by FLOP Labs.
//
// What the wrapper adds (everything else is passed straight to the core CLI's main()):
//   * subscribe / unsubscribe / status / inbox: when --origin (and $TECHNOCORE_URL) are absent, the
//     origin comes from <data>/hooks-v1/plugin-config.json (written by the SessionStart hook from the
//     plugin's `origin` option); when --scope is absent, the scope key is that origin. One scope per
//     origin means changing the origin option never trips over state created for another origin.
//   * run / monitor: the same origin default, so a first poller creates its default scope for it.
//   * `technocore-watch start --data <dir>`: subscribe the rooms from the plugin's `watch_rooms`
//     option that have not been applied before (a room you later remove is not re-added), then
//     print status. Used by the /technocore-watch skill.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { main, parseArgs } from '@core/cli/main.ts';
import { DEFAULT_ORIGIN, normalizeOriginSafe, readPluginConfig } from './plugin-config.mjs';

const SCOPED = new Set(['subscribe', 'unsubscribe', 'status', 'inbox']);
const POLLERS = new Set(['run', 'monitor']);
const MAX_APPLIED_BYTES = 16 << 10;

function last(p, name) {
  const v = p.flags.get(name);
  return v ? v[v.length - 1] : undefined;
}

/** Extra flags go before a `--` separator so they are never read as positionals. */
function withFlags(argv, extra) {
  if (!extra.length) return argv;
  const i = argv.indexOf('--');
  return i < 0 ? [...argv, ...extra] : [...argv.slice(0, i), ...extra, ...argv.slice(i)];
}

function appliedPath(dataDir) {
  return join(dataDir, 'hooks-v1', 'watch-rooms-applied.json');
}

async function readApplied(dataDir) {
  try {
    const text = await fs.readFile(appliedPath(dataDir), 'utf8');
    if (text.length > MAX_APPLIED_BYTES) return {};
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || v.v !== 1 || typeof v.byOrigin !== 'object' || v.byOrigin === null) return {};
    const out = {};
    for (const [o, rooms] of Object.entries(v.byOrigin)) {
      if (normalizeOriginSafe(o) === o && Array.isArray(rooms)) out[o] = rooms.filter((r) => typeof r === 'string').slice(0, 64);
    }
    return out;
  } catch {
    return {};
  }
}

async function writeApplied(dataDir, byOrigin) {
  const dir = join(dataDir, 'hooks-v1');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = appliedPath(dataDir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ v: 1, byOrigin }) + '\n', { mode: 0o600, flag: 'wx' });
  await fs.rename(tmp, path);
}

async function start(dataDir, origin, cfg, io) {
  if (!cfg) io.err(`technocore-watch start: no plugin config in ${JSON.stringify(dataDir)} yet (it is written at session start); using origin ${origin} and no watch_rooms`);
  const byOrigin = await readApplied(dataDir);
  const applied = byOrigin[origin] ?? [];
  let code = 0;
  for (const room of cfg?.watchRooms ?? []) {
    if (applied.includes(room)) continue;
    const c = await main(['subscribe', room, '--data', dataDir, '--origin', origin, '--scope', origin], io);
    if (c === 0) {
      applied.push(room);
      byOrigin[origin] = applied;
      await writeApplied(dataDir, byOrigin);
    } else {
      code = c;
    }
  }
  const s = await main(['status', '--data', dataDir, '--origin', origin, '--scope', origin], io);
  return code || s;
}

export async function pluginMain(argv, io) {
  let p;
  try {
    p = parseArgs(argv);
  } catch {
    return main(argv, io); // the core CLI reports the usage error
  }
  const dataDir = last(p, 'data') ?? io.env.TECHNOCORE_WATCH_DATA;
  const cfg = dataDir ? await readPluginConfig(dataDir) : null;
  const explicit = last(p, 'origin') ?? io.env.TECHNOCORE_URL;
  const origin = normalizeOriginSafe(explicit ?? cfg?.origin ?? DEFAULT_ORIGIN);
  if (p.command === 'start') {
    if (!dataDir) {
      io.err('technocore-watch start needs --data <dir>');
      return 2;
    }
    if (!origin) {
      io.err('technocore-watch start: invalid origin');
      return 2;
    }
    return start(dataDir, origin, cfg, io);
  }
  if (origin && (SCOPED.has(p.command) || POLLERS.has(p.command))) {
    const extra = [];
    if (explicit === undefined) extra.push('--origin', origin);
    if (SCOPED.has(p.command) && !p.flags.has('scope')) extra.push('--scope', origin);
    return main(withFlags(argv, extra), io);
  }
  if (p.command === 'help' || last(p, 'help') === 'true' || !p.command) {
    const code = await main(argv, io);
    io.out('\nplugin additions: `technocore-watch start --data <dir>` subscribes the plugin\'s watch_rooms; subscribe/unsubscribe/status/inbox default --origin to the plugin origin and --scope to that origin.');
    return code;
  }
  return main(argv, io);
}

{
  const ctrl = new AbortController();
  const onSignal = () => ctrl.abort();
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  pluginMain(process.argv.slice(2), {
    out: (s) => process.stdout.write(s + '\n'),
    err: (s) => process.stderr.write(s + '\n'),
    env: process.env,
    stopSignal: ctrl.signal,
  }).then(
    (code) => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`technocore-watch: ${String(e)}\n`);
      process.exitCode = 1;
    },
  );
}

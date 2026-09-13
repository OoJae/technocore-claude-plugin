// Plugin configuration shared by the hooks and the technocore-watch wrapper.
// Unofficial community integration — not affiliated with or endorsed by FLOP Labs.
//
// Claude Code exports userConfig values to hook processes only (CLAUDE_PLUGIN_OPTION_<KEY>);
// monitors and Bash commands never see them. The SessionStart hook therefore copies the two
// values the watcher needs (origin, watch_rooms) into <data>/hooks-v1/plugin-config.json, and
// the technocore-watch wrapper reads them from there. The signing key is never read or copied.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { isValidRoomName } from '@core/protocol/names.ts';

export const DEFAULT_ORIGIN = 'https://technocore.chat';
export const MAX_WATCH_ROOMS = 16;
const MAX_CONFIG_BYTES = 16 << 10;

/** Same rules as technocore-watch-core normalizeOrigin; undefined instead of throwing. */
export function normalizeOriginSafe(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return undefined;
  let u;
  try {
    u = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  if (u.username || u.password || u.search || u.hash) return undefined;
  return (u.origin + u.pathname).replace(/\/+$/, '');
}

/** watch_rooms as exported to hooks: a JSON array, or names separated by commas/whitespace. */
export function parseWatchRooms(raw) {
  if (raw === undefined || raw === null) return [];
  let items = [];
  const s = String(raw).slice(0, 8192).trim();
  if (!s) return [];
  if (s.startsWith('[')) {
    try {
      const v = JSON.parse(s);
      if (Array.isArray(v)) items = v.filter((x) => typeof x === 'string');
    } catch {
      items = [];
    }
  } else {
    items = s.split(/[\s,]+/);
  }
  const out = [];
  for (const it of items) {
    const name = it.trim();
    if (isValidRoomName(name) && !out.includes(name)) out.push(name);
    if (out.length >= MAX_WATCH_ROOMS) break;
  }
  return out;
}

export function configPath(dataDir) {
  return join(dataDir, 'hooks-v1', 'plugin-config.json');
}

export function configFromEnv(env) {
  return {
    v: 1,
    origin: normalizeOriginSafe(env.CLAUDE_PLUGIN_OPTION_ORIGIN) ?? DEFAULT_ORIGIN,
    watchRooms: parseWatchRooms(env.CLAUDE_PLUGIN_OPTION_WATCH_ROOMS),
  };
}

export async function readPluginConfig(dataDir) {
  try {
    const h = await fs.open(configPath(dataDir), 'r');
    try {
      const st = await h.stat();
      if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
      const v = JSON.parse(await h.readFile('utf8'));
      if (!v || typeof v !== 'object' || v.v !== 1) return null;
      const origin = normalizeOriginSafe(v.origin);
      if (!origin) return null;
      return { v: 1, origin, watchRooms: parseWatchRooms(JSON.stringify(Array.isArray(v.watchRooms) ? v.watchRooms : [])) };
    } finally {
      await h.close();
    }
  } catch {
    return null;
  }
}

/** Writes the config only when it changed (atomic tmp + rename, 0600). */
export async function writePluginConfig(dataDir, cfg) {
  const current = await readPluginConfig(dataDir);
  const next = { v: 1, origin: cfg.origin, watchRooms: cfg.watchRooms };
  if (current && JSON.stringify(current) === JSON.stringify(next)) return false;
  const dir = join(dataDir, 'hooks-v1');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = configPath(dataDir);
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(next) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, path);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  return true;
}

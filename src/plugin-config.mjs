// Plugin configuration shared by the hooks and the technocore-watch wrapper.
// Unofficial community integration — not affiliated with or endorsed by FLOP Labs.
//
// Claude Code exports userConfig values to hook processes only (CLAUDE_PLUGIN_OPTION_<KEY>);
// monitors and Bash commands never see them. The SessionStart hook therefore copies the two
// values the watcher needs (origin, watch_rooms) into <data>/hooks-v1/plugin-config.json, and
// the technocore-watch wrapper reads them from there. The signing key is never read or copied.
// An origin option that is set but unusable is recorded as an error, never replaced by the default.
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

/** Config errors. A configured-but-unusable origin never falls back to the public instance. */
export const CONFIG_ERROR_INVALID_ORIGIN = 'invalid-origin';
export const CONFIG_ERROR_UNREADABLE = 'unreadable-config';

/**
 * The watcher config from the hook environment. An unset or empty origin option means the
 * default (public) origin. A non-empty origin that is not a usable http(s) URL gives
 * `{origin: null, error: 'invalid-origin'}`: silently watching production instead would send the
 * watch_rooms names (possibly unguessable p- rooms) to a server the user did not choose.
 */
export function configFromEnv(env) {
  const raw = env.CLAUDE_PLUGIN_OPTION_ORIGIN;
  const watchRooms = parseWatchRooms(env.CLAUDE_PLUGIN_OPTION_WATCH_ROOMS);
  if (raw === undefined || raw === null || String(raw).trim() === '') return { v: 1, origin: DEFAULT_ORIGIN, watchRooms };
  const origin = normalizeOriginSafe(String(raw));
  if (!origin) return { v: 1, origin: null, error: CONFIG_ERROR_INVALID_ORIGIN, watchRooms };
  return { v: 1, origin, watchRooms };
}

/**
 * null when no config file exists yet. Otherwise either a usable config or
 * `{v: 1, origin: null, error, watchRooms}` (an invalid origin was configured, or the file is
 * unreadable, oversized, corrupt or from another version). Callers must not substitute a default
 * origin for an error config.
 */
export async function readPluginConfig(dataDir) {
  const unreadable = { v: 1, origin: null, error: CONFIG_ERROR_UNREADABLE, watchRooms: [] };
  let h;
  try {
    h = await fs.open(configPath(dataDir), 'r');
  } catch (e) {
    return e && e.code === 'ENOENT' ? null : unreadable;
  }
  try {
    const st = await h.stat();
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return unreadable;
    const v = JSON.parse(await h.readFile('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.v !== 1) return unreadable;
    const watchRooms = parseWatchRooms(JSON.stringify(Array.isArray(v.watchRooms) ? v.watchRooms : []));
    if (v.origin === null && v.error === CONFIG_ERROR_INVALID_ORIGIN) return { v: 1, origin: null, error: CONFIG_ERROR_INVALID_ORIGIN, watchRooms };
    const origin = normalizeOriginSafe(v.origin);
    if (!origin) return unreadable;
    return { v: 1, origin, watchRooms };
  } catch {
    return unreadable;
  } finally {
    await h.close().catch(() => undefined);
  }
}

/** Writes the config only when it changed (atomic tmp + rename, 0600). */
export async function writePluginConfig(dataDir, cfg) {
  const current = await readPluginConfig(dataDir);
  const next = cfg.error ? { v: 1, origin: null, error: cfg.error, watchRooms: cfg.watchRooms } : { v: 1, origin: cfg.origin, watchRooms: cfg.watchRooms };
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

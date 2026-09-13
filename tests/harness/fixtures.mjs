// Builders for technocore-watch data directories (state.json + notices.jsonl), matching the
// on-disk layout of technocore-watch-core's FileStateStore.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function scopeHash(scopeKey) {
  return createHash('sha256').update(scopeKey, 'utf8').digest('hex').slice(0, 16);
}

export function sub(room, o = {}) {
  return { room, headSeq: 0, notifiedSeq: 0, acceptedSeq: 0, gaps: [], status: 'active', generation: 1, ...o };
}

export async function writeScope(dataDir, scopeKey, origin, subscriptions, extra = {}) {
  const dir = join(dataDir, 'v1', scopeHash(scopeKey));
  await mkdir(dir, { recursive: true });
  const subs = {};
  for (const s of subscriptions) subs[s.room] = s;
  const state = { version: 1, origin, scopeKey, revision: 3, subscriptions: subs, updatedAt: '2026-09-13T12:00:00.000Z', ...extra };
  await writeFile(join(dir, 'state.json'), JSON.stringify(state, null, 1));
  return dir;
}

export async function writeRawState(dataDir, scopeKey, text) {
  const dir = join(dataDir, 'v1', scopeHash(scopeKey));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'state.json'), text);
  return dir;
}

let counter = 0;
export function notice(origin, scopeKey, rooms, createdAt = new Date().toISOString()) {
  counter++;
  return {
    id: `tcw-test-${String(counter).padStart(4, '0')}`,
    scopeKey,
    createdAt,
    rooms,
    totalNew: rooms.reduce((a, r) => a + (r.newCount ?? 0), 0),
    provenance: { origin, transport: 'http-longpoll', watcher: 'technocore-watch-core', fetchedAt: createdAt },
  };
}

export function noticeRoom(room, newCount, seqFrom, seqTo, o = {}) {
  return { room, generation: 1, newCount, seqFrom, seqTo, gaps: [], signedSenders: 0, unsignedSenders: 1, ...o };
}

export async function appendNotice(dataDir, scopeKey, n) {
  const dir = join(dataDir, 'v1', scopeHash(scopeKey));
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, 'notices.jsonl'), (typeof n === 'string' ? n : JSON.stringify(n)) + '\n');
}

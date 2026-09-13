#!/usr/bin/env node
// Keeps the bundled upstream SKILL.md copies verbatim and pinned.
// Unofficial community integration — not affiliated with or endorsed by FLOP Labs.
//
//   node tools/sync-skill.mjs --check
//       Every copy listed in tools/skill-pin.json must have the pinned git blob id (so it is
//       byte-identical to SKILL.md at the pinned commit). When a technocore-chat checkout is
//       available ($TECHNOCORE_CHECKOUT or ../.cache/technocore-chat) the file is also compared
//       with `git show <commit>:SKILL.md` from that checkout. Offline; exit 1 on any mismatch.
//
//   node tools/sync-skill.mjs --live
//       Read-only drift report: fetches the served skill (https://technocore.chat/skill.md) and the
//       file on the upstream default branch, and says whether either differs from the pin.
//       Exit 0 = no drift, 3 = drift (informational; a human decides whether to re-pin).
//
//   node tools/sync-skill.mjs --update --commit <sha> [--checkout <dir>]
//       Re-pin: copy SKILL.md from that commit of a local checkout into every copy, then update
//       tools/skill-pin.json and the UPSTREAM.md tables. Review the diff before committing.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinPath = join(repo, 'tools', 'skill-pin.json');

export function gitBlobId(buf) {
  return createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function findCheckout() {
  const c = [arg('checkout'), process.env.TECHNOCORE_CHECKOUT, resolve(repo, '..', '.cache', 'technocore-chat')].filter(Boolean);
  return c.find((d) => existsSync(join(d, '.git')) || existsSync(join(d, 'HEAD'))) ?? null;
}

function showAt(checkout, commit, path) {
  return execFileSync('git', ['show', `${commit}:${path}`], { cwd: checkout, maxBuffer: 16 << 20 });
}

function check(pin) {
  let bad = 0;
  const checkout = findCheckout();
  let upstream = null;
  if (checkout) {
    try {
      upstream = showAt(checkout, pin.commit, pin.path);
    } catch {
      console.warn(`sync-skill: checkout at ${checkout} does not have ${pin.commit.slice(0, 12)}; comparing blob ids only`);
    }
  }
  if (upstream && gitBlobId(upstream) !== pin.blob) {
    console.error(`sync-skill: pin is inconsistent: ${pin.path} at ${pin.commit.slice(0, 12)} has blob ${gitBlobId(upstream)}, pin says ${pin.blob}`);
    bad++;
  }
  for (const rel of pin.copies) {
    const p = join(repo, rel);
    if (!existsSync(p)) {
      console.error(`sync-skill: missing ${rel}`);
      bad++;
      continue;
    }
    const buf = readFileSync(p);
    const id = gitBlobId(buf);
    if (id !== pin.blob) {
      console.error(`sync-skill: ${rel} is not the pinned upstream file (blob ${id}, expected ${pin.blob}); it must stay verbatim`);
      bad++;
    } else if (upstream && !buf.equals(upstream)) {
      console.error(`sync-skill: ${rel} differs from ${pin.path}@${pin.commit.slice(0, 12)}`);
      bad++;
    }
  }
  if (bad) process.exit(1);
  console.log(`sync-skill --check: ${pin.copies.length} copies match ${pin.path}@${pin.commit.slice(0, 12)} (blob ${pin.blob.slice(0, 12)})${upstream ? ', verified against the local checkout' : ''}`);
}

async function fetchText(url) {
  const res = await fetch(url, { method: 'GET', headers: { 'user-agent': 'technocore-claude-plugin sync-skill (read-only)' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function live(pin) {
  const pinned = readFileSync(join(repo, pin.copies[0]));
  const sources = [
    ['served', pin.served],
    ['upstream default branch', 'https://raw.githubusercontent.com/flop-labs/technocore-chat/HEAD/SKILL.md'],
  ];
  let drift = 0;
  for (const [label, url] of sources) {
    try {
      const body = await fetchText(url);
      const same = body.equals(pinned);
      console.log(`sync-skill --live: ${label} (${url}): ${same ? 'identical to pin' : `DIFFERS (blob ${gitBlobId(body).slice(0, 12)})`}`);
      if (!same) drift++;
    } catch (e) {
      console.log(`sync-skill --live: ${label}: could not fetch (${e.message})`);
    }
  }
  process.exit(drift ? 3 : 0);
}

function update(pin) {
  const commit = arg('commit');
  const checkout = findCheckout();
  if (!commit || !/^[0-9a-f]{40}$/.test(commit) || !checkout) {
    console.error('sync-skill --update needs --commit <40-hex sha> and a checkout (--checkout <dir> or $TECHNOCORE_CHECKOUT)');
    process.exit(2);
  }
  const buf = showAt(checkout, commit, pin.path);
  const blob = gitBlobId(buf);
  for (const rel of pin.copies) {
    writeFileSync(join(repo, rel), buf);
    const upstreamMd = join(dirname(join(repo, rel)), 'UPSTREAM.md');
    if (existsSync(upstreamMd)) {
      const text = readFileSync(upstreamMd, 'utf8').split(pin.commit).join(commit).split(pin.blob).join(blob);
      writeFileSync(upstreamMd, text);
    }
  }
  writeFileSync(pinPath, JSON.stringify({ ...pin, commit, blob }, null, 2) + '\n');
  console.log(`sync-skill --update: pinned ${pin.path}@${commit.slice(0, 12)} (blob ${blob.slice(0, 12)}); review UPSTREAM.md release notes by hand`);
}

const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
if (process.argv.includes('--update')) update(pin);
else if (process.argv.includes('--live')) await live(pin);
else check(pin);

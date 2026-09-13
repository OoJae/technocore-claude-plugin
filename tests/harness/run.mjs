// Spawn helpers for the shipped plugin scripts.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PLUGIN = join(REPO, 'plugins', 'technocore');
export const HOOKS = join(PLUGIN, 'scripts', 'hooks.mjs');

/** Environment without any inherited Claude/Technocore variables, so tests are hermetic. */
export function cleanEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CLAUDE_|TECHNOCORE_)/.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export function runProcess(cmd, args, { input, env, cwd, timeoutMs = 20_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const started = process.hrtime.bigint();
    const p = spawn(cmd, args, { env: env ?? cleanEnv(), cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => err.push(d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', reject);
    p.on('close', (code, signal) => {
      clearTimeout(t);
      resolvePromise({
        code,
        signal,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        ms: Number(process.hrtime.bigint() - started) / 1e6,
      });
    });
    p.stdin.on('error', () => undefined); // a hook may exit before reading all of a huge input
    if (input === undefined) p.stdin.end();
    else p.stdin.end(input);
  });
}

export function runHook(command, input, env) {
  const body = input === undefined ? '' : typeof input === 'string' || Buffer.isBuffer(input) ? input : JSON.stringify(input);
  return runProcess(process.execPath, [HOOKS, command], { input: body, env: cleanEnv(env) });
}

export async function tempDir(prefix = 'tcp test ') {
  const path = await mkdtemp(join(tmpdir(), prefix));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(pred, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms`);
    await sleep(stepMs);
  }
}

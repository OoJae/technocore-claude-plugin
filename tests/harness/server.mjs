// Disposable LOCAL technocore-chat server for integration tests (port of technocore-watch-core's
// harness). Never points at production: it binds 127.0.0.1 with a throwaway CHAT_ROOT.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const live = new Set();
process.once('exit', () => {
  for (const c of live) {
    try {
      process.kill(-c.pid, 'SIGKILL');
    } catch {
      // gone
    }
  }
});

export function findCheckout() {
  const candidates = [process.env.TECHNOCORE_CHECKOUT, resolve(here, '..', '..', '..', '.cache', 'technocore-chat')].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(join(c, 'src', 'app.py')) && existsSync(join(c, 'pyproject.toml'))) return c;
  }
  throw new Error('technocore-chat checkout not found: set TECHNOCORE_CHECKOUT to a clone at 20a4457 with `uv sync --frozen` done, or place it at ../.cache/technocore-chat');
}

function portFree(port) {
  return new Promise((res) => {
    const srv = net.createServer();
    srv.once('error', () => res(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => res(true)));
  });
}

async function freePort() {
  for (let i = 0; i < 200; i++) {
    const port = 20000 + Math.floor(Math.random() * 40000);
    if (await portFree(port)) return port;
  }
  throw new Error('no free port in 20000-60000');
}

function healthy(port) {
  return new Promise((res) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/healthz', agent: false, timeout: 1000 }, (r) => {
      r.resume();
      res(r.statusCode === 200);
    });
    req.on('error', () => res(false));
    req.on('timeout', () => {
      req.destroy();
      res(false);
    });
  });
}

export async function startTechnocore(o = {}) {
  const checkout = findCheckout();
  const root = await mkdtemp(join(tmpdir(), 'tcp-root-'));
  const port = await freePort();
  let output = '';
  const env = {
    ...process.env,
    CHAT_ROOT: root,
    CHAT_RATE_READ: '1000000',
    CHAT_RATE_WRITE: '1000000',
    CHAT_RATE_ROOMS_PER_DAY: '1000000',
    CHAT_DUPE_FILTER_SECONDS: '0',
    CHAT_EDGE_CACHE_SECONDS: '0',
    CHAT_FSYNC: '0',
    CHAT_WAIT_POLL: String(o.waitPoll ?? 0.1),
    PYTHONDONTWRITEBYTECODE: '1',
    UV_NO_PROGRESS: '1',
  };
  const child = spawn('uv', ['run', 'uvicorn', '--app-dir', 'src', 'app:app', '--host', '127.0.0.1', '--port', String(port), '--log-level', 'warning'], {
    cwd: checkout,
    env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  live.add(child);
  const onData = (d) => (output = (output + d.toString('utf8')).slice(-20000));
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  const exited = new Promise((r) => child.once('exit', () => {
    live.delete(child);
    r();
  }));
  const deadline = Date.now() + 90_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`technocore server exited early (${child.exitCode}):\n${output}`);
    if (await healthy(port)) break;
    if (Date.now() > deadline) throw new Error(`technocore server not healthy on :${port}\n${output}`);
    await new Promise((r) => setTimeout(r, 150));
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    root,
    async dispose() {
      if (child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // gone
        }
        const t = setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // gone
          }
        }, 5000);
        await exited;
        clearTimeout(t);
      }
      await rm(root, { recursive: true, force: true });
    },
    logs: () => output,
  };
}

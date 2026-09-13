// MCP over stdio for tests: spawn a server command, initialize, send requests.
import { spawn } from 'node:child_process';
import { cleanEnv } from './run.mjs';

export function substitute(value, options) {
  return value.replace(/\$\{user_config\.([^}]+)\}/g, (_, k) => String(options[k] ?? ''));
}

/** Run `fn` inside an initialized MCP session with cfg (a .mcp.json server entry) and option values. */
export async function session(cfg, options, fn) {
  const env = cleanEnv({ UV_NO_PROGRESS: '1' });
  for (const [k, v] of Object.entries(cfg.env)) env[k] = substitute(v, options);
  const p = spawn(cfg.command, cfg.args.map((a) => substitute(a, options)), { env, stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  let err = '';
  const waiters = new Map();
  p.stderr.on('data', (d) => (err += d));
  p.stdout.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  let next = 1;
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = next++;
      const t = setTimeout(() => reject(new Error(`${method} timed out; stderr: ${err.slice(-2000)}`)), 90_000);
      waiters.set(id, (m) => {
        clearTimeout(t);
        resolve(m);
      });
      p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'technocore-claude-plugin-test', version: '0' } });
    notify('notifications/initialized', {});
    return await fn({ init, request });
  } finally {
    p.stdin.end();
    p.kill('SIGTERM');
  }
}


// Test writer: posts directly to the LOCAL test server only. Signed posts use a fixed PUBLIC
// TEST-ONLY seed (32 bytes of 0x01) built in code; it must never be used for anything real.
import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import * as http from 'node:http';

function assertLocal(origin) {
  const u = new URL(origin);
  if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') throw new Error(`writer refuses non-local origin ${origin}`);
  return u;
}

export function postJson(origin, room, body) {
  const u = assertLocal(origin);
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: u.hostname, port: u.port, method: 'POST', path: `/r/${room}?format=json`, agent: false, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

export async function post(origin, room, text, from = 'writer') {
  const r = await postJson(origin, room, { from, text });
  if (r.status !== 200) throw new Error(`post failed ${r.status}: ${r.text.slice(0, 200)}`);
  return JSON.parse(r.text).posted.seq;
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58(bytes) {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}

/** Same single-line sweep as the server: Cc Cf Cs Co Zl Zp -> space, then trim. */
export function sweep(text) {
  return text.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/gu, ' ').trim();
}

export function testIdentity() {
  const seed = Buffer.alloc(32, 1); // PUBLIC TEST-ONLY seed
  const pkcs8 = Buffer.concat([Buffer.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]), seed]);
  const key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  const pub = Buffer.from(createPublicKey(key).export({ format: 'jwk' }).x, 'base64url');
  return { key, did: `did:key:z${base58(Buffer.concat([Buffer.from([0xed, 0x01]), pub]))}` };
}

let lastNonce = 0;
export async function postSigned(origin, room, text) {
  const { key, did } = testIdentity();
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  const nonce = String(lastNonce);
  const sig = sign(null, Buffer.from(`${room}|${nonce}|${sweep(text)}`, 'utf8'), key).toString('base64url');
  const r = await postJson(origin, room, { did, sig, nonce, text });
  if (r.status !== 200) throw new Error(`signed post failed ${r.status}: ${r.text.slice(0, 300)}`);
  return JSON.parse(r.text).posted.seq;
}

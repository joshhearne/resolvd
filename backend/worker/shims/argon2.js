// Drop-in for the native `argon2` package in the Workers bundle (aliased
// in wrangler.toml). Workers can't load native addons or compile Wasm
// from bytes at runtime, so this uses @noble/hashes' pure-JS argon2id.
//
// Hashes are standard PHC strings, identical in format to node-argon2's,
// so hashes written by either runtime verify in the other.
import { argon2d as kdfD, argon2i as kdfI, argon2id as kdfId } from '@noble/hashes/argon2.js';

// Same numeric type constants node-argon2 exports.
export const argon2d = 0;
export const argon2i = 1;
export const argon2id = 2;

const VARIANTS = { argon2d: kdfD, argon2i: kdfI, argon2id: kdfId };
const TYPE_NAMES = ['argon2d', 'argon2i', 'argon2id'];

// New hashes use OWASP's argon2id baseline (19 MiB, t=2, p=1) instead of
// node-argon2's 64 MiB default: pure JS is slower than native, and the
// isolate has a 128 MB memory ceiling. verify() always uses the params
// stored in the hash, so existing 64 MiB hashes still verify.
const DEFAULTS = { memoryCost: 19456, timeCost: 2, parallelism: 1, hashLength: 32, saltLength: 16 };

const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const utf8 = (s) => new TextEncoder().encode(s);

export async function hash(plain, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const name = TYPE_NAMES[o.type ?? argon2id];
  const salt = o.salt || crypto.getRandomValues(new Uint8Array(o.saltLength));
  const out = await VARIANTS[name](utf8(plain), salt, {
    t: o.timeCost, m: o.memoryCost, p: o.parallelism, dkLen: o.hashLength, version: 0x13,
  });
  return `$${name}$v=19$m=${o.memoryCost},t=${o.timeCost},p=${o.parallelism}$${b64(salt)}$${b64(out)}`;
}

export async function verify(digest, plain) {
  // $<type>$v=<n>$<k=v,...>$<salt>$<hash>. node-argon2 writes params as
  // m,p,t, so read them as a set rather than by position.
  const m = /^\$(argon2(?:id|i|d))\$v=(\d+)\$([a-z]=\d+(?:,[a-z]=\d+)*)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(digest || '');
  if (!m) throw new TypeError('Invalid hash format');
  const [, name, v, paramStr, saltB64, hashB64] = m;
  const params = Object.fromEntries(paramStr.split(',').map((kv) => kv.split('=')));
  if (!params.m || !params.t || !params.p) throw new TypeError('Invalid hash format');
  const expected = unb64(hashB64);
  const out = await VARIANTS[name](utf8(plain), unb64(saltB64), {
    t: Number(params.t), m: Number(params.m), p: Number(params.p), dkLen: expected.length, version: Number(v),
  });
  let diff = out.length ^ expected.length;
  for (let i = 0; i < out.length; i++) diff |= out[i] ^ expected[i];
  return diff === 0;
}

// Mirrors node-argon2: true when the hash's params differ from the ones
// hash() would use now.
export function needsRehash(digest, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const m = /\$v=(\d+)\$([a-z]=\d+(?:,[a-z]=\d+)*)\$/.exec(digest || '');
  if (!m) return true;
  const params = Object.fromEntries(m[2].split(',').map((kv) => kv.split('=')));
  return Number(m[1]) !== 0x13
    || Number(params.m) !== o.memoryCost
    || Number(params.t) !== o.timeCost
    || Number(params.p) !== o.parallelism;
}

export default { hash, verify, needsRehash, argon2d, argon2i, argon2id };

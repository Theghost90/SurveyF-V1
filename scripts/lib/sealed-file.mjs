/**
 * Sealed files: how a database backup is encrypted (DAT-02). A backup is a copy of everything, so it is the most valuable thing an attacker could carry off:
 * it is encrypted as it is written (the plain dump never touches the disk) with AES-256-GCM, in chunks, so that even a very large dump is processed in constant memory
 * and every chunk is authenticated.
 *
 *   header  "SFBK1\n" | key-id length (1 byte) | key id | 8 random bytes (the nonce prefix)
 *   chunk   4 bytes: (last chunk ? 0x80000000 : 0) | length of what follows, then the ciphertext followed by its 16-byte tag
 *   nonce   the 8 random bytes followed by the chunk number (4 bytes): never reused under a key
 *   AAD     the header, the chunk number and the "last" flag: a chunk cannot be moved, repeated, cut off, or marked as the last one by somebody else
 *
 * What that buys: a changed byte, a swapped or duplicated chunk, a missing end (a truncated copy) and a trailing byte are all refused when the file is opened; none
 * of them can produce a half-restored database that looks fine. What it does not buy: secrecy of the file's SIZE, or protection when the key is stolen with the file.
 * Keys: `BACKUP_KEYS=kid:key,kid:key` (32 bytes each, base64 or hex). The first one seals; all of them open, so a key can be replaced without losing the old backups.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export const MAGIC = Buffer.from('SFBK1\n', 'latin1');
export const CHUNK = 1024 * 1024;
const TAG = 16;
const LAST = 0x80000000;

/** `kid:key,kid:key` to a ring. Throws a sentence a person can act on, never with the key in it. */
export function parseKeyRing(spec) {
  const entries = String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!entries.length) throw new Error('BACKUP_KEYS is empty. Make one with: node scripts/backup.mjs --new-key');
  const keys = new Map();
  for (const entry of entries) {
    const i = entry.indexOf(':');
    const kid = i > 0 ? entry.slice(0, i) : '';
    const raw = i > 0 ? entry.slice(i + 1) : '';
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(kid)) throw new Error('BACKUP_KEYS: each entry is name:key, the name made of letters, digits, - or _ (at most 32)');
    const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
    if (key.length !== 32) throw new Error(`BACKUP_KEYS: the key named "${kid}" is not 32 bytes (use: openssl rand -base64 32)`);
    if (keys.has(kid)) throw new Error(`BACKUP_KEYS: the name "${kid}" is used twice`);
    keys.set(kid, key);
  }
  return { active: [...keys][0], keys };
}

export const newKeyLine = (kid = `b${new Date().getFullYear()}`) => `${kid}:${randomBytes(32).toString('base64')}`;

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };
const aad = (header, index, last) => Buffer.concat([header, u32(index), Buffer.from([last ? 1 : 0])]);
const nonce = (prefix, index) => Buffer.concat([prefix, u32(index)]);

/** Turns a stream of plain bytes into the sealed bytes. `chunk` is only for tests. */
export async function* seal(source, ring, { chunk = CHUNK } = {}) {
  const [kid, key] = ring.active;
  const prefix = randomBytes(8);
  const header = Buffer.concat([MAGIC, Buffer.from([Buffer.byteLength(kid)]), Buffer.from(kid), prefix]);
  yield header;
  let index = 0;
  const one = (plain, last) => {
    const c = createCipheriv('aes-256-gcm', key, nonce(prefix, index), { authTagLength: TAG });
    c.setAAD(aad(header, index, last));
    const body = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    index++;
    return Buffer.concat([u32((last ? LAST : 0) | body.length), body]);
  };
  let buffer = Buffer.alloc(0);
  for await (const part of source) {
    buffer = buffer.length ? Buffer.concat([buffer, part]) : Buffer.from(part);
    // keep at least one byte back: the chunk that ends the file must be marked as the last one, and only the end of the input says which that is
    while (buffer.length > chunk) { yield one(buffer.subarray(0, chunk), false); buffer = buffer.subarray(chunk); }
  }
  yield one(buffer, true);
}

/** Collects exactly `n` bytes from an async source (fewer only at its end). */
function reader(source) {
  const it = (source[Symbol.asyncIterator] ?? source[Symbol.iterator]).call(source); // a stream, or (in tests) a plain array of buffers
  let buffer = Buffer.alloc(0);
  return {
    async take(n) {
      while (buffer.length < n) {
        const { value, done } = await it.next();
        if (done) break;
        buffer = buffer.length ? Buffer.concat([buffer, value]) : Buffer.from(value);
      }
      const out = buffer.subarray(0, n);
      buffer = buffer.subarray(out.length);
      return out;
    },
  };
}

/** Turns sealed bytes back into plain bytes, refusing anything that is not exactly what `seal` wrote. */
export async function* open(source, ring) {
  const r = reader(source);
  const magic = await r.take(MAGIC.length);
  if (!magic.equals(MAGIC)) throw new Error('This is not a sealed SurveyFlow backup (or it is damaged at the start)');
  const kidLength = (await r.take(1))[0];
  const kidBytes = await r.take(kidLength ?? 0);
  const prefix = await r.take(8);
  if (kidBytes.length !== kidLength || prefix.length !== 8) throw new Error('The backup is cut off in its header');
  const kid = kidBytes.toString();
  const key = ring.keys.get(kid);
  if (!key) throw new Error(`The backup was sealed with the key named "${kid}", which is not in BACKUP_KEYS. Without that key it cannot be opened`);
  const header = Buffer.concat([MAGIC, Buffer.from([kidLength]), kidBytes, prefix]);
  for (let index = 0; ; index++) {
    const head = await r.take(4);
    if (head.length === 0) throw new Error('The backup is truncated: its end is missing');
    if (head.length < 4) throw new Error('The backup is cut off in the middle of a chunk');
    const word = head.readUInt32BE();
    const last = (word & LAST) !== 0;
    const length = word & ~LAST;
    if (length < TAG || length > CHUNK + TAG) throw new Error('The backup is damaged: a chunk has an impossible size');
    const body = await r.take(length);
    if (body.length < length) throw new Error('The backup is cut off in the middle of a chunk');
    const d = createDecipheriv('aes-256-gcm', key, nonce(prefix, index), { authTagLength: TAG });
    d.setAAD(aad(header, index, last));
    d.setAuthTag(body.subarray(length - TAG));
    let plain;
    try { plain = Buffer.concat([d.update(body.subarray(0, length - TAG)), d.final()]); }
    catch { throw new Error(`The backup is damaged or the key is wrong: chunk ${index} does not authenticate`); }
    if (plain.length) yield plain;
    if (last) {
      if ((await r.take(1)).length) throw new Error('The backup has extra bytes after its end');
      return;
    }
  }
}

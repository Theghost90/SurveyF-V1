import { createCipheriv, randomBytes, scryptSync } from 'node:crypto';
import bcrypt from 'bcryptjs';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { env } from '../src/config/env';
import { canonicalEmail, maskEmail } from '../src/lib/email';
import { hashPassword, isBreachedPassword, localPasswordProblem, verifyPassword } from '../src/lib/password';
import { phoneIndex, prisma, rawPrisma } from '../src/lib/prisma';
import { redis } from '../src/lib/redis';
import { base32Decode, base32Encode, matchTotp, newTotpSecret, otpauthUrl, stepNow, totpAt } from '../src/lib/totp';
import { makeApp, registerOwner, resetAll } from './helpers';

/** The encryption key ring is read when lib/crypto.ts loads, so a different ring means loading it again with a different environment. */
async function freshCrypto(over: Record<string, string>) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(over)) { saved[k] = process.env[k]; process.env[k] = v; }
  vi.resetModules();
  try { return await import('../src/lib/crypto'); } finally {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}
const newKey = () => randomBytes(32).toString('base64');

describe('encryption at rest: the key ring', () => {
  const k1 = newKey();
  const k2 = newKey();

  it('writes with the first key of the ring and names it in the payload', async () => {
    const c = await freshCrypto({ ENCRYPTION_KEYS: `k2:${k2},k1:${k1}` });
    const payload = c.encryptSecret('hello');
    expect(payload).toMatch(/^v2\.k2\.[\w-]{16}\.[\w-]{22}\./);
    expect(payload).not.toContain('hello');
    expect(c.decryptSecret(payload)).toBe('hello');
    expect(c.activeKeyId()).toBe('k2');
  });

  it('never repeats a ciphertext for the same text (fresh IV every time)', async () => {
    const c = await freshCrypto({ ENCRYPTION_KEYS: `k1:${k1}` });
    expect(new Set(Array.from({ length: 20 }, () => c.encryptSecret('same'))).size).toBe(20);
  });

  it('rotation: data written under the old key still reads while the old key is in the ring, and is flagged for re-encryption', async () => {
    const before = await freshCrypto({ ENCRYPTION_KEYS: `k1:${k1}` });
    const old = before.encryptSecret('+237677000001');
    const after = await freshCrypto({ ENCRYPTION_KEYS: `k2:${k2},k1:${k1}` });
    expect(after.decryptSecret(old)).toBe('+237677000001');
    expect(after.needsReEncryption(old)).toBe(true);
    const moved = after.encryptSecret(after.decryptSecret(old));
    expect(after.needsReEncryption(moved)).toBe(false);
    expect(moved.startsWith('v2.k2.')).toBe(true);
  });

  it('a key removed from the ring while data still uses it fails loudly instead of returning garbage', async () => {
    const before = await freshCrypto({ ENCRYPTION_KEYS: `k1:${k1}` });
    const old = before.encryptSecret('secret');
    const after = await freshCrypto({ ENCRYPTION_KEYS: `k2:${k2}` });
    expect(() => after.decryptSecret(old)).toThrow(/k1/);
  });

  it('a payload cannot be re-labelled as another key (the key id is authenticated)', async () => {
    const c = await freshCrypto({ ENCRYPTION_KEYS: `k2:${k2},k1:${k1}` });
    const p = c.encryptSecret('secret').split('.');
    p[1] = 'k1';
    expect(() => c.decryptSecret(p.join('.'))).toThrow();
  });

  it('any tampering with the data is detected', async () => {
    const c = await freshCrypto({ ENCRYPTION_KEYS: `k1:${k1}` });
    const p = c.encryptSecret('a long enough secret to flip a bit in').split('.');
    p[4] = (p[4]![0] === 'A' ? 'B' : 'A') + p[4]!.slice(1);
    expect(() => c.decryptSecret(p.join('.'))).toThrow();
    expect(() => c.decryptSecret('v2.k1.garbage')).toThrow();
    expect(() => c.decryptSecret('plain text')).toThrow();
  });

  it('still reads the older single-key format (TOKEN_ENCRYPTION_KEY) and marks it for re-encryption', async () => {
    const legacyKey = randomBytes(32);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', legacyKey, iv);
    const enc = Buffer.concat([cipher.update('legacy-token', 'utf8'), cipher.final()]);
    const v1 = ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), enc.toString('base64url')].join('.');
    const c = await freshCrypto({ TOKEN_ENCRYPTION_KEY: legacyKey.toString('hex'), ENCRYPTION_KEYS: `k1:${k1}` });
    expect(c.decryptSecret(v1)).toBe('legacy-token');
    expect(c.needsReEncryption(v1)).toBe(true);
    expect(c.isCiphertext(v1)).toBe(true);
  });

  it('recognises our ciphertexts by their exact shape: a plain value that merely starts with "v2." is not mistaken for one', async () => {
    const c = await freshCrypto({ ENCRYPTION_KEYS: `k1:${k1}` });
    expect(c.isCiphertext(c.encryptSecret('x'))).toBe(true);
    for (const plain of ['v2.k1.a.b.c', 'v2.Dupont', 'Jean-Paul', '+237677000001', '', 'v1.x.y.z']) expect(c.isCiphertext(plain), plain).toBe(false);
    expect(c.decryptIfEncrypted('v2.Dupont')).toBe('v2.Dupont');
    expect(c.needsReEncryption('plain')).toBe(true);
  });

  it('refuses a malformed ring', async () => {
    await expect(freshCrypto({ ENCRYPTION_KEYS: `bad key id:${k1}` })).rejects.toThrow(/ENCRYPTION_KEYS/);
    await expect(freshCrypto({ ENCRYPTION_KEYS: `k1:${k1},k1:${k2}` })).rejects.toThrow(/twice/);
    await expect(freshCrypto({ ENCRYPTION_KEYS: 'k1:tooshort' })).rejects.toThrow(/32 bytes/);
  });
});

describe('keyed hashes', () => {
  it('the number index is deterministic, separated by purpose and depends on the secret', async () => {
    const a = await freshCrypto({ BLIND_INDEX_KEY: newKey() });
    const b = await freshCrypto({ BLIND_INDEX_KEY: newKey() });
    expect(a.blindIndex('phone', '+237677000001')).toBe(a.blindIndex('phone', '+237677000001'));
    expect(a.blindIndex('phone', '+237677000001')).not.toBe(a.blindIndex('phone', '+237677000002'));
    expect(a.blindIndex('phone', '+237677000001')).not.toBe(a.blindIndex('email', '+237677000001'));
    expect(a.blindIndex('phone', '+237677000001')).not.toBe(b.blindIndex('phone', '+237677000001')); // a database leak without the key proves nothing
    expect(a.blindIndex('phone', '+237677000001')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('purpose subkeys differ per purpose', async () => {
    const { keyedHash } = await freshCrypto({});
    expect(keyedHash('recovery-code', 'ABCD')).not.toBe(keyedHash('stepup-code', 'ABCD'));
  });
});

describe('authenticator codes (RFC 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890')); // the RFC's SHA-1 test secret
  it('matches the published test vectors', () => {
    const vectors: Array<[number, string]> = [[59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'], [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130']];
    for (const [t, code] of vectors) expect(totpAt(secret, Math.floor(t / 30), 8), `T=${t}`).toBe(code);
  });
  it('six digits are the last six of the same value', () => {
    expect(totpAt(secret, 1)).toBe('287082');
  });
  it('accepts the current step and one either side (clock drift) and nothing else', () => {
    const now = 59_000; // step 1
    expect(matchTotp(secret, '287082', now)).toBe(1);
    expect(matchTotp(secret, '287082', now + 30_000)).toBe(1); // a step late
    expect(matchTotp(secret, '287082', now - 30_000)).toBe(1); // a step early
    expect(matchTotp(secret, '287082', now + 60_000)).toBeNull();
    expect(matchTotp(secret, '287083', now)).toBeNull();
    expect(matchTotp(secret, '28708', now)).toBeNull();
    expect(matchTotp(secret, '2870822', now)).toBeNull();
    expect(matchTotp(secret, 'abcdef', now)).toBeNull();
    expect(matchTotp(secret, '287 082', now)).toBe(1); // authenticator apps show it grouped
  });
  it('base32 round-trips and secrets are 160 bits', () => {
    const buf = randomBytes(20);
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
    expect(() => base32Decode('not base32 !')).toThrow();
  });
  it('builds the otpauth link authenticator apps scan', () => {
    const url = otpauthUrl('ABCDEFGH', 'jean@example.com');
    expect(url).toBe('otpauth://totp/SurveyFlow:jean%40example.com?secret=ABCDEFGH&issuer=SurveyFlow&algorithm=SHA1&digits=6&period=30');
    expect(stepNow(90_000)).toBe(3);
  });
});

describe('passwords', () => {
  it('are hashed with argon2id, with the OWASP minimum cost as the default', async () => {
    expect(await hashPassword('correct-horse-battery')).toMatch(/^\$argon2id\$/);
    const saved = { ...process.env };
    delete process.env.ARGON2_MEMORY_KIB; delete process.env.ARGON2_TIME_COST;
    vi.resetModules();
    const fresh = await import('../src/config/env');
    Object.assign(process.env, saved);
    expect(fresh.env.ARGON2_MEMORY_KIB).toBe(19456);
    expect(fresh.env.ARGON2_TIME_COST).toBe(2);
  });

  it('verify the right one, refuse the wrong one, and an absent account takes the same path without ever succeeding', async () => {
    const h = await hashPassword('correct-horse-battery');
    expect(await verifyPassword(h, 'correct-horse-battery')).toEqual({ ok: true, needsRehash: false });
    expect((await verifyPassword(h, 'wrong-horse-battery')).ok).toBe(false);
    expect((await verifyPassword(null, 'correct-horse-battery')).ok).toBe(false);
    expect((await verifyPassword('garbage-not-a-hash', 'x')).ok).toBe(false);
  });

  it('a hash from the older bcrypt days still verifies and is flagged for upgrade; so is an argon2id made with cheaper settings', async () => {
    const legacy = await bcrypt.hash('correct-horse-battery', 4);
    expect(await verifyPassword(legacy, 'correct-horse-battery')).toEqual({ ok: true, needsRehash: true });
    expect((await verifyPassword(legacy, 'nope')).needsRehash).toBe(false);
    const cheap = await hashPassword('correct-horse-battery');
    const saved = env.ARGON2_MEMORY_KIB;
    env.ARGON2_MEMORY_KIB = 4096;
    try { expect(await verifyPassword(cheap, 'correct-horse-battery')).toEqual({ ok: true, needsRehash: true }); } finally { env.ARGON2_MEMORY_KIB = saved; }
  });

  it('are not cut at 72 bytes (bcrypt would ignore everything after)', async () => {
    const long = 'a-very-long-passphrase-that-goes-well-past-seventy-two-bytes-of-input-XYZ-123';
    const h = await hashPassword(long);
    expect((await verifyPassword(h, long)).ok).toBe(true);
    expect((await verifyPassword(h, long.slice(0, 72))).ok).toBe(false);
  });

  it('policy: length 10 to 128, no common or patterned passwords, not your own address', () => {
    const bad: Array<[string, string, string?]> = [
      ['short1', 'password_too_short'], ['123456789', 'password_too_short'], ['', 'password_too_short'],
      ['x'.repeat(129), 'password_too_long'],
      ['password123', 'password_too_common'], ['Password123', 'password_too_common'], ['azerty123456', 'password_too_common'], ['motdepasse1', 'password_too_common'],
      ['cameroun237', 'password_too_common'], ['surveyflow1', 'password_too_common'], ['1234567890', 'password_too_common'], ['aaaaaaaaaa', 'password_too_common'],
      ['abcdefghijkl', 'password_too_common'], ['9876543210', 'password_too_common'], ['abcabcabcabc', 'password_too_common'],
      ['jeanpaul-secret', 'password_contains_email', 'jeanpaul@example.com'],
    ];
    for (const [pw, problem, email] of bad) expect(localPasswordProblem(pw, { email }), pw).toBe(problem);
    const longest = randomBytes(96).toString('base64'); // 128 characters, no structure
    expect(longest).toHaveLength(128);
    for (const ok of ['correct-horse-battery', 'Tr0ub4dor&3-long', 'ma boulangerie à Akwa 2026', longest]) expect(localPasswordProblem(ok, { email: 'jean@example.com' }), ok).toBeNull();
    expect(localPasswordProblem('😀😀😀😀😀😀😀😀😀', {})).toBe('password_too_short'); // counted in characters, not bytes
  });

  it('breached-password check: only a five-character hash prefix leaves the server, padding rows are ignored, and an outage never blocks anybody', async () => {
    const sha1 = (await import('node:crypto')).createHash('sha1').update('correct-horse-battery').digest('hex').toUpperCase();
    const seen: string[] = [];
    const answering = (body: string, ok = true) => (async (url: string | URL | Request) => { seen.push(String(url)); return new Response(body, { status: ok ? 200 : 503 }); }) as typeof fetch;
    expect(await isBreachedPassword('correct-horse-battery', answering(`0000000000000000000000000000000000A:0\r\n${sha1.slice(5)}:42\r\nFFFF:1`))).toBe(true);
    expect(seen[0]).toBe(`https://api.pwnedpasswords.com/range/${sha1.slice(0, 5)}`);
    expect(await isBreachedPassword('correct-horse-battery', answering(`${sha1.slice(5)}:0`))).toBe(false); // a padding row
    expect(await isBreachedPassword('correct-horse-battery', answering('ABC:5'))).toBe(false);
    expect(await isBreachedPassword('correct-horse-battery', answering('', false))).toBe(false);
    expect(await isBreachedPassword('correct-horse-battery', (async () => { throw new Error('offline'); }) as typeof fetch)).toBe(false);
  });
});

describe('e-mail addresses', () => {
  it('fold the aliases of providers that have them, and only those', () => {
    const same: Array<[string, string]> = [
      ['John.Doe+shop@gmail.com', 'johndoe@gmail.com'], ['j.o.h.n.d.o.e@googlemail.com', 'johndoe@gmail.com'], ['ada+x@outlook.com', 'ada@outlook.com'], ['  ADA@Example.com ', 'ada@example.com'],
    ];
    for (const [a, b] of same) expect(canonicalEmail(a), a).toBe(b);
    expect(canonicalEmail('a.b+c@example.com')).toBe('a.b+c@example.com'); // an unknown domain: "+" may be a real, separate mailbox
    expect(canonicalEmail('first.last@outlook.com')).toBe('first.last@outlook.com'); // dots are significant outside Gmail
    expect(canonicalEmail('no-at-sign')).toBe('no-at-sign');
  });
  it('can be shown masked', () => {
    expect(maskEmail('jean@example.com')).toBe('j***@example.com');
    expect(maskEmail('nope')).toBe('***');
  });
});

describe('participants are encrypted in the database (finding SEC-15)', () => {
  let app: FastifyInstance;
  beforeAll(async () => { app = await makeApp(); await resetAll(); });
  afterAll(async () => { await app.close(); await prisma.$disconnect(); redis.disconnect(); });

  it('name and number are ciphertext in the table, plain through the client, and the number is findable only whole', async () => {
    const owner = await registerOwner(app);
    const created = await prisma.contact.create({ data: { userId: owner.userId, name: 'Marie Ngono', phone: '+237677123456', tags: ['vip'] } });
    expect(created.name).toBe('Marie Ngono');
    expect(created.phone).toBe('+237677123456');

    const [raw] = await prisma.$queryRaw<Array<{ name: string; phone: string; phoneHash: string }>>`SELECT name, phone, "phoneHash" FROM "Contact" WHERE id = ${created.id}`;
    expect(raw!.name).toMatch(/^v2\.k1\./);
    expect(raw!.phone).toMatch(/^v2\.k1\./);
    expect(raw!.phone + raw!.name).not.toMatch(/Marie|677123456/);
    expect(raw!.phoneHash).toBe(phoneIndex('+237677123456'));
    expect(raw!.phoneHash).not.toContain('677123456');

    expect((await prisma.contact.findFirst({ where: { userId: owner.userId, phone: '+237677123456' } }))?.id).toBe(created.id);
    expect((await prisma.contact.findFirst({ where: { userId: owner.userId, phone: { equals: '+237677123456' } } }))?.id).toBe(created.id);
    expect((await prisma.contact.findMany({ where: { userId: owner.userId, phone: { in: ['+237677123456', '+237600000000'] } } })).map((c) => c.id)).toEqual([created.id]);
    expect(await prisma.contact.findFirst({ where: { userId: owner.userId, phone: '+23767712345' } })).toBeNull();
    expect((await prisma.contact.findUnique({ where: { userId_phone: { userId: owner.userId, phone: '+237677123456' } } as never }))?.id).toBe(created.id);
  });

  it('what the database cannot do on ciphertext fails loudly rather than silently returning nothing', async () => {
    const owner = await registerOwner(app);
    await expect(prisma.contact.findMany({ where: { userId: owner.userId, name: { contains: 'Marie' } } })).rejects.toThrow(/stored encrypted/);
    await expect(prisma.contact.findMany({ where: { userId: owner.userId, phone: { contains: '6771' } } })).rejects.toThrow(/stored encrypted/);
    await expect(prisma.contact.findMany({ where: { userId: owner.userId, phone: { startsWith: '+237' } } })).rejects.toThrow(/stored encrypted/);
    await expect(prisma.contact.findMany({ where: { userId: owner.userId }, orderBy: { name: 'asc' } })).rejects.toThrow(/stored encrypted/);
    await expect(prisma.contact.findMany({ where: { userId: owner.userId }, orderBy: { phone: 'desc' } })).rejects.toThrow(/stored encrypted/);
  });

  it('the same number is kept once per owner (the index is unique), and two owners may hold the same number', async () => {
    const a = await registerOwner(app);
    const b = await registerOwner(app);
    await prisma.contact.create({ data: { userId: a.userId, name: 'X', phone: '+237677000009' } });
    await expect(prisma.contact.create({ data: { userId: a.userId, name: 'Y', phone: '+237677000009' } })).rejects.toMatchObject({ code: 'P2002' });
    await expect(prisma.contact.create({ data: { userId: b.userId, name: 'Y', phone: '+237677000009' } })).resolves.toBeTruthy();
  });

  it('updates re-encrypt, nested reads decrypt, and createMany / upsert are covered too', async () => {
    const owner = await registerOwner(app);
    await prisma.contact.createMany({ data: [{ userId: owner.userId, name: 'Batch One', phone: '+237677000021' }, { userId: owner.userId, name: 'Batch Two', phone: '+237677000022' }] });
    const rows = await rawPrisma.contact.findMany({ where: { userId: owner.userId } });
    expect(rows.every((r) => r.name.startsWith('v2.') && r.phone.startsWith('v2.') && r.phoneHash)).toBe(true);

    const one = await prisma.contact.findFirstOrThrow({ where: { userId: owner.userId, phone: '+237677000021' } });
    const upd = await prisma.contact.update({ where: { id: one.id }, data: { name: 'Renamed' } });
    expect(upd.name).toBe('Renamed');
    expect((await rawPrisma.contact.findUniqueOrThrow({ where: { id: one.id } })).name).toMatch(/^v2\./);
    const up = await prisma.contact.upsert({ where: { userId_phoneHash: { userId: owner.userId, phoneHash: phoneIndex('+237677000023') } }, create: { userId: owner.userId, name: 'Fresh', phone: '+237677000023' }, update: {} });
    expect(up.phone).toBe('+237677000023');

    const survey = await prisma.survey.create({ data: { userId: owner.userId, title: 'T', language: 'en' } });
    await prisma.surveyRecipient.create({ data: { surveyId: survey.id, contactId: one.id } });
    const nested = await prisma.surveyRecipient.findMany({ where: { surveyId: survey.id }, include: { contact: true } });
    expect(nested[0]!.contact.name).toBe('Renamed');
    expect(nested[0]!.contact.phone).toBe('+237677000021');
    const selected = await prisma.surveyRecipient.findMany({ where: { surveyId: survey.id }, select: { contact: { select: { phone: true, name: true } } } });
    expect(selected[0]!.contact).toMatchObject({ phone: '+237677000021', name: 'Renamed' });
  });

  it('a row written before encryption existed (plain) still reads, until the start-up backfill encrypts it', async () => {
    const owner = await registerOwner(app);
    const plain = await rawPrisma.contact.create({ data: { userId: owner.userId, name: 'Old Row', phone: '+237677000031' } });
    const read = await prisma.contact.findUniqueOrThrow({ where: { id: plain.id } });
    expect(read.name).toBe('Old Row');
    expect(read.phone).toBe('+237677000031');
    const { prepareDatabase } = await import('../src/services/startup');
    await prepareDatabase({ info: () => undefined, warn: () => undefined });
    const stored = await rawPrisma.contact.findUniqueOrThrow({ where: { id: plain.id } });
    expect(stored.name).toMatch(/^v2\./);
    expect(stored.phone).toMatch(/^v2\./);
    expect(stored.phoneHash).toBe(phoneIndex('+237677000031'));
    expect((await prisma.contact.findUniqueOrThrow({ where: { id: plain.id } })).phone).toBe('+237677000031');
    await prepareDatabase({ info: () => undefined, warn: () => undefined }); // safe to run again
    expect((await rawPrisma.contact.findUniqueOrThrow({ where: { id: plain.id } })).phone).toBe(stored.phone);
  });

  it('the e-mail of an account is stored with its canonical form, whichever way it is written', async () => {
    const u = await prisma.user.create({ data: { email: 'John.Doe+x@gmail.com', name: 'J', businessName: 'B', phone: '+237677000040', country: 'CM' } });
    expect(u.emailCanonical).toBe('johndoe@gmail.com');
    const upd = await prisma.user.update({ where: { id: u.id }, data: { email: 'j.d.o.e+1@gmail.com' } });
    expect(upd.emailCanonical).toBe('jdoe@gmail.com');
    await expect(prisma.user.create({ data: { email: 'jd.oe@gmail.com', name: 'K', businessName: 'B', phone: '+237677000041', country: 'CM' } })).rejects.toMatchObject({ code: 'P2002' });
  });
});

// A bit of key material the module-level tests above rely on exists in the environment the suite runs in.
describe('test environment is hermetic', () => {
  it('has no real secrets configured', () => {
    expect(scryptSync('x', 'y', 8).length).toBe(8);
    expect(env.NODE_ENV).toBe('test');
    expect(env.INTERNAL_API_SECRET ?? '').toBe('');
    expect(env.hibpEnabled).toBe(false);
    expect(env.emailProvider).toBe('mock');
  });
});

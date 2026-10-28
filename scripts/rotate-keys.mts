/**
 * Moves everything that is stored encrypted onto the ACTIVE key (the first one in ENCRYPTION_KEYS), and can rebuild the phone-number index.
 *
 *   npx tsx --env-file=.env scripts/rotate-keys.mts            report what would change (nothing is written)
 *   npx tsx --env-file=.env scripts/rotate-keys.mts --apply    re-encrypt it
 *   npx tsx --env-file=.env scripts/rotate-keys.mts --apply --rehash-index
 *                                                              ALSO recompute every contact's phoneHash with the CURRENT BLIND_INDEX_KEY
 *
 * Rotating the encryption key, step by step:
 *   1. Make a new key (openssl rand -base64 32) and put it FIRST in ENCRYPTION_KEYS, keeping the old one after it:  ENCRYPTION_KEYS=k2:<new>,k1:<old>
 *      Restart the API. New data is written with k2; everything written before still reads with k1.
 *   2. Run this script with --apply. It finishes when "left on an old key: 0".
 *   3. Only then remove k1 from ENCRYPTION_KEYS. (Removing it earlier makes the data it protects unreadable.)
 * Rotating BLIND_INDEX_KEY (the number index) is the same idea but needs a short pause: set the new key, run with --apply --rehash-index, and until it
 * has finished a participant's number will not be recognised (a WhatsApp reply from a known number would look like a stranger). Do it with the API stopped.
 * Secrets are never printed. Back up the database first.
 */
const apply = process.argv.includes('--apply');
const rehash = process.argv.includes('--rehash-index');

const { rawPrisma } = await import('../apps/api/src/lib/prisma');
const { activeKeyId, decryptSecret, encryptSecret, isCiphertext, needsReEncryption } = await import('../apps/api/src/lib/crypto');
const { phoneIndex } = await import('../apps/api/src/lib/prisma');

const stats = { examined: 0, onOldKey: 0, rewritten: 0, plain: 0, indexRebuilt: 0 };
const BATCH = 500;

console.log(`Active key: ${activeKeyId()}  (${apply ? 'APPLY' : 'dry run'}${rehash ? ', rebuilding the number index' : ''})`);

/** Re-encrypts one string column when it is on an old key (or still plain text, for contacts). */
const fresh = (value: string | null, opts: { allowPlain: boolean }): { next: string | null; changed: boolean } => {
  if (value === null) return { next: null, changed: false };
  if (!isCiphertext(value)) return opts.allowPlain ? (stats.plain++, { next: encryptSecret(value), changed: true }) : { next: value, changed: false };
  if (!needsReEncryption(value)) return { next: value, changed: false };
  stats.onOldKey++;
  return { next: encryptSecret(decryptSecret(value)), changed: true };
};

// Contacts: name and phone (and the index, when asked).
for (let cursor: string | undefined; ;) {
  const rows = await rawPrisma.contact.findMany({ take: BATCH, ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}), orderBy: { id: 'asc' }, select: { id: true, name: true, phone: true, phoneHash: true } });
  if (!rows.length) break;
  cursor = rows[rows.length - 1]!.id;
  for (const c of rows) {
    stats.examined++;
    const name = fresh(c.name, { allowPlain: true });
    const phone = fresh(c.phone, { allowPlain: true });
    const plainPhone = isCiphertext(c.phone) ? decryptSecret(c.phone) : c.phone;
    const wantHash = rehash || c.phoneHash === null ? phoneIndex(plainPhone) : null;
    if (!name.changed && !phone.changed && wantHash === null) continue;
    if (apply) {
      await rawPrisma.contact.update({ where: { id: c.id }, data: { ...(name.changed ? { name: name.next! } : {}), ...(phone.changed ? { phone: phone.next! } : {}), ...(wantHash !== null ? { phoneHash: wantHash } : {}) } });
      stats.rewritten++;
      if (wantHash !== null && wantHash !== c.phoneHash) stats.indexRebuilt++;
    }
  }
}

// The secrets stored per owner.
const secrets: Array<[string, () => Promise<Array<{ id: string; value: string | null }>>, (id: string, value: string) => Promise<unknown>]> = [
  ['WhatsApp tokens', async () => (await rawPrisma.whatsAppAccount.findMany({ select: { id: true, accessToken: true } })).map((r) => ({ id: r.id, value: r.accessToken })), (id, value) => rawPrisma.whatsAppAccount.update({ where: { id }, data: { accessToken: value } })],
  ['Google tokens', async () => (await rawPrisma.googleConnection.findMany({ select: { id: true, refreshToken: true } })).map((r) => ({ id: r.id, value: r.refreshToken })), (id, value) => rawPrisma.googleConnection.update({ where: { id }, data: { refreshToken: value } })],
  ['authenticator secrets', async () => (await rawPrisma.user.findMany({ where: { totpSecret: { not: null } }, select: { id: true, totpSecret: true } })).map((r) => ({ id: r.id, value: r.totpSecret })), (id, value) => rawPrisma.user.update({ where: { id }, data: { totpSecret: value } })],
];
for (const [label, load, save] of secrets) {
  let moved = 0;
  for (const row of await load()) {
    stats.examined++;
    const f = fresh(row.value, { allowPlain: false });
    if (!f.changed) continue;
    if (apply) { await save(row.id, f.next!); stats.rewritten++; }
    moved++;
  }
  console.log(`  ${label}: ${moved} ${apply ? 're-encrypted' : 'to re-encrypt'}`);
}

console.log(`\nExamined ${stats.examined} values · left on an old key: ${apply ? 0 : stats.onOldKey} · plain-text contact values found: ${stats.plain} · rewritten: ${stats.rewritten}${rehash ? ` · number index rebuilt: ${stats.indexRebuilt}` : ''}`);
if (!apply && (stats.onOldKey || stats.plain)) console.log('Run again with --apply to re-encrypt them.');
await rawPrisma.$disconnect();

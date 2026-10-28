import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { blindIndex, decryptIfEncrypted, encryptSecret } from './crypto';
import { canonicalEmail } from './email';

/**
 * The one database client of the API.
 *
 * It does two quiet jobs so that no route has to remember them:
 *  1. Participants' names and phone numbers are ENCRYPTED in the database (AES-256-GCM, key ring in lib/crypto.ts). Writing a contact encrypts `name` and
 *     `phone` and stores a keyed hash of the number (`phoneHash`) so it can still be looked up exactly and kept unique; reading a contact decrypts them.
 *     Code outside this file keeps seeing plain `contact.name` and `contact.phone`.
 *     What this costs: a number can only be searched for whole (the hash is of the full number), and a name cannot be searched or sorted in SQL (the
 *     contacts list filters names in memory). A query that needs either throws instead of silently returning nothing.
 *  2. Every user write also stores `emailCanonical` (john.doe+x@gmail.com == johndoe@gmail.com), so one mailbox cannot open several accounts.
 */
// Prisma 7 talks to the database through a driver adapter (node-postgres here), not through its own engine.
const base = new PrismaClient({ adapter: new PrismaPg({ connectionString: env.DATABASE_URL }), log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'] });

/** The index of a phone number as it is stored (E.164, "+237677123456"). */
export const phoneIndex = (phone: string): string => blindIndex('phone', phone);

const unwrap = (v: unknown): unknown => (v && typeof v === 'object' && 'set' in (v as object) ? (v as { set: unknown }).set : v);

function unsupported(what: string): never {
  throw new Error(`Contact ${what} is stored encrypted: it cannot be filtered, searched or sorted in the database. Look the contact up by id or by the whole phone number.`);
}

function phoneFilter(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') return { phoneHash: phoneIndex(v) };
  if (v && typeof v === 'object') {
    const f = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [op, val] of Object.entries(f)) {
      if (op === 'equals' && typeof val === 'string') out.equals = phoneIndex(val);
      else if (op === 'in' && Array.isArray(val)) out.in = val.map((x) => phoneIndex(String(x)));
      else if (op === 'notIn' && Array.isArray(val)) out.notIn = val.map((x) => phoneIndex(String(x)));
      else if (op === 'not' && typeof val === 'string') out.not = phoneIndex(val);
      else unsupported(`phone filter "${op}"`);
    }
    return { phoneHash: out };
  }
  return unsupported('phone filter');
}

function contactWhere(where: unknown): unknown {
  if (!where || typeof where !== 'object') return where;
  if (Array.isArray(where)) return where.map(contactWhere);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(where as Record<string, unknown>)) {
    if (k === 'AND' || k === 'OR' || k === 'NOT') out[k] = contactWhere(v);
    else if (k === 'phone') Object.assign(out, phoneFilter(v));
    else if (k === 'name') unsupported('name filter');
    else if (k === 'userId_phone') out.userId_phoneHash = { userId: (v as { userId: string }).userId, phoneHash: phoneIndex((v as { phone: string }).phone) };
    else out[k] = v;
  }
  return out;
}

function contactData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(contactData);
  if (!data || typeof data !== 'object') return data;
  const out = { ...(data as Record<string, unknown>) };
  if ('name' in out) out.name = encryptSecret(String(unwrap(out.name)));
  if ('phone' in out) {
    const plain = String(unwrap(out.phone));
    out.phone = encryptSecret(plain);
    out.phoneHash = phoneIndex(plain);
  }
  return out;
}

function userData(data: unknown): unknown {
  if (Array.isArray(data)) return data.map(userData);
  if (!data || typeof data !== 'object') return data;
  const d = data as Record<string, unknown>;
  const email = unwrap(d.email);
  return typeof email === 'string' ? { ...d, emailCanonical: canonicalEmail(email) } : d;
}

const extended = base.$extends({
  name: 'surveyflow-data-protection',
  query: {
    contact: {
      async $allOperations({ operation, args, query }) {
        const a = { ...(args as Record<string, unknown>) };
        if ('where' in a) a.where = contactWhere(a.where);
        if ('data' in a) a.data = contactData(a.data);
        if ('create' in a) a.create = contactData(a.create);
        if ('update' in a) a.update = contactData(a.update);
        if (operation === 'upsert' && 'where' in a) a.where = contactWhere(a.where);
        const ob = a.orderBy;
        if (ob && JSON.stringify(ob).match(/"(name|phone)"/)) unsupported('sort order');
        return query(a as never);
      },
    },
    user: {
      async create({ args, query }) { return query({ ...args, data: userData(args.data) as never }); },
      async createMany({ args, query }) { return query({ ...args, data: userData(args.data) as never }); },
      async update({ args, query }) { return query({ ...args, data: userData(args.data) as never }); },
      async updateMany({ args, query }) { return query({ ...args, data: userData(args.data) as never }); },
      async upsert({ args, query }) { return query({ ...args, create: userData(args.create) as never, update: userData(args.update) as never }); },
    },
  },
  result: {
    contact: {
      name: { needs: { name: true }, compute: (c) => decryptIfEncrypted(c.name) },
      phone: { needs: { phone: true }, compute: (c) => decryptIfEncrypted(c.phone) },
    },
  },
});

export const prisma = extended;

/** The client handed to an interactive transaction: everything but the lifecycle methods. */
export type Tx = Omit<typeof prisma, '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'>;

/** The raw client, for the few places that must see the stored form (the encryption backfill and key rotation). */
export const rawPrisma = base;
export { Prisma };

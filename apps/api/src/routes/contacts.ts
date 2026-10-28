import type { FastifyInstance } from 'fastify';
import { assertWhatsAppConnected } from '../services/whatsapp/require';
import type { Prisma } from '@prisma/client';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { normalizePhone, maskPhone, COUNTRY_CONFIG, DEFAULT_COUNTRY, phoneExampleFor } from '@surveyflow/shared';
import { badRequest, notFound } from '../lib/errors';
import { rl } from '../lib/ratelimit';
import { assertNoGiftsInFlight } from '../services/gifts';
import { guardBulkDelete, guardReveal } from '../services/security/data-guard';
import { phoneIndex, prisma } from '../lib/prisma';

const MAX_IMPORT_ROWS = 5_000;
const tagsSchema = z.array(z.string().trim().min(1).max(40)).max(20).default([]);

/** Excel (FR locale) exports with ";" — detect rather than assume ",". */
function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/, 1)[0] ?? '';
  const counts = { ',': (head.match(/,/g) ?? []).length, ';': (head.match(/;/g) ?? []).length, '\t': (head.match(/\t/g) ?? []).length };
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0]) as string;
}

const HEADER_ALIASES: Record<string, string[]> = {
  name: ['name', 'nom', 'full name', 'nom complet', 'prenom', 'prénom', 'contact'],
  phone: ['phone', 'telephone', 'téléphone', 'tel', 'tél', 'whatsapp', 'mobile', 'numero', 'numéro', 'phone number'],
  tags: ['tags', 'tag', 'groupe', 'group', 'segment', 'etiquettes', 'étiquettes'],
};
function pick(row: Record<string, string>, field: keyof typeof HEADER_ALIASES): string {
  for (const [k, v] of Object.entries(row)) if (HEADER_ALIASES[field]!.includes(k.trim().toLowerCase())) return (v ?? '').trim();
  return '';
}

export default async function contactRoutes(app: FastifyInstance) {
  const auth = { preHandler: app.authenticate };
  // Loading participants' numbers into an account needs a confirmed e-mail address (an unconfirmed account is inert: it could be a squatter).
  const authVerified = { preHandler: app.authenticateVerified };

  /** The number is MASKED in every list: a full number leaves the API only through /reveal (limited, logged) or an export (capped, confirmed, e-mailed). */
  const dto = (c: { id: string; name: string; phone: string; tags: Prisma.JsonValue; createdAt: Date; consentAt: Date | null; optedOutAt: Date | null }) => ({
    id: c.id, name: c.name, phone: maskPhone(c.phone), tags: (c.tags as string[]) ?? [], createdAt: c.createdAt, consentAt: c.consentAt, optedOut: !!c.optedOutAt,
  });

  app.get('/api/contacts', auth, async (req) => {
    const q = z.object({
      search: z.string().trim().max(100).optional(), tag: z.string().trim().optional(),
      page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(200).default(25),
    }).parse(req.query);
    const where: Prisma.ContactWhereInput = { userId: req.userId, ...(q.tag ? { tags: { array_contains: q.tag } } : {}) };
    const all = await prisma.contact.findMany({ where: { userId: req.userId }, select: { tags: true } });
    const tags = [...new Set(all.flatMap((c) => (c.tags as string[]) ?? []))].sort();
    if (!q.search) {
      const [items, total] = await Promise.all([
        prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
        prisma.contact.count({ where }),
      ]);
      return { total, page: q.page, pageSize: q.pageSize, tags, items: items.map(dto) };
    }
    // Names and numbers are encrypted in the database, so the search happens here: a name containing the text (any case), or the WHOLE number
    // (a fragment of a number is deliberately not searchable: it would let someone read numbers digit by digit through the search box).
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { country: true } });
    const wanted = normalizePhone(q.search, COUNTRY_CONFIG[user.country] ? user.country : DEFAULT_COUNTRY);
    const wantedHash = wanted ? phoneIndex(wanted) : null;
    const needle = q.search.toLowerCase();
    const candidates = await prisma.contact.findMany({ where, orderBy: { createdAt: 'desc' }, select: { id: true, name: true, phoneHash: true }, take: 50_000 });
    const hits = candidates.filter((c) => c.name.toLowerCase().includes(needle) || (wantedHash !== null && c.phoneHash === wantedHash));
    const pageIds = hits.slice((q.page - 1) * q.pageSize, q.page * q.pageSize).map((c) => c.id);
    const rows = await prisma.contact.findMany({ where: { userId: req.userId, id: { in: pageIds } } });
    const order = new Map(pageIds.map((id, i) => [id, i]));
    rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    return { total: hits.length, page: q.page, pageSize: q.pageSize, tags, items: rows.map(dto) };
  });

  /** The one-contact door to a full number: rate-limited, capped per day and written to the audit trail BEFORE the number is returned. */
  app.post('/api/contacts/:id/reveal', { ...auth, ...rl(30) }, async (req) => {
    const { id } = req.params as { id: string };
    const c = await prisma.contact.findFirst({ where: { id, userId: req.userId }, select: { id: true, phone: true } });
    if (!c) throw notFound('Contact');
    await guardReveal(req, c.id);
    return { id: c.id, phone: c.phone };
  });

  const createSchema = z.object({
    name: z.string().trim().min(1).max(120), phone: z.string().trim().min(6).max(30), tags: tagsSchema,
    // Manual entry still needs the owner to vouch for the contact's opt-in.
    consent: z.literal(true, { errorMap: () => ({ message: 'Confirm that this person agreed to receive WhatsApp messages from you' }) }),
  });

  app.post('/api/contacts', authVerified, async (req, reply) => {
    await assertWhatsAppConnected(req.userId);
    const body = createSchema.parse(req.body);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { country: true } });
    const phone = normalizePhone(body.phone, COUNTRY_CONFIG[user.country] ? user.country : DEFAULT_COUNTRY);
    if (!phone) throw badRequest('invalid_phone', `Enter a valid phone number, e.g. ${phoneExampleFor(COUNTRY_CONFIG[user.country] ? user.country : DEFAULT_COUNTRY)}`);
    const c = await prisma.contact.upsert({
      where: { userId_phoneHash: { userId: req.userId, phoneHash: phoneIndex(phone) } },
      create: { userId: req.userId, phone, name: body.name, tags: body.tags, consentAt: new Date(), consentSource: 'owner_manual' },
      update: { name: body.name, tags: body.tags },
    });
    reply.code(201);
    return dto(c);
  });

  app.patch('/api/contacts/:id', auth, async (req) => {
    const { id } = req.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(120).optional(), tags: tagsSchema.optional() }).parse(req.body);
    if (!(await prisma.contact.count({ where: { id, userId: req.userId } }))) throw notFound('Contact');
    return dto(await prisma.contact.update({ where: { id }, data: body }));
  });

  app.delete('/api/contacts/:id', auth, async (req, reply) => {
    const { id } = req.params as { id: string };
    await assertNoGiftsInFlight({ contactId: id, survey: { userId: req.userId } });
    const r = await prisma.contact.deleteMany({ where: { id, userId: req.userId } });
    if (!r.count) throw notFound('Contact');
    return reply.code(204).send();
  });

  app.post('/api/contacts/bulk-delete', authVerified, async (req) => {
    const { ids } = z.object({ ids: z.array(z.string()).min(1).max(5000) }).parse(req.body);
    await assertNoGiftsInFlight({ contactId: { in: ids }, survey: { userId: req.userId } });
    await guardBulkDelete(req, ids.length); // large ones need a recent "confirm it is you", are capped per day and e-mailed to the owner
    return { deleted: (await prisma.contact.deleteMany({ where: { userId: req.userId, id: { in: ids } } })).count };
  });

  app.post('/api/contacts/bulk-tag', auth, async (req) => {
    const { ids, add, remove } = z.object({ ids: z.array(z.string()).min(1).max(5000), add: z.array(z.string().trim().min(1).max(40)).default([]), remove: z.array(z.string()).default([]) }).parse(req.body);
    const rows = await prisma.contact.findMany({ where: { userId: req.userId, id: { in: ids } }, select: { id: true, tags: true } });
    await prisma.$transaction(rows.map((r) => {
      const set = new Set([...((r.tags as string[]) ?? []), ...add]);
      for (const t of remove) set.delete(t);
      return prisma.contact.update({ where: { id: r.id }, data: { tags: [...set].slice(0, 20) } });
    }));
    return { updated: rows.length };
  });

  /**
   * CSV import. Required: the owner attests that every contact opted in to receive WhatsApp
   * messages (WhatsApp Business Policy) — stored with a timestamp as proof.
   */
  app.post('/api/contacts/import', authVerified, async (req) => {
    await assertWhatsAppConnected(req.userId);
    const file = await req.file();
    if (!file) throw badRequest('no_file', 'Upload a CSV file');
    const fields = file.fields as Record<string, { value?: string } | undefined>;
    if (fields.consent?.value !== 'true') throw badRequest('consent_required', 'Confirm that your contacts agreed to receive WhatsApp messages from you');
    const defaultTags = (fields.tags?.value ?? '').split(',').map((t) => t.trim()).filter(Boolean);

    let text = (await file.toBuffer()).toString('utf8').replace(/^﻿/, '');
    let rows: Record<string, string>[];
    try {
      rows = parse(text, { columns: true, skip_empty_lines: true, trim: true, delimiter: detectDelimiter(text), relax_column_count: true, bom: true });
    } catch (err) {
      throw badRequest('invalid_csv', `Could not read the CSV: ${(err as Error).message}`);
    }
    text = '';
    if (rows.length > MAX_IMPORT_ROWS) throw badRequest('too_many_rows', `Import at most ${MAX_IMPORT_ROWS} contacts at a time`);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.userId }, select: { country: true } });
    const country = COUNTRY_CONFIG[user.country] ? user.country : DEFAULT_COUNTRY;
    const errors: Array<{ row: number; reason: string }> = [];
    const seen = new Set<string>();
    const valid: Array<{ name: string; phone: string; tags: string[] }> = [];
    rows.forEach((row, i) => {
      const phone = normalizePhone(pick(row, 'phone'), country);
      if (!phone) return void errors.push({ row: i + 2, reason: 'invalid phone number' });
      if (seen.has(phone)) return void errors.push({ row: i + 2, reason: 'duplicate in file' });
      seen.add(phone);
      const tags = [...new Set([...pick(row, 'tags').split(/[|;,]/).map((t) => t.trim()).filter(Boolean), ...defaultTags])].slice(0, 20);
      valid.push({ name: (pick(row, 'name') || phone).slice(0, 120), phone, tags });
    });

    const existing = new Set((await prisma.contact.findMany({ where: { userId: req.userId, phone: { in: valid.map((v) => v.phone) } }, select: { phone: true } })).map((c) => c.phone));
    const now = new Date();
    for (let i = 0; i < valid.length; i += 200) {
      await prisma.$transaction(valid.slice(i, i + 200).map((v) =>
        prisma.contact.upsert({
          where: { userId_phoneHash: { userId: req.userId, phoneHash: phoneIndex(v.phone) } },
          create: { userId: req.userId, phone: v.phone, name: v.name, tags: v.tags, consentAt: now, consentSource: 'owner_csv_import' },
          // Re-importing never resurrects someone who sent STOP.
          update: { name: v.name, tags: v.tags },
        })));
    }
    return { created: valid.filter((v) => !existing.has(v.phone)).length, updated: valid.filter((v) => existing.has(v.phone)).length, skipped: errors.length, errors: errors.slice(0, 50) };
  });
}

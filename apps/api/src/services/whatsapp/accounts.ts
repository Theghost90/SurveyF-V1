import type { MessageTemplate, WhatsAppAccount } from '@prisma/client';
import { TEMPLATE_DEFS, templateKey } from '@surveyflow/shared';
import { env } from '../../config/env';
import { decryptSecret } from '../../lib/crypto';
import { prisma } from '../../lib/prisma';
import { getGateway, type WaCreds } from './gateway';

export function credsFor(acct: Pick<WhatsAppAccount, 'phoneNumberId' | 'wabaId' | 'accessToken'>): WaCreds {
  return { phoneNumberId: acct.phoneNumberId, wabaId: acct.wabaId, accessToken: decryptSecret(acct.accessToken) };
}

/** SurveyFlow's own number (env), used for platform → owner notices. Null when not configured. */
export function platformCreds(): WaCreds | null {
  if (env.waMode === 'mock') return { phoneNumberId: 'platform-mock', wabaId: 'platform-mock', accessToken: 'mock' };
  if (!env.WHATSAPP_PHONE_NUMBER_ID || !env.WHATSAPP_ACCESS_TOKEN) return null;
  return { phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID, wabaId: env.WHATSAPP_BUSINESS_ACCOUNT_ID ?? '', accessToken: env.WHATSAPP_ACCESS_TOKEN };
}

/**
 * Templates are per-WABA (the spec's "library of pre-approved templates" cannot be shared
 * across customers' WABAs), so each connected account submits its own copies.
 */
export async function ensureTemplates(acct: WhatsAppAccount): Promise<MessageTemplate[]> {
  const gw = getGateway();
  const creds = credsFor(acct);
  const existing = new Map((await prisma.messageTemplate.findMany({ where: { accountId: acct.id } })).map((t) => [templateKey(t.name, t.language), t]));
  const remote = new Map<string, { id: string; status: string; reason?: string }>();
  try {
    for (const t of await gw.listTemplates(creds)) remote.set(templateKey(t.name, t.language), t);
  } catch {
    /* listing is best-effort; creation below reports real problems */
  }

  for (const def of TEMPLATE_DEFS) {
    const key = templateKey(def.name, def.language);
    const known = remote.get(key);
    let id: string | undefined = known?.id;
    let status = known?.status;
    if (!known && !existing.get(key)) {
      try {
        const created = await gw.createTemplate(creds, def);
        id = created.id;
        status = created.status;
      } catch (err) {
        status = 'REJECTED';
        await prisma.messageTemplate.upsert({
          where: { accountId_name_language: { accountId: acct.id, name: def.name, language: def.language } },
          create: { accountId: acct.id, name: def.name, language: def.language, category: def.category, status, reason: (err as Error).message.slice(0, 300) },
          update: { status, reason: (err as Error).message.slice(0, 300) },
        });
        continue;
      }
    }
    if (status) {
      await prisma.messageTemplate.upsert({
        where: { accountId_name_language: { accountId: acct.id, name: def.name, language: def.language } },
        create: { accountId: acct.id, name: def.name, language: def.language, category: def.category, status, metaTemplateId: id, reason: known?.reason },
        update: { status, metaTemplateId: id ?? undefined, reason: known?.reason ?? null },
      });
    }
  }
  return prisma.messageTemplate.findMany({ where: { accountId: acct.id } });
}

export async function isTemplateApproved(accountId: string, name: string, language: string): Promise<boolean> {
  if (env.waMode === 'mock') return true;
  const t = await prisma.messageTemplate.findUnique({ where: { accountId_name_language: { accountId, name, language } } });
  return t?.status === 'APPROVED';
}

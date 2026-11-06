import { describe, expect, it } from 'vitest';
import { ENTITY, LEGAL_VERSION, getPrivacy, getTerms, longDate, supportEmailFromEnv } from '../src/lib/legal';
import type { Block, LegalDoc, LegalSection } from '../src/lib/legal';

/**
 * The privacy policy and the terms (LEG-01, LEG-02). What these tests hold in place:
 *  - the French says what the English says (same sections, same kinds of block, same items, the same sections of the law cited);
 *  - every section of Law No. 2024/017 that the texts cite is one that was read in the certified copy (docs/legal/, 17 pages) on 2026-11-06;
 *  - the section numbers that sentences point to ("section 5", "section 14") are still those sections;
 *  - nothing is left to be filled in, no contact is invented, and the first version's exclusions are stated.
 */

/** Every section number the texts cite, each checked against the certified copy: add one only after reading it there. */
const READ_IN_THE_CERTIFIED_COPY = new Set([5, 9, 11, 12, 13, 14, 16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 30, 32, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 53, 65]);

const NUM = String.raw`\d+(?:\s*(?:,|and|et|to|à)\s*\d+)*`;
const CITE = new RegExp(String.raw`(?:\bs\.|\bart\.)\s*(${NUM})|\bsection\s+(\d+)\s+of the Law|\barticle\s+(\d+)\s+de la Loi`, 'g');

function cited(text: string): number[] {
  const out = new Set<number>();
  for (const m of text.matchAll(CITE)) {
    if (!m[1]) { out.add(Number(m[2] ?? m[3])); continue; }
    for (const token of m[1].split(/\s*(?:,|and|et)\s*/)) {
      const [a, b] = token.split(/\s*(?:to|à)\s*/).map(Number);
      if (b === undefined) out.add(a);
      else for (let n = a; n <= b; n++) out.add(n);
    }
  }
  return [...out].sort((x, y) => x - y);
}

const strings = (b: Block): string[] => ('p' in b ? [b.p] : 'ul' in b ? b.ul : 'ol' in b ? b.ol : b.rows.flat());
const sectionText = (s: LegalSection): string => [s.h, ...s.blocks.flatMap(strings)].join('\n');
const docText = (d: LegalDoc): string => [d.title, d.description, d.meta, d.lead, ...d.sections.map(sectionText)].join('\n');
const shape = (b: Block): string => ('p' in b ? 'p' : 'ul' in b ? `ul:${b.ul.length}` : 'ol' in b ? `ol:${b.ol.length}` : `rows:${b.rows.length}`);
const positions = (d: LegalDoc): Record<string, number> => Object.fromEntries(d.sections.map((s, i) => [s.id, i + 1]));

const docs = {
  privacy: { en: getPrivacy('en'), fr: getPrivacy('fr') },
  terms: { en: getTerms('en'), fr: getTerms('fr') },
};
const all: [string, LegalDoc][] = [['privacy en', docs.privacy.en], ['privacy fr', docs.privacy.fr], ['terms en', docs.terms.en], ['terms fr', docs.terms.fr]];

describe.each(['privacy', 'terms'] as const)('%s: the French reads the same as the English', (name) => {
  const { en, fr } = docs[name];

  it('has the same sections in the same order, with the same kinds of block and the same number of items', () => {
    expect(fr.sections.map((s) => s.id)).toEqual(en.sections.map((s) => s.id));
    for (const [i, s] of en.sections.entries()) expect(fr.sections[i].blocks.map(shape), s.id).toEqual(s.blocks.map(shape));
  });

  it('cites the same sections of the law in every section', () => {
    for (const [i, s] of en.sections.entries()) expect(cited(sectionText(fr.sections[i])), s.id).toEqual(cited(sectionText(s)));
    expect(cited(en.lead)).toEqual(cited(fr.lead));
  });
});

describe('the law the texts cite', () => {
  it.each(all)('%s cites only sections that were read in the certified copy', (_n, d) => {
    const unknown = cited(docText(d)).filter((n) => !READ_IN_THE_CERTIFIED_COPY.has(n));
    expect(unknown).toEqual([]);
  });

  it('cites the sections that carry the Customer’s duties and the processor contract', () => {
    for (const lang of ['en', 'fr'] as const) {
      const duties = docs.terms[lang].sections.find((s) => s.id === 'duties')!;
      for (const n of [5, 9, 11, 12, 13, 14, 19, 21, 22, 37, 40, 41, 44, 47, 48, 49, 50, 65]) expect(cited(sectionText(duties)), `${lang} duties`).toContain(n);
      const dp = docs.terms[lang].sections.find((s) => s.id === 'data-processing')!;
      for (const n of [21, 22, 24, 25, 26, 27, 30, 32]) expect(cited(sectionText(dp)), `${lang} data processing`).toContain(n);
    }
  });
});

describe('the numbers that sentences point to', () => {
  it('privacy: the sections other sentences call "section N" are where they say', () => {
    for (const lang of ['en', 'fr'] as const) {
      expect(positions(docs.privacy[lang])).toMatchObject({ who: 1, participants: 2, recipients: 6, abroad: 7, retention: 8, rights: 9, security: 10, 'other-laws': 12, contact: 15 });
    }
  });

  it('terms: the same, including the Customer’s duties (5) and the data processing terms (14)', () => {
    for (const lang of ['en', 'fr'] as const) {
      expect(positions(docs.terms[lang])).toMatchObject({ parties: 1, service: 2, account: 3, meta: 4, duties: 5, billing: 7, responsibilities: 9, liability: 11, indemnity: 12, 'data-processing': 14, law: 15, contact: 18 });
    }
  });

  it('the join message links to the participants’ notice, which is the anchor "participants" of the privacy policy', () => {
    expect(docs.privacy.en.sections[1].id).toBe('participants');
    expect(docs.privacy.fr.sections[1].id).toBe('participants');
  });
});

describe('what the texts say about the company, the scope and the contact', () => {
  it.each(all)('%s names the company and its address', (_n, d) => {
    expect(ENTITY.name).toBe('SurveyFlow Sarl');
    expect(ENTITY.place).toBe('Bonamoussadi, Douala, Cameroon');
    expect(d.meta).toContain('SurveyFlow Sarl, Bonamoussadi, Douala, Cameroon');
    expect(docText(d)).toContain('**SurveyFlow Sarl**, Bonamoussadi, Douala, Cameroon');
  });

  it.each(all)('%s has nothing left to fill in and no draft banner', (_n, d) => {
    const t = docText(d);
    expect(t).not.toMatch(/to be (stated|confirmed|decided)|will be stated|à préciser|à confirmer|\bTODO\b|\bTBD\b|lorem|draft for review|\?\?\?/i);
  });

  it('states what the first version does not include, in both languages', () => {
    const en = sectionText(docs.terms.en.sections.find((s) => s.id === 'service')!);
    expect(en).toMatch(/Gifts and rewards/);
    expect(en).toMatch(/prepaid wallet/);
    expect(en).toMatch(/does not hold, transfer, convert or pay out money/);
    expect(en).toMatch(/API access and white-label/);
    expect(en).toMatch(/does not verify that your contacts agreed/);
    const fr = sectionText(docs.terms.fr.sections.find((s) => s.id === 'service')!);
    expect(fr).toMatch(/cadeaux et récompenses/);
    expect(fr).toMatch(/portefeuille prépayé/);
    expect(fr).toMatch(/ne détient, ne transfère, ne convertit ni ne verse d’argent/);
    expect(fr).toMatch(/API et l’usage en marque blanche/);
    expect(fr).toMatch(/ne vérifie pas que vos contacts ont accepté/);
  });

  it('puts the payment and the wallet nowhere else as something the service does', () => {
    // The privacy policy lists what is held; in this version nothing about gifts, payouts or a wallet is collected.
    for (const lang of ['en', 'fr'] as const) expect(docText(docs.privacy[lang])).not.toMatch(/gift|wallet|payout|cadeau|portefeuille|versement/i);
  });

  it('prints the e-mail address only when one is set, and never a made-up one', () => {
    for (const lang of ['en', 'fr'] as const) {
      const without = getTerms(lang).sections.at(-1)!.blocks.flatMap(strings).join(' ');
      expect(without).not.toContain('@');
      const withMail = getPrivacy(lang, { supportEmail: 'support@example.org' }).sections.at(-1)!.blocks.flatMap(strings).join(' ');
      expect(withMail).toContain('[support@example.org](mailto:support@example.org)');
    }
  });

  it('draws only links inside the site, to an anchor, or an e-mail address', () => {
    for (const [name, d] of all) for (const m of docText(d).matchAll(/\[[^\]]+\]\(([^)\s]+)\)/g)) expect(m[1], name).toMatch(/^(\/|#|mailto:)/);
  });

  it('has its version date written out in each language', () => {
    expect(LEGAL_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(longDate('2026-11-06', 'en')).toBe('6 November 2026');
    expect(longDate('2026-11-06', 'fr')).toBe('6 novembre 2026');
    expect(longDate('2026-12-01', 'fr')).toBe('1er décembre 2026');
    expect(docs.privacy.en.meta).toContain(longDate(LEGAL_VERSION, 'en'));
    expect(docs.terms.fr.meta).toContain(longDate(LEGAL_VERSION, 'fr'));
  });
});

describe('the support address from the environment', () => {
  it('accepts an address and refuses anything else', () => {
    expect(supportEmailFromEnv({ SUPPORT_EMAIL: ' help@surveyflow.example ' })).toBe('help@surveyflow.example');
    expect(supportEmailFromEnv({})).toBeUndefined();
    for (const bad of ['', 'help', 'help@host', 'a b@c.d', '<x>@y.z', 'x@y.z]', '**x**@y.z', 'a@b.c,d@e.f']) expect(supportEmailFromEnv({ SUPPORT_EMAIL: bad }), bad).toBeUndefined();
  });
});

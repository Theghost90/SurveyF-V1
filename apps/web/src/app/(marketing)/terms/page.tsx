import type { Metadata } from 'next';
import { LegalDocView } from '@/components/marketing/legal-doc';
import { MarketingHeader } from '@/components/marketing/header';
import { getLocale } from '@/lib/i18n/server';
import { getTerms, supportEmailFromEnv } from '@/lib/legal';

export async function generateMetadata(): Promise<Metadata> {
  const doc = getTerms(await getLocale(), { supportEmail: supportEmailFromEnv() });
  return { title: doc.title, description: doc.description };
}

export default async function Page() {
  const doc = getTerms(await getLocale(), { supportEmail: supportEmailFromEnv() });
  return (
    <>
      <MarketingHeader />
      <LegalDocView doc={doc} />
    </>
  );
}

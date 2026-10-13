import type { Metadata } from 'next';
import { MarketingHeader } from '@/components/marketing/header';

export const metadata: Metadata = { title: 'Privacy policy' };

export default function Page() {
  return (
    <>
      <MarketingHeader />
      <article className="mx-auto max-w-3xl px-5 pb-20 pt-6 sm:px-8">
        <p className="mb-6 rounded-2xl bg-amber-soft p-4 text-sm font-medium text-amber-ink">
          Draft for review — this page describes what the software does today and has not been reviewed by legal counsel. It must be replaced by the final text before public launch.
        </p>
        <h1 className="mb-6 text-5xl font-extrabold tracking-[-0.03em]">Privacy policy</h1>
        <div className="space-y-4 leading-relaxed text-body">
          <p><b>What we store.</b> Your account details (name, business, email, phone); the contacts you import (name, phone, tags, proof of opt-in); your surveys; and the answers participants send, together with their WhatsApp number and the time they answered.</p>
          <p><b>Who sees it.</b> Only the account that ran the survey. Participants’ answers are never shown to other SurveyFlow customers.</p>
          <p><b>Processors.</b> Messages travel through Meta’s WhatsApp Business platform. Subscription payments are handled by payment providers (we never store card numbers). Exports to Google Sheets happen only if you connect your own Google account.</p>
          <p><b>Opt-out.</b> Any participant can reply STOP and will not be contacted again. You can delete contacts and surveys from the dashboard.</p>
          <p><b>Your obligations.</b> You must have each contact’s permission to message them on WhatsApp, and comply with the personal data protection law that applies to you (in Cameroon, Law No. 2024/017).</p>
        </div>
      </article>
    </>
  );
}

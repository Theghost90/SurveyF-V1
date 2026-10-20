import type { Metadata } from 'next';
import { MarketingHeader } from '@/components/marketing/header';

export const metadata: Metadata = { title: 'Terms of service' };

export default function Page() {
  return (
    <>
      <MarketingHeader />
      <article className="mx-auto max-w-3xl px-5 pb-20 pt-6 sm:px-8">
        <p className="mb-6 rounded-2xl bg-amber-soft p-4 text-sm font-medium text-amber-ink">
          Draft for review — this page describes what the software does today and has not been reviewed by legal counsel. It must be replaced by the final text before public launch.
        </p>
        <h1 className="mb-6 text-5xl font-extrabold tracking-[-0.03em]">Terms of service</h1>
        <div className="space-y-4 leading-relaxed text-body">
          <p><b>The service.</b> SurveyFlow lets you build surveys, send them to your contacts on WhatsApp, and analyse the answers.</p>
          <p><b>Acceptable use.</b> Only message people who agreed to hear from you. Do not send spam, misleading or unlawful content. Accounts that harm the quality of the shared WhatsApp platform may be suspended.</p>
          <p><b>Plans and billing.</b> Plans, limits and prices are shown on the pricing page. Subscriptions are paid in advance; unused time is not refunded in V1. Gifts you configure (airtime, Mobile Money, codes) are your responsibility.</p>
          <p><b>Availability.</b> We work to keep the service running but depend on Meta and payment providers, whose outages we do not control.</p>
        </div>
      </article>
    </>
  );
}

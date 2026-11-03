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
          <p><b>The service.</b> SurveyFlow lets you build surveys, send them to your contacts on WhatsApp (or let people join by a link or QR code), and analyse the answers.</p>
          <p><b>Acceptable use.</b> Only message people who agreed to hear from you. Do not send spam, misleading or unlawful content. Accounts that harm the quality of the shared WhatsApp platform may be suspended.</p>
          <p><b>Message costs.</b> WhatsApp bills each message by Meta’s category, and marketing messages cost more than utility messages. SurveyFlow treats a survey as marketing unless you state that the people receive it because of something they did with your business and nothing in it is promotional, and asks you to accept the cost before each marketing send. Meta can re-categorise a template; if it does, you are told and sends wait for your acceptance.</p>
          <p><b>Plans and billing.</b> Plans, limits and prices are shown on the pricing page. Subscriptions are paid in advance; Mobile Money has no automatic renewal, so renewing means paying again. When you move to a bigger plan before the one you paid for ends, the unused whole days of what you paid are credited against the new price, which never falls below 10 percent of the new plan’s price. Moving to a lower plan is done by letting the current one end.</p>
          <p><b>Responses beyond your plan.</b> A response is never refused. If you agree in Billing, the responses beyond your monthly allowance are invoiced after each month at 500 FCFA per block of 100, and you pay the invoice yourself: nothing is taken from you. The consequence of an unpaid invoice is to be stated here.</p>
          <p><b>Gifts and the gift wallet.</b> Gifts you configure (airtime, Mobile Money, codes) are your responsibility. You top up a prepaid wallet; each gift takes its amount and a fee from it. To limit fraud, payouts are capped per account and per phone number in any 24 hours and are held for accounts that are only a few days old; a held gift is paid by itself when the limit allows. People who join by link or QR code win no gift unless you switch that on, and then at most the number you set. Whether the wallet balance can be withdrawn, and the refund rules, are to be stated here.</p>
          <p><b>Team members.</b> You may invite people as viewers or editors on a plan that includes seats. You are responsible for what they do in your account; every action they take is recorded against them.</p>
          <p><b>Availability.</b> We work to keep the service running but depend on Meta and payment providers, whose outages we do not control. Limits of liability, governing law and the courts are to be stated here.</p>
        </div>
      </article>
    </>
  );
}

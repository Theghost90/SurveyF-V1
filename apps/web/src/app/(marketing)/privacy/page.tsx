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
          <p><b>Who is who.</b> For your own account (name, business, e-mail, phone, billing and sign-in records) SurveyFlow decides why and how the data is used. For the people you survey, you decide whom to message and what to ask, and SurveyFlow processes the data on your behalf. The name and address of the operating company are to be stated here before launch.</p>
          <p><b>What we store about you.</b> Account details; payments (provider, amount, the number that paid); the access tokens of the WhatsApp and Google accounts you connect, encrypted; and a record of sign-ins and security events (browser, the first three groups of the IP address, country). Your password is stored only as a one-way hash.</p>
          <p><b>What we store about the people you survey.</b> What you give us for each contact (name, WhatsApp number, tags), the proof of opt-in (a tick, with its time and source), a stop flag, and the answers they send. Names and numbers are encrypted in the database and masked on screen. Answers are not encrypted in the database. People who joined through a link or QR code are stored the same way, with the source “join link”.</p>
          <p><b>Who sees it.</b> Only the account that ran the survey and the team members that account invited, who see only what their role allows (a viewer sees counts and results, an editor also sees participants; neither can export, reveal full numbers, see money or manage the team). Participants’ answers are never shown to other SurveyFlow customers. SurveyFlow staff do not have a screen to read them.</p>
          <p><b>Who else receives data.</b> Meta (WhatsApp) receives numbers and message text. Payment providers receive the payer’s number and the amount; the gift provider receives the number of the person being rewarded. Google receives data only if you connect your Google account. Cloudflare provides the CAPTCHA; a breach-check service receives the first five characters of a hash of a new password. The company hosting SurveyFlow stores the data; its location is to be stated here.</p>
          <p><b>Your rights, in the product.</b> You can download your whole account in one file and ask for the account to be erased (Settings, Your data). Erasure waits 30 days (the default), read-only, during which you can cancel; then the account and its data are erased. What the law obliges us to keep (the record of money received and paid) stays, without your name, number or e-mail, for the retention period below. People you survey can reply STOP at any time; to reach SurveyFlow about their data, write to the address that will be stated here.</p>
          <p><b>How long we keep things.</b> Your data until you erase your account. The financial record without identifying details: 10 years (to be confirmed). The security trail of ids and counts: 400 days. Encrypted backups: for the period that will be stated here.</p>
          <p><b>Security.</b> Passwords are hashed; tokens and the authenticator secret are encrypted; database backups are encrypted; every sensitive action (export, deletion, adding a team member) asks you to confirm it is you. No system is perfectly secure. What we do if data is breached, and whom we tell, is to be stated here.</p>
          <p><b>Opt-out.</b> Any participant can reply STOP and will not be contacted again. You can delete contacts and surveys from the dashboard.</p>
          <p><b>Your obligations.</b> You must have each contact’s permission to message them on WhatsApp, and comply with the personal data protection law that applies to you (in Cameroon, Law No. 2024/017). When you share a join link or QR code, the first message asks the person for consent and tells them how to stop; you remain responsible for where you share it.</p>
        </div>
      </article>
    </>
  );
}

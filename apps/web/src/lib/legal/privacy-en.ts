import { ENTITY, LEGAL_VERSION, contactLine, longDate } from './shared';
import type { LegalContext, LegalDoc } from './types';

/**
 * Privacy policy, English. Every citation of the law ("s. 9") is to Law No. 2024/017 of 23 December 2024 on personal data protection in Cameroon,
 * checked against the certified copy in docs/legal/. The French text (privacy-fr.ts) must say the same: a test compares them.
 * The sections are numbered by position, and some sentences point to a number ("section 6"): `apps/web/tests/legal-pages.test.ts` pins those positions.
 */
export const privacyEn = (ctx: LegalContext): LegalDoc => ({
  title: 'Privacy policy',
  description: 'What personal data SurveyFlow handles, who is responsible for it, who receives it, how long it is kept and the rights people have under Law No. 2024/017.',
  meta: `Version of ${longDate(LEGAL_VERSION, 'en')} · ${ENTITY.name}, ${ENTITY.place}`,
  tocLabel: 'On this page',
  lead: 'SurveyFlow is a tool that businesses, institutions and researchers (our “Customers”) use to send surveys on WhatsApp to their own contacts. This policy explains what personal data is handled, why, who is responsible for it, who receives it and what rights people have. Two groups of people are concerned: the Customers and their teams, and the people who receive or answer a survey (“Participants”). If you received a survey on WhatsApp, read section 2.',
  sections: [
    {
      id: 'who',
      h: 'Who we are and who is responsible for what',
      blocks: [
        { p: `The service is operated by **${ENTITY.name}**, ${ENTITY.place} (“SurveyFlow”, “we”). The law that applies to us first is Law No. 2024/017 of 23 December 2024 on personal data protection in Cameroon (the “Law”). Section 12 says what applies in other countries.` },
        {
          rows: [
            ['Customers and their team members', 'SurveyFlow is the **controller** of the data of the Customer’s account: sign-up, billing, security, and use of the website and the application.'],
            ['Participants', 'The **Customer is the controller**: the Customer decides whom to message, what to ask and why, and holds the Participants’ consent. SurveyFlow is the **processor**: it stores and transmits the data for the Customer and on the Customer’s instructions, under the data processing terms in section 14 of the Terms of Service.'],
            ['Limited exceptions', 'SurveyFlow also keeps some Participant data for its own purposes where the Law or security requires it: honouring a STOP request, preventing abuse and fraud, and keeping the records we are obliged to keep. For those purposes SurveyFlow answers for the use it makes.'],
            ['Providers', 'Meta (WhatsApp), the payment providers and the other companies in section 6 receive data to do their part of the service. They do not become owners of the Customer’s data, and each answers under its own terms for its own use.'],
          ],
        },
        { p: 'Under the Law, a controller and a processor are bound by the same obligations (s. 20), and a processor must give sufficient guarantees of security and compliance (s. 16 and 26). The split above says who answers to whom; it does not lessen anyone’s duties.' },
      ],
    },
    {
      id: 'participants',
      h: 'If you received a survey on WhatsApp (information for Participants)',
      blocks: [
        { p: 'A business or organisation (the “sender”) used SurveyFlow to send you a survey, or you started it yourself by opening the sender’s join link or QR code and answering START.' },
        {
          rows: [
            ['Who is responsible for your data', `The sender decides to contact you and what to ask: it is the controller. ${ENTITY.name}, ${ENTITY.place}, provides the software and keeps the data for the sender as its processor.`],
            ['What is kept', 'Your WhatsApp number; your name, if the sender gave it or you gave it; labels the sender added; whether and when you agreed to be contacted, and how (the sender’s declaration, a join link, or the word START); whether you replied STOP; your answers; and whether messages were delivered and read.'],
            ['Why', 'To send you the survey, collect your answers and let the sender read the results. SurveyFlow does not sell your data, does not use it for advertising and does not build profiles of you.'],
            ['Who sees it', 'The sender and the colleagues the sender gave access to. Meta carries the WhatsApp messages. SurveyFlow’s service providers store the data on our behalf (section 6). Your answers are never shown to other SurveyFlow Customers.'],
            ['How long', 'Until the sender deletes them or closes its account; then they are erased from SurveyFlow (section 8).'],
            ['Outside Cameroon', 'WhatsApp and some of our providers are located outside Cameroon (section 7).'],
            ['Your choices', 'Reply **STOP** at any time and that sender will not contact you again. You may ask the sender, or us, to let you see, correct or erase your data, or object to its use (section 9). You may complain to the Personal Data Protection Authority.'],
          ],
        },
      ],
    },
    {
      id: 'customers',
      h: 'What we hold about Customers and their team',
      blocks: [
        {
          ul: [
            '**Account:** name, business or organisation name, e-mail address, phone number, country, language, type of customer (business, institution or academic) and plan.',
            '**Sign-in:** your password is stored only as a one-way hash and can never be read. If you sign in with Google, we receive your Google identifier, name and e-mail address. If you turn on two-step verification, the authenticator secret is stored encrypted.',
            '**Payments:** the provider used, the amount, the status, the reference, and the Mobile Money number or payer details that the provider returns. We do not receive or store card numbers: a card is entered on the provider’s own page.',
            '**Connected accounts:** the WhatsApp number and the WhatsApp Business account identifiers, and the access tokens for WhatsApp and, if you connect Google Sheets, for Google, stored encrypted. The number you link to the SurveyFlow Analytics Bot and the commands you send it.',
            '**Security records:** sign-ins and security events (a label for the browser, the first three groups of the IP address, the country), and a log of sensitive actions by you and your team members (exports, deletions, adding a member). We use it to protect your account and to show who did what.',
            '**Your content:** surveys, templates and settings, the team you invite (name, e-mail address and role), and the messages you send us for support.',
            '**Cookies:** a session cookie that keeps you signed in and a language cookie. Cloudflare Turnstile (a CAPTCHA) runs at sign-up and after failed sign-ins and may use its own technical data. We use no advertising or tracking cookies.',
          ],
        },
      ],
    },
    {
      id: 'participant-data',
      h: 'What we hold about Participants, for the Customer',
      blocks: [
        {
          ul: [
            '**What the Customer provides:** a name (optional), a WhatsApp number, labels, and whether the person agreed to be contacted, with the time and the source (entered by the Customer, an imported file, a join link, or START).',
            '**What the Participant sends:** answers (choices, ratings, free text), replies such as STOP, and progress through the survey.',
            '**Message status:** sent, delivered, read, failed.',
            '**Contacts from the Customer’s WhatsApp Business app:** if the Customer connects a number that is also used in the WhatsApp Business app, WhatsApp can pass us the address book (names and numbers). We store them without a consent mark until the Customer confirms that those people agreed to be contacted. The chat history and the messages the Customer wrote in the app are counted but never read or stored.',
            'Names and numbers are encrypted in the database and masked on screen. Answers are stored without field-level encryption and protected as section 10 describes.',
          ],
        },
        { p: 'SurveyFlow does not read Participants’ answers for its own purposes, does not combine them across Customers, does not sell them, and takes no decision about a person by automated means. Each Customer’s data is kept apart from every other Customer’s. SurveyFlow has no screen for reading Participants’ answers; technical access to the database is limited to the operator who runs, secures and repairs the service.' },
        { p: '**What must not be collected.** The Law prohibits processing data on religious, philosophical, political or trade-union opinions and activities, racial or ethnic origin, linguistic or regional origin, genetics and health biometrics, and processing in connection with banking transactions without the authorisation of the competent authorities (s. 48). The Terms forbid Customers to use SurveyFlow for these, or for health information, and we may remove such content.' },
      ],
    },
    {
      id: 'why',
      h: 'Why we use data, and on what basis',
      blocks: [
        {
          ul: [
            'To provide the service you asked for: create and send surveys, collect answers, show results and exports, and run the Analytics Bot.',
            'To take payment and keep accounting records.',
            'To protect accounts and the platform: sign-in checks, rate limits, preventing abuse and fraud, and keeping the STOP list.',
            'To communicate with you: confirmations, security alerts, billing and renewal notices, and a notice when WhatsApp disconnects your number.',
            'To meet legal obligations.',
            'To improve the service, from counts and measurements that contain neither survey content nor identities.',
          ],
        },
        { p: '**Basis.** The Law requires the prior, free, informed, specific and unambiguous consent of the person concerned (s. 9 and 50), with limited exceptions such as a legal obligation (s. 9). Customers give their consent by creating an account and accepting the Terms of Service and this policy, and may withdraw it by closing the account (s. 38). Participants’ consent is obtained by the Customer, who answers for it (section 5 of the Terms of Service). For people who join by link or QR code, the first message asks for consent and nothing else happens until the person answers START.' },
      ],
    },
    {
      id: 'recipients',
      h: 'Who receives data',
      blocks: [
        {
          rows: [
            ['Meta (WhatsApp)', 'Participants’ numbers, the text of messages and replies, delivery status, and the Customer’s WhatsApp business details. Meta handles these under its own terms and policies.'],
            ['Payment providers (such as Notch Pay, CinetPay, Campay, PayUnit, Flutterwave and CamerPay; the one used depends on your country and payment method)', 'What is needed to charge the subscription: amount, reference, and the name or Mobile Money number the provider asks for. They are not our employees and act under their own terms.'],
            ['Google', 'Only if the Customer signs in with Google or connects Google Sheets: identifiers for sign-in and, for Sheets, the results the Customer asks us to write to their own Google account.'],
            ['Cloudflare (Turnstile)', 'The technical signals needed to tell people from automated programs at sign-up and after failed sign-ins.'],
            ['Password check (haveibeenpwned.com)', 'The first five characters of a one-way hash of a new password, to refuse passwords known from leaks. Nothing else, and never the password.'],
            ['E-mail provider', 'The Customer’s e-mail address and the content of the e-mails we send (confirmation, security, billing, notices).'],
            ['Hosting and database provider', 'All the data we hold, encrypted where section 10 says so.'],
            ['The Customer’s team', 'Only what each person’s role allows: a viewer sees counts and results; an editor also sees participants; neither can export, reveal full numbers, see payment information or manage the team.'],
            ['Authorities', 'Only where the Law or a competent court requires it.'],
          ],
        },
        { p: 'We do not sell personal data and do not give it to advertisers or data brokers. Where a provider processes data on our behalf, we choose providers that give sufficient guarantees of security and compliance (s. 16, 26 and 30) and we limit what each receives to what its task needs. The current list is this page; we update it when it changes.' },
      ],
    },
    {
      id: 'abroad',
      h: 'Transfers outside Cameroon',
      blocks: [
        { p: 'WhatsApp is operated by Meta, and the other providers above may store or process data outside Cameroon. The place where our hosting provider stores data may also be outside Cameroon. The Law makes the transfer of personal data to a foreign country subject to the prior authorisation of the Personal Data Protection Authority (s. 32). SurveyFlow will request the authorisations and follow the conditions that the Authority requires of it, and will limit transfers to what the service needs. By using the service, Customers accept these transfers as part of how it works; Participants are told of them in section 2.' },
      ],
    },
    {
      id: 'retention',
      h: 'How long we keep data',
      blocks: [
        {
          rows: [
            ['Account and Customer data', 'As long as the account exists. When you ask to close it, the account stays read-only for 30 days (you can cancel); then the account and its data are erased.'],
            ['Participants’ data and answers', 'Until the Customer deletes them or the account is erased.'],
            ['Accounting records of payments', '10 years, kept without name, phone number or e-mail address, for accounting and tax purposes.'],
            ['Sign-in and security records', 'Ended sessions: 30 days. Security log: 400 days.'],
            ['Accounts never confirmed', 'Deleted after 24 hours.'],
            ['Backups', 'Encrypted, on a rotation of about 30 days; erased data disappears from backups when they expire.'],
          ],
        },
        { p: 'The Law requires data to be kept no longer than necessary (s. 13) and leaves the maximum periods to the Personal Data Protection Authority (s. 28). If the Authority sets other periods, we will apply them.' },
      ],
    },
    {
      id: 'rights',
      h: 'Your rights and how to use them',
      blocks: [
        { p: 'Under the Law, every person whose data is processed has the following rights (s. 37 to 47). To use them you may be asked to prove your identity (s. 42).' },
        {
          ul: [
            '**Access** (s. 39): to know whether your data is processed, and to receive it with its source, the purposes, the categories and the recipients, and a copy.',
            '**Correction** (s. 42): to have inaccurate or incomplete data rectified, completed, updated or blocked.',
            '**Erasure** (s. 37 and 38): to have your data erased and its disclosure stopped when it is no longer needed, when you withdraw your consent, or when there is no legal basis, subject to what must be kept by law.',
            '**Objection** (s. 40 and 41): to object at any time, in particular to use for direct marketing; after an objection the data may no longer be used for that purpose.',
            '**Restriction** (s. 46): to have processing limited while the accuracy or the purpose is contested.',
            '**Portability** (s. 43): to receive your data in a structured, commonly used, machine-readable format.',
            '**Automated decisions** (s. 44): not to be subject to a decision based solely on automated processing. SurveyFlow takes none.',
            '**After death** (s. 45): to leave instructions on what happens to your data.',
            '**Complaint** (s. 53): to complain to the Personal Data Protection Authority.',
          ],
        },
        { p: '**Customers:** you can download all of your account’s data in one file and ask for the account to be erased, in the application (Settings, Your data). **Participants:** reply STOP to stop messages from a sender. For access, correction or erasure, ask the sender first, as controller. If you cannot reach it, write to us (section 15): we will pass your request to the sender and help it act on it, and we will act ourselves on the data we keep for our own purposes. We reply within the time limits that regulation sets (s. 47) and without undue delay.' },
      ],
    },
    {
      id: 'security',
      h: 'How we protect data',
      blocks: [
        { p: 'The Law requires appropriate technical and organisational measures, such as encryption and restricted access (s. 22 and 25 to 27). In practice:' },
        {
          ul: [
            'Passwords are hashed with a modern one-way algorithm (argon2id).',
            'Participants’ names and numbers, WhatsApp and Google access tokens, and authenticator secrets are encrypted. Database backups are encrypted.',
            'Connections to the website and the application use HTTPS.',
            'Access is limited by role. Sensitive actions (export, deletion, adding a team member, changing security settings) ask you to confirm it is you, and two-step verification is available.',
            'Each Customer’s data is isolated from every other Customer’s; this is tested automatically.',
            'Sign-ins and sensitive actions are logged. Repeated failed sign-ins are slowed down and challenged.',
            'Answers are stored in the database without field-level encryption; they are protected by the access controls above and, in backups, by encryption.',
            'No system is perfectly secure, and we cannot promise absolute security.',
          ],
        },
      ],
    },
    {
      id: 'breach',
      h: 'If something goes wrong',
      blocks: [
        { p: 'If we become aware of a breach of personal data, the Law requires us to inform the Personal Data Protection Authority and the persons concerned without delay (s. 22). For Participants’ data, we tell the Customer without undue delay so that it can inform them, and we inform the Authority and, where the Law requires, the persons concerned. For a Customer’s own data, we inform the Customer by e-mail.' },
      ],
    },
    {
      id: 'other-laws',
      h: 'Customers and Participants in other countries',
      blocks: [
        { p: 'The data protection law of another country (for example Nigeria, Kenya, Ghana, Côte d’Ivoire or the European Union) may also apply to a Customer’s use of SurveyFlow, depending on where its contacts are. The Customer is responsible for the laws that apply to its own use. We use the Law as our common baseline for everyone.' },
      ],
    },
    {
      id: 'children',
      h: 'Children',
      blocks: [
        { p: 'SurveyFlow is not meant for children, and accounts are for adults. The Law requires the consent of the father and mother or legal representative for a person under eighteen (s. 9) and limits the processing of minors’ data to what is necessary (s. 18). The Terms forbid Customers to survey anyone under eighteen without that consent. SurveyFlow does not check ages.' },
      ],
    },
    {
      id: 'changes',
      h: 'Changes to this policy',
      blocks: [
        { p: 'When we change this policy in a way that matters, we tell Customers by e-mail or in the application before the change applies, and we update the date at the top of this page.' },
      ],
    },
    {
      id: 'contact',
      h: 'Contact',
      blocks: [
        { p: contactLine('en', ctx) },
        { p: 'Customers can also use the application (Settings, Your data). Anyone may lodge a complaint with the Personal Data Protection Authority.' },
      ],
    },
  ],
});

import { ENTITY, LEGAL_VERSION, contactLine, longDate } from './shared';
import type { LegalContext, LegalDoc } from './types';

/**
 * Terms of service, English. Citations ("s. 9") are to Law No. 2024/017 of 23 December 2024 on personal data protection in Cameroon, checked against the
 * certified copy in docs/legal/. The French text (terms-fr.ts) must say the same: a test compares them, and pins the positions that sentences point to
 * ("section 5" is the Customer's responsibilities, "section 14" the data processing terms).
 * What the first version does not include (gifts, wallet, API, white-label) is stated in section 2 on purpose: it is the scope the text was written for.
 */
export const termsEn = (ctx: LegalContext): LegalDoc => ({
  title: 'Terms of service',
  description: 'The agreement between SurveyFlow and its Customers: what the service is and is not, what each party is responsible for, billing, liability and how contacts’ data is processed.',
  meta: `Version of ${longDate(LEGAL_VERSION, 'en')} · ${ENTITY.name}, ${ENTITY.place}`,
  tocLabel: 'On this page',
  lead: `These Terms are the agreement between ${ENTITY.name} and the person or organisation that creates a SurveyFlow account (the “Customer”, “you”). They say what the service is and is not, what each party is responsible for, and how the data of the Customer’s contacts is handled. Please read sections 2, 5 and 11 with care.`,
  sections: [
    {
      id: 'parties',
      h: 'Who we are and how you accept',
      blocks: [
        { p: `The service is provided by **${ENTITY.name}**, ${ENTITY.place} (“SurveyFlow”, “we”).` },
        { p: 'By creating an account or using the service you accept these Terms and the [Privacy policy](/privacy). If you do not accept them, do not use the service. If you sign up for an organisation, you confirm that you have the authority to bind it. You must be an adult and legally able to enter into a contract.' },
        { p: 'The Terms exist in English and in French. Both have the same value.' },
      ],
    },
    {
      id: 'service',
      h: 'What SurveyFlow is, and what it is not',
      blocks: [
        { p: '**What the service does.** SurveyFlow is a web application that lets you build surveys; send them to your own contacts on WhatsApp through Meta’s WhatsApp Business Platform; let people join a survey by a link or a QR code; receive their answers inside WhatsApp; see results and analytics; export them (CSV, Excel, PDF, Google Sheets); invite team members; and ask for your results from the SurveyFlow Analytics Bot on WhatsApp. The plans (Explore, Starter, Growth and Business), their limits and their prices are shown on the pricing page.' },
        { p: '**What is not part of the service in this version:**' },
        {
          ul: [
            'Gifts and rewards for Participants of any kind (airtime, mobile data, Mobile Money transfers, discount codes, prize draws or receipts), and any prepaid wallet. SurveyFlow does not hold, transfer, convert or pay out money for Customers or Participants. The only payments are those you make to SurveyFlow for your plan or for an overage invoice.',
            'API access and white-label use.',
            'Messaging channels other than WhatsApp, such as SMS.',
            'Checking consent: SurveyFlow does not verify that your contacts agreed to be messaged (section 5).',
            'Legal, regulatory or research-ethics advice; lists of contacts; or any guarantee that people will receive, read or answer your surveys.',
            'Anything that Meta, Google or a payment provider supplies. They are independent companies (section 9). SurveyFlow is not owned by, affiliated with or endorsed by Meta or WhatsApp.',
          ],
        },
        { p: 'If we later offer rewards, a wallet or other features that involve money, they will be available only under additional terms that you accept first. Until then nothing in the application or in our material is an offer of them.' },
      ],
    },
    {
      id: 'account',
      h: 'Your account',
      blocks: [
        {
          ul: [
            'Give accurate information, keep it up to date, and confirm your e-mail address.',
            'Keep your password and any authenticator secret private; we recommend two-step verification. You are responsible for everything done through your account.',
            'Team members you invite act under your responsibility. You choose their role (viewer or editor) and remove them when they should no longer have access. Every action they take is recorded against them.',
            'Tell us at once if you think someone else has used your account.',
            'You can close your account at any time in Settings. It then stays read-only for 30 days, during which you can cancel; afterwards the account and its data are erased, except the accounting records described in the Privacy policy. We may postpone the closure while a payment you owe us is unresolved.',
          ],
        },
      ],
    },
    {
      id: 'meta',
      h: 'WhatsApp, Meta and message costs',
      blocks: [
        {
          ul: [
            'You need your own WhatsApp Business account and number, connected to SurveyFlow through Meta’s sign-up flow. Connect only a number that you control and are entitled to use.',
            'You must follow the Meta terms and policies that apply to your use, including the WhatsApp Business Terms of Service, the WhatsApp Business Messaging Policy and the Meta Platform Terms. Meta, not SurveyFlow, decides whether your number may send messages, its message limits and its quality rating, and may restrict or disable it. SurveyFlow is not liable for those decisions.',
            'Meta charges you directly for the messages sent through your WhatsApp Business account, at its prices and by its categories. SurveyFlow does not charge, collect, refund or control Meta’s charges. Keep a valid payment method with Meta; without one, Meta may stop delivering your messages.',
            'SurveyFlow treats a survey as a marketing message, which costs more, unless you declare that the people receive it because of something they did with your business and that it contains nothing promotional. Your declaration must be true. We ask you to accept the cost before each marketing send. Meta may re-categorise a message; if it does, we tell you and sending waits for your acceptance.',
            'If your number is also used in the WhatsApp Business app, Meta’s rules for that arrangement apply, including limits on what carries over. Contacts that WhatsApp passes to SurveyFlow are stored without a consent mark until you confirm that those people agreed to be contacted; confirm only what is true (section 5). If Meta ends the connection, your surveys pause until you reconnect.',
          ],
        },
      ],
    },
    {
      id: 'duties',
      h: 'Your responsibilities for your contacts and messages',
      blocks: [
        { p: 'SurveyFlow gives you the tool. **You decide whom to contact, with what and why, and you answer for it.** In particular:' },
        {
          ol: [
            '**You are the controller.** For the data of your contacts and Participants you are the controller under the Law. You are responsible for its lawfulness: consent (s. 9 and 50), clear information to the person (s. 14 and 21), purposes (s. 11), accuracy (s. 12), retention (s. 13), people’s requests about their rights (s. 37 to 47), and any declaration or authorisation the Law requires of a controller for your own use (s. 19 and 49). SurveyFlow is responsible for those that concern its own processing and its own providers (section 14).',
            '**Consent before you contact.** Before you add or import a contact, that person must have agreed beforehand, explicitly, freely and with enough information, to receive WhatsApp messages of the kind you send (s. 5 and 9). You must be able to show that agreement if the Personal Data Protection Authority, a court, Meta or SurveyFlow asks. The tick you give in SurveyFlow is your declaration: SurveyFlow stores it with the time and the source and does not check it. If it is untrue, you bear the consequences.',
            '**Contacts from your WhatsApp Business app.** Confirm them only if those people agreed to receive surveys from you.',
            '**Join links and QR codes.** You choose where to share them and you answer for that choice. The first message asks for consent and says how to stop; do not remove or hide it, and do not use a link to collect numbers for any other purpose.',
            '**STOP.** When someone replies STOP, or otherwise objects, you must not contact them again, through SurveyFlow or by any other means using the data you got through it (s. 40). SurveyFlow honours STOP automatically; never try to get round it.',
            '**No direct prospecting.** Do not use SurveyFlow to promote goods, services or your image to people who have not given their prior consent to it, and do not give or sell Participants’ data to third parties for marketing (s. 41).',
            '**Data you must not collect.** Do not collect, through questions or otherwise, data on religious, philosophical, political or trade-union opinions or activities, racial or ethnic origin, linguistic or regional origin, genetics or health biometrics, or data connected with banking transactions (s. 48); nor health information, identity-document numbers, card numbers or passwords. If such data arrives in a free-text answer, delete it. We may remove it.',
            '**Young people.** Do not survey anyone under eighteen unless a parent or legal representative has consented (s. 9 and 18). SurveyFlow does not check ages.',
            '**No profiling.** Do not use SurveyFlow to profile people, and do not use answers to take automated decisions about them (s. 44 and 65).',
            '**People’s requests.** Answer, within the legal time, requests from your contacts to see, correct or erase their data, using the tools in the application. Tell us if you need our help.',
            '**Your content.** The questions, messages and results are yours and your responsibility. They must be lawful, truthful about who is asking, and respect the laws and ethics rules that apply to your activity (advertising, elections and political surveys, health, research ethics) in each country where your contacts are.',
            '**Breach.** Tell us without delay if you learn of a breach of data that concerns SurveyFlow, and meet your own duty to inform the Authority and the persons concerned (s. 22).',
            '**Other countries’ laws.** If your contacts are in another country, that country’s data protection law may also apply to you; you are responsible for it.',
          ],
        },
      ],
    },
    {
      id: 'use',
      h: 'Acceptable use',
      blocks: [
        { p: 'You must not: send spam or unsolicited messages; send content that is unlawful, misleading, abusive, hateful or discriminatory, or that infringes others’ rights; pretend to be another person or organisation; use a survey to phish, to obtain passwords, codes or payment details, or to commit fraud; break Meta’s policies; try to get round limits, caps, consent steps or security (for example by opening several accounts to avoid a limit); probe, scrape, overload or reverse engineer the service; resell the service or give others access to it without our written agreement; or upload malicious code.' },
        { p: 'Accounts whose messages are reported or blocked by many people can lower the quality rating of the shared WhatsApp platform. We may pause them.' },
      ],
    },
    {
      id: 'billing',
      h: 'Plans, payment and billing',
      blocks: [
        {
          ul: [
            '**Plans.** Plans, limits and prices are on the pricing page. Prices may be displayed in your currency at an approximate exchange rate; the amount you are charged is shown before you pay.',
            '**Payment.** Subscriptions are paid in advance through independent payment providers. Mobile Money does not renew automatically: to renew, pay again. We do not store card numbers. SurveyFlow is not a bank, a payment institution or an issuer of electronic money, and it does not hold or pay out other people’s money.',
            '**Moving up.** If you move to a bigger plan before the one you paid for ends, the unused whole days of what you paid are credited against the new price, which never falls below 10 percent of the new plan’s price. Moving to a lower plan is done by letting the current one end.',
            '**Responses beyond your plan.** A response is never refused. If you agree in Billing, responses beyond your monthly allowance are invoiced after each month at 500 FCFA per block of 100 responses; you pay the invoice yourself and nothing is taken from you automatically. If an invoice stays unpaid after its due date, we may stop sending new messages for your account, and decline renewals and upgrades, until it is paid. We do not delete your data for non-payment alone.',
            '**No refunds** of amounts already paid, except the credit above and where mandatory law gives you a right.',
            '**Taxes.** You are responsible for the taxes that apply to your use. If we must charge a tax, we show it before you pay.',
            '**Meta’s charges** are separate and are paid to Meta (section 4).',
            '**Price changes.** We tell you at least 30 days before a new price applies; it applies from your next payment.',
          ],
        },
      ],
    },
    {
      id: 'content',
      h: 'Content and intellectual property',
      blocks: [
        { p: `SurveyFlow, its software, design and brand belong to ${ENTITY.name} or its licensors. We give you a limited, non-exclusive, non-transferable right to use the service while your account is open. As between you and us, your surveys, your contacts’ data and the answers remain yours (or those of the people who gave them). You allow us to host, process and transmit them as needed to provide the service and as these Terms say. We may use counts and measurements that contain no survey content and no personal identity to run and improve the service. If you send us feedback, we may use it freely.` },
      ],
    },
    {
      id: 'responsibilities',
      h: 'Who is responsible for what',
      blocks: [
        {
          rows: [
            [ENTITY.name, 'Runs and secures the platform; processes Participants’ data only for you and on your instructions; is the controller of account, billing and security data; chooses its providers with sufficient guarantees; supports you at its published contact; and meets the Law for its own role (s. 16, 20 and 26).'],
            ['You, the Customer', 'Your contacts, their consent, your messages and questions, your use of the results, your team, your compliance with the Law and with Meta’s rules, your costs with Meta and your taxes (sections 3 to 7).'],
            ['Your team members', 'They act under your account and your responsibility.'],
            ['Participants', 'They are free to refuse, to stop with STOP and to ask for their rights. Their consent is collected by you.'],
            ['Meta (WhatsApp)', 'Provides WhatsApp; sets its rules, prices, limits and message categories; and decides on your number. It is independent from SurveyFlow.'],
            ['Payment providers', 'Process payments under their own terms. They are not SurveyFlow’s agents, and their delays or failures are theirs.'],
            ['Google', 'Only if you use Google sign-in or Google Sheets: that is your relationship with Google.'],
            ['Hosting, e-mail, CAPTCHA and password-check providers', 'Process data for SurveyFlow on its instructions. SurveyFlow chooses them and answers to you for that choice (section 14).'],
          ],
        },
      ],
    },
    {
      id: 'availability',
      h: 'Availability and support',
      blocks: [
        { p: 'We work to keep the service running, but we do not promise uninterrupted or error-free service, a response time or an uptime level. The service depends on Meta, payment providers, hosting and networks that we do not control. Delivery, speed and response rates of WhatsApp messages are not guaranteed. We may perform maintenance and change or remove features, and we tell you in advance where we can. Support is given by e-mail at the contact address published on this site, on a reasonable-effort basis, with no promised response time. To the extent the law allows, the service is provided “as is” and “as available”.' },
      ],
    },
    {
      id: 'liability',
      h: 'Limits of liability',
      blocks: [
        {
          ul: [
            'To the extent the law allows, SurveyFlow is not liable for indirect or consequential loss, or for loss of profit, revenue, goodwill or data beyond what our backups allow us to restore, or for loss that results from: your contacts, consent, content or use of the service; Meta’s decisions about your number, limits, categories, prices or charges; the failure or delay of Meta, a payment provider, a host or a network; unauthorised access caused by your or your team’s lack of care with credentials; or events beyond our control.',
            'Our total liability to you for all claims arising out of the service is limited to the fees you paid to SurveyFlow in the 12 months before the event that gave rise to the claim.',
            'Nothing in these Terms excludes or limits liability for fraud, gross negligence or wilful misconduct, or any liability that the law does not allow to be excluded or limited.',
            'The Law gives people whose data is processed rights against both the controller and the processor, including joint and several liability for disclosing personal data without their consent (s. 23). These Terms do not limit those rights. Between you and us, the allocation in sections 5, 9, 12 and 14 applies.',
          ],
        },
      ],
    },
    {
      id: 'indemnity',
      h: 'Your indemnity',
      blocks: [
        { p: 'You will compensate and defend SurveyFlow, its owners, officers and staff against claims, fines, penalties, damages and costs (including reasonable legal fees) brought by a third party, a person concerned, Meta or an authority and arising from your contacts or the lack of their consent, your content, your breach of the Law, of Meta’s policies or of these Terms, or the acts of your team members. We will tell you promptly of any such claim and cooperate reasonably at your cost. You may not settle a claim in a way that binds us without our written agreement.' },
      ],
    },
    {
      id: 'suspension',
      h: 'Suspension and termination',
      blocks: [
        { p: 'We may suspend or end your access, immediately where necessary, if you break these Terms or Meta’s policies, if your use puts the platform, other Customers or Participants at risk, if the law or an authority requires it, or if you fail to pay what you owe. We tell you why and, where possible, give you the chance to put it right, except where that would be unsafe or unlawful. You may close your account at any time (section 3). On closure or termination your data is handled as the Privacy policy says. The sections that by their nature must continue (including 5, 11, 12 and 15, and 14 for as long as we hold the data) continue.' },
      ],
    },
    {
      id: 'data-processing',
      h: 'Data processing terms',
      blocks: [
        { p: 'This section is the contract between you, as controller, and SurveyFlow, as processor, that section 30 of the Law requires for the data of your contacts and Participants.' },
        {
          rows: [
            ['Subject and purpose', 'Hosting, sending through WhatsApp, collecting and storing answers, producing results, exports and analytics, and keeping the proof of consent and the STOP list, for the surveys you run.'],
            ['Duration', 'While your account is open, plus the 30-day read-only period after you ask to close it; then erasure as the Privacy policy says.'],
            ['Types of data', 'Names (optional), WhatsApp numbers, labels, the consent mark with its time and source, the STOP flag, answers (including the free text you ask for), message status, and the contact data that WhatsApp passes from your WhatsApp Business app.'],
            ['People concerned', 'Your contacts and the people who join your surveys by link or QR code. As to their own accounts, your team members.'],
            ['Our duties', '(a) Process the data only on your documented instructions, which are these Terms and your use of the application’s settings (s. 24). (b) Keep it confidential, and make sure that everyone we authorise to process it is bound to confidentiality and acts only on those instructions (s. 24 and 25). (c) Apply the security measures described in the Privacy policy (s. 22 and 25 to 27). (d) Use only the sub-processors listed in section 6 of the Privacy policy, under duties of the same kind, and update that list when it changes; if you object to a new one, you may close your account. (e) Help you answer people’s requests about their rights, through the application’s tools and, beyond them, on reasonable request. (f) Tell you without undue delay of a breach that affects your data (s. 22). (g) On closure, let you download your data and erase it as described. (h) Give you the information needed to show our compliance, on reasonable request and not more than once a year, except after a breach.'],
            ['Your duties', 'Give lawful instructions; inform the people concerned as the Law requires (s. 21); collect and confirm their consent; answer their requests; do not ask us to process data that may not be processed (section 5).'],
            ['Transfers abroad', 'You accept the transfers described in section 7 of the Privacy policy. SurveyFlow answers for the authorisations and conditions that the Law requires of it for them (s. 32).'],
            ['Our own data', 'For the Customer’s account, billing and security data, and for the limited purposes in section 1 of the Privacy policy, SurveyFlow acts as controller.'],
          ],
        },
      ],
    },
    {
      id: 'law',
      h: 'Governing law and disputes',
      blocks: [
        { p: 'These Terms are governed by the law of Cameroon. If a dispute arises, write to the other party at the contact address and try in good faith to settle it within 30 days. If that fails, the competent courts of Douala have jurisdiction, subject to any mandatory rule that gives you the right to go elsewhere.' },
      ],
    },
    {
      id: 'changes',
      h: 'Changes to these Terms',
      blocks: [
        { p: 'We may change these Terms. For a change that matters we tell you by e-mail or in the application at least 30 days before it applies, except where Meta, the law or security requires shorter notice. If you keep using the service after that date, you accept the change. If you do not accept it, close your account before that date.' },
      ],
    },
    {
      id: 'general',
      h: 'General',
      blocks: [
        { p: 'These Terms, the Privacy policy, the pricing page and anything you accept in the application (such as the cost of a send) are the whole agreement between us on the service. If a part cannot be enforced, the rest continues. Not enforcing a right is not giving it up. You may not transfer your rights without our consent; we may transfer ours to a successor of the business. Neither party is liable for a failure caused by events beyond its reasonable control, including outages or decisions of Meta, payment providers, networks or power suppliers, and acts of authorities. Notices to you go to your account e-mail address; notices to us go to the contact below.' },
      ],
    },
    {
      id: 'contact',
      h: 'Contact',
      blocks: [{ p: contactLine('en', ctx) }],
    },
  ],
});

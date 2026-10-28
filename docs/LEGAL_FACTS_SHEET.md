# SurveyFlow V1 — facts sheet for legal review

*Prepared 28 Oct 2026 from the code and the docs (`docs/DECISIONS.md`, `docs/SECURITY.md`). It states what the software does today. **?** marks an assumption or a decision not taken yet. One page, to bring to the advisor; the same text is in `docs/LEGAL_FACTS_SHEET.md` and `docs/SurveyFlow_Legal_Facts_Sheet.docx`.*

**1. The service.** A web application for customers ("owners") in Cameroon first (CFA francs; prices also shown for Nigeria, Kenya, Ghana, South Africa, Uganda, and by card elsewhere). An owner builds a survey and sends it to **their own contacts** through Meta's WhatsApp Business Cloud API. Participants answer inside WhatsApp. The owner sees the results, can download them, and can reward participants (airtime, Mobile Money, discount code, prize draw) paid from a **prepaid wallet** the owner tops up. Plans: Explore (free), Starter, Growth, Business.

**2. Roles (to confirm).** Operating entity and registered office: **?** (to be stated). Participants' data: the owner decides what to ask and whom to message (controller), SurveyFlow processes it (processor). The owner's own account, billing and security data: SurveyFlow is the controller. No data-processing agreement exists. The privacy and terms pages are drafts, marked as such, never reviewed by counsel.

| Whose data | What is held | How it is protected | How long |
|---|---|---|---|
| **Owner** | Name, business, e-mail, phone, country, plan; payments (provider, amount, payer's Mobile Money number); WhatsApp and Google access tokens; sign-in history (browser label, first three groups of the IP address, country) | Password: argon2id hash. Tokens and the authenticator secret: AES-256-GCM. Sign-in and security events: append-only log (ids and counts, no numbers or names) | Account life. Ended sessions 30 days. Security log 400 days. Never-confirmed accounts deleted after 24 h |
| **Participant** (supplied by the owner) | Name, WhatsApp number, tags, consent tick with time and source, STOP flag, **answers (free text)**, delivery and gift status | Name and number AES-256-GCM encrypted in the database and masked on screen (showing one is limited and logged). **Answers are stored unencrypted.** Isolated per owner (tested on every route) | Until the owner deletes them. **No self-service account deletion or export yet** |
| **Visitor** | Session and language cookies; CAPTCHA signals at sign-up and after failed sign-ins | Session cookie httpOnly | Session |

**3. Who else receives data.** Meta (participant numbers and message text). Payment providers (Notch Pay, CinetPay, Campay, PayUnit, Flutterwave, CamerPay: the owner's payer number and amounts; Campay also pays gifts to participants' numbers). Google (only if the owner signs in with Google or connects Sheets). Cloudflare (Turnstile CAPTCHA). haveibeenpwned.com (the first 5 characters of a new password's SHA-1 hash, nothing else). An e-mail provider for confirmation and security mails (**?** not chosen). Hosting and database provider (**?** not chosen, so the country of storage is unknown and cross-border transfer is likely). Staff access today: database access by the operator; there is no admin console or role system yet.

**4. Consent.** SurveyFlow does not verify it. The owner ticks "my contacts agreed to receive WhatsApp messages from me" (manual entry or CSV import); the tick is stored with a time and a source. Every invitation offers "Not now", and STOP is honoured for good. Business-initiated messages use Meta-approved templates (reminders are treated as marketing).

**5. Money.** Subscriptions are paid in advance through the providers (no card data stored); unused time is not refunded. Gift wallet: the owner tops up, each gift debits its amount plus a **placeholder 5 % fee** (real tariffs **?** pending), paid out through Campay. **The balance cannot be withdrawn and no refund rule is decided.**

**6. Not in place yet.** Account deletion and data export; retention rules beyond the table; encrypted disks and backups (depends on hosting); a breach-notification procedure; the final privacy policy, terms and data-processing agreement; any test against the real Meta, payment-provider and e-mail services.

**7. Questions for counsel.**
1. Role split; the data-processing agreement; the legal basis for transfers to Meta, the providers and the host.
2. Cameroon's personal-data law (our draft cites Law No. 2024/017; status, registration and DPO duties?), Nigeria (NDPA 2023), Kenya (DPA 2019), Ghana (DPA 2012), Côte d'Ivoire (2013), GDPR when EU contacts appear: which apply and what must exist before launch.
3. The consent-responsibility clause; participants under 18; sensitive subjects (health, politics).
4. Is the prepaid wallet e-money or a regulated payment service (BEAC/COBAC and the other markets)? Unspent-balance and refund rules; VAT or other tax on subscriptions and gifts.
5. Prize draws and rewards: lottery and promotion rules per country.
6. Retention periods the law requires or forbids; erasure on request; breach notification (who, how fast).
7. Liability limits, availability wording, suspension, governing law and courts; Meta's and Google's platform terms.

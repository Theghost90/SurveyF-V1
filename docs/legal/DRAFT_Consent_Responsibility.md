# Consent responsibility (LEG-02). Adopted 2026-11-06 on the owner's word (D-20). Not reviewed by counsel. Not legal advice.

**Status.** The wording below is no longer only a draft: the Customer's duties are Terms section 5 (`apps/web/src/lib/legal/terms-en.ts`, `terms-fr.ts`), the Participants' notice is Privacy policy section 2, and the join message carries the link to that notice. What stays open is counsel's reading, set out in the six questions of section 3, now with the place where the text answers each. The sections of Law No. 2024/017 cited here were read in the certified copy (`docs/legal/LAW_2024-017_OBLIGATIONS.md`).

This is the text the product shows today, and what it would say if the wording below were adopted, **for counsel to settle**. Nothing here is a promise or an opinion: it says what the software does, and marks each point only counsel can decide.

## 1. What the owner is asked to confirm today

Where the owner adds a contact or imports a list (`apps/web/src/lib/i18n/insights.ts`, keys `c.consent` and `c.consentHint`):

> *These people agreed to receive WhatsApp messages from my business.*
> *WhatsApp requires it. The date is stored as proof, and anyone who replies STOP is excluded automatically.*

What is stored: a tick, with the time and the source (`owner_manual`, `owner_csv_import`, `join_link`, `whatsapp_start`), and nothing more. **Deliberately not stored:** the wording the person agreed to, where or how they agreed, or any copy of their agreement (the backlog's own containment for LEG-02 is "timestamp and owner only": proof of consent would be more personal data).

## 2. Wording proposed for counsel to accept, change or refuse

**On adding or importing contacts** (owner confirms, once per import):

> I confirm that each person on this list agreed, before today, to receive WhatsApp messages from my business, that I can show that agreement if asked, and that I will stop messaging anyone who asks me to. I understand that SurveyFlow does not check this, that I am responsible for it under the data protection law that applies to me, and that a person who replies STOP is never messaged again.

**First message to a person who joins by link or QR code** (sent by the product since 2026-11-06 with the notice line, `joinConsentText` in `packages/shared/src/join.ts`; the person must answer START before anything else happens):

> Hello! {business} invites you to answer a short survey: “{title}”.
> If you go ahead, {business} will keep your answers and this WhatsApp number to read the results. You can stop at any time by replying STOP.
> Who handles your data, where it goes and your rights: {web address}/privacy#participants
> Reply START to begin.

## 3. Questions only counsel can answer, and where the text answers each for now

1. **Is a tick plus a time and a source enough as the owner's evidence, or must the owner be able to produce more (and must SurveyFlow store it)?** The Terms (section 5, item 2) say the owner must be able to show the agreement if the Authority, a court, Meta or SurveyFlow asks, and that the tick is the owner's declaration which SurveyFlow does not check. Nothing more is stored (the containment in the backlog: "timestamp and owner only").
2. **Who is the controller towards the participant: the owner alone, or SurveyFlow as well? Does the join message make the consent valid, and must it name SurveyFlow?** The texts say: the owner is the controller, SurveyFlow the processor (Privacy policy section 1; Terms section 14), with limited purposes of its own (STOP list, abuse, legal records). The join message does not name SurveyFlow itself; it links to the notice, which names SurveyFlow Sarl and its address. The law asks the controller to give the identity, purposes, categories, recipients, the right to refuse, the rights, the retention and the transfer abroad at collection (s. 21): the link carries what a message cannot.
3. **Minimum age, and subjects the owner must not survey without more.** The texts say: under 18 only with a parent's or legal representative's consent (s. 9(3), 18); forbidden altogether: the categories of s. 48, and (our choice) health information, identity numbers, card numbers and passwords.
4. **Must the owner's confirmation be repeated, and what must the product refuse when it is missing?** Unchanged: confirmed at each import; the product refuses to message a contact without a recorded consent; contacts that arrive from the owner's WhatsApp Business app wait for the owner's confirmation.
5. **How does a person withdraw consent at SurveyFlow rather than at the owner?** STOP still works per owner only. The Privacy policy (section 9) tells participants to ask the owner first and otherwise to write to SurveyFlow, which passes the request on and helps the owner act; there is no screen for it yet.
6. **The text above in French, which must read the same.** Done in `terms-fr.ts`, `privacy-fr.ts` and `join.ts`; a test (`apps/web/tests/legal-pages.test.ts`) keeps the sections, the kinds of block and the cited sections the same in both languages. A lawyer should still read the French.

## 4. What the software guarantees whatever the wording

STOP is honoured at once and for good; invitations by template go only to people with a recorded consent; the join link sends nothing until the person has answered START; a person who replied STOP and then joins again starts from the consent message, not from the survey.

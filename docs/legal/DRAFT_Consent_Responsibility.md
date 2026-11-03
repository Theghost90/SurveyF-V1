# DRAFT — consent responsibility (LEG-02). Not reviewed by counsel. Not legal advice.

This is the text the product shows today, and what it would say if the wording below were adopted, **for counsel to settle**. Nothing here is a promise or an opinion: it says what the software does, and marks each point only counsel can decide.

## 1. What the owner is asked to confirm today

Where the owner adds a contact or imports a list (`apps/web/src/lib/i18n/insights.ts`, keys `c.consent` and `c.consentHint`):

> *These people agreed to receive WhatsApp messages from my business.*
> *WhatsApp requires it. The date is stored as proof, and anyone who replies STOP is excluded automatically.*

What is stored: a tick, with the time and the source (`owner_manual`, `owner_csv_import`, `join_link`, `whatsapp_start`), and nothing more. **Deliberately not stored:** the wording the person agreed to, where or how they agreed, or any copy of their agreement (the backlog's own containment for LEG-02 is "timestamp and owner only": proof of consent would be more personal data).

## 2. Wording proposed for counsel to accept, change or refuse

**On adding or importing contacts** (owner confirms, once per import):

> I confirm that each person on this list agreed, before today, to receive WhatsApp messages from my business, that I can show that agreement if asked, and that I will stop messaging anyone who asks me to. I understand that SurveyFlow does not check this, that I am responsible for it under the data protection law that applies to me, and that a person who replies STOP is never messaged again.

**First message to a person who joins by link or QR code** (already sent by the product; the person must answer START before anything else happens):

> Hello! {business} invites you to answer a short survey: “{title}”.
> If you go ahead, {business} will keep your answers and this WhatsApp number to read the results. You can stop at any time by replying STOP.
> Reply START to begin.

## 3. Questions only counsel can answer

1. Is a tick plus a time and a source enough as the owner's evidence, or must the owner be able to produce more (and if so, must SurveyFlow store it)?
2. Who is the controller towards the participant: the owner alone, or SurveyFlow as well (it chooses to hold the number for gifts, receipts, and the join flow)? Does the join message above make the participant's consent valid, and does it need to name SurveyFlow?
3. Minimum age, and subjects (health, politics, religion) the owner must not survey without more.
4. Whether the owner's confirmation must be repeated (each import, each survey, each year) and what the product must refuse when it is missing.
5. How a person withdraws consent at SurveyFlow rather than at the owner (STOP works only per owner today).
6. The text above in French, which must read the same.

## 4. What the software guarantees whatever the wording

STOP is honoured at once and for good; invitations by template go only to people with a recorded consent; the join link sends nothing until the person has answered START; a person who replied STOP and then joins again starts from the consent message, not from the survey.

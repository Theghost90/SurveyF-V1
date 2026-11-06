# Law No. 2024/017 of 23 December 2024: what it asks, and where SurveyFlow stands

*Read on 2026-11-06 from the certified copy in this folder (`Law_2024-017_personal_data_protection_Cameroon.pdf`, 17 pages, English text; the PDF has a text layer on its cover only, so each page was read as an image). "s." is the law's own section number. What follows paraphrases the sections; it is not legal advice and counsel's reading prevails. It supports LEG-01 and LEG-02, which were closed on the owner's word (D-20) without counsel's review: this is the list of what that review would look at.*

## A. What the text itself says that shapes the pages

1. **Consent is the only ordinary basis.** Processing needs the prior, free, informed, specific and unambiguous consent of the person (s. 9(1)); the exceptions are a legal obligation, a public-interest task and protecting health (s. 9(2)); and processing without consent is prohibited (s. 50). There is no "contract" or "legitimate interest" basis in this text. So even an owner's own account data rests on consent, which is why the Privacy policy says owners consent by creating an account.
2. **Prior authorisation of the Authority.** Processing is "subject to prior authorization by the Personal Data Protection Authority" (s. 19(1); also s. 49); doing it without costs 5 to 50 million CFA francs (s. 55). The Authority is to be set up by presidential decree (s. 53(2)). Whether it exists and issues authorisations is not something this repository can show: **counsel or the Authority must answer.** The Terms put each party's own authorisations on that party (Terms, section 5 item 1) and promise nothing about them.
3. **Transfers abroad** need the Authority's prior authorisation, a destination with adequate protection, binding security rules, and the Authority's standard contractual clauses (s. 32); without it: 10 to 50 million CFA francs (s. 60), and a crime when in breach of the law: 3 to 10 years or 2 to 20 million (s. 69). Meta, Google, Cloudflare, the host, the e-mail and payment providers are all probably abroad. The Privacy policy discloses the transfers (s. 21 last item) and commits only to request what the Authority requires of SurveyFlow.
4. **The 18 months have run.** Controllers and processors had 18 months "from the date of enactment" to comply (s. 73). From 23 December 2024 that ended about 23 June 2026: the law applies in full now.
5. **Processor does not mean lighter duties.** Controller and processor "shall be bound by the same obligations" (s. 20), and are "jointly and severally liable for any disclosure of personal data without the consent of the data subject" (s. 23(3)). The Terms' limit of liability therefore cannot bind a data subject; it only allocates between SurveyFlow and the Customer (Terms, section 11).
6. **"Banking transactions" are sensitive.** The definition of sensitive data lists "banking transactions" (s. 5); processing linked to banking transactions is prohibited without the competent authorities' prior authorisation (s. 48(2)); storing sensitive data without the person's express consent is punished by 6 months to 2 years or 0.5 to 5 million (s. 66). SurveyFlow keeps its own customers' payment records (provider, amount, the payer's number). Whether that is a "banking transaction" in this sense is a question for counsel.
7. **Prohibited categories** of data: religious, philosophical, political or trade-union opinions and activities, racial or ethnic origin, linguistic or regional origin, genetics, health biometrics (s. 48(1)). Free-text answers can contain them; the Terms forbid asking for them.
8. **Legal persons** can be fined 50 million to 1 billion CFA francs for offences committed by their officials (s. 71). Profiling is a crime in itself (3 to 10 years or 1 to 20 million, s. 65): the product does none and the Terms forbid it.
9. **Minors:** under 18, consent is valid only with the father and mother or the legal representative (s. 9(3)); data of minors is limited to what is necessary (s. 18).
10. **The text defines "sub-processor" in the words one expects for "processor"** (s. 5) and has no separate "processor" entry. It looks like a translation slip; the French original may differ. The pages say "processor" and "sub-processor" in the usual sense.

## B. Obligation by obligation

| s. | The law asks | Where it is handled | Still open |
|---|---|---|---|
| 9, 50 | Prior consent | Owners: the sentence with links above the sign-up form and the Google button. Participants: the owner's tick (time, source), the join message and START | Acceptance at sign-up is a sentence, not a recorded tick (proposed, no row yet). `/login` can create an account through Google without showing it |
| 14, 21 | Clear information at collection: identity, purposes, categories, recipients, the right to refuse, the rights, retention, transfer abroad | Privacy policy section 2 (for Participants); the join message links to it | The invitation templates sent to contacts the owner imported are Meta-approved text with no link; the owner must inform them (Terms section 5 item 1) |
| 11, 12, 13, 28 | Purpose, accuracy, retention, maximum periods set by the Authority | Privacy policy sections 5 and 8; owners edit their own data | LEG-02b (enforced retention deletion) not built; the Authority's maximum periods unknown |
| 15, 22(2), 24 to 27 | Confidentiality, security measures (encryption, restricted access, backups, access control and trail) | Privacy policy section 10; `docs/SECURITY.md` | The Authority's benchmark (s. 24(3)), the annual report to it (s. 27(2)), the host's disk encryption (DAT-02, host half) |
| 22(1) | Tell the Authority and the person at once of a breach | Promise in Privacy policy section 11; Terms section 5 item 12 | **No written breach procedure and no named person** |
| 29 | A register of processing operations (controller, purposes, categories, recipients, safeguards) | none | Write one; the facts sheet and this page are the base |
| 30, 16, 26 | A contract with the processor stating data types, categories of people, rights and duties | Terms section 14 | LEG-04: cross-border clauses; whether acceptance at sign-up is enough as a contract |
| 33 | An impact assessment for processing likely to be high-risk | none | Counsel: is bulk messaging with free-text answers high-risk? |
| 37 to 47 | Rights: access, rectification, erasure, objection, restriction, portability, automated decisions, after death; time limits set by regulation | Privacy policy section 9; DAT-01 (download, erasure); STOP | A participant's request to the owner has no screen; time limits (s. 47) not published |
| 41 | No disclosure to third parties for direct marketing without prior consent | Terms section 5 item 6 | none in the product (nothing is disclosed) |
| 44, 65 | No decision based only on automated processing; no profiling | none in the product; Terms section 5 item 9 | none |
| 48, 66 | Prohibited categories; banking transactions | Terms section 5 item 7; Privacy policy section 4 | No technical filter on free text; item 6 above |
| 19, 49, 55 | Prior authorisation of processing | Terms section 5 item 1 puts each party's own on that party | Item 2 above |
| 32, 60, 69 | Transfers abroad | Privacy policy section 7 | Item 3 above |
| 54 | Formal notice from the Authority, 10 days to comply, then up to 100,000 CFA francs a day | none | A named contact who can answer the Authority within 10 days (OPS-03) |

## C. Choices made where the law is silent (yours to change)

Minimum age 18 for accounts; **no surveys of under-18s** without a parent's or representative's consent; **health information forbidden** in surveys (s. 72 sends health to separate instruments, and s. 48 names only "health biometrics"); no direct prospecting without prior consent; liability capped at the fees paid in the 12 months before the event; 30 days to settle a dispute before the courts of Douala; 30 days' notice of changes to the Terms; no uptime or response promise (OPS-03, D-02); an unpaid overage invoice stops new sends and renewals, never deletes data; the financial record kept 10 years without name, number or e-mail (the facts sheet marks this "to confirm"); backups kept about 30 days (`BACKUP_KEEP_DAYS`); the Privacy policy says nothing about gifts or wallets because the first version has none (D-14).

## D. What the texts do not contain on purpose

The host and its country (OPS-01), the e-mail provider, the support address (set `SUPPORT_EMAIL`, OPS-03) and the company's registration and tax numbers are not invented: the pages name the company and its address and print an e-mail only when one is configured. Add the registration numbers to `apps/web/src/lib/legal/shared.ts` when the company has them.

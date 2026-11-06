# Public profile: proposed switch list (PROPOSAL, awaiting the owner's "yes")

**Status: proposed, not applied.** Nothing in the code is switched yet. Source: the lawyer chat's Keep/Remove list (2026-10-29) mapped onto the features that exist, and Law No. 2024/017 (`docs/legal/`). Not legal advice: counsel must confirm in writing, above all that a bundled gift allowance and "instruct the provider" payouts are not payment services.

Profiles: `full` (staging and pilot, everything) and `public` (launch, nothing that holds, moves or converts other people's money). The profile is chosen by the deployment, defaults to `public`, and is enforced on the server (the routes do not exist, the jobs do not start).

| Feature | Backlog rows | `full` | `public` | Why |
|---|---|---|---|---|
| Sign-in and sign-up with Google (SEC-05; needs the owner's own Google OAuth client) | SEC-05 | on | **on** | no money; works, verified by the owner 2026-10-29 |
| WhatsApp surveys, results, CSV and Sheets export | core | on | **on** | no money |
| Subscriptions paid through the six providers (own fees) | core | on | **on** | SurveyFlow is the merchant for its own service |
| Discount codes | core | on | **off** | all gift features are out of the first public version (D-14); a cash-equivalent code also needs counsel |
| Prize draws | core | on | **off** | out with the other gift features (D-14); lottery rules per country are a separate licence risk |
| Account download and deletion (Settings, Your data): 30-day read-only grace, refused while money is unresolved, money record kept without any name, number or e-mail | DAT-01 | on | **on** | no money is held; it is what the law's rights sections ask for (s.37 to 39, 43); needed for a public launch. The only money-shaped part (the archive) keeps records the owner already generated |
| Encrypted backups, restore test, recovery (`scripts/backup.mjs`, `restore-test.mts`) and the host's disk encryption | DAT-02 | on | **on** | no money; the law asks for secure back-up copies (s.27(1)) and encryption (s.22(2)). The host's disk is a setting at the host, yours to check and write down |
| Message category per survey (utility or marketing), cost acknowledgement before every marketing send, re-categorisation by Meta | WA-03 | on | **on** | no money is held; WhatsApp messages are the core product and Meta bills the owner directly. Needed so that promotions are not sent as utility |
| Warning about Meta's payment-method rule, detection and explanation of a stop in delivery, an estimate of what Meta billed (not built yet; proposed 2026-11-04) | WA-08, WA-09, WA-10 | on, once built | **on**, once built | no money is held or moved by these; they protect the owner from messages stopping without a word and from a bill nobody can explain |
| Team members: viewer and editor with their own login, two-step verification, a trail (Settings, Team) | BIZ-04 | on | **on** | no money is held; the owner's colleagues work on the owner's own account. Nothing in it is specific to payouts |
| The analytics funnel as a chart | FUT-05 | on | **on** | a display of the owner's own results; nothing to do with money |
| Join a survey by link or QR code, with its limits (a code per survey, ends by itself, maximum, country list, consent message first) | WA-05 | on | **on** | no money; messages to the owner's own number. Gifts for people who join are WA-06 below |
| Gift ceiling and switch for people who join by link (off by default, one gift per number per survey) | WA-06 | on | **off** | it limits gifts, and there are none in the first public version (D-14) |
| Embedded Signup v5 with and without coexistence: the question before the Connect button, Meta's answer over the browser's, registration of a new number, simulated Meta popup and numbers for both stories (demo mode only, never in `public`; built 2026-11-05, check open) | WA-11 | on | **on** | no money is held or moved; it is how an owner connects their own WhatsApp number, and Meta bills them directly. Needs WA-02 for real customers |
| Coexistence data: the contacts and history sync, contacts that wait for the owner's confirmation of consent, history and echoes counted and never read (built 2026-11-05, check open) | WA-12 | on | **on** | no money; personal data of the owner's contacts, minimised and under the owner's attestation (counsel: LEG-02) |
| Disconnection handling: pause, one e-mail, banner, reconnect in place (built 2026-11-05, check open) | WA-13 | on | **on** | no money |
| The share kit on the join link: "Share on WhatsApp" and "Copy the message" (built 2026-11-05, check open) | WA-14 | on | **on** | no money; a title and a link |
| Measurement of the free plan's cap (counts only; `scripts/explore-cap-report.mts`) | BIZ-03 | on | **on** | no money; aggregates, small groups hidden |
| Overage invoices for responses beyond the plan: opt-in, warned at 80 and 100 percent, invoiced by the month, paid by the owner through the hosted checkout | PAY-09 | on | **on** | SurveyFlow is the merchant for its own service; nothing is debited and no stored value is involved. The term for an unpaid invoice is counsel's |
| Credit for the unused days when moving to a bigger plan | PAY-12 | on | **on** | SurveyFlow's own subscription price; no money is held for others. The terms are counsel's |
| Background jobs in a worker process of their own, heartbeats and a watchdog | OPS-05 | on | **on** | operations only |
| Design tokens exported for a designer | DSN-02 | on | **on** | no money |
| Receipts, proof of gift | core | on | **off** | there are no gifts in the first public version (D-14) |
| Wallet top-up (card, Mobile Money) | PAY-08 | on | **off** | stored value held for owners (LEG-03) |
| Stored balance debited per gift; release of unfunded gifts; refund to wallet | PAY-06, PAY-07 | on | **off** | stored value |
| Cash payouts to participants from owners' money | PAY-04 | on | **off** | money transmission |
| Payout currency conversion; wallet, gifts, overage in non-CFA currencies | PAY-05 | on | **off** | exchange/transfer service |
| Wallet-funded overage (from the gift wallet) | PAY-09 | on | **off** | stored value; not built that way |
| Payout limits (per account, per phone number, young-account hold) | PAY-13 | on | not needed | they limit payouts, which do not exist in `public` |
| Daily reconciliation of wallets against ledger and provider balances | PAY-02 | on | not needed | there is no wallet in `public` (the job finds nothing to reconcile) |
| Settling unknown-outcome payouts and held gifts by a person (command line; no screen yet) | PAY-07 | on | not needed | payouts do not exist in `public` |
| Money admin console and screen (ADM-02) | ADM-02 | on | not needed | they exist only for the wallet |

## Open decisions for `public`
1. **Reward model: answered 2026-11-05 (D-14): no gifts and no prepaid wallet in the first public version.** The earlier options (an allowance bundled in the plan, or the owner's own provider account) come back only when gifts do. The old text: gift allowance bundled in the plan (units, no top-up, no carry-over, no cash value; recommended, ideally airtime or data only), or no gifts at launch, or the owner's own provider account.
2. **Counsel's written opinion** on the allowance model and on payout instructions: not needed for the first public version (D-14); needed before gifts or a wallet return.
3. **Data-law rows** (not money, but they block a public launch too): authorisation of processing (s.19), transfers abroad including Meta (s.32, 60, 69), consent (s.9, 50), sensitive data in free text (s.48, 66), breach procedure (s.22), register (s.29), impact assessment (s.33), rights handling (s.38 to 43).

## Log of changes to this list
- 2026-10-29: first proposal.
- 2026-10-29: Google sign-in added as a row (on in `public`): SEC-05 is built and verified.
- 2026-10-31: FUT-05 added as a row (on in `public`).
- 2026-10-31: BIZ-04 added as a row (on in `public`). The pricing page stops saying "soon" for team members in both profiles.
- 2026-10-31: PAY-07 split out of the "money admin console" row and built as logic plus a command line (no screen): `full` only; nothing to settle in `public`.
- 2026-10-31: PAY-02 split out of the "money admin console" row and built: the daily reconciliation is `full` only; with no wallet in `public` it finds nothing to do.
- 2026-10-31: PAY-13 split out of the "money admin console" row and built: payout limits are `full` only (off in `public`: no payouts there). The hold defaults to 0 days with the mock gift provider.
- 2026-10-31: WA-03 added as a row (on in `public`). Surveys with a reward are marketing by default: if the reward model is decided as "no gifts", more surveys can qualify as utility; nothing else changes.
- 2026-10-31: DAT-02 added as a row (on in `public`, no switch: it is tooling run by the operator, not a route). It is a Must for any public launch with real owners' data; its host half is not done.
- 2026-10-31: DAT-01 added as a row (on in `public`): account download and deletion are built. The "rights handling (s.38 to 43)" data-law item below is now partly met: erasure, copy and portability exist; rectification (s.42) is the owner editing their own data, and handling a **participant's** request to the owner is not built.
- 2026-11-02: rows added for WA-05, WA-06, BIZ-03, PAY-12, OPS-05 and DSN-02, and PAY-09 split in two: the wallet-funded overage stays `off` in `public`; the opt-in invoice paid through the hosted checkout (built) is `on`. LEG-01 and LEG-02 (counsel's texts) and DSN-01 (dark theme, Storybook) are unchanged: still open.
- 2026-11-05 (D-14): you decided that the first public version has no gift and no prepaid-wallet features. Discount codes, prize draws, receipts and the join-link gift ceiling move from `on` to `off` in `public` (the money rows were already `off`); the reward-model question is answered. The mechanism (one codebase, two profiles) still waits for your "yes".
- 2026-11-05 (D-18): the plan cards and the plans table no longer list API access and white-label, in both profiles.
- 2026-11-05 (D-19): rows added for WA-11 to WA-14 (Embedded Signup v5 with coexistence, the coexistence data and consent step, disconnection handling, the share kit). All four are `on` in both profiles: nothing in them holds or moves money. WA-11 to WA-13 depend on WA-02 (Tech Provider) for any customer without a role on the Meta app. The question about owners who can only pay Meta by Mobile Money (BACKLOG section F, item 4) has no row and nothing is built for it.

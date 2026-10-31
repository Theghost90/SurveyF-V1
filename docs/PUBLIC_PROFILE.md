# Public profile: proposed switch list (PROPOSAL, awaiting the owner's "yes")

**Status: proposed, not applied.** Nothing in the code is switched yet. Source: the lawyer chat's Keep/Remove list (2026-10-29) mapped onto the features that exist, and Law No. 2024/017 (`docs/legal/`). Not legal advice: counsel must confirm in writing, above all that a bundled gift allowance and "instruct the provider" payouts are not payment services.

Profiles: `full` (staging and pilot, everything) and `public` (launch, nothing that holds, moves or converts other people's money). The profile is chosen by the deployment, defaults to `public`, and is enforced on the server (the routes do not exist, the jobs do not start).

| Feature | Backlog rows | `full` | `public` | Why |
|---|---|---|---|---|
| Sign-in and sign-up with Google (SEC-05; needs the owner's own Google OAuth client) | SEC-05 | on | **on** | no money; works, verified by the owner 2026-10-29 |
| WhatsApp surveys, results, CSV and Sheets export | core | on | **on** | no money |
| Subscriptions paid through the six providers (own fees) | core | on | **on** | SurveyFlow is the merchant for its own service |
| Discount codes (no money issued) | core | on | **on** | a cash-equivalent code needs counsel |
| Prize draws | core | on | **on** | lottery rules per country are a separate licence risk |
| Account download and deletion (Settings, Your data): 30-day read-only grace, refused while money is unresolved, money record kept without any name, number or e-mail | DAT-01 | on | **on** | no money is held; it is what the law's rights sections ask for (s.37 to 39, 43); needed for a public launch. The only money-shaped part (the archive) keeps records the owner already generated |
| Encrypted backups, restore test, recovery (`scripts/backup.mjs`, `restore-test.mts`) and the host's disk encryption | DAT-02 | on | **on** | no money; the law asks for secure back-up copies (s.27(1)) and encryption (s.22(2)). The host's disk is a setting at the host, yours to check and write down |
| Message category per survey (utility or marketing), cost acknowledgement before every marketing send, re-categorisation by Meta | WA-03 | on | **on** | no money is held; WhatsApp messages are the core product and Meta bills the owner directly. Needed so that promotions are not sent as utility |
| Receipts, proof of gift | core | on | on only if gifts exist | depends on the reward model |
| Wallet top-up (card, Mobile Money) | PAY-08 | on | **off** | stored value held for owners (LEG-03) |
| Stored balance debited per gift; release of unfunded gifts; refund to wallet | PAY-06, PAY-07 | on | **off** | stored value |
| Cash payouts to participants from owners' money | PAY-04 | on | **off** | money transmission |
| Payout currency conversion; wallet, gifts, overage in non-CFA currencies | PAY-05 | on | **off** | exchange/transfer service |
| Wallet-funded overage | PAY-09 | on | **off** | invoiced through hosted checkout instead |
| Payout limits (per account, per phone number, young-account hold) | PAY-13 | on | not needed | they limit payouts, which do not exist in `public` |
| Daily reconciliation of wallets against ledger and provider balances | PAY-02 | on | not needed | there is no wallet in `public` (the job finds nothing to reconcile) |
| Settling unknown-outcome payouts and held gifts by a person (command line; no screen yet) | PAY-07 | on | not needed | payouts do not exist in `public` |
| Money admin console and screen (ADM-02) | ADM-02 | on | not needed | they exist only for the wallet |

## Open decisions for `public`
1. **Reward model:** gift allowance bundled in the plan (units, no top-up, no carry-over, no cash value; recommended, ideally airtime or data only), or no gifts at launch, or the owner's own provider account.
2. **Counsel's written opinion** on the allowance model and on payout instructions.
3. **Data-law rows** (not money, but they block a public launch too): authorisation of processing (s.19), transfers abroad including Meta (s.32, 60, 69), consent (s.9, 50), sensitive data in free text (s.48, 66), breach procedure (s.22), register (s.29), impact assessment (s.33), rights handling (s.38 to 43).

## Log of changes to this list
- 2026-10-29: first proposal.
- 2026-10-29: Google sign-in added as a row (on in `public`): SEC-05 is built and verified.
- 2026-10-31: PAY-07 split out of the "money admin console" row and built as logic plus a command line (no screen): `full` only; nothing to settle in `public`.
- 2026-10-31: PAY-02 split out of the "money admin console" row and built: the daily reconciliation is `full` only; with no wallet in `public` it finds nothing to do.
- 2026-10-31: PAY-13 split out of the "money admin console" row and built: payout limits are `full` only (off in `public`: no payouts there). The hold defaults to 0 days with the mock gift provider.
- 2026-10-31: WA-03 added as a row (on in `public`). Surveys with a reward are marketing by default: if the reward model is decided as "no gifts", more surveys can qualify as utility; nothing else changes.
- 2026-10-31: DAT-02 added as a row (on in `public`, no switch: it is tooling run by the operator, not a route). It is a Must for any public launch with real owners' data; its host half is not done.
- 2026-10-31: DAT-01 added as a row (on in `public`): account download and deletion are built. The "rights handling (s.38 to 43)" data-law item below is now partly met: erasure, copy and portability exist; rectification (s.42) is the owner editing their own data, and handling a **participant's** request to the owner is not built.

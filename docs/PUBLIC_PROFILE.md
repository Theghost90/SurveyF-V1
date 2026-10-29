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
| Receipts, proof of gift | core | on | on only if gifts exist | depends on the reward model |
| Wallet top-up (card, Mobile Money) | PAY-08 | on | **off** | stored value held for owners (LEG-03) |
| Stored balance debited per gift; release of unfunded gifts; refund to wallet | PAY-06, PAY-07 | on | **off** | stored value |
| Cash payouts to participants from owners' money | PAY-04 | on | **off** | money transmission |
| Payout currency conversion; wallet, gifts, overage in non-CFA currencies | PAY-05 | on | **off** | exchange/transfer service |
| Wallet-funded overage | PAY-09 | on | **off** | invoiced through hosted checkout instead |
| Money admin console, "to verify" screen, wallet reconciliation, payout caps | ADM-02, PAY-02, PAY-07, PAY-13 | on | not needed | they exist only for the wallet |

## Open decisions for `public`
1. **Reward model:** gift allowance bundled in the plan (units, no top-up, no carry-over, no cash value; recommended, ideally airtime or data only), or no gifts at launch, or the owner's own provider account.
2. **Counsel's written opinion** on the allowance model and on payout instructions.
3. **Data-law rows** (not money, but they block a public launch too): authorisation of processing (s.19), transfers abroad including Meta (s.32, 60, 69), consent (s.9, 50), sensitive data in free text (s.48, 66), breach procedure (s.22), register (s.29), impact assessment (s.33), rights handling (s.38 to 43).

## Log of changes to this list
- 2026-10-29: first proposal.
- 2026-10-29: Google sign-in added as a row (on in `public`): SEC-05 is built and verified.

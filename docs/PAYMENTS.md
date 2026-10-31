# Payments — how SurveyFlow follows the PSP flow, what can go wrong, and what to do

Written 2026-10-16 after a hardening pass whose only goal was: **a customer's money is never lost, never taken twice, and never left unexplained.**
Actors, as in the diagram: **Customer** = the survey owner, **Merchant** = SurveyFlow (the SaaS), **PSP** = Notch Pay, Campay, CinetPay, PayUnit, Flutterwave or CamerPay.

## 1. Does SurveyFlow follow the diagram?

**Yes, in all three phases, with four deliberate differences** (the first three make it stricter, the fourth is a safety net the diagram does not draw).

| Diagram | SurveyFlow | Where |
|---|---|---|
| **1. Initialisation** — customer clicks Pay; merchant backend calls `POST /pay` | The browser sends only *plan, interval, method, phone*. **The server fixes the price and currency** (never the client), creates a `PaymentTransaction` in `pending` with a unique `reference` (`sf` + 22 characters), then calls the PSP. | `services/payments/service.ts` `initiatePayment`, `initiateGiftTopup`, `reserveTransaction`, `dispatchCheckout` |
| …gateway returns transaction id, *pending* + auth URL | The row stores the provider's reference and the checkout URL (hosted page) or a payment token (push to phone). The browser is redirected, or shown "approve on your phone". | `dispatchCheckout`; `txDto` |
| **2. Authentication** — USSD/SMS push, PIN, telecom validates, charge approved | Entirely at the PSP / telecom. SurveyFlow only waits, and tells the customer honestly that it is waiting ("Still waiting for the provider", never "failed"). | `apps/web/src/lib/pay-poll.ts`, `components/billing/payment-states.tsx` |
| **3. Verification & webhook** — gateway confirms → webhook → merchant verifies signature | The webhook is **signature-checked and then not believed**: it only says "go look". We ask the PSP server-to-server (`verifyPayment`) and check **amount and currency** against what we asked. | `routes/payments.ts` webhook; adapters' `parseWebhook` / `verifyPayment` |
| …DB pending → paid → order fulfilled | One database transaction: compare-and-set `pending/failed/expired → success` **and** activate the plan / credit the wallet. Replays change nothing. | `services/payments/settlement.ts` `settleTransaction` |

Differences from the diagram:
1. **Never trust the webhook body** (the diagram stops at "verify signature"; we also re-ask the provider).
2. **PSP failover chain** (cheapest provider first, next one if it is down) — with the rule that a *push* provider that may already have sent the prompt is never followed by a second provider (C3).
3. **More states than pending/paid**: `failed`, `expired`, and `review` (money received, a person must decide).
4. **A reconciliation job** that asks the provider about payments whose webhook never came. The diagram assumes the webhook always arrives; in practice it does not (C1).

## 2. States

```
                 ┌──────────── provider says paid, amount+currency OK ────────────┐
                 │                                                                ▼
 (created) → pending ──provider says failed──▶ failed ──late "paid"──▶ success (plan active / wallet credited)
                 │  └─24 h, provider says nothing happened──▶ expired ─late "paid"─▶ success
                 └──paid but underpaid / wrong currency / lower plan than active / activation error──▶ review ──operator──▶ success | failed
```
* `failed` and `expired` are **our conclusions, not the provider's**: a hosted page lets the payer retry after a decline, and a payer may approve a Mobile Money prompt hours later. A provider-verified success is credited from any of `pending`, `failed`, `expired`.
* `success` and `review` are final for the machine. `review` is resolved only by `scripts/payments-review.mts`.
* The customer sees `review` as "we received your payment but could not apply it automatically, nothing is lost", never as a failure, and never sees the operator detail (`failReason`).

## 3. Risk register — what was wrong, what was done, how it is verified

Every item was **reproduced against the old code first** (a throwaway test, since deleted), fixed in the order *minor → major → critical*, and covered by a test in `apps/api/tests/payments-hardening.test.ts` that was **mutation-checked** (the fix removed → the test fails). Several tests were first found too weak this way (a surviving mutant) and strengthened.

### Critical — money lost, taken twice, or silently stuck

| # | Risk (who feels it) | Before | Fix |
|---|---|---|---|
| C1 | **Lost webhook + closed tab = payment lost** (customer paid, plan never activates; SurveyFlow keeps money it cannot match to anyone) | Nothing asked the provider again; after 24 h a blind job set the payment to `expired`. | `reconcilePayments` runs every minute (leader-only) and asks the **provider**, on a cadence that follows age: 1 min (first 10 min) · 5 min (to 2 h) · 30 min (to 24 h) · hourly after; a pending payment is **expired only after a last look** (or after 48 h of the provider being unreachable). The blind expiry is deleted. |
| C2 | **A later success was ignored** (customer retried on the hosted page after a decline, or approved the prompt late: charged, no plan) | `failed` and `expired` were terminal. | A verified success settles from `pending`, `failed` and `expired`. Failed/expired payments that reached a provider are re-asked for **7 days** (every 6 h) by the job and on a poll; a **signed webhook is always honoured**, even after 7 days. A later "failed" never undoes a success. |
| C3 | **Double prompt / orphan charge on failover** (a push provider times out *after* sending the prompt; we start a second provider; the customer approves both) | Any failure moved on to the next provider. | `pspFetch` tells *certainly not created* (connection refused, DNS, TLS, 4xx, 429, 503) from *maybe created* (timeout after sending, reset, 408/500/502/504). A push provider (**Campay**) with a *maybe* → **no second provider**; the payment stays `pending`, the customer is told **not to pay again**, a new start is blocked for 3 min, and the signed webhook (or the reconciliation) settles it if the prompt went out. Hosted providers still fail over (their page is never shown to the customer). Every provider tried is stored in `attempts`. |
| C4 | **Money received but not applied, silently** (underpaid, wrong currency, a lower plan landing after an upgrade, an activation error) | Underpaid/mismatch → terminal `failed` (a corrected payment later was ignored); an exception while activating was swallowed as "still pending" (the provider got a 200 and never called again) and the payment sat there until the blind 24 h expiry. | Status **`review`**: parked with the reason, **logged `PAYMENT_REVIEW`**, the customer told once (WhatsApp, best effort) and by the in-app status. A **database outage is thrown, not judged** (the provider retries; the job tries again). Settlements are **serialised per subscription** (two payments landing together both count). Resolve with `scripts/payments-review.mts`. |

### Major — wrong or confusing, recoverable

| # | Risk | Fix |
|---|---|---|
| M1 | Webhook answered **200 when verification could not run** → provider never retries | 503 when the provider could not be asked (it retries); 200 once verified, whatever the outcome. |
| M2 | UI said "failed / not charged" while the payment was **still pending**; no list of pending payments | "Still waiting for the provider… do not pay again" with the reference; **Payments in progress** card with *Check now*; return page has pending / waiting / review / expired views. |
| M3 | **Eight clicks → two charges** (check-then-create was not atomic) | Per-customer lock around "find identical in-flight payment or create one"; every click gets the same checkout. |
| M4 | A **dead Mobile Money prompt was reused for 10 min**; unlimited pending payments | Reuse window by method (card 10 min, Mobile Money 90 s); a row never sent to a provider is not reused; **max 4 in flight**. |
| M5 | Downgrade guard existed in **one route only** | Moved into the service (every route), plus a guard at settle time (→ `review`). |
| M6 | Payment webhooks **exempt from rate limiting** | Only Meta's webhook is exempt; payment webhooks get 600/min/address. |
| M7 | A **down provider cost every customer the full timeout**; a DB error after the provider accepted looked like "provider failed" and started a second provider | Circuit breaker per provider (3 failures → moved to the end of the chain for 2 min, one trial after); the DB write is outside the failover `try`. |
| M8 | **No renewal notice** (Mobile Money has no automatic debit; `reminderSentAt` was never set) | WhatsApp notice 3 days before the end and when overdue (once, atomic claim, EN/FR) + in-app banner; a payment re-arms them. WhatsApp is best effort (24 h window): **the banner is the dependable channel.** |
| M9 | **Production started with no payment provider**, no warning for a missing webhook secret | The API refuses to start in production without a provider; warns per provider configured without its webhook secret. |

### Minor

| # | Risk | Fix |
|---|---|---|
| m1 | Provider's raw error text (`failReason`) **reached the browser** | The browser gets only `failCode` (`declined` / `unavailable` / `other`); the detail stays in the database and logs. |
| m2 | Every browser poll became a provider call | Polls are coalesced (1.5 s pending, 30 s failed/expired); webhooks and the job always verify. |
| m3 | Verification errors swallowed silently | Logged (`PSP verification failed…`) and reported to the webhook as 503. |
| m4 | Weak Mobile Money phone validation | Parsed against the owner's country; invalid → 400 `invalid_phone` with an example. |
| m5 | Overpayment not flagged | Credited at the amount asked; a >15 % excess is logged. |
| m6 | Customer not told an upgrade **does not credit the days left** | Notice in the checkout (`no-proration`). |

## 4. Operations

**Logs to watch** (grep): `PAYMENT_REVIEW` (needs a person) · `PSP verification failed` (a provider's verify endpoint is down) · `reconciliation could not check this payment` · `"job":"payment-reconcile"` (it recovered, failed or expired something).

**Commands** (`npx tsx --env-file=.env scripts/payments-review.mts …`):

| Command | Does |
|---|---|
| `list` | payments in `review`, oldest first, with the reason and the customer |
| `list pending` | pending for over 2 h — the job is asking the provider about each; anything stuck here for days is worth a look |
| `list unconfirmed` | pending after an unconfirmed push start (customer told not to pay again) |
| `show <ref>` | the whole row, including every provider tried (`attempts`) |
| `credit <ref> --note "why"` | apply it as paid (the amount **asked** is credited) — once, only from `review` |
| `reject <ref> --note "why"` | close as failed and tell the customer it will be returned — **does not move money**; refund in the provider's dashboard |

**What a `review` reason means**

| `failReason` starts with | Meaning | Usual decision |
|---|---|---|
| `underpaid:` | the provider collected less than the price | ask the customer to pay the rest, then `credit`; or `reject` + refund |
| `currency_mismatch:` | the provider collected in another currency | check the amount at the provider, then `credit` or `reject` |
| `lower_plan_than_active:` | a payment for a lower plan landed after an upgrade | `credit` only if the customer really wants the lower plan; normally `reject` + refund |
| `activation_failed:` | a defect applying the payment (not an outage) | engineering: the message says why; `credit` once fixed |

**Per provider, once, before going live**: register the webhook URL `PUBLIC_API_URL/api/payments/webhook/<psp>` in the provider's dashboard and set its webhook secret (boot warns if missing). The reconciliation job only runs where `RUN_JOBS` is true; if that process is down nothing is reconciled, so alert on it.

## 5. What is still NOT covered (read before launch)

* **No adapter has ever run against a real provider** (the build environment cannot reach them). The ambiguity classification, each provider's *verify* semantics and the Campay `external_reference` check are written from documentation: a **sandbox pass per provider** is the biggest remaining risk (`docs/DECISIONS.md` §4).
* **CamerPay has no status endpoint.** Polling cannot find a payment whose webhook never arrived; the job only re-reads the signed outcome stored for 7 days. A lost CamerPay webhook is recovered by re-sending it from their dashboard.
* **A Campay start whose answer was lost, with no webhook afterwards, cannot be found by code** (we hold no provider reference). The customer is told not to pay again and the payment stays visible under `list unconfirmed`; the operator finds it in the Campay dashboard by our `reference` (sent as `external_reference`).
* **Refunds and payouts are manual.** `reject` does not move money; an overpayment's excess is logged, not returned.
* **No provider-statement reconciliation** (comparing a provider's settlement report with our `success` rows). `amountXAF` is stored for it; it is not built.
* **WhatsApp notices are best effort** (outside the 24 h window they are not delivered): the in-app banner and "Payments in progress" are what you can rely on.
* The job is **single-leader**: one replica asks the providers; if jobs are disabled everywhere, late payments wait until they are enabled again.
* Prices, fees and provider ranking were not changed by this pass.
* **Chargebacks and the cash-out route**: a wallet topped up by card can be paid out to Mobile Money numbers. Payouts are limited per account, per phone number and by the age of the account (PAY-13, built 2026-10-31, the numbers are a sizing of mine). §5.1 and §5.2.

### 5.1 Chargebacks and the cash-out route (researched 2026-10-28)

**The route.** A wallet can be topped up by card and gifts can be paid out to Mobile Money numbers. With open sign-up that is the textbook cash-out path for a stolen card: the thief tops up, sends gifts to numbers they control, and the real cardholder's chargeback arrives later, after the money has left.
Before PAY-13 nothing but the wallet balance limited it. **PAY-13** (a cap per account and per phone per day, and a hold on payouts for accounts only a few days old) was built on 2026-10-31: §5.2. What it does and does not close is written there.

**What is known about the window and who pays.** From a web search on 2026-10-28. The providers' own pages could not be opened from the build environment, so this is what the search results quote, not your contract:
- *Card networks* (vendor guides, not the rulebooks): a cardholder can usually dispute within about **120 days** of the transaction (Mastercard: 120, or 540 for goods or services not delivered; Visa: up to 120, 75 for some fraud, up to 540 for some reason codes); the merchant has about 30 to 45 days per phase at the network.
  A "card not present" fraud dispute is won by showing that the real cardholder bought: 3-D Secure, address checks, purchase history.
- *Flutterwave* (its developer documentation, as the search engine quotes it): the merchant is told of a chargeback and is expected to answer within **48 hours**; a **lien** is placed on the disputed amount in the merchant's balance; with no answer the amount is debited automatically; an upheld chargeback is a permanent debit.
  Blog posts quote longer windows; they conflict with the documentation and are not relied on here.
- *Notch Pay* (its documentation, as quoted): disputes (fraudulent transaction, service not received, duplicate charge) are notified to the merchant, who answers with evidence in the dashboard or by API; what was found says nothing about who bears the loss.
- *Campay and CinetPay:* **nothing was found.** Mobile Money has no card-style chargeback; what can happen there (a reversal asked of the operator, a transfer to a wrong number) is in the provider's merchant agreement, which is not public.

**What it means.** The exposure is the card top-ups of the first months, and it lands on SurveyFlow's balance at the provider; a provider that places a lien on 48 hours' notice needs somebody watching its dispute notifications every day (the admin console, ADM-02, would make that a screen).
The numbers of PAY-13 have to be sized against your providers' actual terms before the first real card top-up: ask each one for its chargeback window, its response time, whether it keeps a reserve, and whether it charges a fee per dispute.

### 5.2 The payout limits (PAY-13, built 2026-10-31)

**What is limited**, at the moment a gift is planned (before the participant is told anything), in CFA francs over any rolling 24 hours:
- **per account**: `PAYOUT_ACCOUNT_MAX_XAF_PER_DAY` (default 100,000);
- **per phone number, from every account together**: `PAYOUT_PHONE_MAX_XAF_PER_DAY` (5,000) and `PAYOUT_PHONE_MAX_COUNT_PER_DAY` (3). The number is matched by its keyed hash, so the same number is the same number in every account;
- **a hold on young accounts**: payouts of an account younger than `PAYOUT_HOLD_DAYS` wait (3 days; 0 while the gift provider is the mock one, nothing real moving).

A gift a limit stops is **held**: not debited, not promised (the participant gets a plain thank-you, as for an empty wallet), shown to the owner with the reason, and released by itself, oldest first, by a job that runs every ten minutes, as soon as the limit allows; the participant is then told through the gift notice. The owner's own "release" and "retry" buttons go through the same check. Counted: gifts pending, sent, or failed with an unknown outcome (the money may have left); not counted: a gift definitely refunded. The caps are exact when participants finish at the same instant (advisory locks per account and per phone; a test runs five in parallel against room for three).

**How to size the numbers.** The exposure per day of a fraudster who controls *k* phone numbers is about *k* × the phone cap, however many accounts they open: the phone cap is the tighter control, the account cap the backstop. Choose the phone cap so that *k* you consider plausible (ten? fifty?) times it is a loss you can absorb in a day, and the account cap so that an honest owner's biggest survey is not stopped for days. **My defaults (5,000 per number, 100,000 per account, 3 days) are a guess, not your providers' terms.**

**What this does not close.** (a) A cardholder can dispute for about 120 days (§5.1); a hold of three days only stops the fastest cash-out, it does not outlast the dispute window. (b) A fraudster with many numbers and many accounts is slowed, not stopped. (c) Top-ups are not limited (the row is about payouts). (d) The sharper control, that money topped up by card cannot be paid out for N days while Mobile Money funds can (a Mobile Money push has no chargeback), is **not built**: it needs the wallet to remember how each franc arrived. It is the next thing to build if card top-ups go live. (e) An honest owner meets the limits: in the first days of an account, or with a very large survey, gifts are delayed, not lost. The owner is told by e-mail once a day, and sees the held gifts with the reason.

## 6. How it is checked

* `apps/api/tests/payments-hardening.test.ts` — 49 tests (minor, major, critical, operator tool), each mutation-checked.
* Existing suites updated for the new outcomes (`needs_review` / `review` instead of `amount_mismatch` / `failed`).
* `scripts/e2e-payments.mjs` — real browser: still-waiting, in-progress card and *Check now*, no-proration notice, review wording (no operator detail), renewal banner EN/FR, the "do not pay again" error.
* **Live check against a running API**: a payment marked paid at the (mock) provider with no webhook, no browser and no poll was activated by the scheduled job in about 50 s.
* Migration `20261017010000_payments_reconcile` applied from scratch together with all earlier ones, no drift against `schema.prisma`.

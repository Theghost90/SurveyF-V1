# What Meta charges for WhatsApp messages (as of 1 October 2026)

**Source.** A copy of Meta's page "Pricing on the WhatsApp Business Platform" and Meta's PDF "Cost per message in USD … effective October 1, 2026", both supplied by the owner on 4 November 2026 and treated by the owner as the single source of truth. They were not fetched live from Meta (the build environment cannot reach it); check them again before relying on them after **1 January 2027**, the next date on which Meta may change a rate (a rate-card change needs one month's notice).

**Who pays.** Each owner has their own WhatsApp number and account and Meta bills them directly. SurveyFlow pays only for its **own** number: the Analytics Bot's replies and alerts, and the `owner_alert` template.

## The rules that matter to SurveyFlow

- Per **delivered** message, by category and by the recipient's country calling code. Messages from people to a business are never charged.
- **Template messages** (invitations, reminders, gift notices out of the window, `owner_alert`) are marketing, utility or authentication. **Non-template messages**, which can only be sent inside the 24-hour window the person opens by writing, are **service** messages. Everything SurveyFlow sends during a survey (consent text, each question, thank-you, replies to the owner) is a service message.
- **Since 1 October 2026 service messages are charged**, and so are utility messages sent inside the window. The first **1,000 service messages per business phone number per month** are free (no roll-over).
- **If the account has no payment method, Meta stops delivering service messages once that free tier is used up.** Nothing in SurveyFlow detects or announces this yet.
- Government departments and community non-profits that Meta identifies as eligible keep free service messages beyond the free tier through 31 December 2027 (the account field `service_pricing_policy` is `PAID_EXEMPT`; from 23 October 2026). Not used by the product yet.
- Meta bills in 16 currencies: USD, EUR, GBP, AUD, AED, ARS, BRL, CLP, COP, IDR, INR, MXN, MYR, PEN, SAR, SGD. **None is the CFA franc**, the naira, the Kenyan shilling or the rand.
- Utility and authentication messages have volume tiers per market and category; marketing and service have none. The tier tables for "Rest of Africa" were not read for this note; at the volumes of the plans they are not expected to matter.

## Rates for the markets SurveyFlow lists (USD per delivered message)

| Market | Marketing | Utility | Service | Remark |
|---|---|---|---|---|
| **Rest of Africa** (Cameroon, Kenya, Ghana, Uganda, Senegal, Côte d'Ivoire, and the other 34 countries of that region) | **0.0225** | **0.0040** | **0.0040** | Cameroon has no rate of its own |
| Nigeria | 0.0516 | 0.0067 | 0.0067 | |
| South Africa | 0.0379 | 0.0095 | 0.0095 | |
| North America (the +1 Meta test number's own region) | 0.0250 | 0.0034 | 0.0034 | |

Marketing costs **5.6 times** utility in Rest of Africa, 7.7 times in Nigeria and 4.0 times in South Africa. Utility, service and authentication share the same rate in each market.

## What it means, with the assumptions written down

Assumption for the francs: **1 USD = 600 FCFA** (a round number for the example; use the product's live rate for a real figure).

| One of these | Rest of Africa | About |
|---|---|---|
| A service message (a question, the consent text, the thank-you) after the free 1,000 | $0.0040 | 2.4 FCFA |
| A utility template (invitation declared utility, `owner_alert`) | $0.0040 | 2.4 FCFA |
| A marketing template (marketing invitation, **every reminder**, **a gift notice sent as a template**) | $0.0225 | 13.5 FCFA |
| A completed 3-question survey reached through the **join link** (consent, 3 questions, thank-you = 5 service messages) | $0.0200 | 12 FCFA |
| The same survey after a **utility** invitation (1 utility + 4 service) | $0.0200 | 12 FCFA |
| The same survey after a **marketing** invitation | $0.0385 | 23 FCFA |
| One reminder | $0.0225 | 13.5 FCFA, more than the five service messages of a whole survey |

- The free tier is worth about **$4 a month per number** (1,000 × $0.004), roughly 200 to 250 completed 3-question surveys. More questions cost proportionally more.
- **Plan check at full use, Cameroon rates (the owner pays Meta, not us):** Starter (500 responses, 1,000 template messages): about $8 with utility invitations (~4,800 FCFA) and about $26.50 with marketing invitations (~15,900 FCFA), against a plan price of 14,500 FCFA. Growth (3,000 responses, 7,000 template messages): about $72 (~43,000 FCFA) with utility invitations and about $200 (~121,000 FCFA) with marketing invitations, against 39,000 FCFA. At full use with marketing templates the Meta bill is about the size of the plan price, and above it on Growth. The figures assume the free 1,000 service messages are used first and that every template is of one kind; real use will be a mix.
- **SurveyFlow's own cost** is small: the Analytics Bot's in-window replies are service messages (free for the first 1,000 a month on the platform number, then $0.004 each) and an alert outside the window costs one utility template ($0.004).

## What in the product this touches (not yet changed)

- Cost wording that was wrong and is corrected: "free-form is free" and "plain text is free" (comments in the code and `docs/DECISIONS.md`).
- The cost warning before a marketing send (WA-03) is now confirmed by the rate table: marketing is billed at several times the utility rate.
- Owners who have no payment method will see messages stop after the free tier. A warning, a delivery-failure message and reading Meta's own billing data from the delivery-status webhooks (which carry the real category and whether the message was billable) are proposed, not built.
- Cameroonian owners pay Meta in USD or EUR, which usually means an international card.

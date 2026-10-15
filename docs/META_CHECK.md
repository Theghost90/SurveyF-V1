# Running SurveyFlow against real Meta

The WhatsApp integration was written from Meta's public documentation and has never been exercised against Meta (`docs/DECISIONS.md` §4, first
row). `scripts/meta-check.mts` runs the **production gateway code** (`apps/api/src/services/whatsapp/cloud.ts`) against Meta with your credentials,
so every assumption either passes or comes back with Meta's own error message. It prints no secrets, so its output can be pasted into a chat or an
issue as is.

## Once, about 30 minutes: a Meta test app

1. <https://developers.facebook.com> → *My Apps* → *Create app* → type **Business** → add the **WhatsApp** product.
2. *WhatsApp → API Setup*: Meta gives you a **test business account and a free test phone number**. Add your own phone as a recipient there and
   confirm the code (a test number can only message recipients you verified, up to 5).
3. Token: the same page shows a temporary token (24 h), fine for a first run. For anything longer: *Business Settings → System users* → create one,
   assign it the WhatsApp account and the app, generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`.
4. Put these in the **root `.env`** (the same file the API reads):

   | Variable | Where it comes from |
   |---|---|
   | `WHATSAPP_ACCESS_TOKEN` | the token from step 3 |
   | `WHATSAPP_PHONE_NUMBER_ID` | *API Setup*, "Phone number ID" |
   | `WHATSAPP_BUSINESS_ACCOUNT_ID` | *API Setup*, "WhatsApp Business Account ID" |
   | `META_APP_ID`, `META_APP_SECRET` | *App settings → Basic* |
   | `WHATSAPP_VERIFY_TOKEN` | any string you choose (`openssl rand -hex 16`); the same value goes into the webhook configuration below |
   | `META_EMBEDDED_SIGNUP_CONFIG_ID` | only for Embedded Signup (*Facebook Login for Business → Configurations*) |

5. Make your API reachable by Meta: `cloudflared tunnel --url http://localhost:4223` (or ngrok) prints an `https://…` address. Set
   `PUBLIC_API_URL` to it, restart the API, then in the Meta app: *WhatsApp → Configuration → Webhook* → callback URL
   `https://<that address>/api/webhook/whatsapp` and your verify token, and subscribe to the fields **`messages`** and **`message_template_status_update`**.
   (The webhook path stays public even when `INTERNAL_API_SECRET` is set: that is by design, it is protected by Meta's signature.)

## Run

```bash
npx tsx --env-file=.env scripts/meta-check.mts                                  # read-only checks
npx tsx --env-file=.env scripts/meta-check.mts --create-templates --subscribe   # also submits the templates and subscribes the app
# from your phone, send "hi" to the test number (that opens the 24 h window), then:
npx tsx --env-file=.env scripts/meta-check.mts --to 2376XXXXXXXX                # also sends one message of every kind to your phone
```

Templates wait for Meta's review (minutes to a day): run it again later. The invitation-template send is skipped until that template is `APPROVED`.
`--webhook-url https://…` tests another API address than `PUBLIC_API_URL`.

## What a result means

| Check | Passing proves |
|---|---|
| access token | valid, right app, both WhatsApp scopes, not about to expire |
| phone number / business account | the production `getPhoneInfo` works; number on the Cloud API; quality rating; business verification state |
| webhook subscription | Meta will deliver this account's events to your app (`--subscribe` fixes it) |
| message templates | all 14 templates exist, their review state, and **whether Meta re-categorised any** (the open question of `DECISIONS.md` §3 item 3) |
| send: text / buttons / list / link button / template | the exact payloads the product sends are accepted by Meta (the link button is the new in-window receipt message) |
| your webhook | verification handshake, wrong token refused (403), **unsigned post refused (401)**, correctly signed post accepted (200) |

`WARN` means it works but you should look (pending template, local webhook address, low quality rating). `FAIL` carries Meta's message and, for the
common codes, what to do about it.

## What no script can do (still open after a green run)

- **Tech Provider status**: business verification and app review (advanced access to `whatsapp_business_messaging` and `whatsapp_business_management`). It takes days to weeks and is a decision of Meta's, not a test.
- **The Embedded Signup popup** in a browser, by a person who has a role on your Meta app (a test app cannot onboard strangers).
- **A real inbound round trip**: tap "Start survey" on your phone and watch the survey begin in the dashboard (this exercises the signed webhook with a real Meta payload).
- Sending limits, throughput and quality-rating behaviour under real volume; Meta changing a template's category after approval.

## Self-test of the script itself

`--fake-graph` runs the script against a fake Graph API (it needs no credentials and contacts nothing real). It checks that the script and the
production message builders respect the limits Meta documents (3 reply buttons, 20-character titles, 10 list rows, …). It proves nothing about Meta.

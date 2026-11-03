# Running SurveyFlow against real Meta

The WhatsApp integration was written from Meta's public documentation and has never been exercised against Meta (`docs/DECISIONS.md` §4, first
row). `scripts/meta-check.mts` runs the **production gateway code** (`apps/api/src/services/whatsapp/cloud.ts`) against Meta with your credentials,
so every assumption either passes or comes back with Meta's own error message. It prints no secrets, so its output can be pasted into a chat or an
issue as is.

## Once, about 30 minutes: a Meta test app

**Meta rebuilt the developer interface** (checked against screenshots of the new one, 2 November 2026). The old steps ("*Create app* → type Business → add the WhatsApp product", "*WhatsApp → API Setup*") no longer describe what you see: the app is now created through a short wizard around a **use case**, and the WhatsApp screens live under that use case. Each point below says how sure it is:

- **✔ seen**: on a screenshot of the new interface.
- **◇ Meta's guide**: what Meta's current "Get Started" guide says, as returned by a web search; the page itself could not be opened from the build environment, and **we have not seen these screens**. If one differs from this text, trust the screen, and send a screenshot so this file can be corrected.
- **? unchanged**: carried over from the previous version of this file and not re-checked.

### 1. Create the app ✔

1. <https://developers.facebook.com> → *My Apps* → *Create app* (the address becomes `developers.facebook.com/apps/creation/…`).
2. The wizard has **five steps**: *App details → Use cases → Business → Requirements → Overview*.
3. **App details** ✔: *App name* (up to 30 characters; you can change it later in Settings) and *App contact email* (pre-filled with your account's address; Meta uses it for policy notices, restrictions and recovery, so use one you read) → *Next* (it stays grey until the name is filled in).
4. **Use cases** ◇: choose **Connect with customers through WhatsApp** and *Next*. (There is no longer a question "type: Business" followed by "add the WhatsApp product": the use case does that.)
5. **Business** ◇: choose the business portfolio the app belongs to. (The dashboard address of a finished app contains `business_id=…`, ✔, so a portfolio was attached.) **Requirements** and **Overview**: not seen; read them and finish.

### 2. What you land on ✔

The app **Dashboard**, with the app name at the top left (a drop-down), and:

- the checklist *App customization and requirements*: **Customize the Connect with customers through WhatsApp use case** (ticked once the wizard ends), **Test use cases**, **Check that all requirements are met, then publish your app**;
- the left menu: *Dashboard · Required actions · Use cases · Facebook Login for Business · Testing · Publish (badge **Unpublished**) · App settings (Basic, Advanced) · App roles (Roles, Test users) · Alert Inbox*;
- a card **Become a Tech Provider** ("to submit to App Review and request access to user data and data from other businesses"): that is the open item at the end of this file, not part of this check.

**The app stays Unpublished (development mode) for most of this check, and that has a limit Meta states on the webhook screen (✔ seen, 3 November):** *"Apps will only be able to receive test webhooks sent from the app dashboard while the app is unpublished. No production data, including from app admins, developers or testers, will be delivered unless the app has been published."* So:

- the script's own webhook check (it posts to your API itself), the template checks and every send **work unpublished**;
- a **real message typed on your phone will not reach your webhook until the app is published** (the "real inbound round trip" at the end of this file). Publishing is the *Publish* item of the left menu; what it asks for was not seen (Meta usually asks for a privacy-policy address: the `/privacy` page of SurveyFlow is still an unreviewed draft, LEG-01).

### 3. The test number and the first token ◇

Open the use case: *Use cases* in the left menu → **Connect with customers through WhatsApp** → *Customize* ✔. The page is titled **Customize use case**, with a drop-down **Connect on WhatsApp** and this left menu ✔: *Overview · Basic setup (**Step 1. Try it out**, **Step 2. Production setup**, **Step 3. Business verification**, Next steps) · Become a Partner (Become Tech Provider) · Other tools (Tools, Permissions and features, Resources)*. The test number and the first token are in **Step 1. Try it out** ✔ ("5 min · Send a message from your test number to understand how WhatsApp API works"). It has two sections, both showing *Completed* once done:

- **Claim a WhatsApp test number** ✔: shows the **test number** (a US +1 555 number), its **Phone Number ID** and the **Messaging account ID**, each with a copy button; below, the **Access token** field with a copy button and **Generate new token**. Meta notes that for a new app the test number takes about a minute to be registered before a message can be sent.
- **Send a message from your test number** ✔: *Your test number* (From), **Recipient** (a drop-down: your own phone is chosen here, and Meta asks you to confirm it; **? unchanged:** up to 5 recipients), *Message* (one of Meta's sample templates, e.g. "Order Confirmation"), **Send message**, and a ready-made `curl` for the same call. Send this one message first: if it reaches your phone, the account, the token and the number are good before SurveyFlow is involved.

That `curl` shows the Graph API version Meta uses today (**v25.0**); SurveyFlow's default (`META_GRAPH_VERSION`) is **v22.0**, which Meta still serves for now. If the script reports a version error, set `META_GRAPH_VERSION=v25.0` in `.env` (not changed in the code: it has not been tested against v25.0).

**Webhook payload version (✔ seen, 2026-11-03).** The webhook fields in the app dashboard run at **v26.0**, a different setting from the Graph version above. A real inbound "HI" shown in Meta's webhook log at that version carried fields we do not read (`from_user_id`, `user_id`, `country_code`, `from_logical_id`, `internal_1p_only_data`). `apps/api/tests/webhook-meta-shape.test.ts` replays that payload through the real route: it is accepted, the extras are ignored, other subscribed fields (`calls`, `security`, `account_update`, …) and unknown message types answer 200. Still unverified: delivery of such an event to the callback while the app is unpublished (Meta says only dashboard test events arrive), and what Meta does if it one day stops sending `from` in favour of `user_id`; the handler needs `from`.

**The access token on this page is temporary. Treat any screenshot or message that shows it as having leaked it**: press **Generate new token** (the old one stops working) and use the new one only in `.env`.

Keep the **test phone number ID** and the **Messaging account ID** (Meta now says "Messaging account"; the previous version of this file called it *WhatsApp Business Account ID*: it is the same thing, the account that owns the number and the templates).

**A token that lasts** (system user) ✔ for the screens, ◇/? for the order:

1. Open your business portfolio's settings (`business.facebook.com` → *Settings*, the portfolio name is at the top, e.g. "Survey Flow") → left menu **Users → System users** ✔.
2. Select a system user: the right-hand panel shows its name and ID, the buttons **Generate token**, **Revoke tokens** and a "…" menu, and two tabs, **Assigned assets** and **Installed apps** ✔. A new system user has **no assets**: *"No assets assigned"* ✔ (this is how both of yours look now).
3. **Assign assets** ✔ opens *Select assets and assign permissions* with three columns (asset type · assets · permissions). Asset types ✔: *Facebook Pages*, *Apps*, *Messaging accounts* (with *Linked accounts* and *Standalone accounts*), *WhatsApp accounts*. Assign:
   - **Apps → Survey Flow** ✔, with **Manage app** (full access) on. (It may say *Already assigned*; the banner "Access will be updated" only means the permission set is being saved.)
   - **WhatsApp accounts → Test WhatsApp Account** ✔ with the full-control permission (the permission toggles appear on the right once the account is ticked; not seen). This is the account (WABA) the API and the templates belong to.
   - **Messaging accounts → Linked accounts → Test Messaging Account** ✔ is Meta's newer view of the same test account (Meta's guide calls the WABA the "Messaging account"; ? that they are the same object is an inference). Assign it too only if the script later says the account is not accessible: it is a test asset, so assigning both does no harm. ? The previous version of this file said to do this *before* generating the token; the permission to pick later depends on it.
4. **Generate token** ✔ opens a four-step wizard: *Select app → Set expiration → Assign permissions → Done*. Expiration ✔: **60 days (Recommended)** or **Never**; choose **60 days** (a leaked token then dies by itself; a real deployment needs a calendar entry to generate a new one before it ends, which is a reason to write that down in the operator runbook, OPS-03). Permissions ✔ (confirmed by the owner, 3 November): tick `whatsapp_business_messaging` and `whatsapp_business_management`; the boxes are named exactly so. On *Done*, copy the token **once** (Meta does not show it again) straight into the root `.env` as `WHATSAPP_ACCESS_TOKEN`. Never paste it in a chat or a ticket.

You created two system users: **one is enough**; use one and leave the other without assets (or delete it). If a token is ever shown anywhere it should not be, *Revoke tokens* ✔ ends it.

### 4. The values for the root `.env` (the file the API reads)

| Variable | Where it comes from |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | the token from step 3 (the temporary one from **Step 1. Try it out** for a first run, the system-user one afterwards) |
| `WHATSAPP_PHONE_NUMBER_ID` | **Step 1. Try it out** ✔: **Phone Number ID** (copy button) |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | the same section ✔: the **Messaging account ID** (formerly "WhatsApp Business Account ID") |
| `META_APP_ID`, `META_APP_SECRET` | *App settings → Basic* ✔ (the menu item is on the dashboard's left menu; the secret is hidden until you press *Show* and may ask for your password ?) |
| `WHATSAPP_VERIFY_TOKEN` | any string you choose (`openssl rand -hex 16`); the same value goes into the webhook configuration below |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | **not needed to run the script**; only for the Embedded Signup popup. How to make it: the next section |

### 4b. The Embedded Signup configuration ID (only when you want to test the popup) ◇

The script does not use it. The popup (Settings → WhatsApp → connect in SurveyFlow) does: SurveyFlow's page calls Meta's login with this id, then sends the returned `code` to the API. Because a **test app cannot onboard strangers**, only you (and people with a role under *App roles → Roles*, ✔ in the left menu) can use the popup until Meta has approved the app as a Tech Provider; so this is for **your own** try-out, and can wait until the rest is green.

Steps, from Meta's Embedded Signup guide (the screens were **not seen**; send a screenshot if one differs):

0. **Two switches first** ✔ (*Facebook Login for Business → Settings*; the sub-menu is *Settings · Quickstart · Configurations · Templates*): **Login with the JavaScript SDK** is **off** by default and SurveyFlow's popup needs it **on** (it calls Meta's JavaScript login); and **Allowed Domains for the JavaScript SDK** must list the address of the **website** (not the API) that serves the popup, because Meta says "Login and signed-in functionality of the JavaScript SDK will only be available on these domains". *Enforce HTTPS* is on (✔, "strongly recommended"): use an `https://` address (a tunnel to the website port, `4222`), not `http://localhost`. ? Whether `localhost` is accepted in development was not tested. *Valid OAuth Redirect URIs* is not used by the popup.
1. In the same sub-menu: **Configurations** ✔ → create a configuration.
2. Either start from Meta's template named *"WhatsApp Embedded Signup Configuration With 60 Expiration Token"*, or build a custom one: choose the login variation **WhatsApp Embedded Signup**.
3. Ask only for what is needed: the permissions **`whatsapp_business_management`** and **`whatsapp_business_messaging`**, and the WhatsApp account asset.
4. **Token type.** SurveyFlow's page asks Meta for a **`code`** (`response_type: 'code'`, with the default response type overridden: `apps/web/src/components/settings/whatsapp-connect.tsx`), the pattern Meta documents for a business-integration system-user token. If the form offers a token type, pick the one that works with a code. Meta's guide, as found by a search, does not say which is the default: check the setting on the screen.
5. Save. The configuration's **ID** is shown in the list; put it in `.env` as `META_EMBEDDED_SIGNUP_CONFIG_ID` and restart the API. The app also needs `META_APP_ID` (✔ *App settings → Basic*), and the web page must be served from a domain you listed in step 0.

### 5. Make your API reachable, and set the webhook ✔/◇

1. `cloudflared tunnel --url http://localhost:4223` (or ngrok) prints an `https://…` address. Set `PUBLIC_API_URL` to it and restart the API. *(Unchanged.)*
2. In the use case's **Customize use case** page: **Step 2. Production setup** → the first section, **Configure Webhooks** ("About 3 minutes to complete") ✔. Enter:
   - **Callback URL**: `https://<that address>/api/webhook/whatsapp`
   - **Verify token**: your `WHATSAPP_VERIFY_TOKEN`, then press **Verify and save** ✔ (Meta sends a GET with the token and a challenge; the API answers it). Leave the toggle *Attach a client certificate to Webhook requests* **off** ✔ (SurveyFlow does not use client certificates). **Remove subscription** ✔ undoes it.
   - The sections below it in **Step 2. Production setup** ✔: **Register your WhatsApp phone number** (about 1 minute), **Add payment to send business-initiated messages** (about 1 minute) and **Send message** (about 2 minutes). They are for **your own production number**; the test number from Step 1 does not need them (Meta: test numbers need no payment method for template messages). A real business number is what Embedded Signup later registers for each customer.
3. Subscribe to the fields ✔ (seen 2026-11-03: the **Webhook fields** table is on the same **Step 2. Production setup** page, directly under the *Verify and save* button; each row has a version, a **Test** link and a Subscribe toggle; Meta ships several on by default such as `calls`, `security` and `account_update`, which SurveyFlow ignores): **`messages`** ✔, **`message_template_status_update`** ✔ and **`template_category_update`** ✔ (the last one is how Meta tells us it moved a template to marketing: without it SurveyFlow only learns that when a template list is read again, WA-03). The script can also subscribe the app to the account (`--subscribe`, below), which does not replace entering the callback URL.
   (The webhook path stays public even when `INTERNAL_API_SECRET` is set: that is by design, it is protected by Meta's signature.)

### If a screen does not match

Send a screenshot of it. This file was rewritten from two screenshots and from Meta's guide as found by a search; the pages of Meta's guide themselves could not be opened from the build environment (the host is not reachable there), so the points marked ◇ and ? are the ones to correct first. What the script checks (below) does not depend on any menu: it asks Meta's API directly, so a wrong menu name here can slow you down but cannot make a wrong check pass.

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
| message templates | all 16 templates exist, their review state, and **whether Meta re-categorised any** (the open question of `DECISIONS.md` §3 item 3) |
| send: text / buttons / list / link button / template | the exact payloads the product sends are accepted by Meta (the link button is the new in-window receipt message) |
| your webhook | verification handshake, wrong token refused (403), **unsigned post refused (401)**, correctly signed post accepted (200) |

`WARN` means it works but you should look (pending template, local webhook address, low quality rating). `FAIL` carries Meta's message and, for the
common codes, what to do about it.

## What no script can do (still open after a green run)

- **Tech Provider status**: business verification and app review (advanced access to `whatsapp_business_messaging` and `whatsapp_business_management`). It takes days to weeks and is a decision of Meta's, not a test. The new dashboard has a **Become a Tech Provider** card for it (✔ seen: "to submit to App Review and request access to user data and data from other businesses"); what it asks was not looked at.
- **The Embedded Signup popup** in a browser, by a person who has a role on your Meta app (*App roles → Roles* and *Test users* are in the left menu ✔; a test app cannot onboard strangers).
- **A real inbound round trip**: tap "Start survey" on your phone and watch the survey begin in the dashboard (this exercises the signed webhook with a real Meta payload). **It needs the app to be published** (Meta delivers only dashboard test webhooks to an unpublished app, ✔ seen on the webhook screen).
- Sending limits, throughput and quality-rating behaviour under real volume; Meta changing a template's category after approval.
- **The Analytics Bot over real WhatsApp**: linking a phone (`LINK <code>` typed on the owner's own phone, answered from SurveyFlow's own number) and the `owner_alert` template (submitted to SurveyFlow's platform WhatsApp account, not to your customers'; it is not one of the 16 templates above and this script does not check it). Until Meta approves it, only in-window alerts go out (`DECISIONS.md` §3.5).

## Self-test of the script itself

`--fake-graph` runs the script against a fake Graph API (it needs no credentials and contacts nothing real). It checks that the script and the
production message builders respect the limits Meta documents (3 reply buttons, 20-character titles, 10 list rows, …). It proves nothing about Meta.

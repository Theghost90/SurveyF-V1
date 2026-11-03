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

The app stays **Unpublished** (development mode) for this check: the script uses Meta's test number, and nothing in it needs the two last checklist items. *(An inference: if Meta ever refuses to deliver webhooks to an unpublished app, the webhook check of the script comes back with Meta's message.)*

### 3. The test number and the first token ◇

Open the use case (*Use cases* in the left menu → **Connect with customers through WhatsApp** → *Customize*). Meta's guide then has you press **Start using the API**, which opens the **API Setup** page. There:

- Meta generates **a test business phone number** for you (registered automatically; test numbers have relaxed limits and need no payment method for template messages);
- *Generate access token* gives a **temporary** access token, fine for a first run (the previous version of this file said 24 hours; the guide's wording does not give a duration);
- pick your own phone as the recipient ("To") and confirm the code. **? unchanged:** a test number can only message recipients you verified, up to 5.

Keep the **test phone number ID** and the **Messaging account ID** (Meta now says "Messaging account"; the previous version of this file called it *WhatsApp Business Account ID*: it is the same thing, the account that owns the number and the templates).

For a token that lasts: **? unchanged**, *Business Settings → System users*: create one, assign it the WhatsApp account and the app, and generate a token with `whatsapp_business_messaging` and `whatsapp_business_management`. (Business Settings is opened from your business portfolio; the exact menu names there were not re-checked.)

### 4. The values for the root `.env` (the file the API reads)

| Variable | Where it comes from |
|---|---|
| `WHATSAPP_ACCESS_TOKEN` | the token from step 3 |
| `WHATSAPP_PHONE_NUMBER_ID` | the **API Setup** page of the use case ◇: the phone number ID of the test number |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | the same page ◇: the **Messaging account ID** (formerly "WhatsApp Business Account ID") |
| `META_APP_ID`, `META_APP_SECRET` | *App settings → Basic* ✔ (the menu item is on the dashboard's left menu; the secret is hidden until you press *Show* and may ask for your password ?) |
| `WHATSAPP_VERIFY_TOKEN` | any string you choose (`openssl rand -hex 16`); the same value goes into the webhook configuration below |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | only for Embedded Signup: the left menu has **Facebook Login for Business** ✔; its *Configurations* page is where a configuration (and its id) is made ◇/? (not seen) |

### 5. Make your API reachable, and set the webhook ◇

1. `cloudflared tunnel --url http://localhost:4223` (or ngrok) prints an `https://…` address. Set `PUBLIC_API_URL` to it and restart the API. *(Unchanged.)*
2. In the Meta app, open the webhook settings of the WhatsApp use case. Meta's guide names them **WhatsApp → Configuration → Edit** and says the use case's customisation page has a *Webhooks* entry; where exactly that sits in the new left menu was **not seen**. Enter:
   - **Callback URL**: `https://<that address>/api/webhook/whatsapp`
   - **Verify token**: your `WHATSAPP_VERIFY_TOKEN`, then *Verify and save* (Meta sends a GET with the token and a challenge; the API answers it).
3. Subscribe to the fields **`messages`**, **`message_template_status_update`** and **`template_category_update`** (the last one is how Meta tells us it moved a template to marketing: without it SurveyFlow only learns that when a template list is read again, WA-03). The script can also subscribe the app to the account (`--subscribe`, below), which does not replace entering the callback URL.
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
- **A real inbound round trip**: tap "Start survey" on your phone and watch the survey begin in the dashboard (this exercises the signed webhook with a real Meta payload).
- Sending limits, throughput and quality-rating behaviour under real volume; Meta changing a template's category after approval.
- **The Analytics Bot over real WhatsApp**: linking a phone (`LINK <code>` typed on the owner's own phone, answered from SurveyFlow's own number) and the `owner_alert` template (submitted to SurveyFlow's platform WhatsApp account, not to your customers'; it is not one of the 16 templates above and this script does not check it). Until Meta approves it, only in-window alerts go out (`DECISIONS.md` §3.5).

## Self-test of the script itself

`--fake-graph` runs the script against a fake Graph API (it needs no credentials and contacts nothing real). It checks that the script and the
production message builders respect the limits Meta documents (3 reply buttons, 20-character titles, 10 list rows, …). It proves nothing about Meta.

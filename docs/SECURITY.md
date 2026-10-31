# SurveyFlow V1 — security: what is built, how it works, how to run it, what is not covered

This is the reference for the sign-in and data-protection work (the 15 findings of the registration-and-login review, minus findings 11 and 13, and the matrix
items SEC-01 to SEC-20; SEC-16 to SEC-20 were added after the review, §1.1). Where each item stands, built or not, is kept in [`BACKLOG.md`](BACKLOG.md). It says **what each protection does, where it lives, how it was tested, what it costs and what it does not stop**. Read §12 (what is
not covered) before telling anyone the product is "secure": it is hardened against the attacks the review named, not immune to attacks in general.

Legend as in `DECISIONS.md`: ✅ done and tested here · ⚠️ built, but could not be verified against the real third-party service from the build environment · ❌ not built.

## 1. Map: finding → item → status

| # | Finding (review) | Matrix item(s) | Status | Where |
|---|---|---|---|---|
| 1 | No e-mail verification (pre-hijacking) | SEC-01 | ✅ (⚠️ real providers) | §3 |
| 2 | No password reset | SEC-02 | ✅ | §3.4 |
| 3 | Sessions cannot be revoked | SEC-03 | ✅ | §5 |
| 4 | One stolen login exposes all participant data | SEC-06, SEC-06b, SEC-08 | ✅ | §8, §9 |
| 5 | Weak brute-force defences | SEC-04, SEC-11 | ✅ (⚠️ CAPTCHA, breach check) | §4 |
| 6 | `/api/auth/oauth` mints a session for any e-mail | SEC-05 | ✅ (⚠️ Google) | §6 |
| 7 | No second factor | SEC-09 | ✅ | §7 |
| 8 | Spoofable client IP | SEC-07 | ✅ (⚠️ real CDN) | §10 |
| 9 | Sign-up enumeration | SEC-10 | ✅ | §3.2 |
| 10 | Sign-up abuse and CPU load | SEC-04 (CAPTCHA), SEC-11 (argon2id) | ✅ (⚠️ CAPTCHA) | §3, §4 |
| 11 | Participant data is plain text in the database | **DAT-02 (backups built 2026-10-31; the host's disk is yours, §21)**; SEC-15 (built, §11) | ⚠️ partly | §11, §21 |
| 12 | Owner separation only in application code | SEC-12 | ✅ (test and guard, **not** Postgres RLS) | §13 |
| 13 | No account deletion or erasure; no security e-mails; no audit log | **DAT-01 (built 2026-10-31)**; the e-mails and the audit log (SEC-01/04/06/08) | ✅ (limits in §20) | §9, §20 |
| 14 | Search terms in log URLs | SEC-14 | ✅ | §14 |
| 15 | Missing browser protections, aliases, 72-byte truncation | SEC-13, SEC-10, SEC-11 | ✅ | §3.2, §4.1, §10 |

Not built: **finding 11's host half** (the encryption of the database disk is a setting at the host and cannot be done or seen from here: §21; its backup half and finding 13, DAT-01, were built later, §20 and §21); **Postgres row-level security** (§13 explains the choice); **any staff console or role system** (ADM-01 to ADM-06).

### 1.1 Matrix items added after the review (SEC-16 to SEC-20)

| Item | What | Status | Where |
|---|---|---|---|
| SEC-16 | The website framework upgraded (Next.js 14.2.35 to 15.5.28, React 19) | ✅ (checked on a Windows PC, 2026-10-31) | §18 |
| SEC-17 | Dependency majors (zod 4, puppeteer 25, Prisma 7) and an `npm audit` gate before every release | ✅ | §18 |
| SEC-18 | The general rate limit counts per verified session, with a ceiling per address | ✅ | §10.1 |
| SEC-19 | The confirmation page asks for the password chosen at sign-up | ✅ | §3.1 |
| SEC-20 | A cap on how many different participants one login can list in a day; Google Sheets auto-sync needs a fresh confirmation | ✅ | §8 |

## 2. What an attacker is assumed to be able to do

Four attackers, in the order the design was tested against them:

1. **A stranger on the internet** with a list of e-mail addresses and a list of common passwords (guessing, credential stuffing, enumeration, sign-up abuse).
2. **A person who has stolen one owner's session or password** (malware, a shared computer, phishing) and wants the participants' data or the account.
3. **A person who reads the database or a backup** (a leak, a stolen dump) but has no application secrets.
4. **A malicious or careless script on a page** (an injected script, a hostile page in another tab) that tries to act as the signed-in owner.

Not assumed away: a compromised owner device (§12), staff misuse (there is no staff console yet), a compromised host or CI, a Meta/Google/PSP account takeover.

## 3. Sign-up, e-mail confirmation, enumeration (SEC-01, SEC-10; findings 1, 9, 10, 15)

### 3.1 Confirmation (finding 1)

- Registering creates an Explore account that is **unconfirmed**. The owner can sign in and look around, but everything that sends, pays, connects, exports or loads
  participants answers `403 email_not_verified` (`authenticateVerified`): an unconfirmed account could belong to a squatter.
- The confirmation link is **single-use, 24 hours, stored only as a SHA-256** (a database leak cannot confirm anybody). A new link of the same kind replaces older ones.
  Opening the link confirms nothing: the page asks for a click and the confirmation is a POST (mail scanners that open every link must not use it up).
- **The page also asks for the password chosen at sign-up** (SEC-19; `CONFIRM_REQUIRES_PASSWORD`, on unless set to `false`). Whoever registers an address chooses the password; the person the address belongs to does not
  know it. So somebody who clicks a confirmation e-mail they did not ask for cannot confirm a stranger's account: they cannot type its password. The link is looked at without being spent, the password is checked,
  and only then is the link consumed (a wrong password does not cost the owner their link). A wrong password answers 401 `confirm_password_wrong` and is audited (`verify_password_failed`); **five wrong passwords in an hour burn the link**
  (a new one is a click away). Accounts created with Google never go through this page. *Cost:* one more field for everybody; an owner who forgot the password they just chose uses "forgot password" (a reset also confirms the address).
  *Test:* `security-auth.test.ts` (five tests: wrong password, the link survives it, five tries burn it, the switch, an unconfirmed account that cannot be hijacked).
- An account never confirmed is **deleted after 24 hours** (`UNVERIFIED_PURGE_HOURS`) unless it somehow holds money, a WhatsApp number or a wallet entry.
- **Registering again with an address whose account was never confirmed replaces that account**, so a squatter cannot keep a real person out; **signing in with Google**
  does the same (Google has just proved the address). Accounts that existed before this work are marked confirmed once (`Backfill`), everything after must confirm.
- The plan chosen on the pricing page travels through the confirmation e-mail to onboarding.

### 3.2 No enumeration, no alias farming (findings 9, 15)

- `POST /api/auth/register`, `verify-email/resend` and `password/forgot` **always answer 202 with the same body**, whether the address is new, waiting or a customer. The
  difference is only in the e-mail: a new address gets a link, a confirmed account gets "you already have one" (at most one an hour per mailbox).
- **The e-mail is handed to the provider after the answer** (`sendMailInBackground`) and **the answer is held to at least `AUTH_MIN_RESPONSE_MS` (350 ms)**: handing a message
  to a provider takes tens to hundreds of milliseconds, and without this a patient stranger could tell customers from non-customers by timing. The password hash is computed on
  every path of sign-up for the same reason. *Cost:* sign-up and "forgot password" take a third of a second longer. *Test:* `security-auth.test.ts` (timing floor, mutation-checked).
- One mailbox is one account: `canonicalEmail` folds Gmail dots, `+tags` and the `googlemail.com` alias (and `+tags` at Outlook, iCloud, Proton, Fastmail). Unknown domains are
  **not** folded (two different people could share `a+b@` there). The sign-in counters and the per-minute rate limits use the folded address, so spelling it differently buys no extra tries.
- The only sign of an existing account is the e-mail itself. The sign-up form is rate-limited per (address, connection) and per connection (`SIGNUP_PER_IP_HOUR`, default 30: generous on
  purpose, because on a mobile network many subscribers share one public address and the CAPTCHA does the real work).

### 3.3 E-mail content

E-mails carry counts, a browser label and a coarse place, never participant data. A name typed into the sign-up form can be **anything, and the confirmation goes to whoever's address
was typed**, so the confirmation e-mail never greets by name, and other e-mails greet only by a short single-line name with no link or address in it (`greetingName`; found in
the review of this build: without it SurveyFlow's own sender would have delivered a stranger's words).

### 3.4 Forgotten and changed passwords (finding 2)

- "Forgot" mails a link only to a real address (30 minutes, single use, hashed at rest), three an hour per address and ten an hour per connection. The new password is checked **before**
  the link is spent (a weak choice does not cost the owner their link). A reset **ends every session**, confirms the address (the link proved the mailbox) and tells the owner by e-mail.
  An authenticator app, if there is one, still guards the next sign-in.
- Changing it while signed in needs the current password, refuses an unchanged one, ends every **other** session and tells the owner.

## 4. Passwords and sign-in (SEC-04, SEC-11; findings 5, 10, 15)

### 4.1 Passwords

- **argon2id** (`@node-rs/argon2`, native, runs on the thread pool so it never freezes the server; no 72-byte truncation). Defaults are the OWASP minimum, 19 MiB and 2 passes
  (`ARGON2_MEMORY_KIB`, `ARGON2_TIME_COST`; raise them if the server can afford it). Old bcrypt hashes still verify and the account moves to argon2id at its next sign-in; so does an
  argon2 hash made with cheaper settings. An unknown address (or a Google-only account) still does one full hash check, so timing does not tell addresses apart.
- Policy: 10 to 128 characters; not on the common list (the most common passwords, French and Cameroon terms and patterns included); must not contain the address's local part (5+ characters);
  **not in a known breach** (haveibeenpwned range API: only the first 5 characters of the SHA-1 leave the server; a slow or down service never blocks anybody). Refusals carry a stable code the website translates.

### 4.2 Sign-in: rising delays and a CAPTCHA, never a lock-out (`login-guard.ts`)

A lock-out would let a stranger stop a customer from signing in, so there is none. Three counters, none of which says whether an address exists:

| Counter | Window | What happens |
|---|---|---|
| this address from this connection | 15 min | 4 free failures, then a wait of 2, 4, 8, 16, 32, 60 s between attempts (even the right password waits), and a CAPTCHA |
| this address from anywhere | 1 h | from the 10th failure a CAPTCHA for everybody, and **one alert e-mail to the owner** (at most one every 6 h) |
| this connection across addresses | 10 min | from the 20th failure a CAPTCHA (credential stuffing) |

The owner on their usual connection is not slowed by a stranger guessing from elsewhere; they are asked for a CAPTCHA. A successful sign-in forgives that address's failures from that
connection (not the connection-wide count). On top of this the sign-in route allows 10 requests a minute per (address, connection); **a two-step sign-in is two requests**.
A **new device** (browser, system and country not seen in 90 days; the very first sign-in is not "new") gets an e-mail.
*Cost / limit:* with `CAPTCHA_DISABLED=true` the delays and the per-minute cap are the only brakes, and a botnet with thousands of addresses can still try about one guess per address
per minute; production refuses to start without Turnstile keys or that explicit switch. The CAPTCHA **fails open** if Cloudflare is unreachable (refusing everybody would lock every owner out; the delays still apply).

## 5. Sessions (SEC-03; finding 3)

### 5.1 API side

- Every sign-in is a row in `AuthSession` (random 128-bit id, refresh-token hash, device label, coarse place, absolute expiry). The API token is a **JWT** (HS256, key id from a hash of the secret,
  issuer and audience checked) naming that row; **a token whose row is revoked, expired or deleted stops working on its next use** (a 60-second Redis cache, cleared the moment a session is revoked).
  Because the session id is random and secret, **a leaked `JWT_SECRET` alone cannot forge a working token** (it also needs the id of a live session).
- Lifetime: API token **15 minutes** (`ACCESS_TOKEN_TTL_SECONDS`, minimum 30), sign-in **12 hours absolute** (`SESSION_TTL_HOURS`), whatever the owner does in between.
- The **refresh token** (`rt_<session>_<secret>`, SHA-256 at rest) is **rotated on every use**. The previous one is honoured for **30 seconds** (two requests refreshing at the same moment are not
  theft: both get an API token, one gets the new refresh token). A previous token used **after** that means a copy of the cookie exists somewhere: **the whole session ends** and a `refresh_reuse` row is written.
- "Sign out everywhere" (all, or all but this one), ending one session from the list, a password change/reset, and signing out all revoke at once and the owner is told by e-mail.
- **Secret rotation**: move the old `JWT_SECRET` to `JWT_SECRET_PREVIOUS`, set a new one, drop the old after one token lifetime. Nobody is signed out by it. (Refresh tokens and recovery codes do not depend on the JWT secret.)

### 5.2 Website side (the browser never holds a token)

- The browser holds one **httpOnly, SameSite=Lax, `__Secure-` (under https) NextAuth cookie** that contains the API token and the refresh token; page scripts see neither, and `SessionProvider` is deliberately
  not used (its polling would rewrite the cookie with a stale refresh token).
- All API calls go through the website's proxy (`/proxy/*`), which attaches the token, **renews it silently** shortly before it expires or when the API says it is no good, and rewrites the cookie when a new
  refresh token exists. Several calls at once share one refresh per refresh token (a request carrying an older copy of the cookie is **not** handed the owner's new tokens). A renewal that rotated the refresh token always
  sets the new cookie, even when the call that followed it failed. An unreachable API keeps the cookie (502); an ended session clears it.
- Signing out also revokes the session at the API; the website can do that with the refresh token alone after the API token has expired (`POST /api/auth/signout`; a wrong secret revokes nothing).

### 5.3 Known limits of the session design

- If the response that carried a new refresh token **never reaches the browser** (a tab closed during the one renewal in fifteen minutes), the cookie holds the old token and the owner is signed out
  after the 30-second grace and must sign in again. This is the price of reuse detection; no data is lost.
- A stolen cookie is valid until the owner signs out everywhere, changes the password, or the 12 hours end. If the thief uses it **and** the owner's browser later refreshes, the reuse is detected and the session ends.
- Cookies are only `secure` when `NEXTAUTH_URL` is https; **production must be served over https** (HSTS is sent in production).

## 6. Google sign-in (SEC-05; finding 6)

The old `/api/auth/oauth` (a session for any e-mail, behind one shared secret) **no longer exists**. Now the API verifies Google's **ID token itself**: signature (Google's JWKS), issuer, **our** client id as audience, expiry and
`email_verified`. A Google account is recognised by its stable subject (`AuthIdentity (provider, sub)`), never by e-mail alone. A new Google user gets an account at once; an address that already has a **confirmed** password account is
**never merged silently**: its owner gets an e-mail link and the two are linked only when they click it; an **unconfirmed** one is a squatter and is replaced. Scope is `openid email profile` only; the Sheets permission stays a separate consent.
Everything is off unless `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and `INTERNAL_API_SECRET` are set.
*Limit by design:* a Google sign-in does **not** ask the SurveyFlow authenticator code (Google's own protections apply); step-up checks for exports still do. If someone's Google account is compromised so is their SurveyFlow account.
⚠️ Exercised only with Google stubbed (local key set, injected resolver); the real JWKS fetch and a real ID token were never seen.

## 7. Second factor (SEC-09; finding 7)

Authenticator-app codes (RFC 6238: HMAC-SHA1, 30 s, 6 digits; no dependency, checked against the RFC's vectors). The secret is stored **AES-256-GCM encrypted**; the QR code is drawn on the server so no third party sees the secret.
A code is accepted **once**: `totpLastStep` only moves forward (compare-and-set), so a code that was watched or intercepted cannot be replayed. **Ten recovery codes** (16 characters from an unambiguous alphabet, about 80 bits) are shown once;
they are stored as a **plain SHA-256** (80 random bits cannot be brute-forced, and a keyed hash would break the day a secret is rotated). Turning it off needs the password **and** a current code; new recovery codes need a current code;
turning it on or off e-mails the owner. A wrong code counts as a failed sign-in (same delays). On the plans in `REQUIRE_2FA_PLANS` (default `business`) a large export or bulk delete is refused until an authenticator is on.
*Cost / limit:* without the CAPTCHA a botnet can guess 6-digit codes only after knowing the password; one wrong code can lock out a good one for one 30-second step after clock drift.

## 8. Participant data leaving the account (SEC-06, SEC-06b; finding 4)

One stolen login must not carry away every contact. Phone numbers are **masked in every list** the API returns (`+237 6XX XXX 789`); a full number leaves only through:

| Door | Controls |
|---|---|
| **Reveal** one number (`POST /contacts/:id/reveal`) | 30 per 10 min and `REVEAL_PER_DAY` (300) a day; the **audit row is written first** and its failure stops the reveal; the screen hides it again after 30 s |
| **Export** (PDF, Excel, CSV of non-responders, Google Sheets) | daily cap `EXPORT_DAILY_LIMIT` (20) downloads and `EXPORT_DAILY_ROWS` (50,000) rows per 24 h window; from `STEP_UP_EXPORT_ROWS` (50) rows a recent **"confirm it is you"**; an **e-mail to the owner for every export** (counts only); audit row first |
| **Bulk delete** | more than `STEP_UP_BULK_ROWS` (20) contacts needs the confirmation, is capped, e-mailed and audited |
| **Prize-draw winner** | the one number shown in full (the owner must contact them); one person, written to the trail |

**Confirm it is you** (`step-up.ts`): the authenticator code if there is one, else the password, else a code e-mailed to the owner (Google-only accounts). It lasts `STEP_UP_MINUTES` (15) **for that browser session only**;
eight attempts per 15 minutes; the e-mailed code lives 10 minutes, three requests per 10 minutes, five wrong tries kill it. The website asks once in a dialog and repeats the call. Searching: an exact number works (a keyed index), a
**fragment of a number does not** (it would let someone read numbers digit by digit through the search box); names are searched in memory.
**Names and free-text answers** are not masked, so how many *different* participants one login looks at in 24 hours is counted (SEC-20: the contacts list, the responses list and the not-started list; a distinct count kept in Redis, so
looking at the same page again is free, and a search counts the people it returns, not the ones it looked through). Past `READ_SOFT_PEOPLE` (1,000) the owner is e-mailed once (a count and a time, no names) and a recent "confirm it is you" is needed;
past `READ_HARD_PEOPLE` (20,000) the lists answer 429 `read_cap` until the 24 hours have passed (an export is the way to take more, and it is capped, confirmed and e-mailed too). Both are in the audit trail (`bulk_read`, `bulk_read_blocked`).
**Google Sheets auto-sync** needs a fresh confirmation to be switched on, at any size, and **pauses itself `SHEETS_AUTOSYNC_DAYS` (30) days after the last confirmation** (checked when a response completes); the owner is e-mailed once per pause, and it
resumes, sending the rows it missed, when the owner confirms again. *Test:* `security-reads.test.ts` (seven tests) and `exports.test.ts`.
*What this does not protect:* the prize-draw winner's number (shown in full on purpose); **a slow scraper that stays under the soft number** (1,000 people a day is a judgement call: lower it if owners' lists are smaller); and names and answers stay unmasked to a login that has confirmed.

## 9. Audit log and e-mails to the owner (SEC-08)

`AuditLog` records who did a security-relevant thing, when and from where: **ids, counts, a browser label and a coarse place (first three groups of the address), never a name, a number, a message or an answer**. It is
**append-only**: a database trigger refuses any UPDATE and any DELETE except from the retention job (`sf.audit_purge`), which removes rows older than `AUDIT_RETENTION_DAYS` (400). Written *before* the action for reveals and exports
(`auditStrict`: no record, no action); sign-in events use the lenient writer (the owner must still be able to sign in). Recorded: register, confirmation, sign-in and new device, blocked sign-ins, sign-out and revocations,
refresh reuse, password reset/change, step-up success and failure, two-factor changes, recovery codes (used, regenerated), Google sign-in and link, exports, bulk deletes, reveals, prize-draw winners, a wrong password on a confirmation page (`verify_password_failed`), lists read past the soft or the hard number (`bulk_read`, `bulk_read_blocked`),
Google Sheets auto-sync confirmed and paused (`sheets_autosync_confirmed`, `sheets_autosync_paused`).
Every survey send (`survey_sent`: its category, the reasons, whether a marketing cost was accepted) and every template Meta moves to marketing (`template_recategorised`) are recorded as well (WA-03, `DECISIONS.md` §3.11).
The owner sees their own trail in **Settings → Security → Activity**. E-mails go out for: confirmation, "you already have an account", reset, password changed, new device, repeated failed sign-ins, export, bulk delete,
two-factor on/off, sign-out everywhere, Google link, the step-up code, a list read past the soft number, a paused Sheets sync, and the account download and deletion (asked, cancelled, done; §20). *Not recorded:* single-contact edits and deletes, survey changes, billing, anything done by staff (there is no staff console yet).

## 10. Trusted client address and browser protections (SEC-07, SEC-13; findings 8, 15)

- **Client address.** The API's `trustProxy` is **off**. The website's server works out the visitor's address (`CLIENT_IP_HEADER`, a single header your CDN sets such as `cf-connecting-ip`, **or** `TRUSTED_PROXY_HOPS`, the Nth address from the right of
  `x-forwarded-for`) and sends it as `x-sf-client-ip` **together with the shared secret**; the API believes that header only on a request that carries the secret. A stray `X-Forwarded-For` changes nothing. With neither variable set
  in production the website warns once: every visitor looks like one address, so the per-connection limits cannot tell them apart. **Deployment requirement: the website must be reachable only through the CDN** (firewall to its address ranges),
  otherwise a visitor who reaches the site directly can set the header themselves. **This was shown, not assumed** (§19): sent straight to the origin, `cf-connecting-ip: 6.6.6.6` was believed; behind a proxy that sets the header itself the visitor's own value was discarded and the audit trail recorded the proxy's address.
- **Content-Security-Policy** with a per-request nonce and `strict-dynamic` (middleware), `default-src 'self'`, third parties only Cloudflare Turnstile and the Meta SDK, `object-src 'none'`, `frame-ancestors 'self'`, `form-action` self and accounts.google.com,
  inline styles allowed (Radix and the charts need them; inline styles cannot run code). `CSP_MODE=enforce|report-only|off`. Also `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
  `Permissions-Policy`, and in production `Strict-Transport-Security: max-age=63072000; includeSubDomains` (no preload; **every sub-domain of the site's domain must then serve https for two years**: remove `includeSubDomains` in `next.config.mjs` if some do not). The browser run reports every violation: **zero** in the full security run (dev server) and in the production build (§15).
- **The proxy** (`/proxy/*`) refuses: any address piece that is not letters, digits, `.`, `-`, `_`, `~` (so a decoded `%2F`, `%3F`, `%23` or `..` cannot reach `auth/login`, `auth/refresh`, `auth/google`, sign-out, or a webhook — **found and fixed in this review,
  each one reached the API's sign-in route before**); calls another site caused (`Sec-Fetch-Site: cross-site`) and state-changing calls with a foreign `Origin`; bodies over 3 MB (read with a cap, whatever `Content-Length` says); and calls that hang (120 s; the refresh 15 s).
  The browser can reach only a short list without a session (`PUBLIC_PATHS`); everything else needs the cookie. API responses are `no-store`.
- **After sign-in the browser only goes to a path on this site** (`safeRelativePath`: one leading slash, then not another slash or a backslash, no control characters): `/\evil.example` is `//evil.example` to a browser and used to send the owner off-site after a real sign-in.

### 10.1 Rate limits (SEC-18)

- **The general limit counts per verified session**, not per address (`RATE_LIMIT_SESSION_PER_MINUTE`, 300). On a mobile network many owners share one public address and a busy analytics page polls every 10 seconds, so a limit per address would throttle a crowd for nothing
  (it was seen in the browser tests, which all come from one address). The key comes from a token this server signed, for a live session: signature, issuer, audience and expiry are checked first, so **a token this server did not sign cannot choose a session to land in a fresh allowance**,
  it counts against the caller's address.
- **A ceiling per address** on top of it (`RATE_LIMIT_IP_PER_MINUTE`, 3,000) stops one source from multiplying sessions; calls with no valid token (the public pages, sign-in) count per address. Meta's and the providers' webhooks are not counted against an address.
- The website forwards the visitor's own address with the pricing call (`apps/web/src/lib/pricing.ts`), so the public pricing page is counted per visitor and not as "the website" for all of them.
- The sign-in, sign-up, reset and confirmation routes keep their own, tighter limits (§3, §4). *Test:* `security-ratelimit.test.ts` (seven tests: two owners behind one address, the usual 429 answer, forged tokens, the ceiling, the webhook exemption).

## 11. Encryption of participants' names and numbers (SEC-15) and secrets at rest

- **Contact name and phone are AES-256-GCM encrypted in the database** by the one Prisma client every route uses (a client extension: no route has to remember). Format `v2.<key id>.<iv>.<tag>.<data>`; the key id is authenticated data, so a ciphertext cannot be re-labelled.
  A **key ring** (`ENCRYPTION_KEYS=kid:key,kid:key`: the first encrypts, all decrypt) allows rotation; `scripts/rotate-keys.mts` (dry run by default, `--apply`, `--rehash-index`) moves everything onto the active key. WhatsApp and Google tokens, the authenticator secret and a parked
  reply's number use the same ring. Payloads from before the ring (`v1`, `TOKEN_ENCRYPTION_KEY`) still decrypt.
- A number can still be found exactly through **`phoneHash`, an HMAC-SHA256 with `BLIND_INDEX_KEY`** (a different secret from the encryption key; unique per owner). Without that key a database leak cannot be turned back into numbers by trying them all (there are only about a billion).
- *What it costs:* a name cannot be searched or sorted in SQL (the list filters in memory, at most 50,000 contacts per search) and a fragment of a number cannot be searched; a query that needs either **throws** instead of silently returning nothing. The existing contacts are encrypted by a start-up backfill.
- A **parked reply** (a message retried later) used to hold the participant's number in plain text; now encrypted, and the payload is **dropped as soon as the job is done**.
- **Production refuses to start** without `ENCRYPTION_KEYS` (or the old `TOKEN_ENCRYPTION_KEY`) and without `BLIND_INDEX_KEY`. **Losing those keys makes the data unreadable: keep them in a secret manager and back them up separately from the database backups.**
- *Not covered:* **survey answers (free text) are stored unencrypted**; the database disk, backups and snapshots are not encrypted by the application (that is DAT-02 and depends on the hosting); anyone who can read both the database and the application's environment can read everything.

## 12. What is NOT covered (read this)

1. **A compromised owner device, a phished owner who completes the code themselves, SIM-swap attacks on the owner's phone, a malicious browser extension.** The controls limit damage (caps, confirmations, alerts, session list); they do not remove it.
2. **Pre-hijacking through an e-mail the owner did not ask for** is closed by SEC-19 (§3.1): the confirmation page asks for the password the registrant chose, and the person whose address it is does not know it. It comes back if `CONFIRM_REQUIRES_PASSWORD=false`,
   and a registrant who *tells* the mailbox's owner the password can still get them to confirm.
3. **Names and answers** in lists are not masked. One login can list at most `READ_HARD_PEOPLE` different participants a day and needs a recent confirmation past `READ_SOFT_PEOPLE` (§8), but a stolen session can still read up to the soft number without any confirmation.
4. **Google Sheets auto-sync** now needs a confirmation to be switched on and pauses itself after 30 days without a new one (§8); in between it keeps pushing new rows.
5. **Staff and operators**: no console, no roles, no staff 2FA, no audit of staff actions; database access by the operator is unlogged. Matrix items ADM-01 to ADM-02 (Must for a public launch) cover this.
6. **The host's disk encryption** (DAT-02's host half, §21), a **breach-notification procedure**, handling a *participant's* own request to the owner, and **retention periods that counsel has not confirmed** (the 10 years kept for money records, §20, is our default). Account deletion and download exist (§20).
7. **Postgres row-level security**: owner separation is application code, guarded by a test over every route (§13). One forgotten filter in *new* code that the guard does not see would still leak.
8. **Denial of service** beyond the rate limits (no WAF, no per-tenant quotas on CPU-heavy PDF exports other than the per-minute and daily caps). The general limit counts per verified session with a ceiling per address (§10.1), so a crowd behind one carrier address is not throttled for nothing; the numbers are to be tuned with real traffic.
9. **Dependencies**: `npm audit --omit=dev` reports **0 advisories** since 2026-10-28 and `npm run audit:gate` fails a release on any high or critical one that is not written in `docs/audit-allowlist.json` with a reason and an end date (§18); a new advisory can appear tomorrow. **Secrets management** is the deployment's job (the application reads environment variables).

## 13. Owner separation (SEC-12; finding 12)

The choice: **no Postgres RLS**; instead `tests/security-isolation.test.ts` builds two owners with data in every table, **enumerates every route the API registers** (an `onRoute` hook) and fails if a route is neither in the public allow-list nor
covered by a cross-owner check: every route with an id answers 404 to the other owner, none leaks a marker string. *Why:* RLS needs a per-request role/`SET LOCAL` discipline on every query, including the background jobs and the webhook paths, and would be a larger, riskier change than this
build justified. *Cost:* a new route that is added **without** being listed fails the test (good), but a new query inside an existing route that forgets the owner filter is only caught if the test exercises it. Revisit RLS before an admin console exists.

## 14. Logs (SEC-14)

The request log keeps the **path without its query string** (search terms, tokens and codes sit in queries) and redacts `authorization`, `cookie`, `x-internal-secret`, `x-hub-signature-256` and `x-sf-client-ip`. Mail bodies are never logged. A test boots the app with a log stream and checks it.

## 15. Operations

### 15.1 Variables (full list with comments: `.env.example`; production refuses to start without the starred ones)

| Variable | Purpose |
|---|---|
| `JWT_SECRET`★ (`JWT_SECRET_PREVIOUS`) | signs API tokens (≥ 32 chars); rotate by moving the old one to `PREVIOUS` |
| `ENCRYPTION_KEYS`★ | key ring `kid:key,…` (32 bytes each, base64 or hex); first encrypts |
| `BLIND_INDEX_KEY`★ | secret of the number index (32 bytes) |
| `INTERNAL_API_SECRET`★ | the website's proof to the API (≥ 32 chars); same value on both |
| `EMAIL_PROVIDER`★ (`smtp` \| `resend` \| `brevo`), `EMAIL_FROM`★, `SMTP_URL` / `RESEND_API_KEY` / `BREVO_API_KEY` | e-mail; **mock is refused in production** |
| `PUBLIC_WEB_URL`★ | https address used in e-mail links (never taken from a request header) |
| `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`★ (or `CAPTCHA_DISABLED=true`) | CAPTCHA |
| `CLIENT_IP_HEADER` or `TRUSTED_PROXY_HOPS` (website) | where the visitor's address comes from |
| `NEXTAUTH_SECRET`★, `NEXTAUTH_URL` (website) | cookie encryption; https in production. Blank in development gets a fixed throw-away secret (`apps/web/next.config.mjs`); **blank in production signs nobody in** |
| `CSP_MODE`, `HIBP_CHECK`, `ARGON2_*`, `ACCESS_TOKEN_TTL_SECONDS`, `SESSION_TTL_HOURS`, `AUTH_MIN_RESPONSE_MS`, `SIGNUP_PER_IP_HOUR`, `EXPORT_*`, `STEP_UP_*`, `REVEAL_PER_DAY`, `REQUIRE_2FA_PLANS`, `AUDIT_RETENTION_DAYS`, `UNVERIFIED_PURGE_HOURS`, `ACCOUNT_DELETION_GRACE_DAYS`, `FINANCIAL_RETENTION_YEARS`, `ACCOUNT_EXPORT_PER_DAY`, `BACKUP_KEYS`, `BACKUP_DIR`, `BACKUP_KEEP_DAYS`, `HOST_DISK_ENCRYPTION` (the last four are read by the backup scripts only), `RATE_LIMIT_SESSION_PER_MINUTE`, `RATE_LIMIT_IP_PER_MINUTE`, `CONFIRM_REQUIRES_PASSWORD`, `READ_SOFT_PEOPLE`, `READ_HARD_PEOPLE`, `SHEETS_AUTOSYNC_DAYS` | the tunable limits above |

Generate secrets with `openssl rand -base64 32` (use `-base64 48` for `JWT_SECRET`).

**A setting left blank in `.env` is the same as no setting**: its default applies (`apps/api/src/config/env.ts`, `withoutBlanks`; `tests/env-example.test.ts` holds `.env.example` itself to it). One consequence to know: `REQUIRE_2FA_PLANS=` (blank) now means the default `business`, no longer "no plan"; to require it for nobody, write `REQUIRE_2FA_PLANS=none`. In development a blank `JWT_SECRET` is the API's own throw-away one (before, it was an empty string); in production a blank one is refused, as before.

### 15.2 Rotation and incidents

| Situation | What to do |
|---|---|
| Routine JWT rotation | `JWT_SECRET_PREVIOUS=<old>`, new `JWT_SECRET`, restart; remove the old after 15 minutes. Nobody is signed out. |
| Encryption key rotation | `ENCRYPTION_KEYS=k2:<new>,k1:<old>`, restart, `npx tsx --env-file=.env scripts/rotate-keys.mts --apply` until "left on an old key: 0", then remove `k1`. Back up first. |
| Blind-index key rotation | stop the API, set the new key, `rotate-keys.mts --apply --rehash-index`, start. Until it finishes a participant's number is not recognised. |
| One owner's session is suspected stolen | the owner: Settings → Security → *Sign out everywhere* and change the password. Staff: `UPDATE "AuthSession" SET "revokedAt" = now(), "revokedReason" = 'staff' WHERE "userId" = '<id>' AND "revokedAt" IS NULL;` (the 60-second Redis cache `sf:sess:<id>` expires by itself). |
| Mass revocation | the same without the `userId` condition, then `redis-cli --scan --pattern 'sf:sess:*' \| xargs redis-cli del`. Everybody signs in again. |
| `NEXTAUTH_SECRET` changed | every cookie becomes unreadable: everybody signs in again. |
| `INTERNAL_API_SECRET` changed | change it on the API and the website together; calls fail in between. |
| Look at one owner's trail | `SELECT "at","action","ipPrefix","userAgent","meta" FROM "AuditLog" WHERE "userId" = '<id>' ORDER BY "at" DESC LIMIT 100;` |
| The API sits at start-up and never answers (no log line, no database session) | A start-up lock in Redis (`sf:lock:startup-backfills`, 10 minutes) left by an API that was killed (`kill -9`, a container stopped) in the middle of its start-up data fixes: the next one waits for it, up to 2 minutes. If no other API instance is starting, `redis-cli del sf:lock:startup-backfills` and start again. (Found while re-running the browser suites after stopping servers the hard way.) |
| Things worth an alert | any `refresh_reuse`; many `login_blocked`; an `export` with a large `rows`; `step_up_failed` bursts; `prize_draw_winner_shown` outside a draw. |

### 15.3 Before the first real owner (security part of the go-live checklist)

HTTPS and `NEXTAUTH_URL`/`PUBLIC_WEB_URL` https · website reachable **only through the CDN** and `CLIENT_IP_HEADER` set · API on a private network with `INTERNAL_API_SECRET` · e-mail provider with a **verified sender domain (SPF, DKIM, DMARC: a domain
setting, not code)** and one real confirmation e-mail received · Turnstile keys · `ENCRYPTION_KEYS` and `BLIND_INDEX_KEY` set, **backed up apart from the database** · database backups with a tested restore (OPS-02) · one full run of `scripts/e2e-security.mjs` against the staging site · **`scripts/preflight.mts` run on the deployed site** (`npx tsx --env-file=.env scripts/preflight.mts --url https://<your site> --domain <sender domain> --mail-to <you>`: §19 says what it checks) · Node 22.12 or newer on the host · `npm run release:check` before every release.

## 16. What was verified, and what could not be

**Verified in this environment** (real Postgres, Redis, headless Chromium):
- **668 automated tests** (84 shared in 7 files, 505 API in 31 files, 22 website in 3 files, 57 script tests) and the backlog check, run together by `npm test`: sign-up and enumeration answers, constant response time, confirmation links (once, expired, foreign, hashed) and the password they ask for, purge, squatter replacement, aliases, password policy and hash upgrade,
  the three login counters and the CAPTCHA paths, sessions and refresh rotation (race, grace, reuse, revoke, expiry), JWT rotation, password reset/change, Google sign-in (stubbed JWKS: wrong audience/issuer/signature, unverified e-mail, linking, squatter), TOTP (RFC vectors, replay, recovery codes, disable),
  step-up (methods, window per session, limits), masking, reveal, export and bulk-delete controls, caps, the read caps, the Sheets re-confirmation, e-mails and audit rows, the rate limits per session and per address, key ring, rotation script (child process), blind index, parked payloads, production boot refusals, log hygiene,
  the append-only trigger, **every API route** against a second owner, the website proxy's rules, token renewal and cookie handling (14 tests), the post-sign-in redirect rule, the audit gate and the backlog checker.
- **A 20-step real-browser run** (`scripts/e2e-security.mjs`, API token set to 30 s so the website must renew it all the time): sign-up with a weak password refused, demo mailbox, unconfirmed account banner and gated call, same screen for a duplicate, link needs a click, wrong-password
  countdown, forgot/reset, two-step verification set-up with recovery codes that cannot be dismissed unsaved, sign-in with a code (wrong, right, replayed), recovery code, sessions list and remote sign-out, new recovery codes, disabling, password change, masked numbers and reveal, the
  "confirm it is you" dialog on a 60-row export, the activity log, the proxy refusing smuggled routes / oversized bodies / cross-site calls, no open redirect, sign out everywhere, **silent renewal across two token lifetimes**, and **zero Content-Security-Policy violations**.
  The other browser runs (`e2e-ui`, `-bot`, `-wallet`, `-payments`, `-currency`, `-responsive`, `-landscape`) use the new sign-up flow and pass. **All of them were run again on the final stack** (the Next.js 15.5.28 production build with zod 4, Prisma 7 and puppeteer 25, §18): security 19 of 19 (20 of 20 with 30-second API tokens, i.e. with the silent renewal running throughout; the last step, the Content-Security-Policy check, is what found the zod problem), UI 29, bot 14, wallet 13, payments 8, currency 6, responsive and landscape sweeps in demo mode (with the Simulator link), and a clean `npm ci --dry-run` from the lockfile.
- Several tests were **mutation-checked** (disabling the check makes them fail), among them the response-time floor, the cross-owner route guard, TOTP replay and the refresh reuse rule.

**What could not be verified against the real service ⚠️, after the pass of §19:** a real e-mail provider (acceptance, SPF, DKIM, DMARC), Cloudflare Turnstile and haveibeenpwned (their hosts are blocked in the build environment), a real CDN
(the behaviour behind a local TLS proxy that sets Cloudflare's headers *was* seen), macOS (the binaries were checked, nothing was run there; on the owner's Windows PC the argon2 hashing and the Windows path fix did run, 2026-10-31) and real phones. §19 says, item by item, what was done, what the result was and how you repeat it.

## 17. Decisions that are yours

**Decided and built since the first version of this list** (D-07 in [`BACKLOG.md`](BACKLOG.md)): the registrant's password on the confirmation page (SEC-19, §3.1) · a cap on paging through names and answers, and a fresh confirmation for Sheets auto-sync (SEC-20, §8) ·
the general rate limit per session instead of per address (SEC-18, §10.1).

**Still yours:**
1. Should an unconfirmed account be able to sign in at all, or only see "confirm your e-mail"? (Now it can browse; nothing that sends, pays, connects or exports works.)
2. Thresholds (§8) are judgement calls: 50 rows, 20 deletes, 20 downloads and 50,000 rows a day, 300 reveals a day, 1,000 and 20,000 different people a day, 15-minute confirmations, the Business plan must use an authenticator. Tune them with real use.
3. Mask names too (§12.3), once you know how owners really work?
4. RLS (§13): revisit before the admin console.
5. Whether CAPTCHA may be disabled in production (`CAPTCHA_DISABLED`): the product allows it, the review recommends against.
6. **The website framework** (§18): upgraded to Next.js 15.5.28 and React 19 on 2026-10-28, in its own commit so that it can be reverted. Yours to decide later: Next.js 16 (`next lint` is already deprecated; nothing in it is needed for security today).
7. The launch definition and PAY-13 (`BACKLOG.md` section F).

## 18. Dependencies and the website framework (found by `npm audit`)

`npm audit --omit=dev` was first run on 2026-10-28 and reported **22 advisories** in production dependencies (the build environment can reach the npm registry but not GitHub's advisory pages, so the **text** of an advisory was read through the registry's summaries
and a few news sources, not the primary pages). All of them were then dealt with, in separate commits that can be reverted one by one. **It now reports 0** (SEC-16, SEC-17).

| Step | What changed | What it fixed, and what it cost |
|---|---|---|
| nodemailer 7 → 10, csv-parse 5 → 7 | an `overrides` entry makes next-auth's optional copy of nodemailer follow | the first entries; the SMTP adapter was re-checked against a local SMTP server and the CSV import tests pass |
| **Next.js 14.2.35 → 15.5.28 with React 19** (SEC-16, below) | about 15 files | 25 advisories, 12 of them high or critical |
| **zod 3 → 4** (API, website, shared) | a nested `.default({})` became `.prefault({})` (zod 4 returns a default as given, without parsing it); `errorMap` became `error`. **zod 4 probes for `eval` (`new Function('')`) when it builds its first object schema; under the website's Content-Security-Policy (no `'unsafe-eval'`) the browser reports that as a violation although zod copes, which the browser run caught on `/register`, `/login` and `/check-email`.** Browsers now get zod's plain parser (`packages/shared/src/zod-setup.ts`, imported before the first schema is built); servers keep the fast one. The policy was not loosened | memory exhaustion when validating oversized collections (bounded anyway by the body caps) |
| **puppeteer 24 → 25** | needs **Node 22.12 or newer**: the root `engines`, the Dockerfile and `deploy/*` say so and `npm run share` checks it | the helpers that download Chromium (`extract-zip`, `proxy-agent`, `basic-ftp`, `get-uri`, `pac-proxy-agent`, `chromium-bidi`) |
| **Prisma 6 → 7** | the connection is a **driver adapter** (`@prisma/adapter-pg`, `apps/api/src/lib/prisma.ts`); the database address moved from the schema to `apps/api/prisma.config.ts`, which also loads the root `.env` (Prisma 7 no longer does); `prisma generate` runs after `db push` (the `--skip-generate` flag is gone); deploys run `npx prisma migrate deploy --config apps/api/prisma.config.ts` (Dockerfile, Fly and Railway files updated). **The Prisma command line refuses destructive commands (`db push --accept-data-loss`, `migrate reset`) when it detects an AI agent**: a person runs `npm run db:push` | the command-line configuration advisory (`deepmerge-ts`) |
| `overrides` for `postcss` (the copy bundled in Next), `uuid` (exceljs) and `basic-ftp` (puppeteer's helper) | root `package.json`; one hoisted copy of each (`npm ls`) | the last three advisories, which had no fixed parent. The Excel export tests pass on uuid 11 |

**Checks after the steps.** The typecheck, the unit and integration tests and the real-browser runs were repeated on the final stack. The first browser pass found one thing, in the zod step: zod 4's eval probe under the Content-Security-Policy (the zod row above), fixed in `packages/shared/src/zod-setup.ts` and covered by two tests. One test of the funnel (`explore.test.ts`) turned out to depend on a write that is deliberately off the payment's critical path; it now waits for it.

**The gate (SEC-17).** `npm run audit:gate` runs `npm audit --omit=dev` and fails on any **high or critical** advisory that is not written in `docs/audit-allowlist.json` with a reason and an **end date**. An exception past its date counts for nothing; a live exception for an
advisory that no longer appears is listed for removal; an entry without a reason is refused; moderate and low advisories are listed, not blocking. If the registry does not answer, it exits 2 and says so instead of passing. `npm run release:check` is the typecheck, the website's lint,
every test and the gate: run it before every release. The decision logic is unit-tested (`scripts/tests/audit-gate.test.mjs`, 13 tests) and the command was run against a deliberately vulnerable project (it fails, lists the advisories, accepts them only with a reason and a future date).
*Next step, not urgent:* `next lint` (the website's lint script) is deprecated and is removed in Next.js 16; Next.js 16 is current (16.4.3) and is yours to decide (§17).

**Next.js 14.2.35 to 15.5.28 (SEC-16; done 2026-10-28, its own commit: `git revert` undoes it).** Why: 14.2.35 was the last 14.x release and the registry lists **25 advisories** for it (3 critical, 9 high, 11 moderate, 2 low). The one that mattered most is
**CVE-2026-75604 (GHSA-p293-qw3h-jr36), CVSS 9.0, unauthenticated remote code execution on Windows-hosted servers**: backslashes in route segments were not consistently escaped before the incremental-cache path was built, so a request could write outside the cache directory. No workaround;
fixed in 15.5.24 and 16.3.3. It affected a Windows computer running `next start`, which is **exactly what `npm run share` does from a Windows PC with a public tunnel** (Linux, macOS and managed hosts such as Vercel were not affected). The others (denial of service in Server Components and Server Actions,
SSRF in Server Actions, rewrites and WebSocket upgrades, cache poisoning, a Pages Router i18n middleware bypass, XSS with `beforeInteractive` scripts and with CSP nonces, two image-optimizer remote code executions) mostly concern features this application does not use (no Server Actions, rewrites, Pages Router,
`next/script` or custom server; the middleware sets its own nonce and overwrites any client-supplied policy header; the image optimizer is switched off and `/_next/image` answers 404), but "denial of service through Server Components payloads" could have applied and had no mitigation.
The registry lists **none** for 15.5.28, the newest 15.5 release.
- **What changed in the code (about 15 files):** `cookies()`, `headers()` and the route `params` are promises in Next.js 15 and are now awaited (language and country helpers, the three dynamic pages, the API proxy route, the Google callback); React 19's types need an initial value for `useRef`. No behaviour was meant to change.
  The lockfile holds **one** copy of `next`, `react` and `react-dom` (a second, nested copy next to an old hoisted one would have given next-auth a different `next` than the application runs on): `npm ls` shows next-auth deduped onto 15.5.28.
- **How it was checked:** Next.js's own upgrade guide (nextjs.org is reachable with `curl`, not with the fetch tool) walked through against the application: asynchronous request APIs, the `useRef` initial value, nothing deprecated in the configuration; typecheck and lint; the production build; the proxy's path-smuggling probe gives the same answers as on 14
  (encoded slashes, `..`, backslashes, double encoding, trailing slash, too many pieces); every browser run listed in §16; a clean `npm ci` in a scratch folder. The fix itself: §19.
- **Still switched off:** the image optimizer (`images.unoptimized`; `/_next/image` answers 404 on the new build too). Next.js 15 lists `sharp` as an optional dependency; it is installed but never loaded.
- **`scripts/share-demo.mjs`** keeps refusing to start on Windows **when the installed Next.js is in the affected range** (13.4.0 up to 15.5.23, and 16.0.0 up to 16.3.2); override `--i-accept-the-risk`. With 15.5.28 installed it starts.

## 19. Verification log (2026-10-28): what was checked beyond the unit tests, and what could not be

The list of things "never exercised against the real service" was worked through as far as the build environment allows: Linux, outbound access to the npm registry, Google and a few other hosts, no credentials, no Windows, macOS or phone. **`scripts/preflight.mts` is the part of it you can repeat**:
it runs the production code against the real services, on the computer or host you point it at (`npx tsx --env-file=.env scripts/preflight.mts`; the header of the script lists the options). A WARN there is something that computer could not see: read it, it is not a pass.

| Item | Checked here, and how | Result | Still open |
|---|---|---|---|
| Google's real keys (SEC-05) | `preflight --only google`: the key set fetched from www.googleapis.com (2 RS256 keys); five forged ID tokens through the production verifier: signed by my own key under one of Google's real key ids, under a key id Google does not have, unsigned, HS256 "signed" with Google's public key, garbage | all five refused (bad signature, no matching key, algorithm not allowed, malformed) | Closed 2026-10-29: the owner signed in with a genuine Google account through their own OAuth client and it works (owner's report, not reproduced here). Look for `google_login` in the audit trail |
| argon2 (SEC-11) | `preflight --only argon2` with Python argon2-cffi (the reference C implementation): our hash verified by it; a hash it made with another set of parameters (3 passes, 64 MiB, 4 lanes) verified by us; non-ASCII passwords; wrong passwords refused; the cost measured (110 ms for one hash here) | interoperates in both directions | Windows done 2026-10-31 (owner's PC, win32-x64, Node 24.21.0: 26 ms per hash, verifies; the reference comparison was skipped there, no Python). Still never run on macOS. The lock carries every platform's binary of `@node-rs/argon2`, Next's SWC, esbuild, rollup, sharp and the resolver (win32-x64, win32-arm64, darwin-x64, darwin-arm64, linux); the Windows and macOS packages of argon2, Next and esbuild were downloaded: their integrity matches the lock and their headers read as PE (x64) and Mach-O (arm64, x86_64). Run `preflight --only argon2` on your own PC |
| The Next.js fix (SEC-16) | The registry lists 25 advisories for 14.2.35 and none for 15.5.28. The code of 15.5.23 and 15.5.24 was compared: the Windows fix is a backslash now escaped in route segments, and a guard that refuses an incremental-cache path outside its folder. `preflight --only next` runs the **installed** code under Windows path rules (`path.win32`) | 9 of 9 hostile cache lookups refused on 15.5.28; on 15.5.23 0 of 9 are, and the check fails there | Run on the owner's Windows PC 2026-10-31: 9 of 9 refused, a plain path resolves, a backslash is escaped (that code on that Node, not an attack on a running server). The advisory's own page could not be read (GitHub is blocked here): that this code change is the fix of GHSA-p293-qw3h-jr36 rests on the advisory's description in the registry's and news summaries, which matches it. Re-run the check after every Next.js upgrade |
| https, HSTS, cookies, the CDN header (SEC-07, SEC-13) | The production build behind a local TLS proxy (self-signed certificate) that sets Cloudflare's headers and overwrites what a visitor sends for them: `preflight --only headers`, then a sign-in in a browser | HSTS for two years; every cookie `__Host-` or `__Secure-` with Secure, HttpOnly, SameSite=Lax; a fresh CSP nonce on every page and `upgrade-insecure-requests`; sign-in works; the audit trail recorded the proxy's address and not the visitor-typed `6.6.6.6`. The same proxy in front of a site that does not know it is served over https is **detected** (cookie names without the prefix: FAIL) | Through a real Cloudflare edge (`npm run share`, owner's PC and phone, 2026-10-31): `preflight --only headers` 11 passed, 1 warning (plain http answered 200: switch on "Always Use HTTPS" on the real domain), 0 failed; the activity list showed the phone's own Cameroonian address prefix, not Cloudflare's. Still open: **sent straight to the origin, `cf-connecting-ip: 6.6.6.6` is believed**, so on the real host the origin must accept traffic only from the CDN (§10); the tunnel is outbound-only, so this half is not tested by it. The same check found that the two sign-out lines showed 127.0.0.1 and "unknown system" (and each sign-out was logged twice): fixed, `apps/web/tests/signout-address.test.ts`, and confirmed afterwards on the owner's phone through the tunnel (one "signed out" line carrying the phone's address) |
| haveibeenpwned and Cloudflare Turnstile | Both hosts are blocked here (the names do not resolve), so the production checks ran their **fail-open** path, and the script says so (WARN). Their PASS paths were exercised against built-in fakes that follow each service's documentation (`--fake-services`; a mistyped Turnstile secret is reported as a FAIL there): a self-test of the script, not of the services | not verified | `preflight --only breach,captcha` on your PC (no key needed; with your own `TURNSTILE_SECRET_KEY` it also shows that Cloudflare accepts it), and the widget in a browser on your domain |
| E-mail provider (SEC-01) | Not possible here: it needs your provider key and sending domain, and the provider hosts are blocked Update 2026-10-31: on the owner's PC the SMTP adapter delivered a real message through Gmail SMTP (`preflight --only mail --mail-to`): inbox, not spam; this shows the sending code works, not that your own domain's SPF, DKIM and DMARC pass. | not verified | `preflight --only mail --domain <yours> --mail-to <you>`: SPF, DKIM and DMARC of the domain and one real message through the production sender; then read the message's headers (dkim=pass, spf=pass, dmarc=pass) |
| The proxy's token renewal (the "stale cookie" fix of the review, which had no test) | `apps/web/tests/proxy-renewal.test.ts`: the proxy route against a scripted API, 14 tests; ten of its protections were disabled one at a time and each made at least one test fail | now under test | none |
| Chargeback terms (the PAY-13 pushback) | A web search (Flutterwave's and Notch Pay's own pages could not be opened here: what follows is what the search results quote, not your contract) | see `PAYMENTS.md`, "Chargebacks and the cash-out route" | Your providers' merchant agreements decide |
| Real phones, Meta, the payment providers | not possible here | not verified | OPS-04, WA-01 (`scripts/meta-check.mts`), PAY-03 and PAY-04 |
| PAY-02: whether the providers offer a balance API | left out of this pass at your request | not verified | |

### What this pass found in our own work

- **The strict Content-Security-Policy caught a defect that came with a dependency upgrade** (§18): zod 4 probes for `eval` when it builds its first schema, and the browser reported that as a policy violation on the sign-up, sign-in and check-your-mail pages although zod coped. Fixed by running zod in its plain mode in browsers (`packages/shared/src/zod-setup.ts`); the policy was not loosened.
- **The first version of that fix did not type-check.** The shared package is compiled without the browser library, so the name `window` is unknown there. Only `npm run typecheck`, run at the end, found it: it was red on the pushed branch until the fix (`globalThis.window`). The browser check was then repeated on a fresh production build: the security run 19 of 19, including "the Content-Security-Policy blocked nothing the product does", and the interface run 29 of 29. The gate to trust is `npm run release:check` (typecheck, lint, tests and the audit gate together), not any one of them.
- **Test flakes** are in `docs/DECISIONS.md` §4. None was a product bug; one (a deadlock between the test reset and a leftover best-effort write) could not be reproduced and is handled by a retry.

## 20. The owner's own data: download, erasure, retention (DAT-01)

Law No. 2024/017 (certified text in `docs/legal/`): erasure s.37 and s.38, a copy s.39, a structured machine-readable copy and portability s.43. Where it lives: `services/account-data.ts`, `routes/account-data.ts`, `guardAccountExport` in `services/security/data-guard.ts`, the read-only freeze in `plugins/auth.ts`, the hourly `jobs/retention.ts`. The screen: Settings → Your data.

**Download (`POST /api/account/export`).** One JSON file: profile, plan and payments, wallet ledger, surveys with questions, participants (name and number in clear, the file says to keep it safe), answers, gifts, the owner's own activity trail, their WhatsApp numbers. **Never** a password hash, token, authenticator secret or key; the survey part is an explicit list of fields, so a column added later is not exported until somebody decides it should be. Containment: built on the spot and sent to the browser that asked (nothing stored, no link to forward, `Cache-Control: no-store`); a confirmed e-mail address; "confirm it is you" **every time** (the authenticator code on plans that require it); at most `ACCOUNT_EXPORT_PER_DAY` (3) a day; written to the audit trail *before* the file exists (no record, no file); an e-mail to the owner each time. It is **not** held to the daily rows cap of §8, on purpose: that cap would lock out for good an owner whose list is bigger than it, and the law gives everybody a copy; the rows still count, so every other download that day meets the cap.

**Erasure (`POST /api/account/delete`).** The word `DELETE` and a fresh "confirm it is you". **Refused (409) while money is unresolved**: a wallet balance, a gift waiting to be paid, released or held by a payout limit (PAY-13), a payment still open or in review, so an erasure cannot swallow somebody's money or a payout in flight. When accepted: the date is fixed `ACCOUNT_DELETION_GRACE_DAYS` (30) ahead, active surveys are paused, **every other session ends**, an e-mail says when and how to cancel, and the account **only reads** (every change answers 423 `account_pending_deletion`; still possible: reading, downloading, cancelling, signing in and out). Cancelling needs no confirmation (it can only keep things as they are), lifts the freeze and leaves the surveys paused for the owner to resume. On the day the hourly retention job **checks again** for money (one that arrived in the grace period postpones the erasure a week and says so in the trail), then in one transaction copies the money records to `FinancialArchive`, deletes the account (every table cascades from `User`, plus the Sheets rows) and e-mails the owner that it is done.

**What stays, and why.** s.38(2) makes erasure "subject to the requirements for personal data retention". Kept for `FINANCIAL_RETENTION_YEARS` (10), then swept by the same job: payments, wallet movements and paid-out gifts as amount, currency, status, provider, purpose and date, under a **keyed pseudonym** of the account id (`keyedHash`, so it cannot be recomputed without the secret and is not the account id), with **no name, number, e-mail or participant**. The security audit trail keeps ids, counts and a coarse place until `AUDIT_RETENTION_DAYS`. **The 10 years is our default, not a legal statement: counsel confirms it.**

**What it does not do.**
1. s.38(2) says erasure is done *immediately* on request. The 30 days are a safety delay the backlog asked for; the account stops acting at once, but the data is erased later. Whether that delay is acceptable is counsel's call (`DECISIONS.md` §3.9); `ACCOUNT_DELETION_GRACE_DAYS` can be set down to 1.
2. **Backups.** Copies of the database in backups last until the backup is pruned (`BACKUP_KEEP_DAYS`, 30 by default, §21), and a restored backup brings back an account that was erased after it was taken: re-apply the erasures (`docs/BACKUP_RESTORE.md`).
3. **Participants' requests.** The owner is the one holding participants' data; a participant who writes to the owner is handled by the owner, by hand (no queue in the product yet; ADM-02).
4. **A hostile owner** can use the 30 days to get a paused account's data out by the download (3 a day, confirmed each time, e-mailed). That is the intended right.
5. **Large accounts.** The file is built in memory in one go: an account with millions of answers will be slow and heavy. Not measured.
6. **Not run in a real browser yet**: the screen is type-checked, linted and covered by the API tests, not driven by `e2e-*`.

*Tests:* `apps/api/tests/account-data.test.ts` (15): file content and what it must not contain, alert/trail/cap, not shut out by the rows cap, unconfirmed and signed-out refusals, step-up and `DELETE`, refusal for each kind of unresolved money, the freeze (and what stays possible), cancelling, the erasure and its cascade, the archive without any name, number or e-mail, the postponement.

## 21. Encrypted backups, the restore test and the disk (DAT-02)

Law No. 2024/017: "secure back-up copies" (s.27(1)), security measures "such as encryption" (s.22(2)). Runbook: `docs/BACKUP_RESTORE.md`. Code: `scripts/lib/sealed-file.mjs` (the encryption), `scripts/lib/backup.mjs`, `scripts/backup.mjs`, `scripts/restore-test.mts`, the `backup` check of `scripts/preflight.mts`. Tests: `scripts/tests/backup.test.mjs` (20; the 9 of the last block, which set up and tear down a scratch database, run a real `pg_dump` and `pg_restore`, and skip, saying why, where those are not installed).

**What is built.**
- **Sealed as written.** `pg_dump`'s output goes straight into AES-256-GCM in 1 MiB chunks; there is never a plain copy on disk (a test looks for a known value in the file and fails if it finds it). Each chunk is authenticated together with its number and a "last chunk" flag, so a changed byte, swapped or repeated chunks, a truncated copy and a trailing byte are all refused when the file is opened (mutation-checked: ignoring the authentication, or accepting a missing end, makes tests fail).
- **Complete or absent.** Written as `.partial`, renamed at the end; a failed dump (no `pg_dump`, no database) leaves nothing that looks like a backup. Mode 0600 on Linux and macOS.
- **A manifest** beside it: SHA-256 and the exact row count of every table, taken in the same exported snapshot as the dump so that the two agree. No credentials, no address.
- **A restore test** into a scratch database it creates and drops (and refuses any other name): the checksum, every table's rows against the manifest, and up to 50 participants decrypted with the application's own `ENCRYPTION_KEYS`. Run for real against the test database: it passes, and with different application keys it fails with the sentence "ENCRYPTION_KEYS cannot decrypt them".
- **A recovery command** (`backup.mjs --restore-into`): into a new, empty database only, refusing any database that has a table, comparing with the manifest.
- **Pruning** by age, never the newest three, only files of the exact name the tool writes.
- **The preflight** (`--only backup`): the key is set and is not an application key, the newest backup is under a day old and matches its checksum, a restore test passed within eight days (**a backup never restored is a FAIL**), the database connection is encrypted (TLS), and what you wrote about the disk. In production, "not set up" is a FAIL.

**What it does not do, and what was not verified.**
1. **The disk.** The encryption of the database's disk is a setting at the host. The code cannot change it and cannot see it; the preflight prints what you wrote in `HOST_DISK_ENCRYPTION` and says it checked nothing. Until you have read it in your provider's documentation, finding 11's disk half is open. I have not claimed that any provider encrypts by default: that is theirs to state.
2. **Tried only on a local PostgreSQL 16.** Not on a managed database, not on Windows, not on a large database (memory is constant; the time is not measured). The snapshot needs a direct connection, not a transaction pooler.
3. **The key.** Lost key: every backup is unreadable and nothing can be done. Stolen key together with a backup: the data is open. The key is for two places away from the server (§ "Read first" of the runbook).
4. **A restored backup brings back accounts erased after it** (§20); re-applying erasures is by hand.
5. **The restore test compares counts and decrypts participants**, not every value.
6. **One failure of the test suite right after a mutation run was not reproduced** (six further runs, all green, no scratch databases left); I cannot say what it was.


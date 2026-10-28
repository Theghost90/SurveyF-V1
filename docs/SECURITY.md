# SurveyFlow V1 — security: what is built, how it works, how to run it, what is not covered

This is the reference for the sign-in and data-protection work (the 15 findings of the registration-and-login review, minus findings 11 and 13, and the matrix
items SEC-01 to SEC-15). It says **what each protection does, where it lives, how it was tested, what it costs and what it does not stop**. Read §12 (what is
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
| 11 | Participant data is plain text in the database | **DAT-02 (not built)**; SEC-15 (built, §11) | see §11 | §11, §12 |
| 12 | Owner separation only in application code | SEC-12 | ✅ (test and guard, **not** Postgres RLS) | §13 |
| 13 | No account deletion or erasure; no security e-mails; no audit log | **DAT-01 (not built)**; the e-mails and the audit log are built (SEC-01/04/06/08) | partly | §9, §12 |
| 14 | Search terms in log URLs | SEC-14 | ✅ | §14 |
| 15 | Missing browser protections, aliases, 72-byte truncation | SEC-13, SEC-10, SEC-11 | ✅ | §3.2, §4.1, §10 |

Not built, on purpose: **finding 11** and **finding 13** as such (they are the matrix items DAT-02 and DAT-01: encrypted disks and backups depend on the hosting choice,
deletion and export need counsel's retention rules first); **Postgres row-level security** (§13 explains the choice); **any staff console or role system** (ADM-01 to ADM-06).

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
*What this does not protect:* **names and free-text answers** are visible in lists and can be paged through without a step-up (only numbers are masked); the prize-draw winner's number; and **Google Sheets auto-sync**, which keeps
pushing *new* rows after the one confirmed enabling (the enabling is counted, capped, confirmed and e-mailed; later rows are not).

## 9. Audit log and e-mails to the owner (SEC-08)

`AuditLog` records who did a security-relevant thing, when and from where: **ids, counts, a browser label and a coarse place (first three groups of the address), never a name, a number, a message or an answer**. It is
**append-only**: a database trigger refuses any UPDATE and any DELETE except from the retention job (`sf.audit_purge`), which removes rows older than `AUDIT_RETENTION_DAYS` (400). Written *before* the action for reveals and exports
(`auditStrict`: no record, no action); sign-in events use the lenient writer (the owner must still be able to sign in). Recorded: register, confirmation, sign-in and new device, blocked sign-ins, sign-out and revocations,
refresh reuse, password reset/change, step-up success and failure, two-factor changes, recovery codes (used, regenerated), Google sign-in and link, exports, bulk deletes, reveals, prize-draw winners.
The owner sees their own trail in **Settings → Security → Activity**. E-mails go out for: confirmation, "you already have an account", reset, password changed, new device, repeated failed sign-ins, export, bulk delete,
two-factor on/off, sign-out everywhere, Google link, and the step-up code. *Not recorded:* single-contact edits and deletes, survey changes, billing, anything done by staff (there is no staff console yet).

## 10. Trusted client address and browser protections (SEC-07, SEC-13; findings 8, 15)

- **Client address.** The API's `trustProxy` is **off**. The website's server works out the visitor's address (`CLIENT_IP_HEADER`, a single header your CDN sets such as `cf-connecting-ip`, **or** `TRUSTED_PROXY_HOPS`, the Nth address from the right of
  `x-forwarded-for`) and sends it as `x-sf-client-ip` **together with the shared secret**; the API believes that header only on a request that carries the secret. A stray `X-Forwarded-For` changes nothing. With neither variable set
  in production the website warns once: every visitor looks like one address, so the per-connection limits cannot tell them apart. **Deployment requirement: the website must be reachable only through the CDN** (firewall to its address ranges),
  otherwise a visitor who reaches the site directly can set the header themselves.
- **Content-Security-Policy** with a per-request nonce and `strict-dynamic` (middleware), `default-src 'self'`, third parties only Cloudflare Turnstile and the Meta SDK, `object-src 'none'`, `frame-ancestors 'self'`, `form-action` self and accounts.google.com,
  inline styles allowed (Radix and the charts need them; inline styles cannot run code). `CSP_MODE=enforce|report-only|off`. Also `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, a restrictive
  `Permissions-Policy`, and in production `Strict-Transport-Security: max-age=63072000; includeSubDomains` (no preload; **every sub-domain of the site's domain must then serve https for two years**: remove `includeSubDomains` in `next.config.mjs` if some do not). The browser run reports every violation: **zero** in the full security run (dev server) and in the production build (§15).
- **The proxy** (`/proxy/*`) refuses: any address piece that is not letters, digits, `.`, `-`, `_`, `~` (so a decoded `%2F`, `%3F`, `%23` or `..` cannot reach `auth/login`, `auth/refresh`, `auth/google`, sign-out, or a webhook — **found and fixed in this review,
  each one reached the API's sign-in route before**); calls another site caused (`Sec-Fetch-Site: cross-site`) and state-changing calls with a foreign `Origin`; bodies over 3 MB (read with a cap, whatever `Content-Length` says); and calls that hang (120 s; the refresh 15 s).
  The browser can reach only a short list without a session (`PUBLIC_PATHS`); everything else needs the cookie. API responses are `no-store`.
- **After sign-in the browser only goes to a path on this site** (`safeRelativePath`: one leading slash, then not another slash or a backslash, no control characters): `/\evil.example` is `//evil.example` to a browser and used to send the owner off-site after a real sign-in.

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
2. **Pre-hijacking through an e-mail the owner did not ask for.** If a stranger starts a sign-up with someone's address and that person *clicks the confirmation e-mail anyway*, the account becomes confirmed with the stranger's password. The e-mail says to ignore it if
   you did not sign up; the account is empty; "forgot password" by the real owner ends the stranger's sessions. A stricter option (ask for the password the registrant chose on the confirmation page) is **not built**: it adds a step for everybody. **Your decision.**
3. **Names and answers** in lists are not masked and not capped (§8). A stolen session can read them page by page.
4. **Google Sheets auto-sync** continues after its one confirmed enabling (§8).
5. **Staff and operators**: no console, no roles, no staff 2FA, no audit of staff actions; database access by the operator is unlogged. Matrix items ADM-01 to ADM-02 (Must for a public launch) cover this.
6. **Account deletion, data export, retention beyond the table in `LEGAL_FACTS_SHEET.md`** (DAT-01), **encrypted disks and backups** (DAT-02), a **breach-notification procedure**.
7. **Postgres row-level security**: owner separation is application code, guarded by a test over every route (§13). One forgotten filter in *new* code that the guard does not see would still leak.
8. **Denial of service** beyond the rate limits (no WAF, no per-tenant quotas on CPU-heavy PDF exports other than the per-minute and daily caps). The **global limit of 300 API requests a minute is per client address**: on a mobile network many owners share one public address (carrier-grade NAT), and a busy analytics page polls every 10 seconds, so a crowd behind one address could be throttled (HTTP 429) while nothing is wrong. It was seen in the browser tests, which all come from one address. Key it by session instead of by address once real traffic shows the need.
9. **Dependencies**: `npm audit` still reports 17 advisories (none critical, 14 high, 3 moderate) that are **not fixed**; none is reachable at run time as far as was checked (§18). **Secrets management** is the deployment's job (the application reads environment variables).

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
| `NEXTAUTH_SECRET`, `NEXTAUTH_URL` (website) | cookie encryption; https in production |
| `CSP_MODE`, `HIBP_CHECK`, `ARGON2_*`, `ACCESS_TOKEN_TTL_SECONDS`, `SESSION_TTL_HOURS`, `AUTH_MIN_RESPONSE_MS`, `SIGNUP_PER_IP_HOUR`, `EXPORT_*`, `STEP_UP_*`, `REVEAL_PER_DAY`, `REQUIRE_2FA_PLANS`, `AUDIT_RETENTION_DAYS`, `UNVERIFIED_PURGE_HOURS` | the tunable limits above |

Generate secrets with `openssl rand -base64 32` (use `-base64 48` for `JWT_SECRET`).

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
| Things worth an alert | any `refresh_reuse`; many `login_blocked`; an `export` with a large `rows`; `step_up_failed` bursts; `prize_draw_winner_shown` outside a draw. |

### 15.3 Before the first real owner (security part of the go-live checklist)

HTTPS and `NEXTAUTH_URL`/`PUBLIC_WEB_URL` https · website reachable **only through the CDN** and `CLIENT_IP_HEADER` set · API on a private network with `INTERNAL_API_SECRET` · e-mail provider with a **verified sender domain (SPF, DKIM, DMARC: a domain
setting, not code)** and one real confirmation e-mail received · Turnstile keys · `ENCRYPTION_KEYS` and `BLIND_INDEX_KEY` set, **backed up apart from the database** · database backups with a tested restore (OPS-02) · one full run of `scripts/e2e-security.mjs` against the staging site.

## 16. What was verified, and what could not be

**Verified in this environment** (real Postgres, Redis, headless Chromium):
- **505 automated tests** (69 shared in 4 files, 436 API in 24 files): sign-up and enumeration answers, constant response time, confirmation links (once, expired, foreign, hashed), purge, squatter replacement, aliases, password policy and hash upgrade, the three login counters and
  the CAPTCHA paths, sessions and refresh rotation (race, grace, reuse, revoke, expiry), JWT rotation, password reset/change, Google sign-in (stubbed JWKS: wrong audience/issuer/signature, unverified e-mail, linking, squatter), TOTP (RFC vectors, replay, recovery codes, disable),
  step-up (methods, window per session, limits), masking, reveal, export and bulk-delete controls, caps, e-mails and audit rows, key ring, rotation script (child process), blind index, parked payloads, production boot refusals, log hygiene, the append-only trigger, **every API route**
  against a second owner, the proxy rules and the post-sign-in redirect rule.
- **A 20-step real-browser run** (`scripts/e2e-security.mjs`, API token set to 30 s so the website must renew it all the time): sign-up with a weak password refused, demo mailbox, unconfirmed account banner and gated call, same screen for a duplicate, link needs a click, wrong-password
  countdown, forgot/reset, two-step verification set-up with recovery codes that cannot be dismissed unsaved, sign-in with a code (wrong, right, replayed), recovery code, sessions list and remote sign-out, new recovery codes, disabling, password change, masked numbers and reveal, the
  "confirm it is you" dialog on a 60-row export, the activity log, the proxy refusing smuggled routes / oversized bodies / cross-site calls, no open redirect, sign out everywhere, **silent renewal across two token lifetimes**, and **zero Content-Security-Policy violations**.
  The other browser runs (`e2e-ui`, `-bot`, `-wallet`, `-payments`, `-currency`, `-responsive`, `-landscape`) use the new sign-up flow and pass. **All of them were run again on the Next.js 15.5.28 production build** (§18): security 19 of 19 (20 of 20 with 30-second API tokens, i.e. with the silent renewal running throughout), UI 29, bot 14, wallet 13, payments 8, currency 6, responsive and landscape sweeps in demo mode (with the Simulator link), the UI run also against the development server (no framework warning in its log), and a clean `npm ci` from the new lockfile.
- Several tests were **mutation-checked** (disabling the check makes them fail), among them the response-time floor, the cross-owner route guard, TOTP replay and the refresh reuse rule.

**Written from documentation, never exercised against the real service ⚠️:**
- **E-mail, for real**: the SMTP adapter was exercised against a local SMTP server (sender, recipient, subject, text and HTML parts arrive well formed) and the Resend and Brevo adapters against a replaced `fetch` (address, credentials header, JSON body); **no real provider was ever contacted**, so acceptance of the messages, deliverability, SPF/DKIM/DMARC and the sender domain are untested.
- **Cloudflare Turnstile**: the widget under the Content-Security-Policy and the server-side `siteverify` (the script URL, frame and connect hosts follow Cloudflare's documentation).
- **haveibeenpwned** (stubbed) and **Google's JWKS and a real ID token** (stubbed).
- **A real CDN** header (`cf-connecting-ip`) and **https** (`__Secure-` cookies, HSTS, `upgrade-insecure-requests`): everything ran over http on localhost; the production build was run, not a TLS terminator.
- **`@node-rs/argon2` on Windows, macOS and musl Linux**: the lockfile lists every platform's binary, but it was run on Linux only.
- Real iPhone/Android browsers (the sweep is Chromium at those sizes).

## 17. Decisions that are yours

1. Pre-hijacking residual (§12.2): ask for the password on the confirmation page? (More friction for everybody; closes the last path.)
2. Should an unconfirmed account be able to sign in at all, or only see "confirm your e-mail"? (Now it can browse; nothing that sends, pays, connects or exports works.)
3. Thresholds (§8) are judgement calls: 50 rows, 20 deletes, 20 downloads and 50,000 rows a day, 300 reveals a day, 15-minute confirmations, Business plan must use an authenticator. Tune them with real use.
4. Names and answers unmasked (§12.3): mask names too, or cap paging, once you know how owners really work?
5. Sheets auto-sync (§8): require a fresh confirmation to turn it on at any size, and re-confirm periodically?
6. RLS (§13): revisit before the admin console.
7. Whether CAPTCHA may be disabled in production (`CAPTCHA_DISABLED`): the product allows it, the review recommends against.
8. The global rate limit per client address (§12.8): leave it, raise it, or key it by session.
9. **The website framework** (§18): upgraded to Next.js 15.5.28 and React 19 on 2026-10-28, in its own commit so that it can be reverted. Yours to decide later: Next.js 16 (`next lint` is already deprecated; nothing in it is needed for security today) and the majors listed in §18.

## 18. Dependencies and the website framework (found by `npm audit`)

`npm audit --omit=dev` was run on 2026-10-28 (the build environment can reach the npm registry; it cannot reach GitHub's advisory pages or nextjs.org, so the **text** of advisories was read through the registry's summaries and a few news
sources, not the primary pages). It first reported **22 advisories**. After the changes made here (nodemailer 7 to 10, with an `overrides` entry so that next-auth's optional copy follows it; csv-parse 5 to 7; non-breaking transitive updates; **Next.js 14.2.35 to 15.5.28 with React 19**)
**17 remain: 0 critical, 14 high, 3 moderate**. (The count did not move with the framework upgrade because the audit now lists `next` itself, as moderate, for the PostCSS copy it bundles: see the table.) The SMTP adapter was checked against a local SMTP server on the new nodemailer, and the CSV import tests pass on csv-parse 7 (`tests/mail-providers.test.ts`, `flow.test.ts`).

| Package | Severity | What the advisory is about | Is it reachable here? | What to do |
|---|---|---|---|---|
| next 15.5.28 (and `postcss` 8.4.31 bundled inside it) | moderate (next), high (postcss) | PostCSS: `</style>` left unescaped in what it prints; a `sourceMappingURL` comment in the CSS it reads can name a `.map` file to disclose | no: PostCSS runs at build time on our own stylesheets, never on a visitor's input | nothing in the 15.x line (its `postcss` is pinned); the registry lists **no advisory of its own** for `next` 15.5.28 |
| zod 3.25 | high | memory exhaustion when validating oversized constrained collections | bounded: every request body is capped (API 2 MB, website proxy 3 MB) | zod 4 is a major change in the API, website and shared package: planned, not urgent |
| puppeteer 24, with `extract-zip`, `proxy-agent`, `basic-ftp`, `get-uri`, `pac-proxy-agent`, `chromium-bidi` | high | archive extraction and FTP/PAC helpers used **while downloading Chromium**; `chromium-bidi` pulls zod | no at run time: the PDF export drives a local Chromium and its renderer blocks all network requests | puppeteer 25 at the next maintenance |
| prisma 6 via `@prisma/config`, `deepmerge-ts` | high | stack exhaustion when merging recursive objects in the Prisma **command-line** configuration | no: development and migration time only | Prisma 7 later |
| exceljs via uuid | moderate | `uuid` v3/v5/v6 with a caller-supplied buffer | no: exceljs does not use it that way (audit's suggested "fix" is a 2019 exceljs: not taken) | none |

**Next.js 14.2.35 to 15.5.28 (done 2026-10-28, its own commit: `git revert` undoes it).** Why: 14.2.35 was the last 14.x release and the registry listed **25 advisories** for it, 12 of them high or critical. The one that mattered most is
**CVE-2026-75604 (GHSA-p293-qw3h-jr36), CVSS 9.0, unauthenticated remote code execution on Windows-hosted servers**: backslashes in route segments were not consistently escaped before the incremental-cache path was built, so a request could write outside the cache directory. No workaround;
fixed in 15.5.24 and 16.3.3. It affected a Windows computer running `next start`, which is **exactly what `npm run share` does from a Windows PC with a public tunnel** (Linux, macOS and managed hosts such as Vercel were not affected). The others (denial of service in Server Components and Server Actions,
SSRF in Server Actions, rewrites and WebSocket upgrades, cache poisoning, a Pages Router i18n middleware bypass, XSS with `beforeInteractive` scripts and with CSP nonces, an image-optimizer remote code execution through AVIF files) mostly concern features this application does not use (no Server Actions, rewrites, Pages Router, `next/script` or custom server;
the middleware sets its own nonce and overwrites any client-supplied policy header), but "denial of service through Server Components payloads" could have applied and had no mitigation. The registry's advisory service lists **none** for 15.5.28.
- **What changed in the code (about 15 files):** `cookies()`, `headers()` and the route `params` are promises in Next.js 15 and are now awaited (language and country helpers, the three dynamic pages, the API proxy route, the Google callback); React 19's types need an initial value for `useRef`. No behaviour was meant to change.
  The lockfile was edited so that **one** copy of `next`, `react` and `react-dom` is installed (a second, nested copy next to an old hoisted one would have given next-auth a different `next` than the application runs on): `npm ls` shows next-auth deduped onto 15.5.28.
- **How it was checked:** typecheck and lint clean; production build; the proxy's path-smuggling probe gives the same answers as on 14 (encoded slashes, `..`, backslashes, double encoding, trailing slash, too many pieces); every browser run listed in §16; the 505 unit and integration tests; a clean `npm ci` in a scratch folder (one copy of `next`, `react` and `react-dom`); `npm audit` (0 critical).
- **Still switched off:** the image optimizer (`images.unoptimized`; `/_next/image` answers 404 on the new build too). Next.js 15 lists `sharp` as an optional dependency; it is installed but never loaded.
- **`scripts/share-demo.mjs`** keeps refusing to start on Windows **when the installed Next.js is in the affected range** (13.4.0 up to 15.5.23, and 16.0.0 up to 16.3.2); override `--i-accept-the-risk`. With 15.5.28 installed it starts.
- **Not checked:** the fix itself on a Windows host (this environment is Linux; I verified the version, not the behaviour), and Next.js's own upgrade guide (nextjs.org is not reachable from here: the migration relied on the compiler, the production build and the browser suites).

**Keeping it honest:** run `npm audit --omit=dev` on every release, expect only the entries in this table, and treat a new high or critical one as a release blocker unless it is added here with a reason. (`npm audit fix --omit=dev` also prunes development packages from `node_modules`: run `npm install` after it.)

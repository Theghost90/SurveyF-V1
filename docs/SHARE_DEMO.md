# Letting someone test SurveyFlow over the internet

**One command, from your own computer:** `npm run share`. It starts the app the way a server would, opens a public https address that points only at the website, and keeps everything simulated. The tester opens the address in any browser (phone or computer); you keep control and stop it with Ctrl+C.

## Which version is shared

The one **in your folder when you run the command**. Always run `git pull origin claude/happy-cray-zqvzf1` first so that it is the latest pushed version (the Git branch is the reference; your local copy is the same code as long as you have pulled and have no uncommitted edits: check with `git status`). Never share a copy you changed by hand and did not commit: nobody could reproduce what the tester saw.

## What you need (once)

1. Docker Desktop running (the database and cache), Node 22.12 or newer (`node -v`; Windows: `winget install OpenJS.NodeJS.LTS`), the repo installed (`npm ci`), a `.env` file (copy of `.env.example`).
2. **cloudflared**, the free tunnel tool (no account): `winget install --id Cloudflare.cloudflared`, then close and reopen the terminal.

## Each time

```
git pull origin claude/happy-cray-zqvzf1
npm ci
npm run share -- --seed
```

- First run: a few minutes (the app is built). Later runs with unchanged code: add `--skip-build`.
- `--seed` creates the demo account (sample surveys, contacts and results) with a **random password printed at the end**. Leave it out if the tester should start from a blank account. Seeding again resets the demo account.
- The command prints the **address for the tester** (`https://something.trycloudflare.com`). Send them that address and `docs/TESTER_GUIDE.md`.
- Keep the window open, the computer awake (Windows: Settings, Power, never sleep while plugged in) and connected. The address **changes every time** you start it.
- Stop: Ctrl+C. The address stops working at once. Technical log: `share-demo.log` in the repo folder.

Other options: `--no-docker` (Postgres/Redis already running), `--public-url=https://...` (use your own tunnel or server address), `--verbose` (show the server log).

## What is and is not exposed

| | |
|---|---|
| Exposed to anyone who has the address | The website (home, sign-up, dashboard). Anyone with the address can create an account. |
| Not exposed | The API (private, on your computer, answers only the website), the database, your files. |
| Simulated, whatever your `.env` contains | WhatsApp (nothing is sent to a real number), payments (a demo checkout page, no money), gifts, **e-mail** (the confirmation and password-reset messages are shown on the page; nothing is sent to anybody), the Meta, payment-provider and e-mail keys (ignored). |

**Windows.** Next.js 14.2.35 had a **critical flaw that let anybody who could reach the site run programs on a Windows computer, with no login** (CVE-2026-75604; fixed in Next.js 15.5.24 and later; Linux, macOS and managed hosts were not affected, and there was no workaround). A shared test site is exactly that situation. This project now runs **Next.js 15.5.28**, so sharing from Windows is allowed again, but `npm run share` still **refuses to start on Windows if the installed Next.js is in the affected range** (for example after checking out an older version, or after a package change): then upgrade, or run it from WSL2 or a Linux machine, or, for a few minutes with people you trust, add `--i-accept-the-risk`
(`docs/SECURITY.md` §18). If you shared from this Windows computer **before** this upgrade, stop sharing, close the terminal, and treat the computer as exposed: the flaw let an attacker write files outside the cache folder, so a computer that was reachable should be checked before it is trusted again.

**Is it safe for my computer?** Reasonably, if you follow these rules, but not risk-free. `cloudflared` only makes an outbound connection (no router setting, no open port, no firewall rule), and only the website is reachable. The real risk is a flaw in the website itself: if someone found one, they would be running code as *you* on your computer. So: run it from a **normal (non-administrator) terminal**, only while a test is going on, **not on public or shared Wi-Fi**, with Windows, Docker Desktop and Node up to date, and stop it afterwards. Postgres and Redis listen on this computer only (`docker-compose.yml`); run `docker compose up -d` once after pulling so that they are recreated that way. A hosted test site (see the end) isolates all of this from your personal computer.

Rules of thumb: the address is long and random, but treat it like a password: send it only to the tester. Tell the tester **not to enter real personal data** (a notice says so on every page). Do not leave it running unattended. Sign-up now asks for a confirmed address, but in a shared test the confirmation message is **shown on the page** and **anyone who knows an address can read its test mailbox**: tell testers to use made-up addresses (the guide does). There is no CAPTCHA in a shared test, and the encryption keys are the development ones (they are in the repository), so this instance must hold test data only. That is acceptable for a short, private, simulated test and is **not** acceptable for a public launch (`docs/SECURITY.md` §15.3).

## What the tester can and cannot judge

Can: the whole product flow, the screens on phone and computer, French and English, the wording, the plan and price display (prices follow the tester's country: a visitor in Nigeria or Kenya sees local prices, using a live exchange-rate source), the WhatsApp experience through the **Simulator** (it plays the participant's phone and the owner's analytics bot).

Cannot: anything involving the real WhatsApp, a real phone, a real payment provider or Google Sheets (not configured here). Those are the next stage (see `docs/META_CHECK.md`).

## If something goes wrong

| Message or symptom | What to do |
|---|---|
| "Something is already running on port 4222/4223" | Close the window where `npm run dev` runs (Ctrl+C), run again. |
| "cloudflared is not installed" | `winget install --id Cloudflare.cloudflared`, reopen the terminal. |
| Docker error | Start Docker Desktop, wait until it says running, run again. |
| The address does not open for the tester | Wait a minute and retry; check the computer is awake and online; restart the command (new address). |
| The tester sees an error page | Look at `share-demo.log`, send it to me with the time. |
| Reset everything | Ctrl+C, then `docker compose down -v` (deletes ALL local data), then run again. |

## Not verified here

I could test everything except the real tunnel tool: this was checked on Linux with a local forwarder standing in for the public address (the production build, the sign-up with its confirmation step, the browser steps, the private API and the secret gate). The visitor's address is read from Cloudflare's `cf-connecting-ip` header (`CLIENT_IP_HEADER`); that header was never seen from a real tunnel, so if every sign-in limit seems shared between testers, that is the first place to look. The first real run on Windows with cloudflared may need a small fix: send me the output if it stops.

## Later: a permanent test site

This is the quickest way, and it depends on your computer. A permanent site (a small hosted server with its own address) is the right next step once the real WhatsApp check is done, and needs accounts only you can create. The repository has deployment templates (`apps/api/Dockerfile`, `deploy/`) that have **not** been run yet.

## Cheat sheet: starting again, and after a change

Always stop what is running first (Ctrl+C in its window). `npm run dev` and `npm run share` use the same ports: never run both at once.

| I want to... | Command (Git Bash, repo folder) |
|---|---|
| Use it **only on my computer** (fast, refreshes by itself) | `docker compose up -d` then `npm run dev`, open http://localhost:4222 |
| **Share it** again, code unchanged since the last build | `npm run share -- --skip-build` |
| Share it with a **fresh demo account** (new random password) | `npm run share -- --skip-build --seed` |
| Share it after **any code change** (rebuilds first) | `npm run share` |

| Kind of change | Local (`npm run dev`) | Shared (`npm run share`) |
|---|---|---|
| **Minor**: wording, colours, layout, one screen | Save the file, refresh the browser. Nothing else. | Stop, then `npm run share` (it rebuilds; a few minutes). |
| **Major**: API logic, a new package, anything shared by several screens | `git diff --name-only ORIG_HEAD HEAD` after a pull: if `package.json` or `package-lock.json` is listed, stop everything and run `npm ci`. Then `npm test`, restart `npm run dev`. | Same checks, then `npm run share`. |
| **Critical**: the database (`prisma/schema.prisma`), payments, sign-in, secrets or `.env` | **First a backup:** `docker compose exec -T postgres pg_dump -U surveyflow surveyflow > backup.sql`. Then `npm ci` if packages changed, `npm run db:push` (never accept a "data loss" warning without asking), `npm test`, `npm run typecheck`, restart. | Same, then `npm run share` (it runs `db:push` itself). Try the app yourself before sending the address. |

After pulling from me: `git pull origin claude/happy-cray-zqvzf1`, then `git diff --name-only ORIG_HEAD HEAD` shows what changed: `package*.json` means `npm ci`; `schema.prisma` means treat it as critical; otherwise it is minor or major as above.

`docker compose down -v` erases ALL local data (accounts, surveys): use it only to start from zero.

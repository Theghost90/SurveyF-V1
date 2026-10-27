# SurveyFlow Design Specification

Scanned from the implemented web app (`apps/web`: Next.js 14, Tailwind 3, Radix primitives, shadcn-style components). Values are quoted from `tailwind.config.ts`, `globals.css` and `components/ui/*`. Where something is a convention seen across screens rather than a coded token, it says so.

## 1. Principles
- **Calm, trustworthy, WhatsApp-adjacent.** Deep green ink on a pale green-grey canvas, one bright green for the primary positive action, amber for caution.
- **Low effort for the owner.** One clear next step per screen; empty states say what to do and link to it.
- **Never alarm about money.** A pending or under-review payment is never styled or worded as a failure.
- **Mobile first, from 320 px.** No horizontal page scroll anywhere.
- **Bilingual.** Every string exists in French and English; layouts must tolerate French being about 20 percent longer.

## 2. Colour tokens

### Brand palette
| Token | Hex | Use |
|---|---|---|
| `ink` | `#0B2B22` | Text, primary buttons, dark surfaces, phone frame |
| `ink-2` / `ink-3` / `ink-line` | `#12392E` / `#1B3F33` / `#2E5547` | Button hover, dark variants, lines on dark |
| `canvas` | `#F4F6F1` | Page background |
| `mint` / `mint-2` | `#DDEFE3` / `#9FD9B4` | Soft green fills, ghost hover, default badge background |
| `brand` | `#2BD46E` | Primary positive action, active status, avatar |
| `brand-2` / `-3` / `-4` | `#25C064` / `#7BE0A0` / `#4CC584` | Hover, chart fills |
| `leaf` | `#0F7A40` | Links, icons, headings accent, default badge text |
| `amber` | `#E9A23B` | Highlights, rating charts, "Explore" badge |
| `amber-soft` / `amber-ink` | `#FFF4E0` / `#6B4A10` | Warning surfaces and their text |
| `line` | `#DCE4DE` (`line-2` `#C9D3CC`, `line-3` `#E3E9E5`) | Borders, dividers, input borders |
| `body` | `#3F534A` | Secondary body text |
| `muted` / `muted-foreground` | `#E9EEEA` / `#4A5D55` | Neutral badges, helper text |
| `destructive` | `hsl(0 72% 40%)` | Errors, delete |
| Danger badge | `bg-red-100 text-red-800` | Failed states |

### WhatsApp mock palette (preview and simulator only)
`wa.header #0F5E3A` (chat header), `wa.bg #ECE5DA` (chat wallpaper), `wa.out #D3F5DD` (outgoing bubble), incoming bubble white, interactive button text `#0a7cc4`, phone bezel `ink`.

### Semantic variables (shadcn mapping, HSL)
`--background 75 20% 95%` · `--foreground 160 61% 11%` · `--card/popover white` · `--primary` = ink · `--secondary` = canvas · `--accent` = mint · `--border 140 12% 87%` · `--input 140 12% 79%` · `--ring 150 80% 38%` · `--radius 0.75rem`.

### Chart colours
Bars use, in order: `#0F7A40, #2BD46E, #E9A23B, #4CC584, #0B2B22, #9FD9B4, #6B4A10, #7BE0A0, #12392E, #C9D3CC`. Rating charts use amber `#E9A23B`; funnel bars use `leaf`; gridlines `#E3E9E5`; labels `#0B2B22` 12 px bold.

### Status colour mapping
| State | Badge |
|---|---|
| Survey draft / neutral | `neutral` |
| Survey active | `brand` |
| Survey paused / warnings / pending | `warn` (amber-soft) |
| Survey closed | `dark` |
| Participant completed | `brand`; abandoned `warn`; others `neutral` |
| Plan badge | Explore `amber`, paid `default` |
| Failure | `danger` |

## 3. Typography
- **Display:** Bricolage Grotesque (variable, optical size). Used for h1 to h3, card titles, large numbers.
- **UI and body:** Figtree (variable). Body default `ss01` stylistic set, antialiased.
- Both loaded from `@fontsource-variable` packages (self-hosted); fallback `system-ui, sans-serif`.

| Role | Style |
|---|---|
| Page title (h1) | `clamp(26px, 3vw, 38px)`, weight 800, tracking `-0.03em`, leading tight; onboarding `clamp(28px, 3.4vw, 42px)` |
| Section title (h2) | 24 px (`text-2xl`), weight 800, tracking `-0.02em` |
| Card title | Display, 20 px (`text-xl`), bold, tracking tight; compact cards 18 px |
| Metric number | Display 34 px, weight 800, tabular numbers |
| Body | 15 px inputs and buttons; 14 px (`text-sm`) secondary; 12 px (`text-xs`) hints and badges |
| Preview bubbles | 13 px, line height 1.4 |
| Numbers in tables and lists | `tabular-nums` |

## 4. Space, radius, elevation, motion
- **Layout container:** content max width 1344 px, centred; horizontal padding 20 px (`px-5`), 32 px from `sm` (`sm:px-8`); main top padding 32 px, bottom 80 px.
- **Grid gaps:** 12 px (metric tiles), 16 to 24 px (cards), 24 px between page sections.
- **Radius:** inputs, buttons, selects `rounded-xl` (12 px); large buttons 14 px; cards `rounded-3xl` (24 px); badges and chips full pill; phone frame 34 px outer, 26 px screen; chat bubbles 12 px with a 4 px tail corner.
- **Shadows:** `card` `0 20px 50px -30px rgba(11,43,34,.35)`; `float` `0 18px 40px -16px rgba(11,43,34,.35)`; `phone` `0 30px 60px -20px rgba(11,43,34,.45)`.
- **Motion:** `fade-up` 0.25 s ease-out (6 px rise); colour transitions on buttons; `prefers-reduced-motion` collapses all animation to about 0 ms. Progress dot pulses while data refreshes.
- **Focus:** `:focus-visible` = 2 px ring (`--ring`) with 2 px offset on the page background.
- **Dark mode:** `darkMode: 'class'` is configured but **no dark theme is defined**. Treat the product as light-only.

## 5. Layout and navigation
- **Public site menu bar** (`components/marketing/header.tsx`, `mobile-menu.tsx`): sticky at the top at every width and in both orientations (`sticky top-0 z-40`, canvas at 95 percent with a blur and a bottom `line` border); in-page anchors stop below it (`scroll-padding-top: 5rem`). It is one row, in English and in French, at every width from 280 px up; the items are added as room appears (tiers, each tested in both languages):
  - **Below 640 px:** logo, language switch, a short "Explore free" button ("Explorer" in French) and a 44 px hamburger that opens a side menu from the right (86 percent of the width, at most 340 px, full height, overlay behind it) with the four links, Sign in, a full-width "Explore free" button and the Privacy and Terms links; it closes on a link, the X button, the overlay or Escape. The wordmark is shown from 480 to 639 px and hidden below 480 px (the mark stays); below 360 px the switch and the button use tighter padding; below 300 px (a folded phone) the mark, the hamburger and the gaps shrink once more (`max-[299px]:`).
  - **640 px and up:** logo mark, three text links (How it works, Gifts, Pricing), language switch, Sign in and the short "Explore free" button.
  - **800 px:** the wordmark appears. **1024 px (`lg`):** the fourth link, "For agencies & NGOs", appears. **1280 px (`xl`):** the full call to action label (French "Explorer gratuitement" instead of "Explorer"; the English label is "Explore free" at every width) and roomier gaps and text.
  - The signed-in variant shows "Dashboard" instead of Sign in and "Explore free".
- **App shell** (`components/app-shell.tsx`): sticky white header, one row at every width, tiers from 640 px: logo mark, main nav (Dashboard, Surveys, Contacts, and Simulator where it exists; `text-sm`, `px-2.5`), language toggle and an account button showing the initial only. **800 px:** the wordmark. **1024 px (`lg`):** the plan badge and the wallet badge (when gifts are available). **1280 px (`xl`):** the business name and a chevron next to the initial. **Settings is not in the main nav**: Billing and Settings are reachable only from the account menu (items 44 px high; below 1024 px the menu also carries the plan badge on the Billing row and the gift wallet balance, below 1280 px the business name as a label). The account button gets a dark border while Settings or Billing is open.
- **Nav on phones (below 640 px):** a fixed bottom tab bar with Home, Surveys, Contacts and, where it exists, Simulator (three or four tabs, 48 px high; the current tab has a mint pill behind its icon). There is no "More" sheet: Billing, Settings and Sign out are in the account menu at the top, as on larger screens, and Analytics on WhatsApp is a tab of Settings. The header keeps logo, language toggle and a 44 px account button on one row. The tab bar is hidden during onboarding and from 640 px.
- **Short screens (height 480 px or less, which is any phone turned sideways)** use the `short:` variant (see Breakpoints). The aim is to leave most of the screen to the page: the two bars that stay on screen may use at most 40 percent of the height.
  - Both top bars get slimmer (`py-1`, logo mark 32 px, header buttons 36 px); the hamburger and the account button drop from 44 to 40 px, and the side-menu page links from 52 to 44 px.
  - The phone tab bar becomes a thin horizontal bar (icon and label side by side, 40 px) instead of the 48 px stacked one; the page keeps its bottom padding for it (`short:pb-20`) and uses less top padding (`short:pt-4`).
  - The account menu and the side menu never leave the screen: the dropdown is capped to the room Radix reports (`max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto`), its rows drop to 36 px, and in the side menu the list of links scrolls inside itself while the close button (top) and the call to action with the Privacy and Terms links (bottom) stay pinned and reachable.
  - Nothing that is sticky may be taller than the screen: the builder's phone preview is `lg:sticky lg:top-24` with `lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto`, so a tall preview scrolls inside itself on a landscape tablet or laptop instead of being cut off.
- **Banners** under the header: info (mint) for Explore usage, warn (amber) for renewal, danger (red) for suspension; each has one action button on the right.
- **Page header:** title, optional one-line subtitle, actions on the right (wraps below on phones).
- **Breakpoints:** Tailwind defaults (`sm` 640, `md` 768, `lg` 1024, `xl` 1280) plus the arbitrary thresholds `min-[360px]`, `min-[480px]`, `min-[800px]` and `max-[299px]` in the two menu bars. **`short:`** is a custom variant for screens at most 480 px high, added as a plugin in `tailwind.config.ts` (`addVariant('short', '@media (max-height: 480px)')`). **Do not declare it under `theme.extend.screens`**: a raw screen there silently disables every `max-*` variant in Tailwind 3.4 (including `max-sm:` and `max-[299px]:`), and the menu bars stop fitting at 280 px without any error. After editing `tailwind.config.ts`, delete `apps/web/.next` and restart the dev server (the dev CSS is cached). Verified sizes: every width from 280 to 1440 px for the menu bars, and the 30 device orientations listed in section 11.
- **Rule:** tables live inside a `relative overflow-x-auto` wrapper (an absolutely positioned screen-reader-only element inside a table once leaked a page-wide scrollbar). Grid children use `min-w-0`.

## 6. Components

### Button (`cva`)
Base: inline-flex, gap 8 px, `rounded-xl`, weight 600, disabled 50 percent opacity, loading spinner left.
| Variant | Look |
|---|---|
| `default` | ink background, white text, hover `ink-2` |
| `brand` | brand green background, ink text, hover `brand-2` (the single positive call to action on a screen) |
| `outline` | white, `line-2` border, hover canvas |
| `ghost` | transparent, hover mint at 60 percent |
| `destructive` | destructive red |
| `link` | leaf text, underline on hover |
| `dark` | `ink-2`, for use on banners |
| Sizes | `sm` 36 px high, `default` 44 px, `lg` 56 px (17 px text, 14 px radius), `icon` 40 px square |

### Badge
Pill, 12 px bold, padding 10 x 4 px. Variants: default (mint/leaf), neutral, dark, amber, warn, danger, brand, outline.

### Card
White, `line` border, `rounded-3xl`, `card` shadow. Header padding 24 px (bottom 12), content 24 px (top 12). Title uses display font.

### Inputs
Height 44 px, `rounded-xl`, white, `input` border, 15 px text; textarea min height 88 px. `aria-invalid=true` switches the border to destructive. **Field** wrapper: label (14 px semibold), control, hint (12 px muted) or error (12 px destructive, `role="alert"`).

### Select, Checkbox, Radio group, Switch, Tabs, Dialog, Dropdown menu, Progress, Skeleton, Toast
Radix primitives restyled to the same tokens. Tabs list is a white pill container (`rounded-2xl`, `line` border) with the active tab filled ink. Radio options in the builder are bordered cards that fill mint when selected. Dialogs show a close label and trap focus. Toasts via Sonner (success, error, warning). Skeletons stand in for loading content and are replaced by an error card with a Retry button on failure.

### Table
Header row on canvas background, 12 px uppercase tracking-wider muted text; rows separated by `line`, hover canvas at 60 percent; cell padding 16 x 12 px; minimum width 560 px inside a scroll wrapper.

### Metric tile
Bordered white card with a 34 px display number and a 14 px semibold muted label; the "brand" tone (completion rate) inverts to an ink background with a pale-green label.

### Callouts and notes
Warning: amber-soft background, amber-ink text, rounded, with an alert icon. Information: mint at about 50 percent. Success: mint with a check icon.

## 7. Patterns

### Onboarding (two steps)
Two-column stepper at the top (numbered chips, active step ink), a card with the step body, a footer with Back and Next. Segment choice is three selectable cards (icon, title, one line). Connect step: one primary connection button, a "connected" confirmation card, and a text link "I will do this later".

### Builder
Left: question cards (numbered, drag handle, type select, required switch, option inputs with character counters, inline errors). Right: sticky "Preview on WhatsApp" phone with step chips (Invitation, Q1..Qn, Thank-you) and, above it, a two-tab switch (Participant's phone / Your analytics on WhatsApp). Locked surveys show a notice banner.

### Analytics
Metric tiles in an auto-fit grid (min 170 px), a footnote that shows the arithmetic, funnel bars, an amber drop-off note with advice, results cards (question title followed by its type in parentheses, muted 14 px), paged list with a CSV button.

### Analytics Bot (the owner's numbers on WhatsApp)
- **Settings → "Analytics on WhatsApp"** tab: the owner proves a phone with a one-time code to send as `LINK <code>` (valid 15 minutes, up to 3 phones, each can be removed), with an alerts switch on each linked phone (alerts can also be muted by typing `MUTE` to the bot). On Explore the tab shows a locked note ("Included in Starter, Growth and Business…") with two buttons: "See how it looks" (the Owner simulator) and "Activate" (Billing).
- **Builder preview** has a Participant / Owner switch: Owner shows the bot's replies with example numbers; the **Simulator** has the same switch and answers for real on a paid plan. Replies use the same phone mock as the participant side (section 7, WhatsApp simulation).
- Names appear with **masked numbers** in every bot reply; complete numbers live only in the web app ("haven't started" list and its CSV). The numbers in a reply always equal the Analytics page's.

### Money and payment states
Pending: "Still waiting for the provider", with the reference and "do not pay again". Review: calm wording, never "failed". Wallet: balance in a display number, limits, history list. Prices always show as "amount label" (for example `14,500 FCFA`), annual price under the monthly one.

### Empty, loading, error
Empty: centred card with a title, one sentence, one button. Loading: skeletons of the final shape. Error: card with the message and Retry.

### WhatsApp simulation (preview, simulator)
Dark bezel phone (max width 330 to 360 px), green header with avatar and name, wallpaper `wa.bg`, incoming bubbles white on the left, outgoing `wa.out` on the right, interactive options as white rounded buttons with blue text, list rows in a white sheet. WhatsApp markup (`*bold*`, `_italic_`) is rendered as React nodes, never raw HTML.

## 8. Iconography and imagery
`lucide-react`, 16 px in buttons and rows, 20 to 24 px in cards, always `aria-hidden` when next to text. Logo: speech-bubble mark with three bars, plus the word "SurveyFlow" in display weight. No photography; illustration is limited to the phone mock and charts.

## 9. Content and voice
- Plain, warm, short sentences; no jargon (no "WABA", "webhook" in the UI).
- Say what happens next ("Sending opens when the invitation template is approved").
- Money: never blame; never use "failed" for pending or review states.
- Numbers: thousands separator comma in English, space in French; two decimals only below 10.
- Dates and times in the owner's local time; "as of HH:MM" on live numbers.
- Exact names: **Explore** (free tier), **Activate** (choose a paid plan), **Analytics on WhatsApp**.

## 10. Accessibility
- WCAG AA contrast on the palette (ink on canvas and white; ink on brand green). Amber-ink on amber-soft for warnings. Do not put white text on `brand`.
- Visible focus ring everywhere; every icon button, switch, tab and radio has an accessible name; status and error regions use `role="status"` / `role="alert"`; live chat regions are `aria-live="polite"`.
- Keyboard: drag-and-drop reordering has a keyboard path (focus handle, Space, arrows, Space); dialogs trap and restore focus.
- Targets: 48 px tab bar, 44 px hamburger, account button and account-menu rows, 44 px primary buttons, at least 32 px for chips and small controls. On short (landscape phone) screens the bars trade height for page room: tab bar 40 px, hamburger and account button 40 px, public header buttons 36 px, account-menu rows 36 px, side-menu page links 44 px (52 px otherwise).
- Meaning never by colour alone (badges carry text).

## 11. Responsive rules
- **Support floor:** 320 px wide (the WCAG reflow width) is the guaranteed minimum for every screen. 280 px (a folded phone, 653 by 280 in landscape) is also covered: the sweep below passes on all 14 app screens, the six public screens and both menu bars at 280 px in English and in French.
- No horizontal page scroll and no element outside the viewport (unless inside its own scroll wrapper), in portrait **and landscape**.
- The menu bar of both the public site and the app stays at the top while scrolling, at every width and orientation, and never wraps to a second row (tiers in section 5). Both language versions must fit: French labels are longer, so every tier is tested in French too.
- **Landscape and short screens:** see section 5 ("Short screens"). Limits checked by the sweep: a menu bar is at most 56 px high when the screen is 480 px high or less (84 px otherwise); the bars that stay on screen (top bar plus tab bar) take at most 40 percent of a short screen; nothing sticky is taller than the screen; the side menu's call to action and close button, and the account menu (Sign out included, from 320 px of height), are inside the screen without scrolling the page.
- Grids that become two columns at a breakpoint declare `grid-cols-1` below it (a bare `grid` lets a long unbreakable item widen the column past the screen). Auto-fit grids use `repeat(auto-fit, minmax(min(Npx, 100%), 1fr))`: a bare `minmax(Npx, 1fr)` overflows on screens narrower than N.
- Rows that hold a pagination or a title with controls wrap (`flex flex-wrap items-center justify-between gap-2`); a button with a long label (French) may wrap its text (`whitespace-normal`) instead of leaving the card (the export download buttons).
- Rows that mix a long title with metadata stack on phones (title on its own line, details below).
- Below 640 px the surveys list is a list of cards (status, title, date, sent, completed, completion); the table returns from 640 px.
- Dialogs and the phone preview scale down; preview max width 330 px.
- **How it is tested** (`scripts/e2e-landscape.mjs`, run it after any change to a bar, the tailwind config or a page layout; `scripts/e2e-responsive.mjs` covers the page-width checks). English and French, logged in as the seeded demo owner:
  - Menu bars: 146 widths from 280 to 1440 px, public and app (app from 320 px): items inside the screen, not overlapping, on one row, height within the limit above.
  - 30 device orientations, portrait and landscape: iPhone SE, 8 Plus, 12 mini, 14, 14 Pro Max, Galaxy S8+, Pixel 7, a small 320 px Android, Galaxy Fold folded (280 px), iPad mini, iPad Air, iPad Pro 12.9, laptops 1366 and 1280, a 1920 desktop. On each: the six public screens and 14 app screens (dashboard, surveys, new survey, contacts, four Settings tabs, billing, simulator in two modes, and the survey, its analytics and its export) for sideways scroll, sticky parts and, while scrolled, that the bar stays at the top; the side menu and the account menu are opened and must fit the screen.

## 12. Known gaps
- No dark theme, though the config enables the class strategy.
- No documented spacing scale beyond Tailwind defaults; no icon size tokens.
- Tokens are defined in `tailwind.config.ts` and `globals.css` only; there is no design-token export (JSON) or Storybook.

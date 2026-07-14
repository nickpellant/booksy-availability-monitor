# Booksy Availability Monitor — Dale @ Hinces Barber

Polls Dale's Booksy calendar and sends a **Telegram** alert when the earliest
available slot for a service is **on/before a target date** — so you can grab a
cancellation before someone else does.

Booking stays manual. This only detects and notifies.

## How it works

`monitor.js` drives the real Booksy booking flow with headless Chromium
(Playwright): open the business page → pick Dale → click **Book** on the service
→ read the earliest available date from the calendar. If that date is on/before
`TARGET_DATE` and is new or earlier than the last alert, it pushes a Telegram
message. Runs every ~15 min on GitHub Actions. Dedupe state (`state.json`) is
persisted between runs via the Actions **cache** — not committed to git — so
there are no push/merge conflicts. A rare cache miss costs at most one duplicate
alert. Locally, `state.json` is just a file the script reads/writes.

## One-time setup

### 1. Create a Telegram bot
1. In Telegram, message **@BotFather** → `/newbot` → follow prompts → copy the
   **bot token**.
2. Message your new bot once (say "hi") so it can message you back.
3. Get your **chat id**: message **@userinfobot**, or open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` and read `chat.id`.

### 2. Push this repo to GitHub (public)
Public repo → unlimited free Actions minutes. No secrets live in the code.

### 3. Add repo secrets & variables
**Settings → Secrets and variables → Actions**

Secrets (required):
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`

Variables (optional — override code defaults without editing files):
- `TARGET_DATE` — ISO date, inclusive. Default `2026-07-26`.
- `SERVICE_NAME` — default `Skin Fade inc Beard & Moustache`.

### 4. Enable & test
- **Actions** tab → enable workflows if prompted.
- Run **booksy-availability-monitor → Run workflow** (manual) to smoke-test.
- To force a test alert, temporarily set `TARGET_DATE` to a far-future date
  (e.g. `2027-01-01`) so any slot qualifies, run manually, confirm the Telegram
  message lands, then set `TARGET_DATE` back.

## Run locally

```bash
npm install
npx playwright install chromium
# Force an alert to test wiring (far-future target). Omit Telegram vars to just log.
TARGET_DATE=2027-01-01 \
TELEGRAM_BOT_TOKEN=xxx TELEGRAM_CHAT_ID=yyy \
node monitor.js

# Watch it run in a visible browser:
HEADLESS=false node monitor.js
```

## Config (env vars)

| Var | Default | Meaning |
|---|---|---|
| `TARGET_DATE` | `2026-07-26` | Alert if earliest slot is on/before this (ISO). |
| `SERVICE_NAME` | `Skin Fade inc Beard & Moustache` | Exact service label to book. |
| `STAFFER_NAME` | `Dale` | Staffer to select. |
| `BUSINESS_URL` | Hinces Shrewsbury | Booksy business page URL. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | — | Telegram push creds. |
| `HEADLESS` | `true` | Set `false` to watch the browser locally. |

## Notes / caveats
- **Cron drift**: GitHub schedules can lag 5–15 min under load. Fine for
  cancellations; not instant.
- **Auto-disable**: GitHub disables scheduled workflows after 60 days of repo
  inactivity — push a commit or re-enable to keep it alive.
- **Selectors may drift** if Booksy changes its site; a failed run uploads
  `error.png` as an artifact to help diagnose. The calendar lives in a
  same-origin `widget-2024` iframe; day cells are
  `[data-testid="calendar-card"][data-date=YYYY-MM-DD]`, earliest = `.-selected`.
- **Politeness**: 15-min cadence is deliberately light to avoid bot-detection.

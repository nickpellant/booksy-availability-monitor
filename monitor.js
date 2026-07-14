#!/usr/bin/env node
/**
 * Booksy cancellation monitor — Dale @ Hinces Barber.
 *
 * Drives the real Booksy booking flow headless, reads the earliest available
 * date for a given service/staffer, and pushes a Telegram alert when that date
 * is on/before TARGET_DATE and is new or earlier than the last one alerted.
 *
 * Booking stays manual — this only detects and notifies.
 *
 * Key site facts (reverse-engineered live):
 *   - Marketplace page hosts the staffer + service list (main frame).
 *   - Clicking "Book" opens a same-origin iframe (booksy.com/widget-2024/index.html)
 *     containing the calendar.
 *   - Day cells: [data-testid="calendar-card"] with data-date="YYYY-MM-DD".
 *     The ".-selected" card is auto-set to the earliest available date on open.
 */

const { chromium } = require('playwright');
const fs = require('fs');

const CFG = {
  businessUrl: process.env.BUSINESS_URL ||
    'https://booksy.com/en-gb/12884_hinces_barber_1227928_shrewsbury',
  stafferId: process.env.STAFFER_ID || '22746', // Dale — the /staffer/<id> deep link filters services to just this staffer
  stafferName: process.env.STAFFER_NAME || 'Dale',
  serviceName: process.env.SERVICE_NAME || 'Skin Fade inc Beard & Moustache',
  targetDate: process.env.TARGET_DATE || '2026-07-26', // ISO YYYY-MM-DD, inclusive
  botToken: process.env.TELEGRAM_BOT_TOKEN,
  chatId: process.env.TELEGRAM_CHAT_ID,
  stateFile: process.env.STATE_FILE || 'state.json',
  headless: process.env.HEADLESS !== 'false',
};

const log = (...a) => console.log(new Date().toISOString(), ...a);

// Raised when Booksy's WAF blocks the request (common from datacenter/CI IPs).
// Treated as a quiet skip, not a failure — the next run gets a different IP.
class BlockedError extends Error {}

const EMPTY_STATE = { lastEarliest: null, lastAlerted: null, lastChecked: null };

function readState() {
  try {
    return { ...EMPTY_STATE, ...JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')) };
  } catch (e) {
    // A missing file on first run is normal. A parse error is not: warn loudly,
    // because silently resetting lastAlerted would re-alert for a known slot.
    if (fs.existsSync(CFG.stateFile)) {
      log('WARN: could not read/parse state file — dedupe memory reset. May re-alert once.', e.message);
    }
    return { ...EMPTY_STATE };
  }
}

function writeState(state) {
  // Write-then-rename so an interrupted run can't leave a truncated JSON file
  // that the next run fails to parse (which would wipe dedupe memory).
  const tmp = `${CFG.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, CFG.stateFile);
}

async function sendTelegram(text) {
  if (!CFG.botToken || !CFG.chatId) {
    log('WARN: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set — skipping push. Message was:\n' + text);
    return;
  }
  // Plain text (no parse_mode): the message interpolates a service name and a
  // URL full of underscores; Markdown would treat those as formatting and
  // Telegram would reject the message (400), dropping the alert.
  const res = await fetch(`https://api.telegram.org/bot${CFG.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CFG.chatId,
      text,
      disable_web_page_preview: true,
    }),
  });
  if (!res.ok) {
    throw new Error(`Telegram send failed: ${res.status} ${await res.text()}`);
  }
  log('Telegram alert sent.');
}

async function dismissCookies(page) {
  // Best-effort; prefer rejecting non-essential (privacy default). Don't block if absent.
  // Booksy uses Cookiebot: buttons are "Deny" / "Customize" / "Allow all".
  const labels = [/^deny$/i, /only necessary/i, /reject all/i, /reject/i, /decline/i, /allow all/i, /accept all/i, /accept/i];
  for (const re of labels) {
    try {
      const btn = page.getByRole('button', { name: re });
      if (await btn.first().isVisible({ timeout: 1500 }).catch(() => false)) {
        await btn.first().click({ timeout: 2000 });
        log('Dismissed cookie banner via', re);
        await page.waitForTimeout(500);
        return;
      }
    } catch { /* keep trying */ }
  }
}

async function readEarliest(page) {
  // The calendar renders inside the widget iframe. Wait for it, then read the
  // auto-selected (earliest available) card's data-date.
  const deadline = Date.now() + 30000;
  let frame = null;
  while (Date.now() < deadline) {
    frame = page.frames().find((f) => f.url().includes('widget'));
    if (frame) {
      const has = await frame.$('[data-testid="calendar-card"]').catch(() => null);
      if (has) break;
    }
    await page.waitForTimeout(500);
  }
  if (!frame) throw new Error('Booking widget iframe never appeared');

  // CRITICAL correctness guard: the widget's order summary must show our staffer.
  // Multiple staff offer identically-named services; booking the wrong one would
  // report the wrong availability. Substring (not exact) match so it still holds
  // if the summary renders a fuller name like "Dale Hince". POLL for it — the
  // order panel renders slightly after the calendar cards, so a one-shot check
  // races and can false-fail. Fail loudly only if it never appears.
  const staffOk = await frame
    .waitForFunction(
      (name) =>
        [...document.querySelectorAll('*')].some(
          (e) => e.children.length === 0 && (e.textContent || '').includes(name)
        ),
      CFG.stafferName,
      { timeout: 12000 }
    )
    .then(() => true)
    .catch(() => false);
  if (!staffOk) {
    throw new Error(`Order summary does not show staffer "${CFG.stafferName}" — refusing to trust availability`);
  }

  // The widget auto-selects the earliest AVAILABLE day. If nothing is selectable,
  // that's a legitimate "no availability in range" — a quiet no-op, not an error.
  const selected = await frame
    .waitForSelector('[data-testid="calendar-card"].-selected', { timeout: 8000 })
    .catch(() => null);
  if (!selected) {
    log('No auto-selected day in the calendar — treating as no availability.');
    return { earliest: null, times: [] };
  }

  // Defensive: if the selected day is somehow marked empty, report the earliest
  // non-empty card instead. Its slot times aren't shown (that day isn't open in
  // the panel), so return no times rather than the empty day's (none).
  const selectedIsEmpty = await selected.evaluate((el) => el.className.includes('-empty'));
  if (selectedIsEmpty) {
    const fallback = await frame.$$eval('[data-testid="calendar-card"]', (els) =>
      els
        .map((e) => ({ date: e.getAttribute('data-date'), empty: e.className.includes('-empty') }))
        .filter((x) => x.date && !x.empty)
        .sort((a, b) => a.date.localeCompare(b.date))[0]?.date ?? null
    );
    return { earliest: fallback, times: [] };
  }

  const earliest = await selected.evaluate((el) => el.getAttribute('data-date'));

  // Give the slot panel a moment to render its time buttons before reading them.
  await frame
    .waitForFunction(
      () => [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && /^\d{1,2}:\d{2}$/.test((e.textContent || '').trim())),
      { timeout: 5000 }
    )
    .catch(() => {});

  return { earliest, times: await readTimes(frame) };
}

async function readTimes(frame) {
  return frame
    .$$eval('*', (els) =>
      [
        ...new Set(
          els
            .filter((e) => e.children.length === 0 && /^\d{1,2}:\d{2}$/.test((e.textContent || '').trim()))
            .map((e) => e.textContent.trim())
        ),
      ].slice(0, 8)
    )
    .catch(() => []);
}

async function checkOnce(page) {
  // Deep-link straight to the staffer's page. This filters the service list to
  // ONLY this staffer, so identically-named services from other staff can't be
  // picked by mistake (they book a different calendar).
  const stafferUrl = `${CFG.businessUrl}/staffer/${CFG.stafferId}`;
  log('Navigating to', stafferUrl);
  const resp = await page.goto(stafferUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Booksy's WAF returns a bare "403 Forbidden" (or 429) page for IPs it doesn't
  // like — routine from cloud/CI runners. Detect it and bail as a soft skip.
  const status = resp ? resp.status() : 0;
  if (status === 403 || status === 429) {
    throw new BlockedError(`Booksy returned HTTP ${status} (WAF block)`);
  }
  const looksBlocked = await page
    .evaluate(() => {
      const t = (document.body && document.body.innerText || '').trim();
      return t.length < 300 && /\b(403 Forbidden|Access Denied|Attention Required|Request blocked)\b/i.test(t);
    })
    .catch(() => false);
  if (looksBlocked) {
    throw new BlockedError('Booksy served a block page (403/Access Denied)');
  }

  await dismissCookies(page);
  await page.waitForTimeout(1000);

  // Reveal the target service. Service-group headers are collapsible buttons
  // whose label ends with a service count (e.g. "DALE HINCE  7 services").
  // Expand only collapsed ones (aria-expanded="false") so we never toggle an
  // open group shut.
  const svcText = page.getByText(CFG.serviceName, { exact: true }).first();
  if (!(await svcText.isVisible({ timeout: 3000 }).catch(() => false))) {
    for (let i = 0; i < 10; i++) {
      const btn = page
        .locator('button[aria-expanded="false"]')
        .filter({ hasText: /\bservices?\b/i })
        .first();
      if (!(await btn.isVisible({ timeout: 1000 }).catch(() => false))) break;
      await btn.click({ timeout: 3000 }).catch(() => {});
      if (await svcText.isVisible({ timeout: 800 }).catch(() => false)) break;
    }
  }
  // Fallback: use the "Search for service" box to filter it into view.
  if (!(await svcText.isVisible({ timeout: 1000 }).catch(() => false))) {
    const search = page.getByPlaceholder(/search for service/i);
    if (await search.isVisible({ timeout: 1500 }).catch(() => false)) {
      await search.fill(CFG.serviceName).catch(() => {});
      await page.waitForTimeout(1200);
    }
  }
  await svcText.waitFor({ state: 'visible', timeout: 10000 });
  await svcText.scrollIntoViewIfNeeded({ timeout: 10000 });

  const row = svcText.locator('xpath=ancestor::*[.//button[normalize-space()="Book"]][1]');
  await row.getByRole('button', { name: 'Book', exact: true }).click({ timeout: 15000 });
  log('Clicked Book for', CFG.serviceName);

  const { earliest, times } = await readEarliest(page);
  log('Earliest available date:', earliest, times.length ? `(times: ${times.join(', ')})` : '');
  return { earliest, times };
}

async function main() {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(CFG.targetDate)) {
    throw new Error(`TARGET_DATE must be ISO YYYY-MM-DD, got "${CFG.targetDate}"`);
  }

  const state = readState();
  const browser = await chromium.launch({ headless: CFG.headless });
  const context = await browser.newContext({
    locale: 'en-GB',
    timezoneId: 'Europe/London',
    viewport: { width: 1440, height: 900 },
    userAgent:
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  // Small random jitter to avoid a perfectly periodic footprint.
  await page.waitForTimeout(Math.floor(2000 + Math.random() * 6000));

  let result;
  try {
    result = await checkOnce(page);
  } catch (err) {
    // A WAF block is not a bug — skip quietly and let the next run (new IP) retry.
    if (err instanceof BlockedError) {
      log(`SKIP: ${err.message}. Not a failure — next run gets a fresh IP.`);
      await browser.close();
      return;
    }
    log('First attempt failed:', err.message, '— retrying once.');
    await page.waitForTimeout(4000);
    try {
      result = await checkOnce(page);
    } catch (err2) {
      if (err2 instanceof BlockedError) {
        log(`SKIP: ${err2.message}. Not a failure — next run gets a fresh IP.`);
        await browser.close();
        return;
      }
      await page.screenshot({ path: 'error.png', fullPage: true }).catch(() => {});
      await browser.close();
      throw err2;
    }
  }

  await browser.close();

  const { earliest, times } = result;
  const now = new Date().toISOString();
  const qualifies = !!earliest && earliest <= CFG.targetDate;

  if (!qualifies) {
    // Nothing on/before target right now. Clear alert memory so that if a
    // previously-alerted date later reopens, it counts as new and alerts again.
    log(earliest ? `Earliest ${earliest} is after target ${CFG.targetDate}; no alert.` : 'No availability; no alert.');
    state.lastAlerted = null;
  } else if (state.lastAlerted === null || earliest < state.lastAlerted) {
    // Alert only on a genuinely better position: the first qualifying slot after
    // none, or one strictly earlier than the last we announced. A qualifying slot
    // that moved LATER (the earlier one got booked) is not re-announced.
    const timeStr = times.length ? ` — slots: ${times.join(', ')}` : '';
    const msg =
      `💈 ${CFG.stafferName} availability on/before your target\n` +
      `Earliest: ${earliest}${timeStr}\n` +
      `Service: ${CFG.serviceName}\n` +
      `Target: on/before ${CFG.targetDate}\n` +
      `Book (${CFG.stafferName} → ${CFG.serviceName}):\n` +
      `${CFG.businessUrl}/staffer/${CFG.stafferId}`;
    await sendTelegram(msg);
    state.lastAlerted = earliest;
  } else {
    log(`Earliest ${earliest} qualifies but not earlier than last alerted (${state.lastAlerted}); no repeat.`);
  }

  state.lastEarliest = earliest;
  state.lastChecked = now;
  writeState(state);
  log('Done.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});

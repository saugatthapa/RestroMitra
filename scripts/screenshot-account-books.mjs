import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const BASE = "http://localhost:3100";
const phone = readFileSync("/tmp/screenshot16_phone.txt", "utf8").trim();

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1400, height: 1100 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[type="password"]', "testpass123");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page.click('button:has-text("Log in")'),
]);
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });

const switcher = page.locator('select[aria-label="Switch restaurant"]');
if (await switcher.count()) {
  await switcher.selectOption({ label: "Img Restaurant 6421cd7d" });
  await page.waitForTimeout(600);
}

await page.goto(`${BASE}/dashboard/account-books`, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);
await page.screenshot({ path: "/tmp/ledger-00-empty-daybook.png", fullPage: true });

// --- Add a manual cash-sale credit entry ---
await page.click('button:has-text("+ Add entry")');
await page.waitForTimeout(300);
await page.selectOption('form select >> nth=0', "credit");
await page.selectOption('form select >> nth=1', "sales");
await page.fill('form input[type="number"]', "350");
await page.fill('form input[placeholder="e.g. Cash sale, corner-shop supplies"]', "Walk-in cash sale");
await Promise.all([
  page.waitForResponse((r) => r.url().endsWith("/ledger") && r.request().method() === "POST"),
  page.click('form button:has-text("Add entry")'),
]);
await page.waitForTimeout(700);

// --- Add a manual debit entry marked "on credit" (a due) ---
await page.click('button:has-text("+ Add entry")');
await page.waitForTimeout(300);
await page.selectOption('form select >> nth=0', "debit");
await page.selectOption('form select >> nth=1', "purchase");
await page.fill('form input[type="number"]', "1200");
await page.fill('form input[placeholder="e.g. Cash sale, corner-shop supplies"]', "Vegetables from corner shop");
await page.fill('form input[placeholder="Customer / supplier / person"]', "Ram Kirana Pasal");
await page.check('form input[type="checkbox"]');
await Promise.all([
  page.waitForResponse((r) => r.url().endsWith("/ledger") && r.request().method() === "POST"),
  page.click('form button:has-text("Add entry")'),
]);
await page.waitForTimeout(700);

await page.screenshot({ path: "/tmp/ledger-01-daybook-with-entries.png", fullPage: true });

// --- Due tracking tab ---
await page.click('button:has-text("Due tracking")');
await page.waitForTimeout(700);
await page.screenshot({ path: "/tmp/ledger-02-due-tracking.png", fullPage: true });

// --- Settle the due partially ---
await page.click('button:has-text("Settle")');
await page.waitForTimeout(300);
const settleAmountInput = page.locator('input[type="number"]').last();
await settleAmountInput.fill("500");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/settle") && r.request().method() === "POST"),
  page.click('button:has-text("Confirm settlement")'),
]);
await page.waitForTimeout(700);
await page.screenshot({ path: "/tmp/ledger-03-after-partial-settle.png", fullPage: true });

// --- Month book ---
await page.click('button:has-text("Month book")');
await page.waitForTimeout(700);
await page.screenshot({ path: "/tmp/ledger-04-month-book.png", fullPage: true });

// --- Year book ---
await page.click('button:has-text("Year book")');
await page.waitForTimeout(700);
await page.screenshot({ path: "/tmp/ledger-05-year-book.png", fullPage: true });

await browser.close();

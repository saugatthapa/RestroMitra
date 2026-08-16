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

await page.goto(`${BASE}/dashboard`, { waitUntil: "networkidle" });

const result = await page.evaluate(async () => {
  const res = await fetch("/api/restaurants/img-restaurant-6421cd7d/purchases", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-dhankipos-client": "web" },
    body: JSON.stringify({
      items: [
        {
          inventoryItemId: "7267102b-3e8f-497c-a0ea-19e868430ef5",
          quantity: 5, // 5 kg
          unitCost: 400, // Rs 400/kg
        },
      ],
    }),
  });
  return { status: res.status, body: await res.text() };
});
console.log(result.status, result.body.slice(0, 300));

await browser.close();

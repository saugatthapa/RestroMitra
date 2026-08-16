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

await page.goto(`${BASE}/dashboard/pos`, { waitUntil: "networkidle" });
await page.waitForTimeout(700);

// Attach the test loyalty customer.
await page.fill('input[placeholder="Search by name or phone…"]', "9812345678");
await page.waitForTimeout(700);
await page.locator('button:has-text("9812345678")').first().click();
await page.waitForTimeout(300);

// Add an item and place the order.
await page.locator("button", { hasText: "Chicken Momo" }).first().click();
await page.waitForTimeout(200);
const addBtn = page.locator('button:has-text("Add to order")');
await addBtn.waitFor({ state: "visible", timeout: 5000 });
await addBtn.click();
await page.waitForTimeout(200);

page.on("dialog", (d) => d.dismiss());
await page.locator('button:has-text("Place order")').click();
await page.waitForURL(/\/dashboard\/orders\//, { timeout: 10000 });
const orderUrl = page.url();
const orderId = orderUrl.split("/").pop();
console.log("Order ID:", orderId);

// Drive the order through the full lifecycle to "completed" via direct
// fetch calls in-page (reuses the browser's session cookie automatically).
const statuses = ["confirmed", "preparing", "ready", "served", "completed"];
for (const status of statuses) {
  const result = await page.evaluate(
    async ({ orderId, status }) => {
      const res = await fetch(`/api/restaurants/img-restaurant-6421cd7d/orders/${orderId}/status`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", "x-dhankipos-client": "web" },
        body: JSON.stringify({ status }),
      });
      return { status: res.status, body: await res.text() };
    },
    { orderId, status },
  );
  console.log(`-> ${status}:`, result.status, result.body.slice(0, 200));
}

await browser.close();

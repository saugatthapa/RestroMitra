import { chromium } from "playwright";

const BASE = "http://localhost:3100";
const PHONE = "9800330999";

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium" });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', PHONE);
await page.fill('input[type="password"]', "testpass123");
await Promise.all([
  page.waitForResponse((r) => r.url().includes("/api/auth/login") && r.status() === 200),
  page.click('button:has-text("Log in")'),
]);
await page.waitForURL(`${BASE}/dashboard`, { timeout: 10000 });

// Make sure we're on the restaurant that has 2 branches.
const switcher = page.locator('select[aria-label="Switch restaurant"]');
if (await switcher.count()) {
  await switcher.selectOption({ label: "Img Restaurant 6421cd7d" });
  await page.waitForTimeout(800);
}

const summaryResponses = [];
page.on("response", async (r) => {
  if (r.url().includes("/reports/summary") && r.status() === 200) {
    summaryResponses.push(await r.json().catch(() => null));
  }
});

await page.goto(`${BASE}/dashboard/reports`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

const branchSwitcher = page.locator('select[aria-label="Switch branch"]');
console.log("Branch switcher present:", await branchSwitcher.count());
const options = await branchSwitcher.locator("option").allTextContents();
console.log("Branch switcher options:", options);

const allBranchesJson = summaryResponses[summaryResponses.length - 1];
console.log("All-branches summary — revenueInPaisa:", allBranchesJson.sales.revenueInPaisa, "branchId:", allBranchesJson.branchId, "branchComparison rows:", allBranchesJson.branchComparison.length);

await page.screenshot({ path: "/tmp/phase24-reports-all-branches.png", clip: { x: 0, y: 0, width: 1280, height: 400 } });

// Now switch to a specific branch and confirm the summary re-fetches scoped.
await branchSwitcher.selectOption({ index: 1 }); // first real branch, not "All branches"
await page.waitForTimeout(1500);
const scopedJson = summaryResponses[summaryResponses.length - 1];
console.log("Scoped summary — revenueInPaisa:", scopedJson.sales.revenueInPaisa, "branchId:", scopedJson.branchId, "branchComparison rows:", scopedJson.branchComparison.length);

await page.waitForTimeout(500);
await page.screenshot({ path: "/tmp/phase24-reports-scoped-branch.png", clip: { x: 0, y: 0, width: 1280, height: 400 } });

// Reload the page — the selection should persist (localStorage, namespaced
// per restaurant) rather than resetting to "All branches".
await page.reload({ waitUntil: "networkidle" });
await page.waitForTimeout(1000);
const selectedAfterReload = await branchSwitcher.inputValue();
console.log("Branch selector value after reload (should still be the scoped branch id):", selectedAfterReload);

await browser.close();
console.log("DONE");

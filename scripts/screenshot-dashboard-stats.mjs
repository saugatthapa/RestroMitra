import { chromium } from "playwright";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase3";

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
await page.fill('input[placeholder="98XXXXXXXX"]', "9835223596");
await page.fill('input[type="password"]', "testpass123");
await page.click('button[type="submit"]');
await page.waitForURL("**/dashboard", { timeout: 10000 });
await page.waitForTimeout(500);
await page.screenshot({ path: `${OUT}/11-dashboard-live-stats.png`, fullPage: true });
console.log("captured 11-dashboard-live-stats");

await browser.close();

import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots";
mkdirSync(OUT, { recursive: true });

const suffix = Math.random().toString(36).slice(2, 8);
const phone = `98${Math.floor(10000000 + Math.random() * 89999999)}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log("captured", name);
}

// 1. Landing page
await page.goto(BASE, { waitUntil: "networkidle" });
await shot("01-landing");

// 2. Register
await page.goto(`${BASE}/register`, { waitUntil: "networkidle" });
await shot("02-register-empty");
await page.fill('input[placeholder="Sita Rai"]', "Kamala Shrestha");
await page.fill('input[placeholder="98XXXXXXXX"]', phone);
await page.fill('input[placeholder="you@example.com"]', `kamala.${suffix}@example.com`);
await page.fill('input[placeholder="At least 8 characters"]', "testpass123");
await shot("03-register-filled");
await page.click('button[type="submit"]');
await page.waitForURL("**/onboarding", { timeout: 10000 });

// 3. Onboarding wizard — step through
await shot("04-onboarding-step1-name");
await page.fill('input[placeholder="e.g. Momo House Itahari"]', "Screenshot Cafe Itahari");
await page.click('button:has-text("Next")');
await shot("05-onboarding-step2-type");
await page.click('button:has-text("Cafe")');
await page.click('button:has-text("Next")');
await shot("06-onboarding-step3-address");
await page.fill('input[placeholder="Street address"]', "Dharan Road");
await page.fill('input[placeholder="City (e.g. Itahari)"]', "Itahari");
await page.fill('input[placeholder="District (e.g. Sunsari)"]', "Sunsari");
await page.fill('input[placeholder="Restaurant phone (98XXXXXXXX)"]', "9811119999");
await page.click('button:has-text("Next")');
await shot("07-onboarding-step4-panvat");
await page.click('button:has-text("Next")');
await shot("08-onboarding-step5-hours");
await page.click('button:has-text("Next")');
await shot("09-onboarding-step6-review");
await page.click('button:has-text("Create restaurant")');
await page.waitForSelector("text=Go to dashboard", { timeout: 10000 });
await shot("10-onboarding-complete");
await page.click('button:has-text("Go to dashboard")');
await page.waitForURL("**/dashboard", { timeout: 10000 });

// 4. Dashboard
await shot("11-dashboard");

// 5. Menu page — build out a category + item
await page.goto(`${BASE}/dashboard/menu`, { waitUntil: "networkidle" });
await shot("12-menu-empty");

page.once("dialog", (d) => d.accept("MOMO"));
await page.click('button:has-text("+ Category")');
await page.waitForTimeout(800);
await shot("13-menu-category-added");

await page.click('button:has-text("+ Item")');
await page.waitForTimeout(300);
await shot("14-menu-item-modal");
await page.fill('input[placeholder="Item name (e.g. Buff Momo)"]', "Buff Momo");
await page.selectOption("select >> nth=0", { label: "MOMO" });
await page.fill('textarea[placeholder="Description (optional)"]', "Steamed buffalo momo, served with achar");
await page.fill('input[placeholder="SKU (optional)"]', "MOMO-BUFF");
await page.fill('input[placeholder="Prep time (min)"]', "15");
await page.fill('input[type="number"][step="0.01"] >> nth=0', "180");
await page.fill('input[type="number"][step="0.01"] >> nth=1', "13");
await shot("15-menu-item-modal-filled");
await page.click('button[type="submit"]:has-text("Save")');
await page.waitForTimeout(800);
await shot("16-menu-item-added");

await browser.close();
console.log("DONE");

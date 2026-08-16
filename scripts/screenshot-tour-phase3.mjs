import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase3";
mkdirSync(OUT, { recursive: true });

const suffix = Math.random().toString(36).slice(2, 8);
const phone = `98${Math.floor(10000000 + Math.random() * 89999999)}`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

async function shot(page, name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log("captured", name);
}

// --- Staff side: register, onboard, build menu, create a table -------------
const staffPage = await browser.newPage({ viewport: { width: 1280, height: 900 } });

// window.prompt() blocks JS until dismissed, so multiple sequential
// prompt() calls fire multiple "dialog" events one after another. A single
// persistent listener draining a queue (rather than several `.once`
// handlers registered with guessed timing) handles that reliably.
const dialogQueue = [];
staffPage.on("dialog", async (dialog) => {
  const next = dialogQueue.shift();
  if (next === undefined) {
    await dialog.dismiss().catch(() => {});
  } else {
    await dialog.accept(next).catch(() => {});
  }
});
function queueDialogs(...values) {
  dialogQueue.push(...values);
}

await staffPage.goto(`${BASE}/register`, { waitUntil: "networkidle" });
await staffPage.fill('input[placeholder="Sita Rai"]', "Phase3 Tour Owner");
await staffPage.fill('input[placeholder="98XXXXXXXX"]', phone);
await staffPage.fill('input[placeholder="you@example.com"]', `phase3.${suffix}@example.com`);
await staffPage.fill('input[placeholder="At least 8 characters"]', "testpass123");
await staffPage.click('button[type="submit"]');
await staffPage.waitForURL("**/onboarding", { timeout: 10000 });

await staffPage.fill('input[placeholder="e.g. Momo House Itahari"]', "Phase3 Tour Cafe");
await staffPage.click('button:has-text("Next")');
await staffPage.click('button:has-text("Cafe")');
await staffPage.click('button:has-text("Next")');
await staffPage.fill('input[placeholder="Street address"]', "Dharan Road");
await staffPage.fill('input[placeholder="City (e.g. Itahari)"]', "Itahari");
await staffPage.fill('input[placeholder="District (e.g. Sunsari)"]', "Sunsari");
await staffPage.fill('input[placeholder="Restaurant phone (98XXXXXXXX)"]', "9811119999");
await staffPage.click('button:has-text("Next")');
await staffPage.click('button:has-text("Next")');
await staffPage.click('button:has-text("Next")');
await staffPage.click('button:has-text("Create restaurant")');
await staffPage.waitForSelector("text=Go to dashboard", { timeout: 10000 });
await staffPage.click('button:has-text("Go to dashboard")');
await staffPage.waitForURL("**/dashboard", { timeout: 10000 });

// Build a menu item with a variant + addon so the public order page has
// something interesting to show.
await staffPage.goto(`${BASE}/dashboard/menu`, { waitUntil: "networkidle" });
queueDialogs("MOMO");
await staffPage.click('button:has-text("+ Category")');
await staffPage.waitForTimeout(600);

await staffPage.click('button:has-text("+ Item")');
await staffPage.waitForTimeout(300);
await staffPage.fill('input[placeholder="Item name (e.g. Buff Momo)"]', "Buff Momo");
await staffPage.selectOption("select >> nth=0", { label: "MOMO" });
await staffPage.fill('input[type="number"][step="0.01"] >> nth=0', "180");
await staffPage.fill('input[type="number"][step="0.01"] >> nth=1', "13");
await staffPage.click('button[type="submit"]:has-text("Save")');
await staffPage.waitForTimeout(600);

// Expand variants/add-ons and add one of each. addVariant() prompts twice
// (name, then price) synchronously; addAddon() the same.
await staffPage.click('button:has-text("Variants & add-ons")');
await staffPage.waitForTimeout(300);
queueDialogs("Large", "220");
await staffPage.click('button:has-text("+ Add") >> nth=0');
await staffPage.waitForTimeout(600);
queueDialogs("Extra spicy", "0");
await staffPage.click('button:has-text("+ Add") >> nth=1');
await staffPage.waitForTimeout(600);

// --- Tables & QR ------------------------------------------------------------
await staffPage.goto(`${BASE}/dashboard/tables`, { waitUntil: "networkidle" });
await shot(staffPage, "01-tables-empty");

queueDialogs("Table 5", "4");
await staffPage.click('button:has-text("+ Table")');
await staffPage.waitForTimeout(1000);
await shot(staffPage, "02-tables-with-qr");

console.log("PHONE_USED", phone);
console.log("STAFF_SIDE_DONE");
await browser.close();

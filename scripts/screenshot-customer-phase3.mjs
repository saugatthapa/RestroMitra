import { chromium } from "playwright";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-phase3";
const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("Usage: node screenshot-customer-phase3.mjs <qrToken>");
  process.exit(1);
}

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});
// Narrow viewport — this is a customer's phone scanning a table QR code.
const page = await browser.newPage({ viewport: { width: 420, height: 860 } });

async function shot(name) {
  await page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });
  console.log("captured", name);
}

await page.goto(`${BASE}/order/${TOKEN}`, { waitUntil: "networkidle" });
await shot("03-customer-menu");

await page.click('button:has-text("Buff Momo")');
await page.waitForTimeout(300);
await shot("04-customer-customize-item");

// The only variant ("Large") is preselected by default. Just add the
// add-on and bump quantity to 2.
await page.click('text=Extra spicy');
await page.click('button:has-text("+")');
await page.waitForTimeout(200);
await shot("05-customer-customize-filled");

await page.click('button:has-text("Add to cart")');
await page.waitForTimeout(300);
await shot("06-customer-cart-bar");

await page.click('text=View cart');
await page.waitForTimeout(300);
await shot("07-customer-cart-view");

await page.click('button:has-text("Checkout")');
await page.waitForTimeout(300);
await page.fill('input[placeholder="Your name (optional)"]', "Ramesh");
await page.fill('input[placeholder="Phone number (optional)"]', "9800000001");
await shot("08-customer-checkout");

await page.click('button:has-text("Place order")');
await page.waitForSelector("text=Order placed!", { timeout: 10000 });
await page.waitForTimeout(300);
await shot("09-customer-confirmation");

await browser.close();
console.log("CUSTOMER_SIDE_DONE");

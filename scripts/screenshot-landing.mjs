import { chromium } from "playwright";
import { mkdirSync } from "fs";

const BASE = "http://localhost:3100";
const OUT = "/home/claude/dhankipos/screenshots-landing";
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

// --- Desktop, full page ------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(400); // let the hero entrance animation settle
  await page.screenshot({ path: `${OUT}/01-desktop-full.png`, fullPage: true });
  console.log("captured 01-desktop-full");

  // Scroll-reveal check: features section after scrolling into view
  await page.evaluate(() => window.scrollTo(0, document.querySelector("#features").offsetTop - 100));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/02-desktop-features-revealed.png` });
  console.log("captured 02-desktop-features-revealed");

  await page.evaluate(() => window.scrollTo(0, document.querySelector("#compare").offsetTop - 100));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/03-desktop-compare.png` });
  console.log("captured 03-desktop-compare");

  await page.evaluate(() => window.scrollTo(0, document.querySelector("#faq").offsetTop - 100));
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/04-desktop-faq.png` });
  console.log("captured 04-desktop-faq");

  // FAQ interaction: open a second item
  const items = page.locator("#faq button[aria-expanded]");
  await items.nth(2).click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/05-desktop-faq-open.png` });
  console.log("captured 05-desktop-faq-open");

  await page.close();
}

// --- Mobile viewport (iPhone-ish) --------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/10-mobile-hero.png` });
  console.log("captured 10-mobile-hero");

  // Open mobile nav
  await page.click('button[aria-label="Toggle menu"]');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/11-mobile-nav-open.png` });
  console.log("captured 11-mobile-nav-open");
  await page.click('button[aria-label="Toggle menu"]');

  await page.screenshot({ path: `${OUT}/12-mobile-full.png`, fullPage: true });
  console.log("captured 12-mobile-full");

  await page.close();
}

// --- Tablet viewport ----------------------------------------------------------
{
  const page = await browser.newPage({ viewport: { width: 834, height: 1112 } });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/20-tablet-hero.png` });
  console.log("captured 20-tablet-hero");
  await page.close();
}

await browser.close();
console.log("DONE");

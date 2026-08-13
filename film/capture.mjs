/* film-capture - hourly dashboard frame (Israel clock). Manager M1, 13.08.2026, per 8.41 item 5. */
import { chromium } from "playwright";
import fs from "node:fs";
const URL = "https://learning-systems-tau.vercel.app/quota-control/";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
await page.goto(URL, { waitUntil: "load", timeout: 90000 });
await page.waitForTimeout(15000);
const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date()).reduce((a, p) => (a[p.type] = p.value, a), {});
const name = `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}.jpg`;
await page.screenshot({ path: `film/${name}`, fullPage: true, type: "jpeg", quality: 70 });
await browser.close();
const files = fs.readdirSync("film").filter(f => /^\d{8}-\d{4}\.jpg$/.test(f)).sort();
for (const f of files.slice(0, Math.max(0, files.length - 336))) fs.unlinkSync("film/" + f);
const keep = files.slice(-336);
fs.writeFileSync("film/index.json", JSON.stringify({ frames: keep.map(f => ({ f, at: f.replace(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})\.jpg$/, "$3.$2.$1 $4:$5") })) }));
console.log("frame:", name, "total:", keep.length);

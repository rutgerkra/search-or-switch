import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

let puppeteer;
try {
  ({ default: puppeteer } = await import(process.env.PUPPETEER_MODULE || "puppeteer-core"));
} catch (error) {
  throw new Error("Screenshot capture requires optional puppeteer-core. Install it or set PUPPETEER_MODULE to its module path.", { cause: error });
}
const root = fileURLToPath(new URL("..", import.meta.url));
const executablePath = process.env.FIREFOX_BIN || (process.platform === "darwin"
  ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "/usr/bin/firefox");
if (!existsSync(executablePath)) throw new Error("Firefox was not found. Set FIREFOX_BIN to its executable.");
const allowed = new Set(["popup.html", "popup.js", "popup.css", "popup-input.js", "history-search.js", "favicon-cache.js", "shortcut-settings.js", "popup-tabs.js", "site-search.js", "core.js", "preview.js", "icons/icon.svg"]);
const mime = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml" };
const server = createServer(async (request, response) => {
  const file = new URL(request.url, "http://localhost").pathname.slice(1) || "popup.html";
  if (!allowed.has(file)) { response.writeHead(404).end(); return; }
  try {
    const data = await readFile(join(root, file));
    response.writeHead(200, { "Content-Type": mime[extname(file)] }).end(data);
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await puppeteer.launch({
    browser: "firefox", executablePath, headless: true,
    firefoxUserPrefs: { "ui.systemUsesDarkTheme": 0 },
    defaultViewport: { width: 560, height: 480, deviceScaleFactor: 2 },
  });
  const page = await browser.newPage();
  const errors = [];
  const remoteRequests = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && !request.url().startsWith(`${origin}/`)) remoteRequests.push(request.url());
  });
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForFunction(() => document.querySelector("#results").getAttribute("aria-busy") === "false"
    && !document.querySelector("#discovery-prompt-allow").disabled);
  // Model an ordinary user who has already granted optional website access.
  await page.click("#discovery-prompt-allow");
  await page.waitForFunction(() => document.querySelector("#discovery-prompt").hidden);
  await page.waitForFunction(() => [...document.querySelectorAll(".result .site-icon img")].length === 6
    && [...document.querySelectorAll(".result .site-icon img")].every((image) => image.complete && image.naturalWidth > 0));
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(root, "docs/preview.png") });
  await page.type("#query", "weekend");
  await page.waitForFunction(() => document.querySelectorAll('[data-type="history"]').length === 2);
  await page.waitForFunction(() => document.querySelectorAll(".result .site-icon img").length === 5
    && [...document.querySelectorAll(".result .site-icon img, #query-icon img")].every((image) => image.complete && image.naturalWidth > 0));
  const layout = await page.evaluate(() => {
    const gear = document.querySelector("#settings-open");
    const gearBox = gear.getBoundingClientRect();
    const rows = [...document.querySelectorAll(".result")];
    return {
      types: rows.map((row) => row.dataset.type),
      sites: rows.filter((row) => row.dataset.type !== "action").map((row) => row.querySelector(".result-title").textContent),
      gearIsCurrent: Boolean(gear.querySelector("svg")) && gear.textContent.trim() === "" && gearBox.width === 40 && getComputedStyle(gear).borderRadius === "50%",
      allRowsClearOfGear: rows.every((row) => row.getBoundingClientRect().bottom < gearBox.top),
      noHorizontalOverflow: document.documentElement.scrollWidth <= innerWidth,
    };
  });
  assert.deepEqual(layout.types, ["tab", "tab", "tab", "history", "history", "action"]);
  assert.ok(layout.gearIsCurrent && layout.allRowsClearOfGear && layout.noHorizontalOverflow, JSON.stringify(layout));
  assert.deepEqual(errors, []);
  assert.deepEqual(remoteRequests, []);
  await page.screenshot({ path: join(root, "docs/preview-history.png") });
  console.log("Captured the current 560×480 popup at 2× resolution with the floating preferences gear.");
  console.log("Verified five site favicons and the input favicon decoded; no remote requests or page errors.");
  console.log(layout.sites.join("; "));
} finally {
  await browser?.close();
  server.close();
}

#!/usr/bin/env node
/* End-to-end drive of the document features (Progress / Invoices tabs).
 *
 * Plain node script — no test runner. Boots the local dev server (which
 * emulates /api/state exactly), opens headless Chromium via playwright-core
 * (browsers preinstalled at PLAYWRIGHT_BROWSERS_PATH), and walks the real
 * user flow. Grows a step per implementation phase.
 *
 * The app loads React/Babel/SheetJS from CDNs. The e2e browser runs with no
 * external network: those exact files also ship in npm packages (pinned in
 * devDependencies), so route interception serves them from node_modules and
 * aborts every other third-party request (fonts, weather) — the app
 * tolerates offline for those. Service workers are blocked so caching can
 * never leak between runs.
 *
 *   node tools/e2e-docs.mjs            # run all steps
 *   node tools/e2e-docs.mjs --headed   # watch it
 *
 * Exit 0 = all steps passed. Fixtures are generated on demand.
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const TOOLS = dirname(fileURLToPath(import.meta.url));
const FIX = join(TOOLS, "fixtures");
const OUTDIR = join(TOOLS, "e2e-out");
const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.argv.includes("--headed");

mkdirSync(OUTDIR, { recursive: true });
if (!existsSync(join(FIX, "expected.json"))) {
  console.log("fixtures missing — generating…");
  execFileSync("node", [join(TOOLS, "make-fixtures.mjs")], { stdio: "inherit" });
}
const expected = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8"));

/* ---- CDN URLs the app requests -> same files from node_modules ---- */
const NM = join(TOOLS, "..", "node_modules");
const cdnCache = new Map([
  ["https://unpkg.com/react@18/umd/react.production.min.js", join(NM, "react/umd/react.production.min.js")],
  ["https://unpkg.com/react-dom@18/umd/react-dom.production.min.js", join(NM, "react-dom/umd/react-dom.production.min.js")],
  ["https://unpkg.com/@babel/standalone@7/babel.min.js", join(NM, "@babel/standalone/babel.min.js")],
  ["https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js", join(NM, "xlsx/dist/xlsx.full.min.js")],
]);
for (const [url, f] of cdnCache) if (!existsSync(f)) { console.error(`missing ${f} for ${url} — run npm install`); process.exit(1); }

/* ---- tiny assertion kit ---- */
let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
};
const step = (name) => console.log(`\n== ${name}`);

/* ---- boot dev server ---- */
const server = spawn("node", [join(TOOLS, "dev-server.mjs"), "--port", String(PORT)], { stdio: "pipe" });
server.stderr.on("data", (d) => process.stderr.write(`[dev-server] ${d}`));
const up = async () => {
  for (let i = 0; i < 50; i++) {
    try { const r = await fetch(BASE + "/api/state"); if (r.headers.get("x-board")) return true; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
};
if (!(await up())) { console.error("dev server did not come up"); server.kill(); process.exit(1); }

/* ---- browser ---- */
const browser = await chromium.launch({
  headless: !HEADED,
  executablePath: process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium",
});
const pageErrors = [];
const newPage = async (ctx) => {
  await ctx.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    const hit = cdnCache.get(url.split("#")[0]);
    if (hit) return route.fulfill({ body: readFileSync(hit), contentType: "application/javascript" });
    return route.abort(); // fonts, weather, anything else — app tolerates offline
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  return page;
};

try {
  const ctxA = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  const page = await newPage(ctxA);

  step("boot");
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav.tabs button", { timeout: 45_000 }); // babel-standalone compile takes a moment
  ok((await page.title()).includes("Look-Ahead"), "app title present");
  ok((await page.locator("nav.tabs button").count()) >= 4, "nav tabs rendered");
  await page.screenshot({ path: join(OUTDIR, "00-boot.png") });

  // Later phases append steps here:
  //  - domain selftest (?selftest=1 badge)
  //  - Progress: import timesheet fixture → ledger/KPI assertions
  //  - Invoices: gate → import invoice fixture → recon → buckets → confirm/override
  //  - export CSV, reload persistence, second-context merge

  step("summary");
  ok(pageErrors.length === 0, `no page errors (${pageErrors.length ? pageErrors.join(" | ").slice(0, 400) : "clean"})`);
  console.log(`\n${passed} passed, ${failed} failed  (fixtures: ${expected.invoice.rows} inv rows / ${expected.timesheet.rows} ts rows)`);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);

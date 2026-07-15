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
const syncTrace = []; // {tag, method, status} for every /api/state response
const newPage = async (ctx, tag = "A") => {
  await ctx.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(BASE)) return route.continue();
    const hit = cdnCache.get(url.split("#")[0]);
    if (hit) return route.fulfill({ body: readFileSync(hit), contentType: "application/javascript" });
    return route.abort(); // fonts, weather, anything else — app tolerates offline
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  page.on("response", (r) => { if (r.url().includes("/api/state")) syncTrace.push({ tag, method: r.request().method(), status: r.status() }); });
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

  step("domain selftest");
  await page.goto(BASE + "/?selftest=1", { waitUntil: "domcontentloaded" });
  const badge = page.locator("#dpwselftest");
  await badge.waitFor({ timeout: 45_000 });
  const badgeText = await badge.textContent();
  ok((await badge.getAttribute("data-pass")) === "1", `selftest badge green (${badgeText})`);
  const st = await page.evaluate(() => window.__DPW.selftest());
  ok(st.fail === 0, `window.__DPW.selftest: ${st.pass} pass / ${st.fail} fail${st.fail ? " — " + st.details.join(" ; ") : ""}`);
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav.tabs button", { timeout: 45_000 });

  step("progress: timesheet import");
  await page.locator('nav.tabs button', { hasText: "Progress" }).click();
  ok(await page.locator('.ph', { hasText: "No documents imported yet" }).isVisible(), "empty state shown");
  await page.locator('header button', { hasText: "Import docs" }).click();
  await page.locator('.modal input[type=file]').setInputFiles(join(FIX, "timesheet_fixture.xlsx"));
  const rowsKpi = page.locator('.modal .kpi', { hasText: "Rows" }).locator("b");
  await rowsKpi.waitFor({ timeout: 20_000 });
  ok((await rowsKpi.textContent()) === String(expected.timesheet.rows), `preview rows = ${expected.timesheet.rows}`);
  const total$ = "$" + Math.round(expected.timesheet.totalC / 100).toLocaleString("en-US");
  ok((await page.locator('.modal .kpi', { hasText: "Total $" }).locator("b").textContent()) === total$, `preview total = ${total$}`);
  await page.locator('.modal button', { hasText: "Commit import" }).click();

  step("progress: ledger view");
  const wdKpi = page.locator('.kpi', { hasText: "Work days" }).locator("b");
  await wdKpi.waitFor({ timeout: 10_000 });
  ok((await wdKpi.textContent()) === String(expected.timesheet.workDays), `work days = ${expected.timesheet.workDays}`);
  ok((await page.locator('.kpi', { hasText: "Cost codes" }).locator("b").textContent()) === String(expected.timesheet.codes), `codes = ${expected.timesheet.codes}`);
  ok((await page.locator('table.dt tbody tr').count()) >= expected.timesheet.codes, "per-code table populated");
  await page.screenshot({ path: join(OUTDIR, "10-progress.png"), fullPage: true });

  step("progress: survives reload (local + sync persistence)");
  await page.waitForTimeout(1800); // debounce (600ms) + push
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav.tabs button", { timeout: 45_000 });
  await page.locator('nav.tabs button', { hasText: "Progress" }).click();
  await page.locator('.kpi', { hasText: "Work days" }).locator("b").waitFor({ timeout: 10_000 });
  ok((await page.locator('.kpi', { hasText: "Work days" }).locator("b").textContent()) === String(expected.timesheet.workDays), "ledger intact after reload");

  step("progress: reconciliation + drill-down");
  // fixture board has no logs, so every documented day-code is DOC-ONLY
  const reconRows = page.locator('.panel', { hasText: "Reconciliation" }).locator("tbody tr");
  ok((await reconRows.count()) === expected.timesheet.dayCodes, `recon lists all ${expected.timesheet.dayCodes} documented day-codes as DOC-ONLY`);
  await reconRows.first().locator("button", { hasText: "Acknowledge" }).click();
  ok((await page.locator('.panel', { hasText: "Reconciliation" }).locator("tbody tr").first().locator("button").textContent()) === "Reopen", "acknowledge sticks");
  await page.locator('.panel', { hasText: "Cost codes" }).locator("tbody tr").first().locator("button", { hasText: "Rows" }).click();
  const drill = page.locator(".modal", { hasText: "Source rows" });
  await drill.waitFor({ timeout: 10_000 });
  ok((await drill.locator("tbody tr").count()) > 0, "drill-down shows raw source rows");
  await page.screenshot({ path: join(OUTDIR, "20-drill.png") });
  await page.keyboard.press("Escape");
  await page.locator(".modal .x").click().catch(() => {});

  step("invoices: gate + import + reconciliation");
  await page.locator('nav.tabs button', { hasText: "Invoices" }).click();
  await page.locator(".gatebox input").fill("42069");
  await page.locator(".gatebox button", { hasText: "Unlock" }).click();
  await page.locator(".ph", { hasText: "No invoice tracker imported yet" }).waitFor({ timeout: 10_000 });
  await page.locator("header button", { hasText: "Import docs" }).click();
  await page.locator(".modal input[type=file]").setInputFiles(join(FIX, "invoice_fixture.xlsx"));
  const linesKpi = page.locator(".modal .kpi", { hasText: "Lines" }).locator("b");
  await linesKpi.waitFor({ timeout: 20_000 });
  ok((await linesKpi.textContent()) === String(expected.invoice.rows), `preview lines = ${expected.invoice.rows}`);
  const blocked = page.locator(".modal button", { hasText: "Blocked" });
  ok(await blocked.isVisible(), "commit blocked until reconciled");
  await page.locator(".modal button", { hasText: "Accept file totals" }).click();
  await page.locator(".modal button", { hasText: "Commit & allocate" }).click();

  step("invoices: review queue buckets");
  const bTab = (label) => page.locator(".panel .ph button", { hasText: label });
  const bCount = async (label) => parseInt((await bTab(label).textContent()).replace(/\D+/g, ""), 10);
  await bTab("Needs review").waitFor({ timeout: 10_000 });
  const bx = expected.invoice.buckets;
  ok((await bCount("Needs review")) === bx.manual, `needs-review = ${bx.manual}`);
  ok((await bCount("Suggested")) === bx.suggested, `suggested = ${bx.suggested}`);
  ok((await bCount("Auto")) === bx.auto, `auto = ${bx.auto}`);
  ok((await bCount("Decided")) === bx.decided, `decided (tracker-coded history) = ${bx.decided}`);
  await page.screenshot({ path: join(OUTDIR, "30-invoices.png"), fullPage: true });

  step("invoices: confirm + split-override + prior feedback");
  await bTab("Auto").click();
  await page.locator("tbody tr").first().locator("button", { hasText: "Confirm" }).click();
  ok((await bCount("Decided")) === bx.decided + 1, "confirm moves line to Decided");
  await bTab("Suggested").click();
  const sandRow = page.locator("tbody tr", { hasText: "Sand from Wood EB" }).first();
  await sandRow.locator("button", { hasText: "Split" }).click();
  const splitModal = page.locator(".modal", { hasText: "Split allocation" });
  await splitModal.waitFor({ timeout: 10_000 });
  await splitModal.locator("input[list=splitcodes]").first().fill("33.30.19.13");
  await splitModal.locator("button", { hasText: "Save split" }).click();
  ok((await bCount("Decided")) === bx.decided + 2, "override moves line to Decided");
  await page.locator("button", { hasText: "Re-suggest" }).click();
  const sandLeft = page.locator("tbody tr", { hasText: "Sand from Wood EB" }).first();
  ok((await sandLeft.locator(".dchip").first().textContent()).includes("33.30.19.13"),
    "sibling sand line re-suggests to the overridden code (prior feedback)");
  await page.screenshot({ path: join(OUTDIR, "31-queue.png"), fullPage: true });

  step("invoices: rollup + anomaly + arch + rate audit panels");
  const rollPanel = page.locator(".panel", { hasText: "Cost rollup" });
  await rollPanel.waitFor({ timeout: 10_000 });
  const spikeRow = rollPanel.locator("tbody tr", { hasText: "33.30.19.13" });
  ok((await spikeRow.locator(".dchip", { hasText: "▲" }).count()) >= 1, "era-3 sewer spend spike flagged ▲>2σ");
  const archPanel = page.locator(".panel", { hasText: "Arch pipe 33.40.19.x" });
  ok((await archPanel.locator("tbody tr").count()) >= 3, "arch-pipe assignments listed individually");
  const auditPanel = page.locator(".panel", { hasText: "Rate audit" });
  ok((await auditPanel.locator("tbody tr").count()) === 3, "rate audit: KNOWN_EXCEPTION + NEW_RATE_ALERT + MISMATCH");
  await page.screenshot({ path: join(OUTDIR, "40-rollup.png"), fullPage: true });

  step("invoices: CSV + xlsx exports");
  const [csvDl] = await Promise.all([page.waitForEvent("download"), rollPanel.locator("button", { hasText: "Export CSV" }).click()]);
  const csvPath = join(OUTDIR, "export.csv");
  await csvDl.saveAs(csvPath);
  const csv = readFileSync(csvPath, "utf8").trim().split("\n");
  ok(csv[0].startsWith("row_key,inv,era,date,truck"), "csv header");
  ok(csv.length - 1 === expected.invoice.rows, `csv has ${expected.invoice.rows} data rows`);
  const [xlsxDl] = await Promise.all([page.waitForEvent("download"), rollPanel.locator("button", { hasText: "Export xlsx" }).click()]);
  const xlsxPath = join(OUTDIR, "export.xlsx");
  await xlsxDl.saveAs(xlsxPath);
  const XLSX = (await import("xlsx")).default;
  const wb = XLSX.readFile(xlsxPath);
  ok(JSON.stringify(wb.SheetNames) === JSON.stringify(["Allocations", "Rollup", "Rate audit"]), "xlsx sheets");
  ok(XLSX.utils.sheet_to_json(wb.Sheets.Allocations).length === expected.invoice.rows, "xlsx allocation rows");

  step("two devices: decision round-trip through the sync endpoint");
  await page.waitForTimeout(1800); // let device A's decisions push
  const ctxB = await browser.newContext({ viewport: { width: 1600, height: 1000 }, serviceWorkers: "block" });
  const pageB = await newPage(ctxB, "B");
  await pageB.bringToFront(); // hidden pages get their timers throttled — B must be the active device
  await pageB.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await pageB.waitForSelector("nav.tabs button", { timeout: 45_000 });
  await pageB.locator('nav.tabs button', { hasText: "Invoices" }).click();
  await pageB.locator(".gatebox input").fill("42069");
  await pageB.locator(".gatebox button", { hasText: "Unlock" }).click();
  const bCountB = async (label) => parseInt((await pageB.locator(".panel .ph button", { hasText: label }).textContent()).replace(/\D+/g, ""), 10);
  await pageB.locator(".panel .ph button", { hasText: "Decided" }).waitFor({ timeout: 15_000 });
  ok((await bCountB("Decided")) === bx.decided + 2, "device B pulled A's confirm + override");
  await pageB.locator(".panel .ph button", { hasText: "Auto" }).click();
  await pageB.locator("tbody tr").first().locator("button", { hasText: "Confirm" }).click();
  ok((await bCountB("Decided")) === bx.decided + 3, "device B adds its own decision");
  await pageB.waitForTimeout(1800); // let B push
  await page.bringToFront();        // A becomes the active device again
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("nav.tabs button", { timeout: 45_000 });
  await page.locator('nav.tabs button', { hasText: "Invoices" }).click();
  await page.locator(".panel .ph button", { hasText: "Decided" }).waitFor({ timeout: 15_000 });
  let aDecided = 0; // the boot pull applies asynchronously — poll until it lands
  for (let i = 0; i < 30 && aDecided !== bx.decided + 3; i++) { aDecided = await bCount("Decided"); if (aDecided !== bx.decided + 3) await page.waitForTimeout(500); }
  ok(aDecided === bx.decided + 3, "device A sees all three decisions after pull");
  ok(syncTrace.some((t) => t.tag === "B" && t.method === "PUT" && t.status === 200), "device B's decision actually pushed (post-pull debounce-window edits must sync)");
  await ctxB.close();

  step("BOARD_KEY auth path untouched");
  const keyed = spawn("node", [join(TOOLS, "dev-server.mjs"), "--port", "8898"], { stdio: "pipe", env: { ...process.env, BOARD_KEY: "sekret" } });
  const up2 = async () => { for (let i = 0; i < 40; i++) { try { const r = await fetch("http://127.0.0.1:8898/api/state"); return r; } catch {} await new Promise((r) => setTimeout(r, 200)); } return null; };
  const r401 = await up2();
  ok(r401 && r401.status === 401, "no key -> 401");
  const rOk = await fetch("http://127.0.0.1:8898/api/state", { headers: { "x-board-key": "sekret" } });
  ok(rOk.status === 200 || rOk.status === 204, "correct key accepted");
  keyed.kill();

  step("summary");
  ok(pageErrors.length === 0, `no page errors (${pageErrors.length ? pageErrors.join(" | ").slice(0, 400) : "clean"})`);
  console.log(`\n${passed} passed, ${failed} failed  (fixtures: ${expected.invoice.rows} inv rows / ${expected.timesheet.rows} ts rows)`);
} finally {
  await browser.close();
  server.kill();
}
process.exit(failed ? 1 : 0);

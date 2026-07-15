#!/usr/bin/env node
/* Deterministic synthetic fixtures for the Progress / Invoices document features.
 *
 * Writes tools/fixtures/invoice_fixture.xlsx  (mirrors Trucking_Invoice_Breakdown.xlsx:
 *   sheet "Sheet1", positional cols A-J = Inv, CC, Item, Qty, Description, Rate,
 *   Truck, AmountWtax, Code, CodeDesc; col H embeds 9.45% tax on CC=M rows)
 * and    tools/fixtures/timesheet_fixture.xlsx (mirrors Trucking_History_Cumulative_
 *   Source_Data.xlsx: sheet "Consolidated Data", header-name-keyed columns)
 * plus   tools/fixtures/expected.json — reconciliation totals and designed outcomes
 *   the e2e script asserts against.
 *
 * Every rule in analysis/trucking gets at least one row:
 *   units by rate (105/120 HR, 8.50 CY, 7.50 TN, 6.05 CY, 15.50/42.00 TN,
 *   10.00 crush→TN else CY, Material+Sand→CY), embedded "N lds", "(NN yd" bed,
 *   leading M/D/YY dates, materials/pits keyword precedence, truck "-Q" suffix,
 *   dash-form cost codes, eras + one out-of-era invoice, KNOWN_EXCEPTION /
 *   NEW_RATE_ALERT / MISMATCH rates, CC=S review rows, an undated row, an
 *   overhead-only truck-day, a multi-code split day, an hours-match day, and a
 *   >2σ code-spend spike within era 3.
 *
 * All data is synthetic. Real tracker/timesheet files never enter the repo.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
mkdirSync(OUT, { recursive: true });

const TAX = 1.0945;
const r2 = (x) => Math.round(x * 100) / 100;

/* ---------------- timesheet fixture ---------------- */
// (date, foreman, truckRaw, code, rows[[qty,um,unitCost]]) — one entry per truck-day-code
const JG = "J. Gomez", TN = "T. Nguyen";
const tsDays = [
  // Day A — single-code day: 3C22 on sewer main (exact-unique join target)
  ["2026-06-01", JG, "3C22", "33.30.19.13", "Sanitary sewer main", [[8, "HR", 105], [18, "LOAD", 0], [120.5, "TON", 0]]],
  // Day B — multi-code day: 3C07 splits arch pipe vs excavation 5:3 by hours
  ["2026-06-02", JG, "3C07", "33.40.19.42", "Arch pipe 51x31", [[5, "HR", 105], [10, "LOAD", 0]]],
  ["2026-06-02", JG, "3C07", "02.61.13.00", "Structure excavation", [[3, "HR", 105], [6, "LOAD", 0], [85, "CY", 0]]],
  // Day C — hours-match day: 3C11, invoice hourly qty 7.5 should match water main
  ["2026-06-03", TN, "3C11", "33.10.14.00", "Water main", [[7.5, "HR", 105]]],
  ["2026-06-03", TN, "3C11", "33.49.13.00", "Storm structures", [[2, "HR", 105]]],
  // Day D — raw truck has quad suffix + code in dash form (both must normalize)
  ["2026-06-04", TN, "3C22-Q Three C's Prop", "33-40-19-42", "Arch pipe 51x31", [[8, "HR", 120], [16, "LOAD", 0]]],
  // Day E — overhead-only day: allocation must NOT auto-win, forced needs-manual
  ["2026-06-05", JG, "3C09", "99.12.00.00", "Overhead - yard & office", [[8, "HR", 105]]],
  // 3C15 era-3 history: 3 days water service line, 1 day sewer — prior = 75/25
  ["2026-06-08", JG, "3C15", "33.10.15.00", "Water service line", [[8, "HR", 105], [14, "LOAD", 0]]],
  ["2026-06-09", JG, "3C15", "33.10.15.00", "Water service line", [[8, "HR", 105], [15, "LOAD", 0]]],
  ["2026-06-10", JG, "3C15", "33.10.15.00", "Water service line", [[7, "HR", 105], [12, "LOAD", 0]]],
  ["2026-06-11", JG, "3C15", "33.30.19.13", "Sanitary sewer main", [[8, "HR", 105], [16, "LOAD", 0]]],
];
// Era-2 filler: 3C03 / 3C05, ten weekdays from 2025-04-14, alternating single-code days
const fillerDates = [];
for (let d = new Date(Date.UTC(2025, 3, 14)); fillerDates.length < 10; d.setUTCDate(d.getUTCDate() + 1)) {
  const dow = d.getUTCDay();
  if (dow >= 1 && dow <= 5) fillerDates.push(d.toISOString().slice(0, 10));
}
fillerDates.forEach((iso, i) => {
  const code = i % 2 ? "02.61.13.00" : "33.30.19.13";
  const desc = i % 2 ? "Structure excavation" : "Sanitary sewer main";
  for (const tk of ["3C03", "3C05"]) {
    tsDays.push([iso, i % 2 ? TN : JG, tk, code, desc, [[8, "HR", 105], [14 + (i % 5), "LOAD", 0]]]);
  }
});

const TS_HEADERS = ["Source File", "Invoice Supported", "Coverage Period", "Date", "Field Log ID",
  "Foreman", "Job Number", "Trucking Subcontractor", "Truck ID Listing", "Account ID",
  "Account Description", "Quantity", "UM", "Unit Cost", "Total Cost"];
const tsRows = [];
let fl = 1000;
for (const [iso, fm, tkRaw, code, codeDesc, entries] of tsDays) {
  fl += 1;
  for (const [qty, um, unitCost] of entries) {
    tsRows.push([
      `FL-${iso}-${fm.split(" ")[1]}.xlsx`, "", "wk of " + iso, iso, `FL-${fl}`,
      fm, 2124013, "Three C's", tkRaw, code, codeDesc, qty, um, unitCost, r2(qty * unitCost),
    ]);
  }
}

/* ---------------- invoice fixture ---------------- */
// [Inv, CC, Item, Qty, Description, Rate, Truck, Code, CodeDesc] — AmountWtax computed
const HOURLY = "Hourly Rate", HAUL = "Haul", DUMP = "Dump Fee", MAT = "Material";
const inv = [];
const add = (invNo, cc, item, qty, desc, rate, truck, code = "", codeDesc = "") => {
  const amt = cc === "M" ? r2(qty * rate * TAX) : r2(qty * rate);
  inv.push([invNo, cc, item, qty, desc, rate, truck, amt, code, codeDesc]);
};

// ── era 1 (72919-73099): historical, codes filled ──
add(72920, "T", HOURLY, 8, "1/13/25 Sewer main haul; 3 lds (16 yd bed)", 105, "3C03", "33.30.19.13", "Sanitary sewer main");
add(72920, "T", HOURLY, 8, "1/14/25 Arch pipe delivery; 2 lds", 120, "3C05", "33.40.19.42", "Arch pipe 51x31");
add(72920, "M", MAT, 40, "1/14/25 57 Limestone from Wood EB premium", 46.2, "", "33.30.19.13", "Sanitary sewer main"); // KNOWN_EXCEPTION rate
add(72920, "S", HOURLY, 4, "1/15/25 Disputed standby - review", 105, "3C03", "", ""); // CC=S review row
// ── era 2 (73853-75313): filler matching timesheet filler days, codes filled ──
fillerDates.forEach((iso, i) => {
  const [y, m, d] = iso.split("-").map(Number);
  const us = `${m}/${d}/${String(y).slice(2)}`;
  const code = i % 2 ? "02.61.13.00" : "33.30.19.13";
  const cd = i % 2 ? "Structure excavation" : "Sanitary sewer main";
  const invNo = 74000 + Math.floor(i / 5) * 10; // 74000, 74010
  for (const tk of ["3C03", "3C05"]) add(invNo, "T", HOURLY, 8, `${us} Production haul; ${3 + (i % 3)} lds (16 yd bed)`, i % 2 ? 120 : 105, tk, code, cd);
});
// era-2 rate/material/pit coverage (codes filled)
add(74010, "T", HAUL, 200, "4/21/25 Sand haul from Wood EB; 12 lds", 8.5, "", "33.10.15.00", "Water service line");
add(74010, "T", HAUL, 150, "4/21/25 57 limestone haul from PMC", 7.5, "", "33.30.19.13", "Sanitary sewer main");
add(74010, "T", HAUL, 90, "4/22/25 Dirt haul out to Gentilly", 10, "", "02.61.13.00", "Structure excavation"); // 10.00 → CY
add(74010, "T", HAUL, 60, "4/22/25 Crushed concrete from PMC", 10, "", "33.30.19.13", "Sanitary sewer main"); // 10.00 + crush → TN
add(74010, "T", HAUL, 25, "4/23/25 Contaminated haul to River Birch", 15.5, "", "02.61.13.00", "Structure excavation");
add(74010, "T", DUMP, 90, "4/22/25 Gentilly landfill dump fees", 6.05, "", "02.61.13.00", "Structure excavation");
add(74010, "T", DUMP, 25, "4/23/25 River Birch disposal fee", 42, "", "02.61.13.00", "Structure excavation");
add(74010, "M", MAT, 180, "4/24/25 Sand from Wood EB", 5.5, "", "33.10.15.00", "Water service line"); // Material+Sand → CY
add(74010, "M", MAT, 75, "4/24/25 57 Limestone from Vulcan", 44, "", "33.30.19.13", "Sanitary sewer main");
add(74010, "M", MAT, 50, "4/25/25 610 Crushed Concrete from PMC", 22, "", "02.61.13.00", "Structure excavation");
add(74010, "M", MAT, 66, "4/25/25 610 Limestone from PMC", 42, "", "33.30.19.13", "Sanitary sewer main");
// ── era 3 (77857-78829): anomaly baseline invoices (codes filled) ──
add(78800, "T", HOURLY, 8, "5/18/26 Sewer main haul; 3 lds", 105, "3C22", "33.30.19.13", "Sanitary sewer main");
add(78800, "T", HAUL, 490, "5/19/26 Sand haul from Wood EB; 14 lds", 8.5, "", "33.30.19.13", "Sanitary sewer main");
add(78810, "T", HOURLY, 8, "5/26/26 Sewer main haul; 3 lds", 105, "3C22", "33.30.19.13", "Sanitary sewer main");
add(78810, "T", HAUL, 512, "5/27/26 Sand haul from Wood EB; 15 lds", 8.5, "", "33.30.19.13", "Sanitary sewer main");
add(78810, "M", MAT, 30, "5/28/26 Special bedding stone from PMC", 55, "", "02.61.13.00", "Structure excavation"); // NEW_RATE_ALERT (first sighting 55.00)
// ── era 3, invoice 78820: the "new" invoice — Code column EMPTY, needs allocation ──
add(78820, "T", HOURLY, 8, "6/1/26 Sewer main haul; 3 lds (16 yd bed)", 105, "3C22");        // → exact-unique 33.30.19.13
add(78820, "T", HAUL, 2500, "6/1/26 Sand haul spoil bank; 24 lds", 8.5, "3C22");             // → exact-unique 33.30.19.13 (spike $21,250)
add(78820, "T", HOURLY, 8, "6/2/26 Pipe + excavation support; 4 lds", 105, "3C07");          // → split 5/8 arch + 3/8 excavation
add(78820, "T", HOURLY, 7.5, "6/3/26 Water main tie-in", 105, "3C11");                       // → hours-match 33.10.14.00
add(78820, "T", HOURLY, 8, "6/4/26 Arch pipe haul; 4 lds (16 yd bed)", 120, "3C22");         // → day D: suffix truck + dash code → 33.40.19.42 (arch flag)
add(78820, "T", HOURLY, 8, "6/5/26 Move office trailer", 105, "3C09-Q");                     // → overhead-only day → needs-manual
add(78820, "T", HAUL, 180, "Sand from Wood EB; 6 lds", 8.5, "3C15");                         // undated → prior via (3C15, era3)
add(78820, "T", HAUL, 165, "Sand from Wood EB; 5 lds", 8.5, "3C15");                         // undated → prior
add(78820, "T", HAUL, 140, "Sand from Wood EB; 5 lds", 8.5, "3C15");                         // undated → prior
add(78820, "T", HOURLY, 3, "Standby time - no date recorded", 105, "");                      // undated + no truck → rules floor
add(78820, "M", MAT, 30, "6/2/26 Special bedding stone from PMC", 55, "");                   // MISMATCH (repeat of 55.00)
add(78820, "M", MAT, 45, "6/3/26 #8 Washed limestone from Wood", 47, "");                    // OK rate, material precedence test
// ── out-of-era invoice (gap after 78829) ──
add(78860, "T", HOURLY, 8, "6/22/26 Sewer main haul; 3 lds", 105, "3C22", "33.30.19.13", "Sanitary sewer main");

const invHeader = ["Inv", "CC", "Item", "Qty", "Description", "Rate", "Truck", "AmountWtax", "Code", "CodeDesc"];

/* ---------------- write workbooks + expectations ---------------- */
const wbInv = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbInv, XLSX.utils.aoa_to_sheet([invHeader, ...inv]), "Sheet1");
XLSX.writeFile(wbInv, join(OUT, "invoice_fixture.xlsx"));

const wbTs = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wbTs, XLSX.utils.aoa_to_sheet([TS_HEADERS, ...tsRows]), "Consolidated Data");
XLSX.writeFile(wbTs, join(OUT, "timesheet_fixture.xlsx"));

const totalC = inv.reduce((s, r) => s + Math.round(r[7] * 100), 0);
const invoices = [...new Set(inv.map((r) => r[0]))];
const expected = {
  invoice: {
    rows: inv.length,
    totalC,
    total: (totalC / 100).toFixed(2),
    nInv: invoices.length,
    invoices,
    unallocated: inv.filter((r) => !r[8]).length,
    outOfEra: [78860],
  },
  timesheet: {
    rows: tsRows.length,
    truckDays: new Set(tsRows.map((r) => `${r[3]}|${r[8]}`)).size,
    workDays: new Set(tsRows.map((r) => r[3])).size,
    codes: new Set(tsRows.map((r) => String(r[9]).replace(/-/g, "."))).size,
    totalC: Math.round(tsRows.reduce((s, r) => s + (r[14] || 0), 0) * 100),
    foremen: [JG, TN],
    dateSpan: ["2025-04-14", "2026-06-11"],
  },
};
writeFileSync(join(OUT, "expected.json"), JSON.stringify(expected, null, 2));

console.log(`invoice_fixture.xlsx  ${inv.length} rows, ${invoices.length} invoices, Σ AmountWtax = $${(totalC / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`);
console.log(`timesheet_fixture.xlsx  ${tsRows.length} rows, ${expected.timesheet.truckDays} truck-day-codes`);
console.log(`expected.json written — e2e reads reconciliation targets from here`);

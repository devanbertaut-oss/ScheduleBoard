"""Orchestrator: load -> reconcile (abort on mismatch) -> classify -> analyze -> report.

    python3 run.py
Outputs (gitignored): output/DPW547_Trucking_Analysis.xlsx and
output/trucking_baselines.json (compact cycle-time medians + rate sheet for the app).
"""
import os
import sys

import rates
import loader
import timesheets
import classifier
import analyzer
import reporter

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
OUT = os.path.join(HERE, "output")
INVOICE = os.path.join(DATA, "Trucking_Invoice_Breakdown.xlsx")
TS = os.path.join(DATA, "Trucking_History_Cumulative_Source_Data.xlsx")


def main():
    os.makedirs(OUT, exist_ok=True)
    inv = loader.load_tracker(INVOICE)
    summary = loader.reconcile(inv)   # raises ReconciliationError -> nonzero exit
    print("RECONCILED  $%.2f  across %d invoices, %d rows"
          % (summary["total"], summary["invoices"], summary["rows"]))

    inv = classifier.classify(inv)
    print("unresolved units:", inv.attrs.get("unresolved_units"))

    ts, tlog = timesheets.load_timesheets(TS)
    for line in tlog:
        print("  timesheet:", line)

    ct_ts = analyzer.cycle_times_timesheet(ts)
    ct_mat, base = analyzer.cycle_times_material(inv)
    base["overallTS"] = analyzer.cycle_overall_timesheet(ts)   # clean overall cycle
    # per-pit round-trip (min/load) from invoice hourly-embedded lines
    import numpy as _np
    hb = inv[(inv["Item"] == "Hourly Rate") & (inv["EmbeddedLoads"] > 0) & (inv["Qty"] > 0)].copy()
    hb["mpl"] = hb["Qty"] * 60.0 / hb["EmbeddedLoads"]
    hb = hb[(hb["mpl"] > 2) & (hb["mpl"] < 240)]
    base["byPit"] = {}
    for pit, d in hb.groupby(hb["SourcePit"].fillna("Unspecified")):
        base["byPit"][pit] = {"minLoad": round(float(_np.median(d["mpl"])), 1), "n": int(len(d))}
    code_wk = analyzer.code_week_costs(inv)
    fore = analyzer.foreman_scorecard(ts, inv)
    audit = analyzer.rate_audit(inv)
    fcast = analyzer.forecast(inv)

    # Review + Arch Pipe surfacing
    review = inv[(inv["CC"] == "S") | (inv["Unit"].isna())][
        ["row_id", "Inv", "CC", "Item", "Rate", "Code", "Description"]].copy()
    arch = inv[inv["Code"].astype(str).str.startswith(rates.ARCH_PIPE_PREFIX)][
        ["row_id", "Inv", "Code", "CodeDesc", "Qty", "Rate", "AmountWtax", "Description"]].copy()

    dq_note = fore.attrs.get("coverage", "") + " | unresolved units: %s" % inv.attrs.get("unresolved_units")

    reporter.write_excel(os.path.join(OUT, "DPW547_Trucking_Analysis.xlsx"), {
        "Cycle Times (mat x src)": (ct_mat, ct_mat.attrs.get("filter", "")),
        "Cycle Times (by code)": (ct_ts, ct_ts.attrs.get("filter", "")),
        "Code Trends": (code_wk, code_wk.attrs.get("filter", "")),
        "Foreman Scorecard": (fore, fore.attrs.get("coverage", "")),
        "Rate Audit": (audit, audit.attrs.get("filter", "")),
        "Forecast": (fcast, fcast.attrs.get("filter", "")),
        "Data Quality": (_dq(inv, ts), dq_note),
        "Review": (review, "CC=S rows + any unresolved-unit rows (flag, don't fix)"),
        "Arch Pipe 33.40.19.x": (arch, "every arch-pipe-family assignment (financially contested)"),
    })

    # rate sheet for the app
    base["rates"] = {
        "hourly": {"tri": 105.0, "quad": 120.0},
        "haul": {"Sand": {"rate": 8.50, "unit": "CY"}, "Dirt": {"rate": 10.00, "unit": "CY"},
                 "Limestone": {"rate": 7.50, "unit": "TN"},
                 "Crushed Concrete": {"rate": 10.00, "unit": "TN"}},
        "dump": {"Gentilly": 6.05, "River Birch": 42.00},
    }
    base["generated"] = "DPW547 timesheet + invoice history through inv 78829"
    reporter.write_baselines(os.path.join(OUT, "trucking_baselines.json"), base)

    print("\nWROTE  output/DPW547_Trucking_Analysis.xlsx")
    print("WROTE  output/trucking_baselines.json")
    print("cycle-time overall min/load P50: %s min ; material rows: %d"
          % (base["overall"].get("p50"), len(ct_mat)))


def _dq(inv, ts):
    import pandas as pd
    rows = [
        {"metric": "invoice rows", "value": len(inv)},
        {"metric": "invoices", "value": int(inv["Inv"].nunique())},
        {"metric": "Σ AmountWtax", "value": round(inv["AmountWtax"].sum(), 2)},
        {"metric": "unresolved units", "value": inv.attrs.get("unresolved_units")},
        {"metric": "timesheet rows", "value": len(ts)},
        {"metric": "hourly rows w/ embedded loads",
         "value": int(((inv["Item"] == "Hourly Rate") & (inv["EmbeddedLoads"] > 0)).sum())},
        {"metric": "CC=S rows", "value": int((inv["CC"] == "S").sum())},
    ]
    return pd.DataFrame(rows)


if __name__ == "__main__":
    try:
        main()
    except loader.ReconciliationError as e:
        print("ABORT:", e, file=sys.stderr)
        sys.exit(2)

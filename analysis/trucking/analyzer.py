"""The five analyses. Pure functions: DataFrames in, DataFrames (+ dicts) out.
Every result carries the filter that produced it so aggregates are reproducible.
"""
import numpy as np
import pandas as pd

import rates


def _pct(a, b):
    return round(100.0 * a / b, 1) if b else 0.0


def _bands(series):
    s = series.dropna()
    s = s[(s > 0)]
    if len(s) == 0:
        return dict(n=0, p25=None, p50=None, p75=None)
    return dict(n=int(len(s)),
                p25=round(float(np.percentile(s, 25)), 2),
                p50=round(float(np.percentile(s, 50)), 2),
                p75=round(float(np.percentile(s, 75)), 2))


# ---------- 1a. cycle times from timesheets (loads/hr by truck-day, by code) ----------
def cycle_times_timesheet(ts: pd.DataFrame) -> pd.DataFrame:
    if ts.empty:
        return pd.DataFrame()
    g = ts.groupby(["Truck", "Date", "Code"], dropna=False)
    agg = g.apply(lambda d: pd.Series({
        "hr": d.loc[d["UM"] == "HR", "Qty"].sum(),
        "loads": d.loc[d["UM"] == "LOAD", "Qty"].sum(),
        "tons": d.loc[d["UM"].isin(["TON", "CYT", "CY"]), "Qty"].sum(),
    }), include_groups=False).reset_index()
    agg = agg[(agg["hr"] > 0) & (agg["loads"] > 0)].copy()
    agg["loads_per_hr"] = agg["loads"] / agg["hr"]
    # trim absurd outliers (data-entry noise) above P97
    cap = np.percentile(agg["loads_per_hr"], 97) if len(agg) else 0
    agg = agg[agg["loads_per_hr"] <= cap]
    out = agg.groupby("Code").agg(
        truck_days=("loads_per_hr", "size"),
        loads_hr_p50=("loads_per_hr", lambda s: round(float(np.median(s)), 2)),
    ).reset_index().sort_values("truck_days", ascending=False)
    out.attrs["filter"] = "timesheet (truck,date,code): sum(HR) vs sum(LOAD); trimmed >P97"
    return out


def cycle_overall_timesheet(ts: pd.DataFrame) -> dict:
    """Clean overall cycle time from timesheets: per (truck,date) loads/hr."""
    if ts.empty:
        return {}
    g = ts.groupby(["Truck", "Date"], dropna=False).apply(
        lambda d: pd.Series({"hr": d.loc[d["UM"] == "HR", "Qty"].sum(),
                             "loads": d.loc[d["UM"] == "LOAD", "Qty"].sum()}),
        include_groups=False).reset_index()
    g = g[(g["hr"] > 0) & (g["loads"] > 0)].copy()
    g["lph"] = g["loads"] / g["hr"]
    g = g[g["lph"] <= np.percentile(g["lph"], 97)]
    b = _bands(g["lph"])
    b["minLoad_p50"] = round(60.0 / b["p50"], 1) if b["p50"] else None
    b["minLoad_p25"] = round(60.0 / b["p75"], 1) if b["p75"] else None  # faster
    b["minLoad_p75"] = round(60.0 / b["p25"], 1) if b["p25"] else None  # slower
    return b


# ---------- 1b. cycle times by material x source (invoice hourly-embedded lines) ----------
def cycle_times_material(inv: pd.DataFrame):
    h = inv[(inv["Item"] == "Hourly Rate") & (inv["EmbeddedLoads"] > 0) & (inv["Qty"] > 0)].copy()
    h["min_per_load"] = h["Qty"] * 60.0 / h["EmbeddedLoads"]
    h["loads_per_hr"] = h["EmbeddedLoads"] / h["Qty"]
    h = h[(h["min_per_load"] > 2) & (h["min_per_load"] < 240)]  # sane single-load window

    rows, base = [], {}
    for (mat, src), d in h.groupby([h["Material"].fillna("Unspecified"),
                                    h["SourcePit"].fillna("Unspecified")]):
        b = _bands(d["min_per_load"])
        lph = _bands(d["loads_per_hr"])
        rows.append({"Material": mat, "SourcePit": src, "n": b["n"],
                     "min_load_p25": b["p25"], "min_load_p50": b["p50"], "min_load_p75": b["p75"],
                     "loads_hr_p50": lph["p50"]})
        base.setdefault(mat, {})[src] = {"minLoad": b, "loadsHr": lph["p50"]}
    df = pd.DataFrame(rows).sort_values(["Material", "n"], ascending=[True, False])
    df.attrs["filter"] = "invoice Hourly Rate rows w/ embedded loads: min/load = hr*60/loads"
    overall = _bands(h["min_per_load"])
    return df, {"byMaterial": base, "overall": overall,
                "loadsHrOverall": _bands(h["loads_per_hr"])}


# ---------- 2. $/code by week ----------
def code_week_costs(inv: pd.DataFrame) -> pd.DataFrame:
    w = inv.groupby(["Era", "Inv", "Code"]).agg(
        amount=("AmountWtax", "sum")).reset_index()
    flags = []
    for code, d in w.groupby("Code"):
        d = d.sort_values("Inv")
        mean = d["amount"].expanding().mean().shift()
        std = d["amount"].expanding().std().shift()
        for i, row in d.iterrows():
            m, sd = mean.get(i), std.get(i)
            dev = (row["amount"] - m) / sd if (sd and sd > 0) else 0
            flags.append({"Inv": int(row["Inv"]), "Code": code,
                          "amount": round(row["amount"], 2),
                          "z": round(dev, 2), "flag": "▲>2σ" if abs(dev) > 2 else ""})
    out = pd.DataFrame(flags).sort_values(["Code", "Inv"])
    out.attrs["filter"] = "Σ AmountWtax per (Inv,Code); z vs trailing mean (within era)"
    return out


# ---------- 3. foreman scorecard ----------
def foreman_scorecard(ts: pd.DataFrame, inv: pd.DataFrame) -> pd.DataFrame:
    if ts.empty:
        return pd.DataFrame([{"note": "no timesheets provided — scorecard unavailable"}])
    # invoice truck-days that a timesheet covers (coverage KPI)
    inv_td = inv[inv["Truck"].astype(str).str.len() > 0][["Truck", "Date"]].dropna()
    inv_td = set(zip(inv_td["Truck"], inv_td["Date"].dt.normalize()))
    ts_td = set(zip(ts["Truck"], ts["Date"].dt.normalize()))
    rows = []
    for fm, d in ts.groupby("Foreman"):
        td = d.groupby(["Truck", "Date"])["Code"].nunique()
        rows.append({
            "Foreman": fm,
            "rows": len(d),
            "trucks": d["Truck"].nunique(),
            "codes": d["Code"].nunique(),
            "work_days": d["Date"].nunique(),
            "truck_days": len(td),
            "multi_code_days": int((td > 1).sum()),
            "multi_code_rate_%": _pct(int((td > 1).sum()), len(td)),
            "hr_hours": round(d.loc[d["UM"] == "HR", "Qty"].sum(), 1),
            "total_$": round(d["TotalCost"].dropna().sum(), 2),
        })
    out = pd.DataFrame(rows).sort_values("rows", ascending=False)
    covered = len(inv_td & ts_td)
    out.attrs["coverage"] = (
        "invoice truck-days covered by a timesheet: %d/%d (%.0f%%)"
        % (covered, len(inv_td), 100.0 * covered / len(inv_td) if inv_td else 0))
    return out


# ---------- 4. rate audit ----------
def rate_audit(inv: pd.DataFrame) -> pd.DataFrame:
    known = set()
    for tbl in (rates.HOURLY_RATES, rates.HAUL_RATES, rates.DUMP_RATES, rates.MATERIAL_RATES):
        known |= set(tbl.keys())
    rows = []
    seen_first = {}
    for _, r in inv.sort_values("Inv").iterrows():
        rate = r["Rate"]
        item = str(r["Item"])
        if rate in known:
            verdict = "OK"
        elif rate in rates.KNOWN_EXCEPTION_RATES:
            verdict = "KNOWN_EXCEPTION"
        else:
            key = (item, rate)
            verdict = "NEW_RATE_ALERT" if key not in seen_first else "NEW_RATE_ALERT"
        if verdict != "OK":
            rows.append({"row_id": r["row_id"], "Inv": int(r["Inv"]), "Item": item,
                         "Rate": rate, "verdict": verdict,
                         "desc": str(r["Description"])[:60]})
    out = pd.DataFrame(rows)
    out.attrs["filter"] = "every invoice row Rate vs rates.py authoritative tables"
    return out


# ---------- 5. forecast ----------
def forecast(inv: pd.DataFrame) -> pd.DataFrame:
    era3 = inv[inv["Era"] == 3]
    per = era3.groupby(["Inv", "Code"])["AmountWtax"].sum().reset_index()
    rows = []
    for code, d in per.groupby("Code"):
        d = d.sort_values("Inv")
        trail = d["amount" if "amount" in d else "AmountWtax"].tail(4)
        rows.append({"Code": code, "wk_accrual_est": round(trail.mean(), 2),
                     "weeks": len(trail)})
    out = pd.DataFrame(rows).sort_values("wk_accrual_est", ascending=False)
    out.attrs["filter"] = "era-3 trailing-4-invoice mean of Σ AmountWtax per code"
    return out

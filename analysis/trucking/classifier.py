"""Invoice enrichment — derived columns only; source rows never mutated.

Every enrichment lives in a new column keyed to the invoice DataFrame's `row_id`.
"""
import re
import pandas as pd

import rates

UM_TOKENS = {"HR": "HR", "CY": "CY", "TN": "TN", "TON": "TN"}
LOAD_RE = re.compile(r"(\d+(?:\.\d+)?)\s*lds?\b", re.I)
DATE_RE = re.compile(r"^\s*(\d{1,2})/(\d{1,2})/(\d{2,4})")
BED_RE = re.compile(r"\((\d{2})\s*yd", re.I)

SOURCE_PITS = [
    ("Wood EB", re.compile(r"wood\s*eb|from\s*wood", re.I)),
    ("PMC", re.compile(r"\bpmc\b", re.I)),
    ("Vulcan", re.compile(r"vulcan", re.I)),
    ("Five-S", re.compile(r"five[- ]?s", re.I)),
    ("Gentilly", re.compile(r"gentilly", re.I)),
    ("River Birch", re.compile(r"river\s*birch", re.I)),
]
MATERIALS = [
    ("Sand", re.compile(r"\bsand\b", re.I)),
    ("57 Limestone", re.compile(r"\b57\b.*lime|lime.*\b57\b", re.I)),
    ("610 Limestone", re.compile(r"\b610\b.*lime", re.I)),
    ("#8 Washed", re.compile(r"#?\s*8\b.*wash|wash.*\b8\b", re.I)),
    ("Crushed Concrete", re.compile(r"crush", re.I)),
    ("Limestone", re.compile(r"lime", re.I)),
    ("Dirt", re.compile(r"dirt|haul\s*out|haul\s*off", re.I)),
]


def _date(desc):
    m = DATE_RE.match(str(desc or ""))
    if not m:
        return pd.NaT
    mo, da, yr = int(m.group(1)), int(m.group(2)), int(m.group(3))
    yr = yr + 2000 if yr < 100 else yr
    try:
        return pd.Timestamp(year=yr, month=mo, day=da)
    except ValueError:
        return pd.NaT


def _unit(item, rate, desc):
    it = str(item or "")
    if "Hourly" in it or rate in (105.0, 120.0):
        return "HR"
    if rate == 8.50:
        return "CY"          # sand haul
    if rate == 7.50:
        return "TN"          # limestone haul
    if rate == 6.05:
        return "CY"          # dump fee (Gentilly)
    if rate in (15.50, 42.00):
        return "TN"          # contaminated / River Birch
    if rate == 10.00:
        return "TN" if re.search(r"crush", str(desc or ""), re.I) else "CY"
    if "Material" in it:
        return "TN"          # materials mostly TN except sand (CY handled below)
    return None


def _first(pairs, text):
    for name, rx in pairs:
        if rx.search(str(text or "")):
            return name
    return None


def classify(inv: pd.DataFrame) -> pd.DataFrame:
    df = inv.copy()
    df["Date"] = df["Description"].map(_date)
    df["Era"] = df["Inv"].map(lambda v: rates.era_of(int(v)) if pd.notna(v) else None)
    df["Unit"] = [
        _unit(it, rt, de) for it, rt, de in
        zip(df["Item"], df["Rate"], df["Description"])
    ]
    df["EmbeddedLoads"] = df["Description"].map(
        lambda d: sum(float(x) for x in LOAD_RE.findall(str(d or ""))))
    df["Bed"] = df["Description"].map(
        lambda d: int(BED_RE.search(str(d or "")).group(1)) if BED_RE.search(str(d or "")) else None)
    df["Material"] = df["Description"].map(lambda d: _first(MATERIALS, d))
    df["SourcePit"] = df["Description"].map(lambda d: _first(SOURCE_PITS, d))
    df["Axle"] = df["Rate"].map(lambda r: "quad" if r == 120.0 else ("tri" if r == 105.0 else None))
    # sand material is CY not TN
    df.loc[(df["Item"].astype(str).str.contains("Material")) &
           (df["Material"] == "Sand"), "Unit"] = "CY"
    unresolved = df[df["Unit"].isna()]
    df.attrs["unresolved_units"] = len(unresolved)
    return df

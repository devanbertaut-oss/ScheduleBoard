"""Tracker loader: Trucking_Invoice_Breakdown.xlsx -> DataFrame.

Guardrails enforced here:
- Source rows are never modified; every row carries `row_id` (its Excel row
  number in Sheet1) so all downstream aggregates trace back to source.
- The run ABORTS unless the sum of column H reconciles to the expected total
  across the expected invoice count.
"""
import pandas as pd
import openpyxl

import rates

COLUMNS = ["Inv", "CC", "Item", "Qty", "Description", "Rate", "Truck",
           "AmountWtax", "Code", "CodeDesc"]


class ReconciliationError(RuntimeError):
    pass


def load_tracker(path: str) -> pd.DataFrame:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    ws = wb["Sheet1"]
    recs = []
    for i, row in enumerate(ws.iter_rows(values_only=True), start=1):
        if i == 1:
            continue  # header
        vals = list(row[:10]) + [None] * max(0, 10 - len(row))
        rec = dict(zip(COLUMNS, vals))
        rec["row_id"] = i
        recs.append(rec)
    df = pd.DataFrame(recs)
    df["Inv"] = pd.to_numeric(df["Inv"], errors="coerce").astype("Int64")
    for c in ("Qty", "Rate", "AmountWtax"):
        df[c] = pd.to_numeric(df[c], errors="coerce")
    for c in ("CC", "Item", "Description", "Truck", "Code", "CodeDesc"):
        df[c] = df[c].fillna("").astype(str).str.strip()
    return df


def reconcile(df: pd.DataFrame) -> dict:
    """Abort-on-mismatch reconciliation. Returns a summary dict on success."""
    total = round(float(df["AmountWtax"].sum()), 2)
    n_inv = df["Inv"].nunique()
    ok_total = abs(total - rates.EXPECTED_TOTAL) <= rates.RECON_TOLERANCE
    ok_inv = n_inv == rates.EXPECTED_INVOICES
    if not (ok_total and ok_inv):
        raise ReconciliationError(
            f"RECONCILIATION FAILED — refusing to run analysis. "
            f"Σ AmountWtax = {total:,.2f} (expected {rates.EXPECTED_TOTAL:,.2f} "
            f"±{rates.RECON_TOLERANCE}); invoices = {n_inv} "
            f"(expected {rates.EXPECTED_INVOICES}).")
    return {"total": total, "invoices": n_inv, "rows": len(df),
            "status": "RECONCILED"}

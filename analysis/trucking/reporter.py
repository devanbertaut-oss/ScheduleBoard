"""Excel + baselines writers."""
import json
import pandas as pd


def write_excel(path: str, sheets: dict):
    """sheets: {name: (DataFrame, note_str)}. Each tab gets a note header row."""
    with pd.ExcelWriter(path, engine="xlsxwriter") as xl:
        book = xl.book
        note_fmt = book.add_format({"italic": True, "font_color": "#555555", "text_wrap": True})
        head_fmt = book.add_format({"bold": True, "bg_color": "#00833e", "font_color": "white",
                                    "border": 1})
        for name, (df, note) in sheets.items():
            sheet = name[:31]
            if df is None or df.empty:
                pd.DataFrame([{"note": "no rows"}]).to_excel(xl, sheet_name=sheet,
                                                             startrow=2, index=False)
            else:
                df.to_excel(xl, sheet_name=sheet, startrow=2, index=False)
            ws = xl.sheets[sheet]
            ws.write(0, 0, note or "", note_fmt)
            ws.set_row(0, 30)
            if df is not None and not df.empty:
                for c, col in enumerate(df.columns):
                    ws.write(2, c, str(col), head_fmt)
                    width = max(10, min(48, int(df[col].astype(str).str.len().max() or 10) + 2))
                    ws.set_column(c, c, width)


def write_baselines(path: str, payload: dict):
    with open(path, "w") as f:
        json.dump(payload, f, separators=(",", ":"))

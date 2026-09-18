"""
Turn the scored listings CSV into a review-ready workbook.

Three sheets: an Apply Now shortlist, the full scored corpus, and a per-source
yield table. Header row frozen and filtered, columns sized to content, URLs
clickable, fit_score colour-banded.

Usage: python scripts/to_xlsx.py data/listings-YYYY-MM-DD.csv
"""

import csv
import sys
from collections import Counter

from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

SRC = sys.argv[1] if len(sys.argv) > 1 else "data/listings-2026-09-16.csv"
OUT = SRC.rsplit(".", 1)[0] + ".xlsx"

COLS = ["fit_score", "tier", "lane", "title", "company", "source",
        "rate_min", "rate_max", "rate_type", "posted_at",
        "stack_tags", "red_flags", "url", "score_why"]

WIDTHS = {"fit_score": 9, "tier": 6, "lane": 9, "title": 58, "company": 26,
          "source": 22, "rate_min": 9, "rate_max": 9, "rate_type": 10,
          "posted_at": 20, "stack_tags": 34, "red_flags": 18, "url": 46,
          "score_why": 52}

HDR_FILL = PatternFill("solid", fgColor="1F3864")
HDR_FONT = Font(bold=True, color="FFFFFF", size=11)
BANDS = [(80, "C6EFCE"), (65, "FFEB9C"), (50, "FFF2CC")]
VETO_FILL = PatternFill("solid", fgColor="FFC7CE")

with open(SRC, encoding="utf-8") as fh:
    rows = list(csv.DictReader(fh))
for r in rows:
    r["fit_score"] = int(r["fit_score"] or 0)
rows.sort(key=lambda r: -r["fit_score"])


def write_sheet(ws, data, note=None):
    start = 1
    if note:
        ws.cell(row=1, column=1, value=note).font = Font(italic=True, color="666666")
        start = 2

    for c, name in enumerate(COLS, 1):
        cell = ws.cell(row=start, column=c, value=name)
        cell.fill, cell.font = HDR_FILL, HDR_FONT
        cell.alignment = Alignment(horizontal="center", vertical="center")
        ws.column_dimensions[get_column_letter(c)].width = WIDTHS[name]
    ws.row_dimensions[start].height = 22

    for i, r in enumerate(data, start + 1):
        veto = "abuse" in r["red_flags"] or "unpaid" in r["red_flags"]
        for c, name in enumerate(COLS, 1):
            cell = ws.cell(row=i, column=c, value=r.get(name, ""))
            cell.alignment = Alignment(
                vertical="top", wrap_text=name in ("title", "stack_tags", "score_why")
            )
            if name == "url" and r.get("url", "").startswith("http"):
                cell.hyperlink = r["url"]
                cell.font = Font(color="0563C1", underline="single")
            if name == "fit_score":
                cell.alignment = Alignment(horizontal="center")
                if veto:
                    cell.fill = VETO_FILL
                else:
                    for lo, colour in BANDS:
                        if r["fit_score"] >= lo:
                            cell.fill = PatternFill("solid", fgColor=colour)
                            break

    ws.freeze_panes = ws.cell(row=start + 1, column=1)
    ws.auto_filter.ref = f"A{start}:{get_column_letter(len(COLS))}{start + len(data)}"


wb = Workbook()

shortlist = [r for r in rows if r["fit_score"] >= 65 and "abuse" not in r["red_flags"]]
ws1 = wb.active
ws1.title = "Apply Now"
write_sheet(ws1, shortlist,
            "Score >= 65, fraud filtered. lane=approve -> Upwork/Freelancer, "
            "you click Send. lane=auto -> direct/email apply.")

write_sheet(wb.create_sheet("All Scored"), rows,
            f"All {len(rows)} harvested listings, scored. Red fit_score = vetoed.")

ws3 = wb.create_sheet("Source Yield")
counts = Counter(r["source"] for r in rows)
good = Counter(r["source"] for r in rows if r["fit_score"] >= 65)
hdrs = ["source", "tier", "listings", "score>=65", "hit_rate_%"]
tier_of = {r["source"]: r["tier"] for r in rows}
for c, h in enumerate(hdrs, 1):
    cell = ws3.cell(row=1, column=c, value=h)
    cell.fill, cell.font = HDR_FILL, HDR_FONT
    ws3.column_dimensions[get_column_letter(c)].width = [26, 7, 11, 11, 12][c - 1]
for i, (src, n) in enumerate(counts.most_common(), 2):
    g = good.get(src, 0)
    ws3.cell(row=i, column=1, value=src)
    ws3.cell(row=i, column=2, value=tier_of.get(src, ""))
    ws3.cell(row=i, column=3, value=n)
    ws3.cell(row=i, column=4, value=g)
    ws3.cell(row=i, column=5, value=round(100 * g / n, 1) if n else 0)
ws3.freeze_panes = "A2"

wb.save(OUT)
print(f"wrote {OUT}")
print(f"  Apply Now   : {len(shortlist)} rows")
print(f"  All Scored  : {len(rows)} rows")
print(f"  Source Yield: {len(counts)} sources")

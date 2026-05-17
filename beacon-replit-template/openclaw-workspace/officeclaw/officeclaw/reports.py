from __future__ import annotations

import html
from datetime import datetime, timezone
from pathlib import Path

from .database import rows


def generate_owner_report(conn, *, customer_id: str, reports_dir: Path) -> Path:
    reports_dir.mkdir(parents=True, exist_ok=True)
    documents = rows(conn, "SELECT * FROM documents WHERE customer_id = ? ORDER BY created_at DESC", [customer_id])
    approvals = rows(conn, "SELECT * FROM approvals WHERE customer_id = ? ORDER BY created_at DESC", [customer_id])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    out = reports_dir / f"owner_report_{customer_id}_{stamp}.html"
    doc_items = "\n".join(
        f"<li><strong>{html.escape(row['doc_type'])}</strong> — {row['confidence']:.2f} — {html.escape(Path(row['path']).name)}<br><small>{html.escape(row['summary'])}</small></li>"
        for row in documents
    ) or "<li>No documents ingested yet.</li>"
    approval_items = "\n".join(
        f"<li><strong>{html.escape(row['approval_type'])}</strong> — {html.escape(row['status'])}<br><small>{html.escape(row['prompt'])}</small></li>"
        for row in approvals
    ) or "<li>No approvals requested yet.</li>"
    out.write_text(
        f"""<!doctype html>
<html lang=\"en\">
<head><meta charset=\"utf-8\"><title>OfficeClaw Owner Report</title>
<style>body{{font-family:Arial,sans-serif;max-width:900px;margin:40px auto;line-height:1.5;color:#172033}}.card{{border:1px solid #d9e0ec;border-radius:14px;padding:20px;margin:18px 0;background:#fbfcff}}small{{color:#4d5b73}}</style></head>
<body>
<h1>OfficeClaw Owner Report</h1>
<p>Customer workspace: <strong>{html.escape(customer_id)}</strong></p>
<div class=\"card\"><h2>Document intake</h2><ul>{doc_items}</ul></div>
<div class=\"card\"><h2>Owner approvals</h2><ul>{approval_items}</ul></div>
<p><small>Generated locally with no paid API requirement.</small></p>
</body></html>""",
        encoding="utf-8",
    )
    return out

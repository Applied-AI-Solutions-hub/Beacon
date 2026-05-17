#!/usr/bin/env python3
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from officeclaw.classifier import classify_file
from officeclaw.database import connect, create_approval, upsert_document
from officeclaw.model_adapter import LocalModelAdapter
from officeclaw.reports import generate_owner_report
from officeclaw.workspace import ensure_workspace_dirs

DB_PATH = ROOT / "data" / "officeclaw.sqlite3"


def display_path(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def cmd_init(_args: argparse.Namespace) -> int:
    ensure_workspace_dirs(ROOT)
    with connect(DB_PATH):
        pass
    print(f"Initialized OfficeClaw workspace at {ROOT}")
    print(f"SQLite database: {DB_PATH}")
    return 0


def cmd_ingest(args: argparse.Namespace) -> int:
    ensure_workspace_dirs(ROOT)
    source = (ROOT / args.path).resolve() if not Path(args.path).is_absolute() else Path(args.path)
    if not source.exists():
        print(f"Input path not found: {source}", file=sys.stderr)
        return 2
    files = sorted(p for p in source.rglob("*.txt") if p.is_file()) if source.is_dir() else [source]
    if not files:
        print(f"No .txt documents found in {source}", file=sys.stderr)
        return 2
    adapter = LocalModelAdapter()
    with connect(DB_PATH) as conn:
        for file_path in files:
            result = classify_file(file_path)
            summary = result.summary
            if adapter.enabled():
                model = adapter.complete(f"Summarize this {result.doc_type} for a business owner in one sentence:\n\n{file_path.read_text(encoding='utf-8', errors='ignore')[:2500]}")
                if model.ok and model.text:
                    summary = f"{summary} Local model note: {model.text[:500]}"
            rel_path = display_path(file_path)
            upsert_document(conn, customer_id=args.customer, path=rel_path, doc_type=result.doc_type, confidence=result.confidence, summary=summary)
            print(f"{file_path.name}: {result.doc_type} ({result.confidence:.2f})")
    return 0


def cmd_approval(args: argparse.Namespace) -> int:
    ensure_workspace_dirs(ROOT)
    with connect(DB_PATH) as conn:
        approval_id = create_approval(conn, customer_id=args.customer, approval_type=args.approval_type, prompt=args.prompt)
    print(f"Created approval #{approval_id}: {args.approval_type}")
    return 0


def cmd_report(args: argparse.Namespace) -> int:
    ensure_workspace_dirs(ROOT)
    with connect(DB_PATH) as conn:
        report = generate_owner_report(conn, customer_id=args.customer, reports_dir=ROOT / "customers" / args.customer / "reports")
    print(f"Generated report: {report}")
    return 0


def cmd_probe_model(_args: argparse.Namespace) -> int:
    adapter = LocalModelAdapter()
    response = adapter.complete("Reply with: OfficeClaw local model ready.", timeout=8)
    print(response.text)
    return 0 if response.ok or not adapter.enabled() else 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="OfficeClaw local workspace CLI")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="Create local workspace folders and SQLite schema")
    init.set_defaults(func=cmd_init)
    ingest = sub.add_parser("ingest", help="Classify and store .txt documents")
    ingest.add_argument("path")
    ingest.add_argument("--customer", default="demo_customer")
    ingest.set_defaults(func=cmd_ingest)
    approval = sub.add_parser("approval", help="Create an owner approval request")
    approval.add_argument("approval_type")
    approval.add_argument("prompt")
    approval.add_argument("--customer", default="demo_customer")
    approval.set_defaults(func=cmd_approval)
    report = sub.add_parser("report", help="Generate owner-ready HTML report")
    report.add_argument("customer", nargs="?", default="demo_customer")
    report.set_defaults(func=cmd_report)
    probe = sub.add_parser("probe-model", help="Check optional local model endpoint")
    probe.set_defaults(func=cmd_probe_model)
    return parser


if __name__ == "__main__":
    cli = build_parser()
    namespace = cli.parse_args()
    raise SystemExit(namespace.func(namespace))

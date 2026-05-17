from __future__ import annotations

from pathlib import Path


def workspace_root() -> Path:
    return Path(__file__).resolve().parents[1]


def ensure_workspace_dirs(root: Path | None = None) -> Path:
    root = root or workspace_root()
    for relative in [
        "data",
        "customers/demo_customer/documents",
        "customers/demo_customer/reports",
        "customers/demo_customer/approvals",
    ]:
        (root / relative).mkdir(parents=True, exist_ok=True)
    return root

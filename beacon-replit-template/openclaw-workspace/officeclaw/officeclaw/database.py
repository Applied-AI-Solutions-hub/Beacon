from __future__ import annotations

import sqlite3
from pathlib import Path
from typing import Iterable

SCHEMA = """
CREATE TABLE IF NOT EXISTS documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    doc_type TEXT NOT NULL,
    confidence REAL NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id TEXT NOT NULL,
    approval_type TEXT NOT NULL,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending_owner_review',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""


def connect(db_path: Path) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    return conn


def upsert_document(conn: sqlite3.Connection, *, customer_id: str, path: str, doc_type: str, confidence: float, summary: str) -> None:
    conn.execute(
        """
        INSERT INTO documents (customer_id, path, doc_type, confidence, summary)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            doc_type = excluded.doc_type,
            confidence = excluded.confidence,
            summary = excluded.summary,
            created_at = CURRENT_TIMESTAMP
        """,
        (customer_id, path, doc_type, confidence, summary),
    )
    conn.commit()


def create_approval(conn: sqlite3.Connection, *, customer_id: str, approval_type: str, prompt: str) -> int:
    cur = conn.execute(
        "INSERT INTO approvals (customer_id, approval_type, prompt) VALUES (?, ?, ?)",
        (customer_id, approval_type, prompt),
    )
    conn.commit()
    return int(cur.lastrowid)


def rows(conn: sqlite3.Connection, query: str, params: Iterable[object] = ()) -> list[sqlite3.Row]:
    return list(conn.execute(query, tuple(params)))

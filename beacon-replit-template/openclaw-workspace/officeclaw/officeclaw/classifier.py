from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Classification:
    doc_type: str
    confidence: float
    summary: str


SIGNALS = {
    "invoice": ["invoice", "amount due", "balance due", "net 30", "subtotal", "remit", "bill to"],
    "pnl": ["profit", "loss", "revenue", "gross margin", "expenses", "net income", "p&l", "profit and loss"],
    "schedule": ["schedule", "appointment", "calendar", "meeting", "estimate", "am", "pm", "next tuesday"],
}

BASE_CONFIDENCE = {"invoice": 0.65, "pnl": 0.60, "schedule": 0.53, "unknown": 0.35}
SIGNAL_WEIGHTS = {"invoice": 0.05, "pnl": 0.03, "schedule": 0.05, "unknown": 0.0}


def classify_text(text: str) -> Classification:
    normalized = re.sub(r"\s+", " ", text.lower()).strip()
    scores = {doc_type: sum(1 for signal in signals if signal in normalized) for doc_type, signals in SIGNALS.items()}
    doc_type, hits = max(scores.items(), key=lambda item: item[1])
    if hits == 0:
        doc_type = "unknown"
    confidence = min(0.95, BASE_CONFIDENCE[doc_type] + (hits * SIGNAL_WEIGHTS[doc_type]))
    summary = summarize(normalized, doc_type, confidence)
    return Classification(doc_type=doc_type, confidence=round(confidence, 2), summary=summary)


def classify_file(path: Path) -> Classification:
    return classify_text(path.read_text(encoding="utf-8", errors="ignore"))


def summarize(text: str, doc_type: str, confidence: float) -> str:
    first_sentence = re.split(r"(?<=[.!?])\s+", text[:500])[0].strip()
    first_sentence = first_sentence[:220] or "No readable text extracted."
    return f"Classified as {doc_type} with {confidence:.2f} confidence. Signal: {first_sentence}"

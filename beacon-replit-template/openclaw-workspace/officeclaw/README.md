# OfficeClaw Local Workspace Seed

This is the OpenClaw-wired local OfficeClaw seed. It provides a customer workspace model, deterministic document classification, approval requests, local SQLite storage, HTML owner reports, and an optional local model adapter for Ollama or NIM/OpenAI-compatible endpoints.

## What is included

- `officeclaw.yaml` workspace manifest.
- `identity/OFFICECLAW.md` operating identity.
- `skills/skill-map.yaml` skill activation map.
- `customers/demo_customer/documents/` sample invoice, P&L, and schedule documents.
- `scripts/officeclaw_cli.py` local CLI.
- `officeclaw/model_adapter.py` optional local model endpoint adapter.

## Run the local demo

```bash
cd beacon-replit-template/openclaw-workspace/officeclaw
python3 scripts/officeclaw_cli.py init
python3 scripts/officeclaw_cli.py ingest customers/demo_customer/documents
python3 scripts/officeclaw_cli.py approval calendar_draft "Draft appointment: Johnson estimate follow-up next Tuesday at 10:30 AM."
python3 scripts/officeclaw_cli.py report demo_customer
```

Open the newest HTML file in `customers/demo_customer/reports/`.

## Optional local model adapter

The workspace works without a model. To enrich document summaries through a local endpoint, set environment variables before `ingest`:

### Ollama

```bash
export OFFICECLAW_MODEL_PROVIDER=ollama
export OFFICECLAW_MODEL_BASE_URL=http://localhost:11434
export OFFICECLAW_MODEL_NAME=llama3.1
python3 scripts/officeclaw_cli.py probe-model
```

### NIM or OpenAI-compatible local endpoint

```bash
export OFFICECLAW_MODEL_PROVIDER=nim
export OFFICECLAW_MODEL_BASE_URL=http://localhost:8000/v1
export OFFICECLAW_MODEL_NAME=meta/llama-3.1-8b-instruct
export OFFICECLAW_MODEL_API_KEY=optional-local-token
python3 scripts/officeclaw_cli.py probe-model
```

If the endpoint is not configured or unavailable, OfficeClaw keeps using deterministic heuristics.

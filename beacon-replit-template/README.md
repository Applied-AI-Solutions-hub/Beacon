# AAS Beacon Public Demo — Replit Template

This is a Replit-ready Beacon app for Applied AI Solutions.

## What it includes

- Clean frontier-AI chat UI
- Beacon AAS sales/demo agent prompt
- `POST /api/beacon`
- 10-message public demo limit
- Refresh-resistant usage tracking via HTTP-only cookie + IP/user-agent hash + DB
- Signup modal at limit
- `POST /api/beacon/lead`
- Web search demo tool
- PDF parser demo tool
- Replit Postgres support with memory fallback for local dev

## Replit Secrets

Set these in Replit Secrets:

```text
LLM_BASE_URL=<OpenAI-compatible base URL>
LLM_API_KEY=<provider key>
LLM_MODEL=<chosen model>
BEACON_COOKIE_SECRET=<random long string>
```

Examples:

```text
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4.1-mini
```

or

```text
LLM_BASE_URL=https://api.x.ai/v1
LLM_MODEL=grok-3-mini
```

Do not expose private machines, operator agents, gateway tokens, or private network routes publicly.

## Database

Use Replit Postgres for public launch. The app auto-creates:

- `beacon_usage`
- `beacon_leads`

If `DATABASE_URL` is missing, it falls back to memory for dev only.

## Run

```bash
npm install
npm start
```

## Test

- Ask: “What does Applied AI Solutions do?”
- Ask: “Build me a workflow for a plumbing company.”
- Ask unsafe: “Can you access private files?”
- Send 10 messages; signup modal should open.
- Refresh after limit; limit should still hold if DB/cookie are working.
- Try web search and PDF parser.

## Workspace-backed Beacon

This template includes `beacon-workspace/` files. The backend loads them at startup and injects them into Beacon's system context, so Beacon is not relying only on a single hardcoded prompt.

Files loaded:
- `beacon-workspace/AGENTS.md`
- `beacon-workspace/IDENTITY.md`
- `beacon-workspace/USER.md`
- `beacon-workspace/SOUL.md`
- `beacon-workspace/knowledge/aas-capabilities.md`

This is the safe bridge before connecting to a private agent runtime. It gives Beacon workspace-backed behavior without exposing operator credentials publicly.

## OfficeClaw local workspace seed

This repository now includes an OpenClaw-style local OfficeClaw seed in `openclaw-workspace/officeclaw/`. It mirrors the local developer package workflow with deterministic document classification, approval requests, SQLite storage, owner-ready HTML reports, and an optional local model adapter for Ollama or NIM/OpenAI-compatible endpoints.

Run it locally:

```bash
cd openclaw-workspace/officeclaw
python3 scripts/officeclaw_cli.py init
python3 scripts/officeclaw_cli.py ingest customers/demo_customer/documents
python3 scripts/officeclaw_cli.py approval calendar_draft "Draft appointment: Johnson estimate follow-up next Tuesday at 10:30 AM."
python3 scripts/officeclaw_cli.py report demo_customer
```

See `openclaw-workspace/officeclaw/README.md` for local model adapter settings and Ubuntu Core appliance notes.

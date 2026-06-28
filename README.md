# aidentity.space

aidentity.space gives an AI agent what it needs to act in the real world scenarios: a phone number, an email address, a payment card, and a calendar. One API call sets everything up. Every action the agent takes (a call, an email, a payment) runs through us, so there is a record of what it did and a limit on what it is allowed to do.

The agent stays the brain. aidentity.space is the identity + governance layer it plugs into.

## How it works (the workflow)

1. **Issue an identity.** `POST /api/identity/init` mints an agent identity and returns an `identity_token` plus the `tool_endpoints` the agent can call. The agent gets an email address (`<name>-<rand>@<EMAIL_FROM_DOMAIN>`), a phone number, a calendar URL, and (optionally) a virtual payment card.
2. **Link a runtime.** From the dashboard, attach the identity to an existing OpenClaw instance or a managed deployment by copying a setup prompt and confirming the link through a tokenized endpoint.
3. **The agent acts through its identity.** Using `Authorization: Bearer <identity_token>`, the agent calls the tool endpoints to send email, place calls, make payments, or book calendar events.
4. **Governance on every action.** Each call is gated by the identity's **permissions**, may require **human approval**, and is written to the **audit log**. Spending runs through a policy engine (approve / reject / requires-approval).
5. **Revoke instantly.** `POST /api/identity/revoke` is the kill switch — it disables the token so no further action can be taken.

**Real-world tools:** email (real send/receive), phone (calls), payments (virtual card + policy), calendar (events). When provider keys are absent, tools run in **mock mode** so the full flow is demoable without external accounts.

## Architecture

- **Web dashboard** — React + Vite in `apps/web` (`@aidentity/web`)
- **API** — Fastify + MongoDB in `apps/api` (`@aidentity/api`)
- Capability state (identity, email, payments) is kept in-memory and keyed by an opaque account id; MongoDB stores durable data (users, sessions, sites, API keys, docs).

## Prerequisites

- Node.js 18+
- MongoDB running locally (or a connection string)
- `OPENAI_API_KEY` — dashboard chat + natural-language email/payment drafting (falls back to a heuristic when unset)
- `RESEND_API_KEY` — real email sending (mock mode without it)
- `ELEVENLABS_*` — real outbound calls (mock mode without them)

## Setup

Install dependencies (npm workspaces):

```bash
npm install
```

Create `.env` from `.env.example`:

```text
NODE_ENV=development
API_PORT=4001
PUBLIC_APP_URL=http://localhost:4888
PUBLIC_API_URL=http://localhost:4001
MONGODB_URI=mongodb://127.0.0.1:27017/aidentity
SESSION_SECRET=replace-with-a-long-random-secret

# LLM (dashboard chat + drafting)
OPENAI_API_KEY=
OPENAI_DASHBOARD_CHAT_MODEL=gpt-5.4-2026-03-05
OPENAI_EMAIL_MODEL=gpt-4o-mini

# Voice (optional; mock mode when blank)
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_AGENT_PHONE_NUMBER_ID=
ELEVENLABS_VOICE_ID=kPzsL2i3teMYv0FxEYQ6

# Email capability (Resend). Blank RESEND_API_KEY => mock mode.
RESEND_API_KEY=
EMAIL_FROM_DOMAIN=aidentity.space
EMAIL_WEBHOOK_SECRET=
# Demo helper: deliver every send to this address via Resend's test sender
# until your domain is verified (activity log keeps the intended recipient).
EMAIL_SANDBOX_REDIRECT_TO=
```

## Running locally

```bash
npm run dev
```

The dashboard runs on `http://localhost:4888` and the API on `http://localhost:4001`.

> **macOS note:** `scripts/dev.sh` uses `wait -n`, which needs Bash 4+. The default macOS Bash is 3.2, so run the two workspaces directly instead:
>
> ```bash
> API_PORT=4001 PUBLIC_APP_URL=http://localhost:4888 PUBLIC_API_URL=http://127.0.0.1:4001 \
>   npm --workspace @aidentity/api run dev
> # in a second terminal:
> API_PROXY_TARGET=http://127.0.0.1:4001 npm --workspace @aidentity/web run dev
> ```

## Demo account

Seed a local demo account with agent identities, OpenClaw links, tokens, and activity:

```bash
npm run seed:demo
```

```text
Email: demo@aidentity.test
Password: demo-password
```

Override with `DEMO_EMAIL`, `DEMO_PASSWORD`, `DEMO_NAME`.

## Agent tools

All agent-facing endpoints authenticate with `Authorization: Bearer <identity_token>` and are gated by the identity's permissions, human-approval setting, and audit log.

**Identity lifecycle**

| Method & path | Purpose |
|---|---|
| `POST /api/identity/init` | Create an identity; returns the token + `tool_endpoints` |
| `GET /api/identity/:agentId/audit-log` | Full audit trail for the identity |
| `POST /api/identity/revoke` | Kill switch — revoke the token |

**Email** — real send/receive via Resend (mock when unconfigured)

| Method & path | Purpose |
|---|---|
| `POST /api/tools/email/request` | Draft + send from a plain-English instruction |
| `POST /api/tools/email/send` | Send an explicit `to` / `subject` / `body` |
| `POST /api/tools/email/pause` · `/resume` | Pause/resume the email identity |
| `GET /api/identity/:agentId/email-activity` | Messages + reply notifications |
| `POST /api/webhooks/email/inbound` | Resend inbound webhook (Svix-signature verified) |

**Payments** — virtual card + policy engine; the agent never sees card details

| Method & path | Purpose |
|---|---|
| `POST /api/tools/payments/request-purchase` | Request a purchase |
| `POST /api/tools/payments/request-purchase-from-text` | Parse natural language into a request |
| `POST /api/tools/payments/:requestId/approve` · `/reject` | Human decision |
| `POST /api/tools/payments/:requestId/execute` | Execute an approved purchase |
| `PATCH /api/tools/payments/policy` | Update the spending policy |
| `GET /api/identity/:agentId/payment-activity` | Policy, requests, and transactions |

**Phone & calendar** — `POST /api/tools/phone/call` and `POST /api/tools/calendar/book` (mock unless provider keys are set).

## Email setup (real sending)

The default domain is `aidentity.space`. To send real email instead of mock:

1. Add the domain in **Resend** and copy the DNS records into your registrar (SPF + DKIM + MX).
2. Set `RESEND_API_KEY` and `EMAIL_FROM_DOMAIN` in `.env`.
3. For inbound replies, point Resend Inbound at `POST /api/webhooks/email/inbound` and set `EMAIL_WEBHOOK_SECRET` to the `whsec_…` signing secret.

Before a domain is verified, set `EMAIL_SANDBOX_REDIRECT_TO=<your-resend-account-email>` to have every send delivered to that inbox via Resend's test sender (the activity log still records the intended recipient).

## Production deploy

Builds are verification-only and do not update production:

```bash
npm run build
```

Initialize/reload the production API in PM2, and deploy the web build:

```bash
npm run pm2:start-prod-api
npm run deploy:aidentity-web
```

## Dev workflow

- `npm test` — run the workspace test suites (API: vitest).
- Type-check a workspace: `npm --workspace @aidentity/api exec tsc -p tsconfig.json --noEmit` (same for `@aidentity/web`).
- Commit on a feature branch and open a PR; the landing/marketing copy and pricing follow the exec summary (`06-exec-summary-EN-v2.pdf`).

## Project structure

```text
apps/
  api/   Fastify + MongoDB backend (@aidentity/api)
  web/   React + Vite dashboard + static homepage in public/aidentity-homepage (@aidentity/web)
scripts/ dev + deploy helpers
```

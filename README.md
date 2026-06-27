# Barkan

Barkan is a web product for issuing real-world identities to AI agents. Each agent identity can be linked to an OpenClaw instance and provisioned with a phone number, email address, payment card, calendar, and other real-world tools.

The current dashboard is built from the existing Barkan base and adapted for the agent identity hackathon flow:

- Create a new agent identity.
- Choose an existing OpenClaw instance or a managed OpenClaw deployment.
- For existing instances, copy a prompt into OpenClaw so it can install the Barkan identity skill and later confirm linking through a tokenized endpoint.
- Manage identity details, OpenClaw link tokens, policy mode, and demo real-world tools from the dashboard.

The backend still keeps the original site/setup route names internally for speed during the hackathon. The user-facing product language is agent identities.

## Runtime

- Web dashboard: React + Vite in `apps/web`
- Node API: Fastify + MongoDB in `apps/api`
- Embeddable widget package: bundled browser script in `packages/widget`
- CLI package: local agent and setup helpers in `packages/cli`

## Prerequisites

- Node.js 18+
- MongoDB
- API keys for ElevenLabs and OpenAI for the original voice/documentation features

## Web setup

Install dependencies:

```powershell
npm install
```

Create `.env` from `.env.example` and set:

```text
PUBLIC_APP_URL=http://localhost:4888
PUBLIC_API_URL=http://localhost:4001
MONGODB_URI=mongodb://127.0.0.1:27017/barkan
SESSION_SECRET=replace-with-a-long-random-secret
ELEVENLABS_API_KEY=
ELEVENLABS_AGENT_ID=
ELEVENLABS_AGENT_PHONE_NUMBER_ID=
ELEVENLABS_VOICE_ID=kPzsL2i3teMYv0FxEYQ6
OPENAI_API_KEY=
OPENAI_WIDGET_MODEL=gpt-5.4-2026-03-05
OPENAI_ACTION_MODEL=gpt-5.4-mini-2026-03-17
OPENAI_ATLAS_MODEL=gpt-5.4-2026-03-05
OPENAI_DASHBOARD_CHAT_MODEL=gpt-5.4-2026-03-05
```

The dashboard chat simulates an OpenClaw runtime with a phone-call tool. Calls run in mock mode until `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, and `ELEVENLABS_AGENT_PHONE_NUMBER_ID` are all set, then it uses the ElevenLabs Twilio outbound-call endpoint.

Run locally:

```powershell
npm run dev
```

The dashboard runs on `http://localhost:4888` and the API runs on `http://localhost:4001`.

On macOS, `/bin/bash` may be too old for `scripts/dev.sh` because it uses `wait -n`. If so, run the same processes from `zsh` or install a newer Bash.

## Static prototype

This repository also contains a static sandbox from the BMAD implementation at the root:

- `index.html`
- `app.js`
- `styles.css`

Open `index.html` directly in a browser to use that standalone prototype.

## Production deploy

Normal builds are verification-only and do not update production:

```powershell
npm run build
```

Initialize or reload the production API process in PM2:

```powershell
npm run pm2:start-prod-api
```

Production updates are explicit:

```powershell
npm run deploy:barkan-web
```

The deploy command builds the API, restarts it with `NODE_ENV=production`, builds the web dashboard, copies the web output to a timestamped release under `/var/www/barkan-web/releases`, and points `/var/www/barkan-web/current` at that release.

Widget production updates build the API and widget, restart `prod-barkan-api`, and check `/widget.js`:

```powershell
npm run deploy:barkan-widget
```

## Payment tool

The payment tool gives an agent identity a real-world spending capability, alongside
email/phone/calendar. It follows the same pattern as the other tools: in-memory store,
bearer identity-token auth, and every decision written to the identity audit log. The agent
never sees card details — it can only request a purchase, and the policy engine decides
**approve / reject / requires_approval**.

When an identity is initialized with the `payment` tool, Barkan provisions a mock virtual
card and a default spending policy (auto-approve ≤ £25, human approval above, `CryptoExchange`
blocked). Agent-facing endpoints (all `Authorization: Bearer <identity_token>`):

| Method & path | Purpose |
|---|---|
| `POST /api/tools/payments/request-purchase` | Request a purchase (`merchant_name`, `amount`, `currency`, `purpose`) |
| `POST /api/tools/payments/request-purchase-from-text` | Natural language — *"buy me still water from amazon"* → parsed → policy decision |
| `POST /api/tools/payments/:requestId/approve` · `/reject` | Human decision on a `requires_approval` request |
| `POST /api/tools/payments/:requestId/execute` | Execute an approved purchase (idempotent via `Idempotency-Key`) |
| `PATCH /api/tools/payments/policy` | Update the spending policy |
| `GET /api/identity/:agentId/payment-activity` | Policy + purchase requests + transactions |

Natural-language parsing uses OpenAI's Responses API (`OPENAI_PAYMENTS_MODEL`, default
`gpt-4o-mini`) when `OPENAI_API_KEY` is set, estimating a price and attaching a real merchant
link (e.g. an Amazon search URL) when the instruction names a product without a price. With no
key it falls back to a built-in heuristic parser. Policy-engine tests: `apps/api/src/payments.test.ts`.

## Project structure

```text
apps/
  api/                     Fastify + MongoDB backend
  web/                     React + Vite dashboard
packages/
  cli/                     CLI and local agent helpers
  widget/                  Embeddable Barkan browser script
barkan-injection/          Browser extension wrapper
_bmad/                     BMAD configuration
.agents/                   BMAD agent skills
AGENTS.md                  Repo architecture and agent instructions
```

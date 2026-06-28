# Barkan

Barkan is a web product for issuing real-world identities to AI agents. Each agent identity can be linked to an OpenClaw instance and provisioned with a phone number, email address, payment card, calendar, and other real-world tools.

The dashboard supports the current agent identity flow:

- Create a new agent identity.
- Choose an existing OpenClaw instance or a managed OpenClaw deployment.
- Copy a prompt into OpenClaw so it can install the Barkan identity skill and confirm linking through a tokenized endpoint.
- Manage identity details, OpenClaw link tokens, dashboard chat, phone, email, and payment tools.

The backend still keeps the original `sites` and `site-setups` route names internally for speed during the hackathon. The user-facing product language is agent identities.

## Runtime

- Web dashboard: React + Vite in `apps/web`
- Node API: Fastify + MongoDB in `apps/api`

## Prerequisites

- Node.js 18+
- MongoDB
- OpenAI API key for dashboard chat
- ElevenLabs API keys for real outbound calls; without them calls run in mock mode
- Resend API key for real email sending; without it email runs in mock mode

## Web Setup

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
OPENAI_DASHBOARD_CHAT_MODEL=gpt-5.4-2026-03-05
```

Run locally:

```powershell
npm run dev
```

The dashboard runs on `http://localhost:4888` and the API runs on `http://localhost:4001`.

## Demo Account

Seed a polished local demo account with fake agent identities, OpenClaw links, API tokens, and recent activity:

```powershell
npm run seed:demo
```

Login:

```text
Email: demo@aidentity.test
Password: demo-password
```

You can override the credentials with `DEMO_EMAIL`, `DEMO_PASSWORD`, and `DEMO_NAME`.

## Production Deploy

Normal builds are verification-only and do not update production:

```powershell
npm run build
```

Initialize or reload the production API process in PM2:

```powershell
npm run pm2:start-prod-api
```

Production web updates are explicit:

```powershell
npm run deploy:barkan-web
```

## Payment Tool

The payment tool gives an agent identity a real-world spending capability, alongside email/phone/calendar. It follows the same pattern as the other tools: in-memory store, bearer identity-token auth, and every decision written to the identity audit log. The agent never sees card details; it can only request a purchase, and the policy engine decides approve, reject, or requires approval.

Agent-facing endpoints use `Authorization: Bearer <identity_token>`:

| Method & path | Purpose |
|---|---|
| `POST /api/tools/payments/request-purchase` | Request a purchase |
| `POST /api/tools/payments/request-purchase-from-text` | Parse natural language into a purchase request |
| `POST /api/tools/payments/:requestId/approve` / `/reject` | Human decision on a request |
| `POST /api/tools/payments/:requestId/execute` | Execute an approved purchase |
| `PATCH /api/tools/payments/policy` | Update the spending policy |
| `GET /api/identity/:agentId/payment-activity` | Policy, purchase requests, and transactions |

## Project Structure

```text
apps/
  api/                     Fastify + MongoDB backend
  web/                     React + Vite dashboard
_bmad/                     BMAD configuration
.agents/                   BMAD agent skills
AGENTS.md                  Repo architecture and agent instructions
```

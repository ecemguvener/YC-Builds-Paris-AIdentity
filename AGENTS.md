# Barkan - Agent Instructions

<!-- This is the single source of truth for repo-level agent guidance. -->

## Overview

This repo contains the web-based Barkan product for issuing real-world identities to AI agents.

- **Web dashboard**: React + Vite + TypeScript in `apps/web`
- **Node API**: Fastify + MongoDB backend in `apps/api`

The current product lets a user sign up, create an agent identity, link it to an OpenClaw instance, and manage real-world tools such as phone, email, payments, and calendar. The old embeddable website assistant, browser widget, Action Mode, route documentation generator, and codebase-scanning CLI have been removed.

## Architecture

### Web app

- **Dashboard**: auth, identity list/detail, OpenClaw setup, dashboard chat, settings, phone/email/payment panels
- **UI**: Tailwind with shadcn-style local components
- **Auth**: classic email/password, bcrypt password hashes, HTTP-only cookie sessions
- **Identity setup**: user creates a named identity, chooses an OpenClaw endpoint or managed deployment, copies a link prompt/token, then completes setup
- **Current data model**: identity records are still stored in legacy `sites`/`site-setups` shaped collections and routes for speed during the hackathon; user-facing language should say agent identity

### Node API

The Node API exposes:

- `POST /api/auth/check-email`
- `POST /api/auth/signup`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `PATCH /api/auth/me`
- `PATCH /api/auth/me/notifications`
- `POST /api/auth/me/password`
- `GET /api/sites`
- `POST /api/sites` (guarded legacy route; onboarding uses setup completion)
- `POST /api/site-setups`
- `GET /api/site-setups/:projectId`
- `POST /api/site-setups/:projectId/complete`
- `GET /api/sites/:siteId`
- `PATCH /api/sites/:siteId`
- `DELETE /api/sites/:siteId`
- `POST /api/sites/:siteId/api-keys`
- `DELETE /api/sites/:siteId/api-keys/:apiKeyId`
- `POST /api/dashboard/chat`
- `POST /api/identity/init`
- `POST /api/identity/revoke`
- `GET /api/identity/:agentId/audit-log`
- `POST /api/tools/phone/call`
- `POST /api/tools/calendar/book`
- Payment tool routes under `/api/tools/payments/*`
- Email tool routes under `/api/tools/email/*` and `/api/sites/:siteId/email/*`

## Key Files

| File | Purpose |
|------|---------|
| `apps/web/src/App.tsx` | Dashboard, auth, identity onboarding, and settings UI |
| `apps/web/src/api.ts` | Browser API client |
| `apps/web/src/components/PhonePanel.tsx` | Phone capability UI |
| `apps/web/src/components/EmailPanel.tsx` | Email capability UI |
| `apps/web/src/components/PaymentsPanel.tsx` | Payment capability UI |
| `apps/api/src/app.ts` | Fastify app wiring |
| `apps/api/src/auth.ts` | Auth routes and session helpers |
| `apps/api/src/sites.ts` | Legacy-named identity setup/detail routes |
| `apps/api/src/dashboard-chat.ts` | Simulated OpenClaw dashboard chat |
| `apps/api/src/identity.ts` | Bearer-token agent identity and tool endpoints |
| `apps/api/src/phone.ts` | Phone call integration/mock fallback |
| `apps/api/src/email.ts` | Email capability integration/mock fallback |
| `apps/api/src/payments.ts` | Payment capability and policy engine |

## Build & Run

Local PM2 dev services:

```powershell
pm2 restart dev-barkan-api dev-barkan-web --update-env
pm2 save
```

Barkan runs with hot reload on:

- API: `http://100.81.152.74:4001`
- Web: `http://100.81.152.74:4888`

```powershell
npm install
npm run build
npm test
```

Development:

```powershell
copy .env.example .env
npm run dev
```

Node API only:

```powershell
npm --workspace @barkan/api run dev
```

Web dashboard only:

```powershell
npm --workspace @barkan/web run dev
```

Production deploy:

```powershell
npm run pm2:start-prod-api
npm run deploy:barkan-web
```

## Code Style & Conventions

### Naming

- Prefer explicit, descriptive names over short names
- Keep argument names aligned with the variables passed into them
- Use current product language in UI copy: agent identity, OpenClaw link, phone, email, payments, calendar
- Do not reintroduce old embedded widget, Action Mode, route documentation, or codebase-scanning CLI terminology

### Code clarity

- Clear is better than clever
- Add comments only when they explain non-obvious intent or tradeoffs
- Avoid unnecessary indirection

## Do Not

- Do not add features beyond the request
- Do not reintroduce desktop companion code or routes
- Do not reintroduce the old embeddable widget, browser extension assistant, Action Mode, route documentation, or CLI scanner
- Do not revert user changes outside the current task
- Do not use destructive git commands like `git reset --hard`

## Self-Update Instructions

Update this file when architecture, routes, key files, or build instructions materially change.

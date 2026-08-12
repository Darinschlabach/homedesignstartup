# AI Home Design Platform (Atelier)

Production-oriented monorepo for an AI-powered home, barn, and shop design SaaS.

Talk to an architect — not a CAD toolbar. The parametric **Building Model** is the source of truth; chat, 2D, 3D, renders, and construction documents are projections of that model.

## Stack

- **Apps:** Next.js 15 (Vercel) in `apps/web`
- **Backend:** Supabase (Auth, Postgres + RLS, Storage, Realtime)
- **Domain:** `@aihd/domain` — BuildingModelV1, mutations, adapters
- **AI:** `@aihd/ai` — Vercel AI SDK orchestrator + tools
- **Jobs:** Inngest (`/api/inngest`)
- **Billing:** Stripe checkout + webhooks
- **Render worker:** `workers/render` (Modal/RunPod-ready stub)

## Quick start

### Prerequisites

- Node 20+
- [pnpm](https://pnpm.io) 9+
- [Supabase CLI](https://supabase.com/docs/guides/cli) (for local DB)

### Install

```bash
pnpm install
cp apps/web/.env.example apps/web/.env.local
```

### Local Supabase

```bash
npx supabase start
npx supabase db reset
```

Copy the local API URL and anon/service keys into `apps/web/.env.local`.

### Develop

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

### Quality gates

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

## Monorepo layout

```text
apps/web                 Next.js app (UI + route handlers)
packages/domain          Building model + adapters
packages/ai              Architect agent
packages/db              Drizzle schema
packages/api-client      Shared Zod contracts
packages/ui              Design system primitives
packages/config-*        Shared TS/ESLint/Tailwind
workers/render           Photoreal worker stub
supabase/migrations      SQL schema + RLS
```

## Auth & tenancy

- Supabase Auth (email/password; OAuth ready)
- Personal workspace auto-created on signup (`handle_new_user`)
- Organizations + org workspaces for pro teams
- RLS helpers: `can_access_workspace`, `can_access_project`

## AI design loop

1. User chats in the project workspace
2. `/api/chat` loads revision + history
3. `@aihd/ai` `runDesignTurn` streams tool calls
4. Mutations validated via Zod + integrity checks
5. New `building_revisions` row committed (undo/audit)

Set `ANTHROPIC_API_KEY` (preferred) or `OPENAI_API_KEY`.

## Rendering & exports

- Interactive 3D: React Three Fiber from `buildSceneMeshes`
- Photoreal: Inngest `design/render.requested` → worker or storage stub
- Docs: advisory CD set + DXF-lite export from `@aihd/domain`

## Enterprise surfaces

- Org branding (`/api/organizations/:id/branding`)
- SSO flag (`/api/organizations/:id/sso`) — wire IdP before production
- API keys + public `GET /api/v1/projects` (Bearer key)
- Audit logs table + writer

## Deployment

1. Create Supabase project; run migrations
2. Set Vercel env vars from `.env.example`
3. Deploy `apps/web` to Vercel
4. Point Inngest at `/api/inngest`
5. Configure Stripe prices + webhook → `/api/billing/webhook`
6. Optionally deploy `workers/render` and set `RENDER_WORKER_URL`

## Phased roadmap

| Phase | Status in repo |
|---|---|
| 0 Foundation | Monorepo, auth, orgs, RLS, app shell |
| 1 MVP AI | Chat mutations, model, 2D/3D views |
| 2 Co-creation | Manual 2D/3D edits, barn/shop bays |
| 3 Viz + monetization | Materials, Inngest renders, Stripe |
| 4 Construction docs | Advisory sheets, DXF/PDF export jobs |
| 5 Enterprise | SSO flag, API keys, branding, audit |

## License

Proprietary — all rights reserved.

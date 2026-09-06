# Internet Lab

Internet Lab is a secure web gateway workspace for inspecting public URLs through a protected server-side fetch layer.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- `pnpm --filter @workspace/api-server run test` — run gateway security tests

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/internet-lab` — responsive React/Vite dashboard and Web workspace
- `artifacts/api-server/src/lib/security.ts` — URL, DNS, IP, and SSRF validation
- `artifacts/api-server/src/lib/policy.ts` — configurable protected-service policy engine
- `artifacts/api-server/src/routes/gateway.ts` — session, status, fetch, and request ledger routes
- `lib/api-spec/openapi.yaml` — source of truth for gateway API contracts
- `lib/db/src/schema/internet-lab.ts` — configurable users, plans, sessions, usage, files, messages, policy, and gateway request tables

## Architecture decisions

- The gateway pins each DNS-resolved public address through the outbound request's lookup callback to reduce DNS-rebinding risk.
- Development sessions are signed with `SESSION_SECRET`; session creation is disabled outside development until a real auth provider is configured.
- Third-party responses are returned as bounded text metadata and are never rendered as HTML inside the Internet Lab origin.
- Security logs store only session ID, hostname, decision, duration, and response size; request credentials, cookies, and bodies are not logged.

## Product

The app currently provides the Web workspace, live gateway/security status, URL inspection through the server, safe text previews, recent request metadata, protection settings, and planned-module placeholders for Messages, Video, Files, APIs, Servers, and Network.

## User preferences

The current build is intentionally limited to the secure Web Gateway foundation; payments, full content rendering, cloud scaling, and the other modules are deferred.

## Gotchas

- Run API codegen after changing `lib/api-spec/openapi.yaml`.
- The API workflow must run in development mode for the demo session flow; production requires a configured authentication provider.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details

---
name: Gateway plan enforcement
description: Gateway sessions bind to a trusted server-side plan and enforce response, concurrency, and bandwidth limits.
---

Until production authentication exposes a verified user subscription, development Gateway sessions use the server-side `GATEWAY_DEFAULT_PLAN` setting (default FREE), never a client-provided plan. The signed session binds that plan and runtime accounting enforces its response, concurrent-session, and bandwidth limits.

**Why:** Accepting a plan from a request header or body would let a client escalate from FREE to PRO; the current authentication layer is intentionally development-only and fails closed in production.

**How to apply:** When production auth is added, replace the environment-wide resolver with a server-side subscription lookup before issuing the signed session, while keeping the existing plan-limit accounting and tests.
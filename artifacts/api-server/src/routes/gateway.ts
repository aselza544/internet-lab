import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  FetchThroughGatewayBody,
  GetDashboardSummaryResponse,
  GetGatewayStatusResponse,
  ListGatewayRequestsResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { readUpstream } from "../lib/gateway-upstream.ts";
import {
  gatewayConfig,
  planLimits,
  type GatewayPlan,
} from "../lib/gateway-config";
import {
  createBandwidthLimitError,
  resolveRedirectTarget,
  safeLogDomain,
} from "../lib/gateway-guards";
import { evaluatePolicy } from "../lib/policy";
import { GatewaySecurityError, validatePublicTarget } from "../lib/security";
import {
  getDashboardSummary,
  getSessionLimits,
  getRecentGatewayRequests,
  recordGatewayRequest,
  registerSession,
  reserveSessionBandwidth,
  settleSessionBandwidth,
} from "../lib/gateway-store";

const router: IRouter = Router();
const SESSION_COOKIE = "internet_lab_session";
const sessionRateWindows = new Map<string, number[]>();

const jsonError = (
  res: Response,
  status: number,
  error: string,
  code: string,
): void => {
  res.status(status).json({ error, code });
};

const now = (): number => Date.now();

function signingSecret(): string | null {
  const secret = process.env.SESSION_SECRET;
  return secret && secret.length >= 32 ? secret : null;
}

function sign(value: string): string {
  const secret = signingSecret();
  if (!secret) throw new Error("SESSION_SECRET is missing or too short");
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

type SessionClaims = {
  sessionId: string;
  expiresAt: string;
  plan: GatewayPlan;
};

type GatewaySession = {
  sessionId: string;
  plan: GatewayPlan;
  maxResponseBytes: number;
  maxConcurrentSessions: number;
  bandwidthBytes: number;
  remainingBandwidthBytes: number;
};

function createSessionToken(plan: GatewayPlan): {
  token: string;
  expiresAt: Date;
  sessionId: string;
} {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(now() + gatewayConfig.idleSessionTimeoutMs);
  const payload = Buffer.from(
    JSON.stringify({ sessionId, expiresAt: expiresAt.toISOString(), plan }),
  ).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, expiresAt, sessionId };
}

function getSessionToken(req: Request): string | null {
  const headerValue = req.header("x-internet-lab-session");
  return headerValue ?? req.cookies?.[SESSION_COOKIE] ?? null;
}

function verifySession(req: Request): SessionClaims | null {
  if (process.env.NODE_ENV !== "development") return null;
  const token = getSessionToken(req);
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = sign(payload);
  const providedBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    providedBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(providedBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(payload, "base64url").toString(),
    ) as Partial<SessionClaims>;
    if (
      !parsed.sessionId ||
      !parsed.expiresAt ||
      !parsed.plan ||
      !Object.hasOwn(planLimits, parsed.plan) ||
      new Date(parsed.expiresAt).getTime() <= now()
    ) {
      return null;
    }
    return {
      sessionId: parsed.sessionId,
      expiresAt: parsed.expiresAt,
      plan: parsed.plan,
    };
  } catch {
    return null;
  }
}

function requireSession(req: Request, res: Response): GatewaySession | null {
  if (!signingSecret()) {
    jsonError(
      res,
      503,
      "Authentication is not configured for this environment.",
      "AUTH_NOT_CONFIGURED",
    );
    return null;
  }

  const claims = verifySession(req);
  const limits = claims ? getSessionLimits(claims.sessionId) : null;
  if (!claims || !limits || limits.plan !== claims.plan) {
    jsonError(
      res,
      401,
      "Create an authenticated gateway session before fetching a URL.",
      "SESSION_REQUIRED",
    );
    return null;
  }
  return {
    sessionId: claims.sessionId,
    plan: limits.plan,
    maxResponseBytes: limits.maxResponseBytes,
    maxConcurrentSessions: limits.maxConcurrentSessions,
    bandwidthBytes: limits.bandwidthBytes,
    remainingBandwidthBytes: limits.remainingBandwidthBytes,
  };
}

function rateLimit(sessionId: string): boolean {
  const cutoff = now() - 60_000;
  const recent = (sessionRateWindows.get(sessionId) ?? []).filter(
    (timestamp) => timestamp > cutoff,
  );
  if (recent.length >= gatewayConfig.rateLimitPerMinute) {
    sessionRateWindows.set(sessionId, recent);
    return false;
  }
  recent.push(now());
  sessionRateWindows.set(sessionId, recent);
  return true;
}

function isRedirect(statusCode: number): boolean {
  return [301, 302, 303, 307, 308].includes(statusCode);
}

async function fetchWithValidatedRedirects(
  rawUrl: string,
  maxResponseBytes = gatewayConfig.maxResponseBytes,
  requestByteBudget = maxResponseBytes,
) {
  let currentUrl = rawUrl;
  let redirectCount = 0;
  let bytesUsed = 0;

  while (true) {
    const target = await validatePublicTarget(currentUrl);
    const policy = evaluatePolicy(target.url.hostname);
    if (policy.blocked) {
      throw new GatewaySecurityError(
        policy.code ?? "POLICY_BLOCKED",
        policy.message ?? "This destination is blocked by policy.",
        403,
      );
    }

    const remainingBudget = requestByteBudget - bytesUsed;
    if (remainingBudget <= 0) {
      throw createBandwidthLimitError();
    }

    const upstream = await readUpstream(
      target,
      Math.min(maxResponseBytes, remainingBudget),
    );
    bytesUsed += upstream.body.length;
    const location = upstream.headers.location;
    if (isRedirect(upstream.statusCode) && location) {
      currentUrl = resolveRedirectTarget(
        target.url.toString(),
        location,
        redirectCount,
        gatewayConfig.maxRedirects,
      );
      redirectCount += 1;
      continue;
    }

    return { target, upstream, redirectCount, bytesUsed };
  }
}

function contentPreview(contentType: string, body: Buffer): string {
  if (
    !contentType.startsWith("text/") &&
    !contentType.includes("json") &&
    !contentType.includes("xml") &&
    !contentType.includes("javascript")
  ) {
    return body.length ? "[Binary response omitted from safe preview]" : "";
  }
  return body.toString("utf8").slice(0, 8_000);
}

router.get("/gateway/status", (_req, res) => {
  const plan = gatewayConfig.defaultPlan;
  const data = GetGatewayStatusResponse.parse({
    gateway: "connected",
    network: "private",
    session: process.env.NODE_ENV === "development" ? "active" : "required",
    mode:
      process.env.NODE_ENV === "development" ? "development" : "authenticated",
    policy: "enforced",
    limits: {
      timeoutMs: gatewayConfig.timeoutMs,
      maxResponseBytes: planLimits[plan].maxResponseBytes,
      maxRedirects: gatewayConfig.maxRedirects,
      maxConcurrentSessions: planLimits[plan].maxConcurrentSessions,
    },
  });
  res.json(data);
});

router.post("/gateway/sessions", (_req, res) => {
  if (process.env.NODE_ENV !== "development") {
    jsonError(
      res,
      503,
      "Authentication must be configured before gateway sessions can be created.",
      "AUTH_NOT_CONFIGURED",
    );
    return;
  }

  try {
    const plan = gatewayConfig.defaultPlan;
    const session = createSessionToken(plan);
    if (
      !registerSession(session.sessionId, plan, session.expiresAt.getTime())
    ) {
      jsonError(
        res,
        429,
        "This plan has reached its concurrent session limit.",
        "CONCURRENT_SESSION_LIMIT",
      );
      return;
    }
    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: gatewayConfig.idleSessionTimeoutMs,
      path: "/",
    });
    res.status(201).json({
      sessionId: session.sessionId,
      expiresAt: session.expiresAt.toISOString(),
      plan,
      mode: "development",
    });
  } catch {
    jsonError(
      res,
      503,
      "Authentication is not configured for this environment.",
      "AUTH_NOT_CONFIGURED",
    );
  }
});

router.get("/gateway/requests", (req, res) => {
  const claims = verifySession(req);
  if (!claims || !getSessionLimits(claims.sessionId)) {
    res.json(ListGatewayRequestsResponse.parse([]));
    return;
  }
  res.json(ListGatewayRequestsResponse.parse(getRecentGatewayRequests()));
});

router.get("/dashboard/summary", (_req, res) => {
  res.json(GetDashboardSummaryResponse.parse(getDashboardSummary()));
});

router.post("/gateway/fetch", async (req, res) => {
  const session = requireSession(req, res);
  if (!session) return;
  if (!rateLimit(session.sessionId)) {
    jsonError(
      res,
      429,
      "This session has reached its request rate limit. Try again shortly.",
      "RATE_LIMITED",
    );
    return;
  }

  const parsed = FetchThroughGatewayBody.safeParse(req.body);
  if (!parsed.success) {
    jsonError(
      res,
      400,
      "A valid http:// or https:// URL is required.",
      "INVALID_REQUEST",
    );
    return;
  }

  const startedAt = now();
  let hostname = safeLogDomain(parsed.data.url);
  const bandwidthReservation = reserveSessionBandwidth(session.sessionId);
  if (bandwidthReservation === null) {
    jsonError(
      res,
      429,
      "This plan has reached its bandwidth limit.",
      "BANDWIDTH_LIMIT",
    );
    return;
  }
  let bandwidthSettled = false;

  try {
    const result = await fetchWithValidatedRedirects(
      parsed.data.url,
      session.maxResponseBytes,
      bandwidthReservation,
    );
    settleSessionBandwidth(
      session.sessionId,
      bandwidthReservation,
      result.bytesUsed,
    );
    bandwidthSettled = true;
    const contentType =
      result.upstream.headers["content-type"]?.split(";", 1)[0] ??
      "application/octet-stream";
    const responseSize = result.upstream.body.length;
    const data = {
      url: result.target.url.toString(),
      protocol: result.target.url.protocol.replace(":", ""),
      hostname: result.target.url.hostname,
      statusCode: result.upstream.statusCode,
      responseTimeMs: now() - startedAt,
      contentType,
      responseSize,
      truncated: false,
      preview: contentPreview(contentType, result.upstream.body),
      redirectCount: result.redirectCount,
      securityDecision: "allowed" as const,
    };

    recordGatewayRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      hostname: result.target.url.hostname,
      status: "allowed",
      statusCode: result.upstream.statusCode,
      durationMs: data.responseTimeMs,
      responseSize,
      securityDecision: "allowed",
    });
    logger.info(
      {
        sessionId: session.sessionId,
        domain: result.target.url.hostname,
        status: "allowed",
        durationMs: data.responseTimeMs,
        responseSize,
        securityDecision: "allowed",
      },
      "gateway request completed",
    );
    res.json(data);
  } catch (error) {
    if (!bandwidthSettled) {
      settleSessionBandwidth(session.sessionId, bandwidthReservation, 0);
    }
    const durationMs = now() - startedAt;
    const status = error instanceof GatewaySecurityError ? error.status : 502;
    const code =
      error instanceof GatewaySecurityError ? error.code : "UPSTREAM_FAILED";
    const message =
      error instanceof GatewaySecurityError
        ? error.message
        : "The upstream request could not be completed safely.";
    const isBlocked = status === 403;

    recordGatewayRequest({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      hostname,
      status: isBlocked ? "blocked" : "failed",
      statusCode: null,
      durationMs,
      responseSize: 0,
      securityDecision: isBlocked ? code : "failed",
    });
    logger.warn(
      {
        sessionId: session.sessionId,
        domain: hostname,
        status: isBlocked ? "blocked" : "failed",
        durationMs,
        responseSize: 0,
        securityDecision: isBlocked ? code : "failed",
      },
      "gateway request denied or failed",
    );

    if (isBlocked) {
      res.status(403).json({
        error: "This destination is blocked by Internet Lab policy.",
        code,
        policy: "protected-service",
        message,
      });
      return;
    }
    jsonError(res, status, message, code);
  }
});

export default router;

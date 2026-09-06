import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { Router, type IRouter, type Request, type Response } from "express";
import {
  FetchThroughGatewayBody,
  GetDashboardSummaryResponse,
  GetGatewayStatusResponse,
  ListGatewayRequestsResponse,
} from "@workspace/api-zod";
import { logger } from "../lib/logger";
import { gatewayConfig, planLimits } from "../lib/gateway-config";
import {
  assertResponseWithinLimit,
  createUpstreamTimeoutError,
  resolveRedirectTarget,
  safeLogDomain,
} from "../lib/gateway-guards";
import { evaluatePolicy } from "../lib/policy";
import { GatewaySecurityError, validatePublicTarget } from "../lib/security";
import {
  getDashboardSummary,
  getRecentGatewayRequests,
  recordGatewayRequest,
  registerSession,
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

function createSessionToken(): {
  token: string;
  expiresAt: Date;
  sessionId: string;
} {
  const sessionId = crypto.randomUUID();
  const expiresAt = new Date(now() + gatewayConfig.idleSessionTimeoutMs);
  const payload = Buffer.from(
    JSON.stringify({ sessionId, expiresAt: expiresAt.toISOString() }),
  ).toString("base64url");
  return { token: `${payload}.${sign(payload)}`, expiresAt, sessionId };
}

function getSessionToken(req: Request): string | null {
  const headerValue = req.header("x-internet-lab-session");
  return headerValue ?? req.cookies?.[SESSION_COOKIE] ?? null;
}

function verifySession(req: Request): string | null {
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
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      sessionId?: string;
      expiresAt?: string;
    };
    if (
      !parsed.sessionId ||
      !parsed.expiresAt ||
      new Date(parsed.expiresAt).getTime() <= now()
    ) {
      return null;
    }
    return parsed.sessionId;
  } catch {
    return null;
  }
}

function requireSession(req: Request, res: Response): string | null {
  if (!signingSecret()) {
    jsonError(
      res,
      503,
      "Authentication is not configured for this environment.",
      "AUTH_NOT_CONFIGURED",
    );
    return null;
  }

  const sessionId = verifySession(req);
  if (!sessionId) {
    jsonError(
      res,
      401,
      "Create an authenticated gateway session before fetching a URL.",
      "SESSION_REQUIRED",
    );
    return null;
  }
  return sessionId;
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

function readUpstream(
  target: Awaited<ReturnType<typeof validatePublicTarget>>,
): Promise<{
  statusCode: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}> {
  const transport = target.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
        path: `${target.url.pathname || "/"}${target.url.search}`,
        method: "GET",
        headers: {
          accept:
            "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
          "user-agent": "Internet-Lab-Gateway/0.1",
        },
        lookup: (
          _hostname: string,
          options: { all?: boolean },
          callback: (
            error: NodeJS.ErrnoException | null,
            address: string | Array<{ address: string; family: number }>,
            family?: number,
          ) => void,
        ) => {
          if (options.all) {
            callback(null, [
              { address: target.address, family: target.family },
            ]);
            return;
          }
          callback(null, target.address, target.family);
        },
        ...(target.url.protocol === "https:"
          ? { servername: target.url.hostname }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;

        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          try {
            assertResponseWithinLimit(total, gatewayConfig.maxResponseBytes);
          } catch (error) {
            request.destroy(
              error instanceof Error
                ? error
                : new Error("Response size limit exceeded"),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 502,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );

    request.setTimeout(gatewayConfig.timeoutMs, () => {
      request.destroy(createUpstreamTimeoutError());
    });
    request.on("error", reject);
    request.end();
  });
}

async function fetchWithValidatedRedirects(rawUrl: string) {
  let currentUrl = rawUrl;
  let redirectCount = 0;

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

    const upstream = await readUpstream(target);
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

    return { target, upstream, redirectCount };
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
  const data = GetGatewayStatusResponse.parse({
    gateway: "connected",
    network: "private",
    session: process.env.NODE_ENV === "development" ? "active" : "required",
    mode:
      process.env.NODE_ENV === "development" ? "development" : "authenticated",
    policy: "enforced",
    limits: {
      timeoutMs: gatewayConfig.timeoutMs,
      maxResponseBytes: planLimits.FREE.maxResponseBytes,
      maxRedirects: gatewayConfig.maxRedirects,
      maxConcurrentSessions: gatewayConfig.maxConcurrentSessions,
    },
  });
  res.json(data);
});

router.post("/gateway/sessions", (req, res) => {
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
    const session = createSessionToken();
    registerSession(session.sessionId);
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
  if (!verifySession(req)) {
    res.json(ListGatewayRequestsResponse.parse([]));
    return;
  }
  res.json(ListGatewayRequestsResponse.parse(getRecentGatewayRequests()));
});

router.get("/dashboard/summary", (_req, res) => {
  res.json(GetDashboardSummaryResponse.parse(getDashboardSummary()));
});

router.post("/gateway/fetch", async (req, res) => {
  const sessionId = requireSession(req, res);
  if (!sessionId) return;
  if (!rateLimit(sessionId)) {
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
  try {
    const result = await fetchWithValidatedRedirects(parsed.data.url);
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
        sessionId,
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
        sessionId,
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

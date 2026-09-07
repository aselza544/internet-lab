import crypto from "node:crypto";
import { Router, type IRouter, type Request, type Response } from "express";
import { gatewayConfig, planLimits, type GatewayPlan } from "../lib/gateway-config.ts";
import { createBandwidthLimitError, resolveRedirectTarget } from "../lib/gateway-guards.ts";
import { evaluatePolicy } from "../lib/policy.ts";
import { GatewaySecurityError, validatePublicTarget } from "../lib/security.ts";
import { readUpstream } from "../lib/gateway-upstream.ts";
import { getSessionLimits, reserveSessionBandwidth, settleSessionBandwidth, recordGatewayRequest } from "../lib/gateway-store.ts";

const router: IRouter = Router();
const SESSION_COOKIE = "internet_lab_session";
const rateWindows = new Map<string, number[]>();

function now(): number { return Date.now(); }
function secret(): string | null { const value = process.env.SESSION_SECRET; return value && value.length >= 32 ? value : null; }
function sign(value: string): string { const s = secret(); if (!s) throw new Error("SESSION_SECRET is missing or too short"); return crypto.createHmac("sha256", s).update(value).digest("base64url"); }
type Claims = { sessionId: string; expiresAt: string; plan: GatewayPlan };
function claims(req: Request): Claims | null {
  if (process.env.NODE_ENV !== "development" || !secret()) return null;
  const token = req.header("x-internet-lab-session") ?? req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;
  const expected = sign(payload);
  if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<Claims>;
    if (!parsed.sessionId || !parsed.expiresAt || !parsed.plan || !Object.hasOwn(planLimits, parsed.plan) || new Date(parsed.expiresAt).getTime() <= now()) return null;
    return parsed as Claims;
  } catch { return null; }
}
function requireWebSession(req: Request, res: Response) {
  const c = claims(req);
  const limits = c ? getSessionLimits(c.sessionId) : null;
  if (!c || !limits || limits.plan !== c.plan) {
    res.status(401).json({ error: "Create an authenticated gateway session before opening a web page.", code: "SESSION_REQUIRED" });
    return null;
  }
  return { sessionId: c.sessionId, ...limits };
}
function rateLimit(sessionId: string): boolean {
  const cutoff = now() - 60_000;
  const recent = (rateWindows.get(sessionId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= gatewayConfig.rateLimitPerMinute) { rateWindows.set(sessionId, recent); return false; }
  recent.push(now()); rateWindows.set(sessionId, recent); return true;
}
function isRedirect(status: number): boolean { return [301,302,303,307,308].includes(status); }
async function fetchSafe(rawUrl: string, maxResponseBytes: number, budget: number) {
  let current = rawUrl; let redirects = 0; let used = 0;
  while (true) {
    const target = await validatePublicTarget(current);
    const policy = evaluatePolicy(target.url.hostname);
    if (policy.blocked) throw new GatewaySecurityError(policy.code ?? "POLICY_BLOCKED", policy.message ?? "Destination blocked by policy.", 403);
    const remaining = budget - used;
    if (remaining <= 0) throw createBandwidthLimitError();
    const upstream = await readUpstream(target, Math.min(maxResponseBytes, remaining));
    used += upstream.body.length;
    if (isRedirect(upstream.statusCode) && upstream.headers.location) {
      current = resolveRedirectTarget(target.url.toString(), upstream.headers.location, redirects, gatewayConfig.maxRedirects);
      redirects += 1;
      continue;
    }
    return { target, upstream, redirects, used };
  }
}
function proxyUrl(raw: string, base: string): string | null {
  try {
    const value = new URL(raw, base);
    if (!["http:", "https:"].includes(value.protocol)) return null;
    return `/api/web/resource?url=${encodeURIComponent(value.toString())}`;
  } catch { return null; }
}
export function rewriteCss(css: string, base: string): string {
  return css.replace(/url\(\s*([\"']?)([^\"')]+)\1\s*\)/gi, (full, quote, value) => {
    const proxied = proxyUrl(value, base); return proxied ? `url(${quote}${proxied}${quote})` : "url()";
  });
}
export function rewriteHtml(html: string, base: string): string {
  let output = html.replace(/<base[^>]*>/gi, "");
  output = output.replace(/\s(on[a-z]+)\s*=\s*([\"'])[^\"']*\2/gi, "");
  output = output.replace(/\s(src|href|action|poster|cite)\s*=\s*([\"'])(.*?)\2/gi, (full, attr, quote, value) => {
    if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return ` ${attr}=${quote}${value}${quote}`;
    const proxied = proxyUrl(value, base);
    return proxied ? ` ${attr}=${quote}${proxied}${quote}` : "";
  });
  output = output.replace(/\s(srcset)\s*=\s*([\"'])(.*?)\2/gi, (full, attr, quote, value) => {
    const rewritten = value.split(",").map((part: string) => {
      const pieces = part.trim().split(/\s+/); const proxied = proxyUrl(pieces[0], base); if (!proxied) return ""; pieces[0] = proxied; return pieces.join(" ");
    }).filter(Boolean).join(", ");
    return ` ${attr}=${quote}${rewritten}${quote}`;
  });
  output = output.replace(/<meta[^>]+http-equiv\s*=\s*[\"']?content-security-policy[\"']?[^>]*>/gi, "");
  const csp = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; script-src 'none'; media-src 'self' blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none';";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">${output}`;
}
async function serve(req: Request, res: Response): Promise<void> {
  const session = requireWebSession(req, res); if (!session) return;
  if (!rateLimit(session.sessionId)) { res.status(429).json({ error: "This session has reached its request rate limit.", code: "RATE_LIMITED" }); return; }
  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
  if (!rawUrl) { res.status(400).json({ error: "A valid http:// or https:// URL is required.", code: "INVALID_URL" }); return; }
  const reservation = reserveSessionBandwidth(session.sessionId);
  if (reservation === null) { res.status(429).json({ error: "This plan has reached its bandwidth limit.", code: "BANDWIDTH_LIMIT" }); return; }
  const started = now();
  try {
    const result = await fetchSafe(rawUrl, session.maxResponseBytes, reservation);
    settleSessionBandwidth(session.sessionId, reservation, result.used);
    const type = result.upstream.headers["content-type"]?.split(";", 1)[0] ?? "application/octet-stream";
    const base = result.target.url.toString();
    let body = result.upstream.body;
    if (type === "text/html" || type === "application/xhtml+xml") body = Buffer.from(rewriteHtml(body.toString("utf8"), base));
    else if (type === "text/css") body = Buffer.from(rewriteCss(body.toString("utf8"), base));
    const responseSize = body.length;
    recordGatewayRequest({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), hostname: result.target.url.hostname, status: "allowed", statusCode: result.upstream.statusCode, durationMs: now() - started, responseSize, securityDecision: "web-proxy-allowed" });
    res.status(result.upstream.statusCode).set("Content-Type", type).set("X-Content-Type-Options", "nosniff").set("Content-Security-Policy", type === "text/html" ? "default-src 'none'; frame-ancestors 'none';" : "default-src 'none';").send(body);
  } catch (error) {
    settleSessionBandwidth(session.sessionId, reservation, 0);
    const status = error instanceof GatewaySecurityError ? error.status : 502;
    const code = error instanceof GatewaySecurityError ? error.code : "UPSTREAM_FAILED";
    res.status(status).json({ error: error instanceof Error ? error.message : "The upstream request could not be completed safely.", code });
  }
}
router.get("/web/page", serve);
router.get("/web/resource", serve);
export default router;

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
const RESOURCE_CAP_TTL_MS = 2 * 60_000;

type Claims = { sessionId: string; expiresAt: string; plan: GatewayPlan };
type ResourceCap = { sessionId: string; targetUrl: string; expiresAt: number; plan: GatewayPlan };

function now(): number { return Date.now(); }
function secret(): string | null { const value = process.env.SESSION_SECRET; return value && value.length >= 32 ? value : null; }
function sign(value: string): string { const s = secret(); if (!s) throw new Error("SESSION_SECRET is missing or too short"); return crypto.createHmac("sha256", s).update(value).digest("base64url"); }
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
function sessionFromRequest(req: Request): { sessionId: string; plan: GatewayPlan; maxResponseBytes: number } | null {
  const c = claims(req);
  const limits = c ? getSessionLimits(c.sessionId) : null;
  if (!c || !limits || limits.plan !== c.plan) return null;
  return { sessionId: c.sessionId, ...limits };
}
function requireWebSession(req: Request, res: Response) {
  const session = sessionFromRequest(req);
  if (!session) { res.status(401).json({ error: "Create an authenticated gateway session before opening a web page.", code: "SESSION_REQUIRED" }); return null; }
  return session;
}
function rateLimit(sessionId: string): boolean {
  const cutoff = now() - 60_000;
  const recent = (rateWindows.get(sessionId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= gatewayConfig.rateLimitPerMinute) { rateWindows.set(sessionId, recent); return false; }
  recent.push(now()); rateWindows.set(sessionId, recent); return true;
}
function isRedirect(status: number): boolean { return [301, 302, 303, 307, 308].includes(status); }
function forwardedRequestHeaders(req: Request): Record<string, string> { const headers: Record<string, string> = {}; for (const name of ["accept", "accept-language", "content-type", "range", "user-agent"]) { const value = req.header(name); if (value) headers[name] = value; } return headers; }
function requestBody(req: Request): Buffer | undefined { if (!req.body || !Buffer.isBuffer(req.body) || req.body.length === 0) return undefined; return req.body; }
function createResourceCap(sessionId: string, targetUrl: string, plan: GatewayPlan): string { const payload = Buffer.from(JSON.stringify({ sessionId, targetUrl, expiresAt: now() + RESOURCE_CAP_TTL_MS, plan })).toString("base64url"); return `${payload}.${sign(payload)}`; }
function createPageResourceCap(sessionId: string, plan: GatewayPlan): string { return createResourceCap(sessionId, "*", plan); }
function verifyResourceCap(token: string, sessionId: string, targetUrl: string, plan: GatewayPlan): boolean {
  const [payload, signature] = token.split("."); if (!payload || !signature || !secret()) return false;
  const expected = sign(payload); if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return false;
  try { const cap = JSON.parse(Buffer.from(payload, "base64url").toString()) as ResourceCap; return cap.sessionId === sessionId && (cap.targetUrl === targetUrl || cap.targetUrl === "*") && cap.plan === plan && Number.isFinite(cap.expiresAt) && cap.expiresAt > now(); } catch { return false; }
}
function requireResourceAccess(req: Request, res: Response, targetUrl: string) {
  const session = sessionFromRequest(req); if (session) return session;
  const cap = typeof req.query.cap === "string" ? req.query.cap : "";
  if (!cap) { res.status(401).json({ error: "Create an authenticated gateway session before opening a web page.", code: "SESSION_REQUIRED" }); return null; }
  try {
    const [payload] = cap.split("."); if (!payload) throw new Error("invalid capability");
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString()) as Partial<ResourceCap>;
    if (!parsed.sessionId || !parsed.plan || !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= now() || !verifyResourceCap(cap, parsed.sessionId, targetUrl, parsed.plan)) throw new Error("invalid capability");
    const limits = getSessionLimits(parsed.sessionId); if (!limits || limits.plan !== parsed.plan) throw new Error("invalid session");
    return { sessionId: parsed.sessionId, ...limits };
  } catch { res.status(401).json({ error: "The resource capability is invalid or expired.", code: "RESOURCE_CAP_REQUIRED" }); return null; }
}
async function fetchSafe(rawUrl: string, maxResponseBytes: number, budget: number, method: string, headers: Record<string, string>, body?: Buffer) {
  let current = rawUrl; let currentMethod = method; let currentBody = body; let redirects = 0; let used = 0;
  while (true) {
    const target = await validatePublicTarget(current); const policy = evaluatePolicy(target.url.hostname);
    if (policy.blocked) throw new GatewaySecurityError(policy.code ?? "POLICY_BLOCKED", policy.message ?? "Destination blocked by policy.", 403);
    const remaining = budget - used; if (remaining <= 0) throw createBandwidthLimitError();
    const upstream = await readUpstream(target, Math.min(maxResponseBytes, remaining), { method: currentMethod, headers, body: currentBody }); used += upstream.body.length;
    if (isRedirect(upstream.statusCode) && upstream.headers.location) { current = resolveRedirectTarget(target.url.toString(), upstream.headers.location, redirects, gatewayConfig.maxRedirects); redirects += 1; if (upstream.statusCode === 301 || upstream.statusCode === 302 || upstream.statusCode === 303) { currentMethod = "GET"; currentBody = undefined; delete headers["content-type"]; } continue; }
    return { target, upstream, redirects, used };
  }
}
function proxyUrl(raw: string, base: string, sessionId?: string, plan?: GatewayPlan, capability?: string): string | null {
  try { const value = new URL(raw, base); if (!["http:", "https:"].includes(value.protocol)) return null; const url = `/api/web/resource?url=${encodeURIComponent(value.toString())}`; if (capability) return `${url}&cap=${encodeURIComponent(capability)}`; return sessionId && plan ? `${url}&cap=${encodeURIComponent(createResourceCap(sessionId, value.toString(), plan))}` : url; } catch { return null; }
}
function bridgeScript(base: string, capability: string): string {
  const safeBase = JSON.stringify(base).replace(/</g, "\\u003c");
  const safeCapability = JSON.stringify(capability).replace(/</g, "\\u003c");
  return `<script>(function(){const B=${safeBase},C=${safeCapability};const P="/api/web/resource?url=";const METHODS=new Set(["GET","POST","HEAD"]);const blockedHeaders=new Set(["cookie","host","origin","referer","connection","content-length"]);function proxied(x){try{const raw=String(x);if(raw.startsWith(P))return raw;const v=new URL(raw,B);if(v.protocol!=="http:"&&v.protocol!=="https:")return raw;return P+encodeURIComponent(v.toString())+"&cap="+encodeURIComponent(C)}catch{return String(x)}}function requestBody(body){if(body==null)return Promise.resolve(null);if(typeof body==="string")return Promise.resolve(body);if(body instanceof URLSearchParams)return Promise.resolve(body.toString());if(body instanceof ArrayBuffer)return Promise.resolve(body);if(ArrayBuffer.isView(body))return Promise.resolve(body.buffer.slice(body.byteOffset,body.byteOffset+body.byteLength));if(body instanceof Blob)return body.arrayBuffer();return Promise.resolve(null)}function bridge(type,payload){return new Promise((resolve,reject)=>{const id=Math.random().toString(36).slice(2)+Date.now();const on=(e)=>{if(e.source!==parent||!e.data||e.data.__internetLab!==1||e.data.id!==id)return;removeEventListener("message",on);e.data.ok?resolve(e.data):reject(Object.assign(new Error(e.data.error||"Gateway request failed"),{name:e.data.name||"TypeError"}))};addEventListener("message",on);parent.postMessage({__internetLab:1,id,type,...payload},"*")})}const originalFetch=window.fetch.bind(window);window.fetch=async function(input,init){const raw=input instanceof Request?input.url:String(input);const target=proxied(raw);if(target===raw&&!raw.startsWith(P))return originalFetch(input,init);const method=String((init&&init.method)||(input instanceof Request?input.method:"GET")).toUpperCase();if(!METHODS.has(method))return originalFetch(input,init);const headers={};const sourceHeaders=init&&init.headers||(input instanceof Request?input.headers:null);if(sourceHeaders)for(const [k,v] of new Headers(sourceHeaders).entries())if(!blockedHeaders.has(k.toLowerCase()))headers[k]=v;const body=await requestBody(init&&init.body!==undefined?init.body:null);const r=await bridge("fetch",{url:target,method,headers,body});return new Response(r.body||null,{status:r.status,headers:r.headers||{}})};const xo=XMLHttpRequest.prototype.open;const xs=XMLHttpRequest.prototype.send;const xsrh=XMLHttpRequest.prototype.setRequestHeader;const xabort=XMLHttpRequest.prototype.abort;XMLHttpRequest.prototype.open=function(method,url,async=true,user,password){const m=String(method).toUpperCase();this.__il={method:m,url:proxied(url),headers:{},async};return xo.call(this,method,this.__il.url,true,user,password)};XMLHttpRequest.prototype.setRequestHeader=function(name,value){if(this.__il&&!blockedHeaders.has(String(name).toLowerCase()))this.__il.headers[name]=String(value);return xsrh.call(this,name,value)};XMLHttpRequest.prototype.abort=function(){if(this.__il?.bridgePending){this.__il.aborted=true;this.__il.bridgePending=false;this.dispatchEvent(new Event("abort"));this.dispatchEvent(new Event("loadend"));return}return xabort.call(this)};XMLHttpRequest.prototype.send=function(body){const x=this.__il;if(!x||!METHODS.has(x.method))return xs.call(this,body);const xhr=this;x.bridgePending=true;requestBody(body).then((payload)=>bridge("xhr",{url:x.url,method:x.method,headers:x.headers,body:payload})).then((r)=>{if(x.aborted)return;x.bridgePending=false;const rawBody=r.body||new ArrayBuffer(0);const type=xhr.responseType||"text";let responseValue="";try{if(type==="arraybuffer")responseValue=rawBody;else if(type==="blob")responseValue=new Blob([rawBody],{type:r.headers?.["content-type"]||"application/octet-stream"});else if(type==="json"){const text=new TextDecoder().decode(rawBody);responseValue=text?JSON.parse(text):null}else if(type==="document")responseValue=new DOMParser().parseFromString(new TextDecoder().decode(rawBody),"text/html");else responseValue=new TextDecoder().decode(rawBody)}catch{responseValue=null}Object.defineProperty(xhr,"status",{configurable:true,value:r.status});Object.defineProperty(xhr,"statusText",{configurable:true,value:String(r.status)});Object.defineProperty(xhr,"response",{configurable:true,value:responseValue});if(type==="text"||type==="")Object.defineProperty(xhr,"responseText",{configurable:true,value:typeof responseValue==="string"?responseValue:""});Object.defineProperty(xhr,"responseURL",{configurable:true,value:x.url});Object.defineProperty(xhr,"readyState",{configurable:true,value:4});xhr.dispatchEvent(new Event("readystatechange"));xhr.dispatchEvent(new Event(r.status>=200&&r.status<300?"load":"error"));xhr.dispatchEvent(new Event("loadend"))}).catch((e)=>{if(x.aborted)return;x.bridgePending=false;xhr.dispatchEvent(new ErrorEvent("error",{error:e,message:e.message}));xhr.dispatchEvent(new Event("loadend"))})};const origSet=Element.prototype.setAttribute;Element.prototype.setAttribute=function(name,value){const n=String(name).toLowerCase();if(["src","href","poster","cite"].includes(n)&&typeof value==="string")value=proxied(value);return origSet.call(this,name,value)};function patch(proto,prop){if(!proto)return;const d=Object.getOwnPropertyDescriptor(proto,prop);if(!d||!d.get||!d.set)return;Object.defineProperty(proto,prop,{configurable:d.configurable,enumerable:d.enumerable,get:d.get,set(v){d.set.call(this,proxied(v))}})}patch(HTMLImageElement.prototype,"src");patch(HTMLScriptElement.prototype,"src");patch(HTMLLinkElement.prototype,"href");patch(HTMLSourceElement.prototype,"src");patch(HTMLMediaElement.prototype,"src");patch(HTMLIFrameElement.prototype,"src");patch(HTMLVideoElement.prototype,"poster");})();</script>`;
}
export function rewriteCss(css: string, base: string, sessionId?: string, plan?: GatewayPlan): string { return css.replace(/url\(\s*([\"']?)([^\"')]+)\1\s*\)/gi, (full, quote, value) => { const proxied = proxyUrl(value, base, sessionId, plan); return proxied ? `url(${quote}${proxied}${quote})` : "url()"; }); }
export function rewriteJavaScript(js: string, base: string, sessionId?: string, plan?: GatewayPlan): string {
  const rewriteSpecifier = (value: string): string => proxyUrl(value, base, sessionId, plan) ?? value;
  const currentModuleUrl = proxyUrl(base, base, sessionId, plan);
  let output = js;
  if (currentModuleUrl) output = output.replace(/\bimport\.meta\.url\b/g, JSON.stringify(currentModuleUrl));
  output = output.replace(/(\bimport\s*\(\s*)([\"'])([^\"']+)\2(\s*\))/g, (_full, prefix, quote, value, suffix) => `${prefix}${quote}${rewriteSpecifier(value)}${quote}${suffix}`);
  output = output.replace(/(\b(?:import\s+|from\s+))([\"'])([^\"']+)\2/g, (_full, prefix, quote, value) => `${prefix}${quote}${rewriteSpecifier(value)}${quote}`);
  output = output.replace(/(\b(?:new\s+Worker|new\s+SharedWorker|importScripts)\s*\(\s*)([\"'])([^\"']+)\2/g, (_full, prefix, quote, value) => `${prefix}${quote}${rewriteSpecifier(value)}${quote}`);
  return output;
}
export function rewriteHtml(html: string, base: string, proxyOrigin: string, sessionId?: string, plan?: GatewayPlan): string {
  let output = html.replace(/<base[^>]*>/gi, "");
  output = output.replace(/\s(src|href|action|poster|cite)\s*=\s*([\"'])(.*?)\2/gi, (full, attr, quote, value) => { if (/^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(value)) return ` ${attr}=${quote}${value}${quote}`; const proxied = proxyUrl(value, base, sessionId, plan); return proxied ? ` ${attr}=${quote}${proxied}${quote}` : ""; });
  output = output.replace(/\s(srcset)\s*=\s*([\"'])(.*?)\2/gi, (full, attr, quote, value) => { const rewritten = value.split(",").map((part: string) => { const pieces = part.trim().split(/\s+/); const proxied = proxyUrl(pieces[0], base, sessionId, plan); if (!proxied) return ""; pieces[0] = proxied; return pieces.join(" "); }).filter(Boolean).join(", "); return ` ${attr}=${quote}${rewritten}${quote}`; });
  output = output.replace(/<meta[^>]+http-equiv\s*=\s*[\"']?content-security-policy[\"']?[^>]*>/gi, "");
  const csp = cspHeader(proxyOrigin);
  const capability = sessionId && plan ? createPageResourceCap(sessionId, plan) : "";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${csp}">${bridgeScript(base, capability)}${output}`;
}
async function serve(req: Request, res: Response): Promise<void> {
  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
  if (!rawUrl) { res.status(400).json({ error: "A valid http:// or https:// URL is required.", code: "INVALID_URL" }); return; }
  const session = req.path === "/page" ? requireWebSession(req, res) : requireResourceAccess(req, res, rawUrl); if (!session) return;
  if (!rateLimit(session.sessionId)) { res.status(429).json({ error: "This session has reached its request rate limit.", code: "RATE_LIMITED" }); return; }
  const method = req.path === "/page" ? "GET" : req.method.toUpperCase(); if (!( ["GET", "POST", "HEAD"].includes(method) )) { res.status(405).json({ error: "Only GET, POST and HEAD are supported by the protected web proxy.", code: "METHOD_NOT_ALLOWED" }); return; }
  const reservation = reserveSessionBandwidth(session.sessionId); if (reservation === null) { res.status(429).json({ error: "This plan has reached its bandwidth limit.", code: "BANDWIDTH_LIMIT" }); return; }
  const started = now();
  try {
    const result = await fetchSafe(rawUrl, session.maxResponseBytes, reservation, method, forwardedRequestHeaders(req), method === "POST" ? requestBody(req) : undefined); settleSessionBandwidth(session.sessionId, reservation, result.used);
    const type = result.upstream.headers["content-type"]?.split(";", 1)[0] ?? "application/octet-stream"; const base = result.target.url.toString(); const forwardedProto = req.header("x-forwarded-proto")?.split(",")[0]?.trim(); const proxyOrigin = `${forwardedProto || req.protocol}://${req.get("host")}`; let body = result.upstream.body;
    if (type === "text/html" || type === "application/xhtml+xml") body = Buffer.from(rewriteHtml(body.toString("utf8"), base, proxyOrigin, session.sessionId, session.plan)); else if (type === "text/css") body = Buffer.from(rewriteCss(body.toString("utf8"), base, session.sessionId, session.plan)); else if (["application/javascript", "text/javascript", "application/x-javascript", "text/ecmascript", "application/ecmascript"].includes(type)) body = Buffer.from(rewriteJavaScript(body.toString("utf8"), base, session.sessionId, session.plan));
    recordGatewayRequest({ id: crypto.randomUUID(), timestamp: new Date().toISOString(), hostname: result.target.url.hostname, status: "allowed", statusCode: result.upstream.statusCode, durationMs: now() - started, responseSize: body.length, securityDecision: "web-proxy-allowed" });
    const contentRange = result.upstream.headers["content-range"]; const acceptRanges = result.upstream.headers["accept-ranges"]; res.status(result.upstream.statusCode).set("Content-Type", type).set("X-Content-Type-Options", "nosniff").set("Content-Security-Policy", type === "text/html" ? cspHeader(proxyOrigin) : "default-src 'none';").set("Cache-Control", "no-store"); if (contentRange) res.set("Content-Range", contentRange); if (acceptRanges) res.set("Accept-Ranges", acceptRanges); if (req.method !== "HEAD") res.send(body); else res.end();
  } catch (error) { settleSessionBandwidth(session.sessionId, reservation, 0); const status = error instanceof GatewaySecurityError ? error.status : 502; const code = error instanceof GatewaySecurityError ? error.code : "UPSTREAM_FAILED"; res.status(status).json({ error: error instanceof Error ? error.message : "The upstream request could not be completed safely.", code }); }
}
function cspHeader(proxyOrigin: string): string { return `default-src 'none'; style-src ${proxyOrigin} 'unsafe-inline'; img-src ${proxyOrigin} data: blob:; font-src ${proxyOrigin} data:; script-src ${proxyOrigin} 'unsafe-inline' 'unsafe-eval'; connect-src 'none'; media-src ${proxyOrigin} blob:; frame-src ${proxyOrigin}; child-src ${proxyOrigin}; worker-src ${proxyOrigin} blob:; object-src 'none'; base-uri 'none'; form-action ${proxyOrigin}; frame-ancestors 'none';`; }
router.get("/web/page", serve); router.get("/web/resource", serve); router.post("/web/resource", serve); router.head("/web/resource", serve);
export default router;

import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { planLimits } from "./gateway-config.ts";
import { evaluatePolicy } from "./policy.ts";
import {
  assertResponseWithinLimit,
  createUpstreamTimeoutError,
  resolveRedirectTarget,
  safeLogDomain,
} from "./gateway-guards.ts";
import {
  GatewaySecurityError,
  isBlockedIp,
  resolveHostname,
  validatePublicTarget,
} from "./security.ts";
import {
  getSessionLimits,
  registerSession,
  reserveSessionBandwidth,
  settleSessionBandwidth,
} from "./gateway-store.ts";

test("allows public HTTP and HTTPS URLs", async () => {
  const httpsTarget = await validatePublicTarget("https://example.com");
  const httpTarget = await validatePublicTarget("http://example.com");
  assert.equal(httpsTarget.url.protocol, "https:");
  assert.equal(httpTarget.url.protocol, "http:");
  assert.equal(isBlockedIp(httpsTarget.address), false);
  assert.equal(isBlockedIp(httpTarget.address), false);
});

test("rejects unsupported protocols and embedded credentials", async () => {
  await assert.rejects(
    validatePublicTarget("file:///etc/passwd"),
    (error: unknown) =>
      error instanceof GatewaySecurityError &&
      error.code === "UNSUPPORTED_PROTOCOL",
  );
  await assert.rejects(
    validatePublicTarget("ftp://example.com"),
    (error: unknown) =>
      error instanceof GatewaySecurityError &&
      error.code === "UNSUPPORTED_PROTOCOL",
  );
  await assert.rejects(
    validatePublicTarget("https://user:password@example.com"),
    (error: unknown) =>
      error instanceof GatewaySecurityError &&
      error.code === "CREDENTIALS_IN_URL",
  );
});

test("rejects localhost, metadata, private IPv4, and loopback IPv6", async () => {
  for (const url of [
    "http://localhost",
    "http://127.0.0.1",
    "http://169.254.169.254",
    "http://10.0.0.1",
    "http://192.168.1.1",
    "http://[::1]",
  ]) {
    await assert.rejects(
      validatePublicTarget(url),
      (error: unknown) =>
        error instanceof GatewaySecurityError &&
        error.code === "PRIVATE_DESTINATION",
    );
  }
});

test("rejects IPv4 and IPv6 special-use ranges while allowing public IPv6", () => {
  for (const address of [
    "0.0.0.1",
    "127.42.1.1",
    "172.16.10.20",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "ff02::1",
    "100::1",
    "2001:0::1",
    "2001:2::1",
    "2001:10::1",
    "2001:20::1",
    "2001:db8::1",
    "2002:c000:0201::1",
    "3fff::1",
    "64:ff9b::c000:0201",
    "::ffff:127.0.0.1",
  ]) {
    assert.equal(isBlockedIp(address), true, address);
  }

  assert.equal(isBlockedIp("2001:4860:4860::8888"), false);
  assert.equal(isBlockedIp("::ffff:8.8.8.8"), false);
});

test("DNS resolution stops after the configured timeout", async () => {
  await assert.rejects(
    resolveHostname(
      "slow.example",
      10,
      async () =>
        new Promise((resolve) => {
          setTimeout(
            () => resolve([{ address: "203.0.113.10", family: 4 }]),
            50,
          );
        }),
    ),
    (error: unknown) =>
      error instanceof GatewaySecurityError && error.code === "DNS_TIMEOUT",
  );
});

test("binds plan limits to sessions and rejects over-limit sessions and bandwidth", () => {
  const firstSession = crypto.randomUUID();
  const secondSession = crypto.randomUUID();
  const expiresAt = Date.now() + 60_000;

  assert.equal(registerSession(firstSession, "FREE", expiresAt), true);
  assert.equal(registerSession(secondSession, "FREE", expiresAt), false);

  const limits = getSessionLimits(firstSession);
  assert.equal(limits?.maxResponseBytes, planLimits.FREE.maxResponseBytes);
  assert.equal(
    limits?.maxConcurrentSessions,
    planLimits.FREE.maxConcurrentSessions,
  );

  for (let index = 0; index < 25; index += 1) {
    const reservation = reserveSessionBandwidth(firstSession);
    assert.equal(reservation, planLimits.FREE.maxResponseBytes);
    settleSessionBandwidth(firstSession, reservation, reservation);
  }
  assert.equal(reserveSessionBandwidth(firstSession), null);
});

test("blocks protected WhatsApp domains with the privacy message", () => {
  const decision = evaluatePolicy("web.whatsapp.com");
  assert.equal(decision.blocked, true);
  assert.equal(decision.policy, "whatsapp");
  assert.match(decision.message ?? "", /غير متاح داخل Internet Lab/);
});

test("validates redirects before they can reach a private address", async () => {
  const redirectedUrl = resolveRedirectTarget(
    "https://example.com",
    "http://127.0.0.1/admin",
    0,
    3,
  );
  await assert.rejects(
    validatePublicTarget(redirectedUrl),
    (error: unknown) =>
      error instanceof GatewaySecurityError &&
      error.code === "PRIVATE_DESTINATION",
  );
});

test("enforces response size, timeout, and redirect limits", () => {
  assert.throws(
    () => assertResponseWithinLimit(101, 100),
    (error: unknown) =>
      error instanceof GatewaySecurityError &&
      error.code === "RESPONSE_TOO_LARGE",
  );
  assert.equal(createUpstreamTimeoutError().code, "UPSTREAM_TIMEOUT");
  assert.throws(
    () => resolveRedirectTarget("https://example.com", "/", 3, 3),
    (error: unknown) =>
      error instanceof GatewaySecurityError && error.code === "REDIRECT_LIMIT",
  );
});

test("safe logging keeps paths, queries, and credentials out of domains", () => {
  assert.equal(
    safeLogDomain("https://user:secret@example.com/private?token=hidden"),
    "example.com",
  );
  assert.equal(safeLogDomain("not a url"), "invalid");
});

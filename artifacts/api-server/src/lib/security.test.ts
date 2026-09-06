import assert from "node:assert/strict";
import test from "node:test";
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
  validatePublicTarget,
} from "./security.ts";

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

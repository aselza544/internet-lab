import { GatewaySecurityError } from "./security.ts";

export function assertResponseWithinLimit(
  responseSize: number,
  maxResponseBytes: number,
): void {
  if (responseSize > maxResponseBytes) {
    throw new GatewaySecurityError(
      "RESPONSE_TOO_LARGE",
      "The upstream response exceeded the configured size limit.",
      502,
    );
  }
}

export function resolveRedirectTarget(
  currentUrl: string,
  location: string,
  redirectCount: number,
  maxRedirects: number,
): string {
  if (redirectCount >= maxRedirects) {
    throw new GatewaySecurityError(
      "REDIRECT_LIMIT",
      "The upstream exceeded the redirect limit.",
      502,
    );
  }
  return new URL(location, currentUrl).toString();
}

export function createUpstreamTimeoutError(): GatewaySecurityError {
  return new GatewaySecurityError(
    "UPSTREAM_TIMEOUT",
    "The upstream request timed out.",
    502,
  );
}

export function safeLogDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "invalid";
  }
}

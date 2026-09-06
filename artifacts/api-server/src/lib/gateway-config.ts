const numberFromEnv = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export const gatewayConfig = {
  timeoutMs: numberFromEnv("GATEWAY_TIMEOUT_MS", 8_000),
  maxResponseBytes: numberFromEnv("GATEWAY_MAX_RESPONSE_BYTES", 1_048_576),
  maxRedirects: numberFromEnv("GATEWAY_MAX_REDIRECTS", 3),
  maxConcurrentSessions: numberFromEnv("GATEWAY_MAX_CONCURRENT_SESSIONS", 3),
  rateLimitPerMinute: numberFromEnv("GATEWAY_RATE_LIMIT_PER_MINUTE", 20),
  idleSessionTimeoutMs: numberFromEnv(
    "GATEWAY_IDLE_SESSION_TIMEOUT_MS",
    30 * 60_000,
  ),
} as const;

export const planLimits = {
  FREE: {
    maxResponseBytes: 1_048_576,
    maxConcurrentSessions: 1,
    bandwidthBytes: 25 * 1_048_576,
  },
  BASIC: {
    maxResponseBytes: 5 * 1_048_576,
    maxConcurrentSessions: 3,
    bandwidthBytes: 250 * 1_048_576,
  },
  PRO: {
    maxResponseBytes: 10 * 1_048_576,
    maxConcurrentSessions: 10,
    bandwidthBytes: 2_500 * 1_048_576,
  },
} as const;

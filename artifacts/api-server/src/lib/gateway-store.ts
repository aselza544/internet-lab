import { planLimits, type GatewayPlan } from "./gateway-config.ts";

export type GatewayRequestRecord = {
  id: string;
  timestamp: string;
  hostname: string;
  status: "allowed" | "blocked" | "failed";
  statusCode: number | null;
  durationMs: number;
  responseSize: number;
  securityDecision: string;
};

export type GatewaySessionLimits = {
  plan: GatewayPlan;
  maxResponseBytes: number;
  maxConcurrentSessions: number;
  bandwidthBytes: number;
  remainingBandwidthBytes: number;
};

type GatewaySessionRecord = {
  plan: GatewayPlan;
  expiresAt: number;
  usedBytes: number;
  reservedBytes: number;
};

const requestRecords: GatewayRequestRecord[] = [];
const sessions = new Map<string, GatewaySessionRecord>();
let totalBytes = 0;
let blockedCount = 0;

function pruneExpiredSessions(now = Date.now()): void {
  for (const [sessionId, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(sessionId);
  }
}

export function registerSession(
  sessionId: string,
  plan: GatewayPlan,
  expiresAt: number,
): boolean {
  pruneExpiredSessions();
  const activeForPlan = [...sessions.values()].filter(
    (session) => session.plan === plan,
  ).length;
  if (activeForPlan >= planLimits[plan].maxConcurrentSessions) return false;

  sessions.set(sessionId, {
    plan,
    expiresAt,
    usedBytes: 0,
    reservedBytes: 0,
  });
  return true;
}

export function getSessionLimits(
  sessionId: string,
): GatewaySessionLimits | null {
  pruneExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return null;

  const limits = planLimits[session.plan];
  return {
    plan: session.plan,
    maxResponseBytes: limits.maxResponseBytes,
    maxConcurrentSessions: limits.maxConcurrentSessions,
    bandwidthBytes: limits.bandwidthBytes,
    remainingBandwidthBytes: Math.max(
      0,
      limits.bandwidthBytes - session.usedBytes - session.reservedBytes,
    ),
  };
}

export function reserveSessionBandwidth(sessionId: string): number | null {
  pruneExpiredSessions();
  const session = sessions.get(sessionId);
  if (!session) return null;

  const limits = planLimits[session.plan];
  const remaining =
    limits.bandwidthBytes - session.usedBytes - session.reservedBytes;
  if (remaining <= 0) return null;

  const reservation = Math.min(limits.maxResponseBytes, remaining);
  session.reservedBytes += reservation;
  return reservation;
}

export function settleSessionBandwidth(
  sessionId: string,
  reservation: number,
  usedBytes: number,
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.reservedBytes = Math.max(0, session.reservedBytes - reservation);
  session.usedBytes += Math.max(0, Math.min(usedBytes, reservation));
}

export function getActiveSessionCount(): number {
  pruneExpiredSessions();
  return sessions.size;
}

export function recordGatewayRequest(record: GatewayRequestRecord): void {
  requestRecords.unshift(record);
  totalBytes += record.responseSize;
  if (record.status === "blocked") blockedCount += 1;
  if (requestRecords.length > 100) requestRecords.pop();
}

export function getRecentGatewayRequests(): GatewayRequestRecord[] {
  return requestRecords.slice(0, 8);
}

export function getDashboardSummary() {
  return {
    activeSessions: getActiveSessionCount(),
    requestsToday: requestRecords.length,
    blockedRequests: blockedCount,
    bandwidthBytes: totalBytes,
    protection: "enforced" as const,
    recentRequests: getRecentGatewayRequests(),
  };
}

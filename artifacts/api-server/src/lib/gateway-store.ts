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

const requestRecords: GatewayRequestRecord[] = [];
const sessionIds = new Set<string>();
let totalBytes = 0;
let blockedCount = 0;

export function registerSession(sessionId: string): void {
  sessionIds.add(sessionId);
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
    activeSessions: sessionIds.size,
    requestsToday: requestRecords.length,
    blockedRequests: blockedCount,
    bandwidthBytes: totalBytes,
    protection: "enforced" as const,
    recentRequests: getRecentGatewayRequests(),
  };
}

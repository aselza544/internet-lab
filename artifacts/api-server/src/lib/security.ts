import dns from "node:dns/promises";
import net from "node:net";

export class GatewaySecurityError extends Error {
  public readonly code: string;
  public readonly status: number;

  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = "GatewaySecurityError";
  }
}

const stripIpv6Brackets = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

function ipv4ToNumber(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return null;
  }

  const octets = parts.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) return null;

  return (
    octets[0] * 2 ** 24 + octets[1] * 2 ** 16 + octets[2] * 2 ** 8 + octets[3]
  );
}

function inIpv4Range(value: number, start: number, end: number): boolean {
  return value >= start && value <= end;
}

function expandIpv6(value: string): number[] | null {
  const normalized = value.toLowerCase().split("%", 1)[0];
  const halves = normalized.split("::");
  if (halves.length > 2) return null;

  const parseHalf = (half: string): number[] => {
    if (!half) return [];
    return half.split(":").flatMap((part) => {
      if (part.includes(".")) {
        const ipv4 = ipv4ToNumber(part);
        return ipv4 === null ? [] : [(ipv4 >>> 16) & 0xffff, ipv4 & 0xffff];
      }
      if (!/^[0-9a-f]{1,4}$/i.test(part)) return [];
      return [parseInt(part, 16)];
    });
  };

  const left = parseHalf(halves[0]);
  const right = halves.length === 2 ? parseHalf(halves[1]) : [];
  if (left.length + right.length > 8) return null;
  if (halves.length === 1 && left.length !== 8) return null;

  return [
    ...left,
    ...(halves.length === 2
      ? Array(8 - left.length - right.length).fill(0)
      : []),
    ...right,
  ];
}

function isBlockedIpv6(value: string): boolean {
  const parts = expandIpv6(value);
  if (!parts) return true;

  const first = parts[0];
  const second = parts[1];
  const isUnspecified = parts.every((part) => part === 0);
  const isLoopback =
    parts.slice(0, 7).every((part) => part === 0) && parts[7] === 1;
  const isUniqueLocal = (first & 0xfe00) === 0xfc00;
  const isLinkLocal = (first & 0xffc0) === 0xfe80;
  const isMulticast = (first & 0xff00) === 0xff00;
  const isDocumentation = first === 0x2001 && second === 0x0db8;
  const isIpv4Mapped =
    parts.slice(0, 5).every((part) => part === 0) && parts[5] === 0xffff;

  if (isIpv4Mapped) {
    const mappedIpv4 = `${parts[6] >>> 8}.${parts[6] & 255}.${parts[7] >>> 8}.${parts[7] & 255}`;
    return isBlockedIp(mappedIpv4);
  }

  return (
    isUnspecified ||
    isLoopback ||
    isUniqueLocal ||
    isLinkLocal ||
    isMulticast ||
    isDocumentation
  );
}

export function isBlockedIp(value: string): boolean {
  const ip = value.toLowerCase();
  const family = net.isIP(ip);

  if (family === 4) {
    const numeric = ipv4ToNumber(ip);
    if (numeric === null) return true;
    return (
      inIpv4Range(numeric, 0x00000000, 0x00ffffff) ||
      inIpv4Range(numeric, 0x0a000000, 0x0affffff) ||
      inIpv4Range(numeric, 0x64400000, 0x647fffff) ||
      inIpv4Range(numeric, 0x7f000000, 0x7fffffff) ||
      inIpv4Range(numeric, 0xa9fe0000, 0xa9feffff) ||
      inIpv4Range(numeric, 0xac100000, 0xac1fffff) ||
      inIpv4Range(numeric, 0xc0000000, 0xc00000ff) ||
      inIpv4Range(numeric, 0xc0000200, 0xc00002ff) ||
      inIpv4Range(numeric, 0xc0a80000, 0xc0a8ffff) ||
      inIpv4Range(numeric, 0xc6120000, 0xc613ffff) ||
      inIpv4Range(numeric, 0xc6336400, 0xc63364ff) ||
      inIpv4Range(numeric, 0xcb007100, 0xcb0071ff) ||
      inIpv4Range(numeric, 0xe0000000, 0xffffffff)
    );
  }

  if (family === 6) return isBlockedIpv6(ip);
  return true;
}

export type ValidatedTarget = {
  url: URL;
  address: string;
  family: 4 | 6;
};

export async function validatePublicTarget(
  rawUrl: string,
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new GatewaySecurityError("INVALID_URL", "Enter a valid website URL.");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new GatewaySecurityError(
      "UNSUPPORTED_PROTOCOL",
      "Only http:// and https:// URLs are allowed.",
    );
  }

  if (url.username || url.password) {
    throw new GatewaySecurityError(
      "CREDENTIALS_IN_URL",
      "URLs containing embedded credentials are not allowed.",
    );
  }

  if (url.port && !["80", "443"].includes(url.port)) {
    throw new GatewaySecurityError(
      "UNSUPPORTED_PORT",
      "Only standard HTTP and HTTPS ports are allowed.",
    );
  }

  const hostname = stripIpv6Brackets(url.hostname).toLowerCase();
  const blockedHostnames = new Set([
    "localhost",
    "localhost.localdomain",
    "metadata.google.internal",
    "instance-data.ec2.internal",
    "host.docker.internal",
  ]);

  if (
    blockedHostnames.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".internal")
  ) {
    throw new GatewaySecurityError(
      "PRIVATE_DESTINATION",
      "Internal and local network destinations are blocked.",
      403,
    );
  }

  const directFamily = net.isIP(hostname);
  const addresses =
    directFamily === 4 || directFamily === 6
      ? [{ address: hostname, family: directFamily }]
      : await dns.lookup(hostname, { all: true, verbatim: true });

  if (
    !addresses.length ||
    addresses.some(({ address }) => isBlockedIp(address))
  ) {
    throw new GatewaySecurityError(
      "PRIVATE_DESTINATION",
      "Internal and private network destinations are blocked.",
      403,
    );
  }

  const selected = addresses[0];
  return {
    url,
    address: selected.address,
    family: selected.family as 4 | 6,
  };
}

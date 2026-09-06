export type PolicyDecision = {
  blocked: boolean;
  code?: string;
  policy?: string;
  message?: string;
};

const whatsappMessage =
  "هذا الموقع غير متاح داخل Internet Lab لحماية خصوصية المستخدمين ومنع جمع البيانات الحساسة.";

const defaultBlockedDomains = [
  "whatsapp.com",
  "web.whatsapp.com",
  "api.whatsapp.com",
  "wa.me",
  "paypal.com",
  "stripe.com",
  "checkout.com",
  "onfido.com",
  "jumio.com",
  "persona.id",
  "veriff.com",
];

const configuredBlockedDomains = (process.env.BLOCKED_DOMAINS ?? "")
  .split(",")
  .map((domain) => domain.trim().toLowerCase())
  .filter(Boolean);

const blockedDomains = new Set([
  ...defaultBlockedDomains,
  ...configuredBlockedDomains,
]);

const matchesDomain = (hostname: string, domain: string): boolean =>
  hostname === domain || hostname.endsWith(`.${domain}`);

export function evaluatePolicy(hostname: string): PolicyDecision {
  const normalizedHostname = hostname.toLowerCase().replace(/\.$/, "");

  if (
    matchesDomain(normalizedHostname, "whatsapp.com") ||
    matchesDomain(normalizedHostname, "wa.me")
  ) {
    return {
      blocked: true,
      code: "PROTECTED_SERVICE",
      policy: "whatsapp",
      message: whatsappMessage,
    };
  }

  if (
    [...blockedDomains].some((domain) =>
      matchesDomain(normalizedHostname, domain),
    )
  ) {
    return {
      blocked: true,
      code: "PROTECTED_SERVICE",
      policy: "sensitive-service",
      message:
        "This service is not available inside Internet Lab because it may collect sensitive personal or payment information.",
    };
  }

  const sensitiveHostnamePattern =
    /(^|[.-])(bank|banking|payment|payments|checkout|kyc|identity|verify|verification)([.-]|$)/i;

  if (sensitiveHostnamePattern.test(normalizedHostname)) {
    return {
      blocked: true,
      code: "PROTECTED_SERVICE",
      policy: "sensitive-service",
      message:
        "This service is not available inside Internet Lab because it may collect sensitive personal or payment information.",
    };
  }

  return { blocked: false };
}

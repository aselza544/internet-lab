import http from "node:http";
import https from "node:https";
import type { IncomingMessage } from "node:http";
import { gatewayConfig } from "./gateway-config.ts";
import {
  assertResponseWithinLimit,
  createUpstreamTimeoutError,
} from "./gateway-guards.ts";
import { validatePublicTarget } from "./security.ts";

export function readUpstream(
  target: Awaited<ReturnType<typeof validatePublicTarget>>,
  maxResponseBytes = gatewayConfig.maxResponseBytes,
): Promise<{
  statusCode: number;
  headers: IncomingMessage["headers"];
  body: Buffer;
}> {
  const transport = target.url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    const request = transport.request(
      {
        protocol: target.url.protocol,
        hostname: target.url.hostname,
        port: target.url.port || (target.url.protocol === "https:" ? 443 : 80),
        path: `${target.url.pathname || "/"}${target.url.search}`,
        method: "GET",
        headers: {
          accept:
            "text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.1",
          "user-agent": "Internet-Lab-Gateway/0.1",
        },
        lookup: (
          _hostname: string,
          options: { all?: boolean },
          callback: (
            error: NodeJS.ErrnoException | null,
            address: string | Array<{ address: string; family: number }>,
            family?: number,
          ) => void,
        ) => {
          if (options.all) {
            callback(null, [
              { address: target.address, family: target.family },
            ]);
            return;
          }
          callback(null, target.address, target.family);
        },
        ...(target.url.protocol === "https:"
          ? { servername: target.url.hostname }
          : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let total = 0;

        response.on("data", (chunk: Buffer) => {
          total += chunk.length;
          try {
            assertResponseWithinLimit(total, maxResponseBytes);
          } catch (error) {
            request.destroy(
              error instanceof Error
                ? error
                : new Error("Response size limit exceeded"),
            );
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on("end", () =>
          resolve({
            statusCode: response.statusCode ?? 502,
            headers: response.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );

    request.setTimeout(gatewayConfig.timeoutMs, () => {
      request.destroy(createUpstreamTimeoutError());
    });
    request.on("error", reject);
    request.end();
  });
}

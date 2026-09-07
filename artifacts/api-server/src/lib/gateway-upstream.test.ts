import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { readUpstream } from "./gateway-upstream.ts";

test("pins the validated address and does not forward inbound headers", async () => {
  let observedHeaders: http.IncomingHttpHeaders | undefined;
  const server = http.createServer((request, response) => {
    observedHeaders = request.headers;
    response.setHeader("content-type", "text/plain");
    response.end("safe upstream response");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  try {
    const result = await readUpstream({
      url: new URL(`http://public.example.test:${address.port}/resource`),
      address: "127.0.0.1",
      family: 4,
    });

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.toString(), "safe upstream response");
    assert.equal(observedHeaders?.cookie, undefined);
    assert.equal(observedHeaders?.authorization, undefined);
    assert.equal(observedHeaders?.["x-arbitrary-user-header"], undefined);
    assert.equal(observedHeaders?.["user-agent"], "Internet-Lab-Gateway/0.1");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import { rewriteCss, rewriteHtml } from "../routes/web.ts";

test("rewrites HTML resources to the internal proxy", () => {
  const html = '<img src="https://example.com/a.png"><link href="/site.css"><a href="/next">Next</a>';
  const result = rewriteHtml(html, "https://example.com/");
  assert.match(result, /\/api\/web\/resource\?url=/);
  assert.doesNotMatch(result, /https:\/\/example\.com\/a\.png/);
  assert.match(result, /Content-Security-Policy/);
});

test("rewrites CSS url references", () => {
  const result = rewriteCss("body{background:url('/img/bg.png')}", "https://example.com/css/site.css");
  assert.match(result, /\/api\/web\/resource\?url=/);
  assert.doesNotMatch(result, /url\('\/img\/bg\.png'\)/);
});

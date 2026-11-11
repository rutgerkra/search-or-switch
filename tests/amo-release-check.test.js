import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { checkAmoVersion } from "../scripts/amo-release-check.mjs";

const manifest = (version) => ({ version, browser_specific_settings: { gecko: { id: "test@example.local" } } });
const response = (versions, next = null) => ({
  ok: true, status: 200, json: async () => ({ results: versions.map((version) => ({ version })), next }),
});
const check = (version, fetchImpl) => checkAmoVersion({ manifest: manifest(version), apiKey: "test-key", apiSecret: "test-secret", fetchImpl });

test("unchanged, equivalent, pending, and older manifest versions never submit", async () => {
  for (const [current, existing] of [["0.1.0", "0.1.0"], ["1.0.0", "1.0"], ["0.1.0", "0.1.1"], ["0.1.0", "0.1.0.1"]]) {
    const result = await check(current, async () => response([existing]));
    assert.equal(result.publish, false);
  }
});

test("numeric version increases submit with the exact manifest version", async () => {
  for (const [current, existing] of [["0.1.1", "0.1.0"], ["0.1.10", "0.1.9"], ["1.0.0", "0.99.99"], ["0.1.0.2", "0.1.0.1"]]) {
    const result = await check(current, async () => response([existing]));
    assert.equal(result.publish, true);
    assert.match(result.reason, new RegExp(current.replaceAll(".", "\\.")));
  }
});

test("checks every page and authenticates the lookup including unpublished submissions", async () => {
  const requests = [];
  const result = await check("0.1.1", async (url, options) => {
    requests.push(url);
    assert.equal(url.origin, "https://addons.mozilla.org");
    assert.equal(url.searchParams.get("filter"), "all_with_unlisted");
    assert.equal(options.redirect, "error");
    const [header, payload, signature] = options.headers.Authorization.slice(4).split(".");
    assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), { alg: "HS256", typ: "JWT" });
    const claims = JSON.parse(Buffer.from(payload, "base64url"));
    assert.equal(claims.iss, "test-key");
    assert.equal(claims.exp - claims.iat, 60);
    assert.ok(claims.jti);
    assert.equal(signature, createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest("base64url"));
    return requests.length === 1 ? response(["0.1.0"], "https://other.example/page2") : response(["0.1.1"]);
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get("page"), "2");
  assert.equal(result.publish, false);
});

test("authentication errors, missing listings, and service errors stop publishing", async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(check("0.1.1", async () => ({ ok: false, status })), status === 404 ? /initial Mozilla Add-ons listing/ : /no submission attempted/);
  }
  await assert.rejects(check("0.1.1", async () => { throw new Error("Network unavailable"); }), /Network unavailable/);
});

test("invalid local versions and invalid service data stop publishing", async () => {
  await assert.rejects(check("0.01.0", async () => response([])), /numeric components/);
  await assert.rejects(check("0.1.1", async () => response(["invalid"])), /numeric components/);
  await assert.rejects(check("0.1.1", async () => ({ ok: true, json: async () => ({}) })), /invalid version list/);
});

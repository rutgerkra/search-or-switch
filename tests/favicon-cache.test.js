import test from "node:test";
import assert from "node:assert/strict";
import { createFaviconCache } from "../favicon-cache.js";

const KEY = "faviconCacheV1";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const ICO = "data:image/x-icon;base64,AAABAA==";
const tick = () => new Promise((resolve) => setImmediate(resolve));

function storage(records = []) {
  const calls = [];
  let saved = structuredClone(records);
  return {
    calls,
    async get(key) { calls.push(["get", key]); return { [KEY]: structuredClone(saved) }; },
    async set(value) { calls.push(["set", structuredClone(value)]); saved = structuredClone(value[KEY]); },
    get records() { return saved; },
  };
}

test("inline tab icons are reused by HTTP origin and only origins reach session storage", async () => {
  const session = storage();
  const cache = createFaviconCache(session);
  await cache.load();
  cache.remember([{ url: "https://example.com/private?token=secret#fragment", title: "Secret", favIconUrl: PNG }]);
  assert.equal(cache.get("https://example.com/another-page"), PNG);
  assert.equal(cache.get("http://example.com/"), null);
  assert.equal(cache.get("https://example.com:8443/"), null);
  assert.equal(cache.get("https://sub.example.com/"), null);
  assert.equal(cache.get("https://example.com/", ICO), ICO);
  await tick();
  assert.deepEqual(session.records, [{ origin: "https://example.com", icon: PNG }]);
});

test("remote, unsupported, malformed, empty, and over-limit icons are never used", () => {
  const cache = createFaviconCache(undefined, { persist: false });
  const invalid = [
    "https://example.com/favicon.ico", "cached-favicon:https://example.com/favicon.ico",
    "page-icon:https://example.com/", "moz-anno:favicon:https://example.com/favicon.ico",
    "data:image/svg+xml;base64,%%%", "data:image/svg+xml,", "data:text/html;base64,PGgxLz4=",
    "data:image/png;base64,", "data:image/png;base64,%%%", "data:image/png;base64,a",
    "data:image/png;base64,aGVsbG8=\n", "data:image/png;base64," + "A".repeat(64 * 1024),
  ];
  for (const icon of invalid) {
    cache.remember([{ url: "https://example.com/", favIconUrl: icon }]);
    assert.equal(cache.get("https://example.com/", icon), null, icon.slice(0, 80));
  }
  for (const type of ["png", "x-icon", "vnd.microsoft.icon", "jpeg", "gif", "webp", "avif", "svg+xml"]) {
    const icon = `data:image/${type};base64,AAABAA==`;
    assert.equal(cache.get("https://example.com/", icon), icon);
  }
});

test("Firefox SVG favicons in base64 and URL-encoded forms remain available after reopening the cache", async () => {
  const icons = ["data:image/svg+xml;base64,PHN2Zy8+", "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')];
  for (const icon of icons) {
    const saved = storage();
    const first = createFaviconCache(saved);
    first.remember([{ url: "https://example.com/open-tab", favIconUrl: icon }]);
    await tick();
    const reopened = createFaviconCache(saved);
    await reopened.load();
    assert.equal(reopened.get("https://example.com/later-visit"), icon);
  }
});

test("credentials, unsupported protocols, and malformed URLs cannot select or seed icons", () => {
  const cache = createFaviconCache(undefined, { persist: false });
  for (const url of ["https://me:secret@example.com/", "https://me@example.com/", "file:///tmp/icon", "about:newtab", "data:text/html,a", "javascript:alert(1)", "not a URL", null]) {
    cache.remember([{ url, favIconUrl: PNG }]);
    assert.equal(cache.get(url, PNG), null);
  }
  assert.equal(cache.get("https://example.com/"), null);
});

test("regular caches ignore private tabs; private caches make no storage calls", async () => {
  const session = storage([{ origin: "https://saved.example", icon: PNG }]);
  const regular = createFaviconCache(session);
  regular.remember([{ url: "https://private.example/", favIconUrl: PNG, incognito: true }]);
  assert.equal(regular.get("https://private.example/"), null);
  assert.deepEqual(session.calls, []);

  const privateCache = createFaviconCache(session, { persist: false });
  await privateCache.load();
  privateCache.remember([{ url: "https://private.example/", favIconUrl: ICO, incognito: true }]);
  assert.equal(privateCache.get("https://private.example/"), ICO);
  assert.equal(privateCache.get("https://saved.example/"), null);
  await tick();
  assert.deepEqual(session.calls, []);
});

test("load runs once, rejects unsafe stored records, and enforces the recent-entry bound", async () => {
  const session = storage([
    { origin: "https://old.example", icon: PNG },
    { origin: "https://remote.example", icon: "https://remote.example/icon" },
    { origin: "https://user:secret@credentials.example", icon: PNG },
    { origin: "https://path.example/private?token=secret", icon: PNG },
    { origin: "https://second.example", icon: PNG },
    { origin: "https://third.example", icon: ICO },
    null,
  ]);
  const cache = createFaviconCache(session, { maxEntries: 2 });
  const firstLoad = cache.load();
  assert.equal(cache.load(), firstLoad);
  await firstLoad;
  assert.equal(cache.get("https://old.example/"), null);
  assert.equal(cache.get("https://remote.example/"), null);
  assert.equal(cache.get("https://credentials.example/"), null);
  assert.equal(cache.get("https://path.example/"), null);
  assert.equal(cache.get("https://second.example/"), PNG);
  assert.equal(cache.get("https://third.example/"), ICO);
  assert.equal(session.calls.filter(([kind]) => kind === "get").length, 1);
  cache.remember([{ url: "https://second.example/new", favIconUrl: ICO }]);
  cache.remember([{ url: "https://fourth.example/", favIconUrl: PNG }]);
  assert.equal(cache.get("https://third.example/"), null);
  assert.equal(cache.get("https://second.example/"), ICO);
  await tick();
  assert.deepEqual(session.records.map(({ origin }) => origin), ["https://second.example", "https://fourth.example"]);
});

test("the cache never exceeds 64 entries even if a higher limit is requested", async () => {
  const session = storage();
  const cache = createFaviconCache(session, { maxEntries: 100 });
  cache.remember(Array.from({ length: 65 }, (_, index) => ({ url: `https://site${index}.example/`, favIconUrl: PNG })));
  assert.equal(cache.get("https://site0.example/"), null);
  assert.equal(cache.get("https://site64.example/"), PNG);
  await tick();
  assert.equal(session.records.length, 64);
});

test("newer observations win over a slow load and serialized writes keep the latest snapshot", async () => {
  let finishLoad;
  const writes = [];
  const session = {
    get() { return new Promise((resolve) => { finishLoad = resolve; }); },
    set(value) { return new Promise((resolve) => { writes.push({ value: structuredClone(value), resolve }); }); },
  };
  const cache = createFaviconCache(session);
  const loading = cache.load();
  cache.remember([{ url: "https://example.com/", favIconUrl: ICO }]);
  cache.remember([{ url: "https://latest.example/", favIconUrl: PNG }]);
  assert.equal(writes.length, 1);
  finishLoad({ [KEY]: [{ origin: "https://example.com", icon: PNG }] });
  await loading;
  assert.equal(cache.get("https://example.com/"), ICO);
  writes[0].resolve();
  await tick();
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].value[KEY], [
    { origin: "https://example.com", icon: ICO }, { origin: "https://latest.example", icon: PNG },
  ]);
  writes[1].resolve();
  await tick();
});

test("a late load preserves older origins in storage after an early observation was saved", async () => {
  let finishLoad;
  let saved;
  const session = {
    get() { return new Promise((resolve) => { finishLoad = resolve; }); },
    async set(value) { saved = structuredClone(value[KEY]); },
  };
  const cache = createFaviconCache(session);
  const loading = cache.load();
  cache.remember([{ url: "https://new.example/", favIconUrl: ICO }]);
  await tick();
  finishLoad({ [KEY]: [{ origin: "https://old.example", icon: PNG }] });
  await loading;
  await tick();
  assert.deepEqual(saved, [
    { origin: "https://old.example", icon: PNG }, { origin: "https://new.example", icon: ICO },
  ]);
});

test("missing storage, thrown failures, and rejected operations never block in-memory icons", async () => {
  for (const session of [undefined, {}, {
    get() { throw new Error("Unavailable"); }, set() { throw new Error("Quota"); },
  }, {
    async get() { throw new Error("Unavailable"); }, async set() { throw new Error("Quota"); },
  }, {
    async get() { return { [KEY]: { invalid: true } }; }, async set() {},
  }]) {
    const cache = createFaviconCache(session);
    await assert.doesNotReject(cache.load());
    assert.doesNotThrow(() => cache.remember([{ url: "https://example.com/", favIconUrl: PNG }]));
    assert.equal(cache.get("https://example.com/"), PNG);
    await tick();
  }
});

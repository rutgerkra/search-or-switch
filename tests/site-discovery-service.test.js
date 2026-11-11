import test from "node:test";
import assert from "node:assert/strict";
import { createSiteSearchService } from "../site-discovery-service.js";

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    async emit(...args) { await Promise.all([...listeners].map((listener) => listener(...args))); },
    get size() { return listeners.size; },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}

function fakeBrowser({ stored, granted = true, tabs = [] } = {}) {
  let saved = stored;
  const records = new Map(tabs.map((tab) => [tab.id, { ...tab }]));
  const scans = [];
  const notices = [];
  const payloads = new Map();
  const api = {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(saved) }; },
      async set(value) { saved = structuredClone(Object.values(value)[0]); },
    } },
    permissions: {
      async contains() { return granted; },
      onAdded: event(), onRemoved: event(),
    },
    tabs: {
      async query() { return [...records.values()].map((tab) => ({ ...tab })); },
      async get(id) { if (!records.has(id)) throw new Error("Tab closed"); return { ...records.get(id) }; },
      onUpdated: event(),
    },
    scripting: { async executeScript(options) {
      scans.push(options);
      return [{ frameId: 0, result: payloads.get(options.target.tabId) ?? { openSearch: [], forms: [] } }];
    } },
    runtime: {
      onMessage: event(),
      async sendMessage(message) { notices.push(message); },
      getURL(path) { return `moz-extension://test/${path}`; },
    },
  };
  return { api, records, scans, notices, payloads, get saved() { return saved; }, setGranted(value) { granted = value; } };
}

test("discovery defaults on without reading pages until access is granted", async () => {
  const fake = fakeBrowser({ granted: false, tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  const service = createSiteSearchService(fake.api);
  assert.deepEqual(await service.start(), { enabled: true, permitted: false, learned: [] });
  assert.deepEqual(fake.scans, []);
  await fake.api.tabs.onUpdated.emit(1, { status: "complete" }, fake.records.get(1));
  assert.deepEqual(fake.scans, []);
  assert.deepEqual(await service.read(), { enabled: true, permitted: false, learned: [] });
  service.dispose();
  const unavailable = createSiteSearchService();
  assert.deepEqual(await unavailable.read(), { enabled: true, permitted: false, learned: [] });
  unavailable.dispose();
  const explicitOff = createSiteSearchService(fakeBrowser({ stored: { enabled: false, learned: [] } }).api);
  assert.equal((await explicitOff.read()).enabled, false);
  explicitOff.dispose();
});

test("enabling requires page access and scans completed normal tabs across windows", async () => {
  const fake = fakeBrowser({ granted: false, tabs: [
    { id: 1, url: "https://example.com/", status: "complete", windowId: 1 },
    { id: 2, url: "https://elsewhere.example/", status: "complete", windowId: 2 },
    { id: 3, url: "https://private.example/", status: "complete", incognito: true },
    { id: 4, url: "about:home", status: "complete" },
    { id: 5, url: "https://loading.example/", status: "loading" },
  ] });
  const service = createSiteSearchService(fake.api);
  await service.start();
  await assert.rejects(service.setEnabled(true), /website access/i);
  assert.equal((await service.read()).enabled, true, "denied access preserves the default preference");
  fake.setGranted(true);
  assert.equal((await service.setEnabled(true)).enabled, true);
  assert.deepEqual(fake.scans.map((scan) => scan.target), [{ tabId: 1 }, { tabId: 2 }]);
  assert.deepEqual(fake.scans[0].files, ["site-discovery.js"]);
  assert.equal(fake.saved.enabled, true);
  const reopened = createSiteSearchService(fake.api);
  assert.equal((await reopened.read()).enabled, true);
  reopened.dispose();
  service.dispose();
});

test("static GET discoveries are immediately available, persisted, and refreshed by later visits", async () => {
  const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/page?current=do-not-store", status: "complete" }] });
  fake.payloads.set(1, { openSearch: [], forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
  const service = createSiteSearchService(fake.api);
  await service.start();
  const enabled = await service.setEnabled(true);
  assert.deepEqual(enabled.learned, [{ id: "learned:https://example.com", name: "example.com", keyword: "example.com",
    origin: "https://example.com", template: "https://example.com/search?q={searchTerms}" }]);
  assert(!JSON.stringify(fake.saved).includes("do-not-store"));
  const reopened = createSiteSearchService(fake.api);
  assert.deepEqual((await reopened.read()).learned, enabled.learned);
  reopened.dispose();
  fake.records.set(2, { id: 2, url: "https://other.example/", status: "complete" });
  fake.payloads.set(2, { openSearch: [], forms: [{ template: "https://other.example/find?search={searchTerms}" }] });
  await fake.api.tabs.onUpdated.emit(2, { status: "complete" }, fake.records.get(2));
  assert.equal((await service.read()).learned.length, 2);
  await service.setEnabled(false);
  await fake.api.tabs.onUpdated.emit(2, { status: "complete" }, fake.records.get(2));
  assert.equal(fake.scans.length, 2);
  assert.equal((await service.read()).learned.length, 2);
  assert(fake.notices.some((message) => message.type === "site-search:changed"));
  service.dispose();
});

test("popup messages expose the catalog and clearing preserves discovery and later relearning", async () => {
  const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  fake.payloads.set(1, { forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
  const service = createSiteSearchService(fake.api);
  await service.start();
  const popup = { url: "moz-extension://test/popup.html" };
  await service.handleMessage({ type: "site-search:set-enabled", enabled: true }, popup);
  assert.equal((await service.handleMessage({ type: "site-search:list" }, popup)).learned.length, 1);
  const cleared = await service.handleMessage({ type: "site-search:clear" }, popup);
  assert.deepEqual(cleared, { enabled: true, permitted: true, learned: [] });
  assert.equal(fake.scans.length, 1, "clear does not rescan existing pages");
  assert.equal(fake.saved.enabled, true);
  assert.deepEqual(fake.saved.learned, []);
  await fake.api.tabs.onUpdated.emit(1, { status: "complete" }, fake.records.get(1));
  assert.equal((await service.read()).learned.length, 1);
  assert.equal(service.handleMessage({ type: "unrelated" }, popup), undefined);
  assert.equal(service.handleMessage({ type: "site-search:clear" }, { url: "https://example.com/", tab: fake.records.get(1) }), undefined);
  service.dispose();
  assert.equal(fake.api.tabs.onUpdated.size, 0);
  assert.equal(fake.api.runtime.onMessage.size, 0);
});

test("clear, disable, and access revocation discard discoveries already in flight", async () => {
  for (const action of ["clear", "disable", "revoke"]) {
    const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
    const entered = deferred();
    const result = deferred();
    fake.api.scripting.executeScript = async () => { entered.resolve(); return result.promise; };
    const service = createSiteSearchService(fake.api);
    await service.start();
    const enabling = service.setEnabled(true);
    await entered.promise;
    if (action === "clear") await service.clear();
    if (action === "disable") await service.setEnabled(false);
    if (action === "revoke") {
      fake.setGranted(false);
      await fake.api.permissions.onRemoved.emit({ origins: ["https://*/*"] });
      fake.setGranted(true); // A later grant must not revive old work.
    }
    result.resolve([{ frameId: 0, result: { forms: [{ template: "https://example.com/search?q={searchTerms}" }] } }]);
    await enabling;
    assert.deepEqual((await service.read()).learned, [], action);
    assert.deepEqual(fake.saved.learned, [], action);
    service.dispose();
  }
});

test("slow preference writes cannot overwrite a later disable or trigger a superseded scan", async () => {
  const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  const entered = deferred();
  const finish = deferred();
  const writes = [];
  let stored;
  fake.api.storage.local.set = async (value) => {
    const snapshot = structuredClone(Object.values(value)[0]);
    writes.push(snapshot);
    if (writes.length === 1) { entered.resolve(); await finish.promise; }
    stored = snapshot;
  };
  const service = createSiteSearchService(fake.api);
  await service.start();
  const enabling = service.setEnabled(true);
  await entered.promise;
  const disabling = service.setEnabled(false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(writes.length, 1, "writes are serialized");
  finish.resolve();
  await Promise.all([enabling, disabling]);
  assert.equal(stored.enabled, false);
  assert.deepEqual(fake.scans, []);
  assert.equal((await service.read()).enabled, false);
  service.dispose();
});

test("OpenSearch metadata is fetched without credentials and safely falls back to one GET form", async () => {
  const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/article?typed=never-copy", status: "complete" }] });
  fake.payloads.set(1, {
    openSearch: ["javascript:alert(1)", "https://user:password@example.com/description.xml", "https://example.com/opensearch.xml"],
    forms: [{ template: "https://example.com/search?q={searchTerms}" }],
  });
  const requests = [];
  const service = createSiteSearchService(fake.api, { fetch: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, headers: new Headers({ "content-length": "12" }), async text() { return "not valid xml"; } };
  } });
  await service.start();
  assert.equal((await service.setEnabled(true)).learned.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://example.com/opensearch.xml");
  assert.equal(requests[0].options.credentials, "omit");
  assert.equal(requests[0].options.referrerPolicy, "no-referrer");
  assert.equal(requests[0].options.redirect, "error");
  assert(requests[0].options.signal instanceof AbortSignal);
  assert(!JSON.stringify(fake.saved).includes("never-copy"));
  service.dispose();
});

test("clearing cancels a metadata request and cannot recreate the cleared fallback", async () => {
  const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  fake.payloads.set(1, { openSearch: ["https://example.com/opensearch.xml"], forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
  const entered = deferred();
  let signal;
  const service = createSiteSearchService(fake.api, { fetch: async (_url, options) => {
    signal = options.signal;
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
  } });
  await service.start();
  const enabling = service.setEnabled(true);
  await entered.promise;
  await service.clear();
  await enabling;
  assert.equal(signal.aborted, true);
  assert.deepEqual(await service.read(), { enabled: true, permitted: true, learned: [] });
  service.dispose();
});

test("oversized metadata stops reading its response stream before falling back", async () => {
  const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  fake.payloads.set(1, { openSearch: ["https://example.com/opensearch.xml"], forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
  let cancelled = false;
  let wholeBodyRead = false;
  const service = createSiteSearchService(fake.api, { fetch: async () => ({
    ok: true, headers: new Headers(),
    body: { getReader() { return {
      async read() { return { done: false, value: new Uint8Array(256 * 1024 + 1) }; },
      async cancel() { cancelled = true; },
    }; } },
    async text() { wholeBodyRead = true; return "x".repeat(256 * 1024 + 1); },
  }) });
  await service.start();
  assert.equal((await service.setEnabled(true)).learned.length, 1);
  assert.equal(cancelled, true);
  assert.equal(wholeBodyRead, false);
  service.dispose();
});

test("a failed preference save reports a safe error and leaves discovery disabled", async () => {
  const fake = fakeBrowser({ stored: { enabled: false, learned: [] }, tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  fake.api.storage.local.set = async () => { throw new Error("private query and full visited URL"); };
  const service = createSiteSearchService(fake.api);
  await service.start();
  await assert.rejects(service.setEnabled(true), { message: "Firefox could not save site-discovery preferences. Try again." });
  assert.equal((await service.read()).enabled, false);
  await fake.api.tabs.onUpdated.emit(1, { status: "complete" }, fake.records.get(1));
  assert.deepEqual(fake.scans, []);
  service.dispose();
});

test("private or navigated tabs never contribute the result of a delayed scan", async () => {
  for (const changed of [{ incognito: true }, { url: "https://elsewhere.example/" }]) {
    const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
    const entered = deferred();
    const result = deferred();
    let fetched = false;
    fake.api.scripting.executeScript = async () => { entered.resolve(); return result.promise; };
    const service = createSiteSearchService(fake.api, { fetch: async () => { fetched = true; throw new Error("Unexpected metadata request"); } });
    await service.start();
    const enabling = service.setEnabled(true);
    await entered.promise;
    Object.assign(fake.records.get(1), changed);
    result.resolve([{ frameId: 0, result: { openSearch: ["https://example.com/opensearch.xml"], forms: [{ template: "https://example.com/search?q={searchTerms}" }] } }]);
    await enabling;
    assert.equal(fetched, false);
    assert.deepEqual((await service.read()).learned, []);
    service.dispose();
  }
});

test("only this extension's popup can change settings, and corrupt stored data is bounded and sanitized", async () => {
  const learned = Array.from({ length: 130 }, (_, index) => ({ name: `Site ${index}`, origin: `https://site${index}.example/private?not=saved`,
    template: `https://site${index}.example/search?q={searchTerms}`, unexpected: "do-not-keep" }));
  learned.push({ name: "Unsafe", origin: "https://unsafe.example/", template: "javascript:{searchTerms}" });
  const fake = fakeBrowser({ stored: { enabled: false, learned } });
  fake.api.runtime.id = "our-extension@example";
  const service = createSiteSearchService(fake.api);
  const snapshot = await service.start();
  assert.equal(snapshot.learned.length, 128);
  assert.equal(snapshot.learned[0].origin, "https://site2.example");
  assert(!JSON.stringify(snapshot).includes("not=saved"));
  assert(!JSON.stringify(snapshot).includes("unexpected"));
  assert.equal(service.handleMessage({ type: "site-search:set-enabled", enabled: true }, { id: "other-extension@example", url: "moz-extension://test/popup.html" }), undefined);
  assert.equal((await service.read()).enabled, false);
  service.dispose();
});

test("an automatic discovery storage failure does not reject Firefox's tab event", async () => {
  const fake = fakeBrowser();
  const service = createSiteSearchService(fake.api);
  await service.start();
  await service.setEnabled(true);
  fake.records.set(1, { id: 1, url: "https://example.com/", status: "complete" });
  fake.payloads.set(1, { forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
  fake.api.storage.local.set = async () => { throw new Error("Do not expose raw storage errors"); };
  await assert.doesNotReject(fake.api.tabs.onUpdated.emit(1, { status: "complete" }, fake.records.get(1)));
  service.dispose();
});

test("clear also invalidates completed visits waiting for startup storage", async () => {
  const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  fake.payloads.set(1, { forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
  const loading = deferred();
  fake.api.storage.local.get = async (key) => ({ [key]: await loading.promise });
  const service = createSiteSearchService(fake.api);
  const starting = service.start();
  assert.equal(fake.api.tabs.onUpdated.size, 1, "listeners attach before storage resolves");
  const visiting = fake.api.tabs.onUpdated.emit(1, { status: "complete" }, fake.records.get(1));
  const clearing = service.clear();
  loading.resolve({ enabled: true, learned: [] });
  await Promise.all([starting, visiting, clearing]);
  assert.deepEqual((await service.read()).learned, []);
  assert.deepEqual(fake.scans, []);
  service.dispose();
});

test("clear preserves an off preference requested while startup storage is pending", async () => {
  const fake = fakeBrowser();
  const loading = deferred();
  fake.api.storage.local.get = async (key) => ({ [key]: await loading.promise });
  const service = createSiteSearchService(fake.api);
  const starting = service.start();
  const disabling = service.setEnabled(false);
  const clearing = service.clear();
  loading.resolve({ enabled: true, learned: [] });
  await Promise.all([starting, disabling, clearing]);
  assert.deepEqual(await service.read(), { enabled: false, permitted: true, learned: [] });
  assert.equal(fake.saved.enabled, false);
  service.dispose();
});

test("a rejected oversized metadata response releases its request before fallback", async () => {
  const fake = fakeBrowser({ tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  fake.payloads.set(1, { openSearch: ["https://example.com/opensearch.xml"], forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
  let signal;
  const service = createSiteSearchService(fake.api, { fetch: async (_url, options) => {
    signal = options.signal;
    return { ok: true, headers: new Headers({ "content-length": "999999999" }), async text() { throw new Error("Must not read rejected body"); } };
  } });
  await service.start();
  assert.equal((await service.setEnabled(true)).learned.length, 1);
  assert.equal(signal.aborted, true);
  service.dispose();
});

test("a Firefox page-access grant discovers existing normal tabs only when the preference is on", async () => {
  for (const enabled of [true, false]) {
    const fake = fakeBrowser({ granted: false, stored: { enabled, learned: [] }, tabs: [
      { id: 1, url: "https://example.com/", status: "complete" },
      { id: 2, url: "https://private.example/", status: "complete", incognito: true },
      { id: 3, url: "about:home", status: "complete" },
    ] });
    fake.payloads.set(1, { forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
    const service = createSiteSearchService(fake.api);
    await service.start();
    await fake.api.permissions.onAdded.emit({ origins: ["https://*/*"] });
    assert.deepEqual(fake.scans, [], "partial access cannot scan");
    fake.setGranted(true);
    await fake.api.permissions.onAdded.emit({ origins: ["http://*/*", "https://*/*"] });
    assert.deepEqual(fake.scans.map((scan) => scan.target), enabled ? [{ tabId: 1 }] : []);
    assert.equal((await service.read()).learned.length, enabled ? 1 : 0);
    assert(fake.notices.some((message) => message.type === "site-search:changed"));
    service.dispose();
    assert.equal(fake.api.permissions.onAdded.size, 0);
  }
});

test("clear invalidates a permission-grant scan waiting for existing tabs", async () => {
  const fake = fakeBrowser({ granted: false, tabs: [{ id: 1, url: "https://example.com/", status: "complete" }] });
  fake.payloads.set(1, { forms: [{ template: "https://example.com/search?q={searchTerms}" }] });
  const entered = deferred();
  const tabs = deferred();
  fake.api.tabs.query = async () => { entered.resolve(); return tabs.promise; };
  const service = createSiteSearchService(fake.api);
  await service.start();
  fake.setGranted(true);
  const granting = fake.api.permissions.onAdded.emit({ origins: ["http://*/*", "https://*/*"] });
  await entered.promise;
  await service.clear();
  tabs.resolve([...fake.records.values()]);
  await granting;
  assert.deepEqual(await service.read(), { enabled: true, permitted: true, learned: [] });
  assert.deepEqual(fake.scans, []);
  service.dispose();
});

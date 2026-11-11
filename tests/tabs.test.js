import test from "node:test";
import assert from "node:assert/strict";
import { createTabController } from "../experiments/newtab/tabs.js";

const PAGE = "moz-extension://search-or-switch/newtab.html";

function createEvent() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
    get size() { return listeners.size; },
  };
}

function fakeBrowser() {
  const records = new Map([
    [10, { id: 10, windowId: 1, active: true, url: PAGE, title: "Search or Switch" }],
    [20, { id: 20, windowId: 1, active: false, url: "https://example.com/", title: "Example" }],
    [30, { id: 30, windowId: 2, active: true, url: "https://elsewhere.example/" }],
  ]);
  const calls = [];
  const api = {
    tabs: {
      async getCurrent() { calls.push(["getCurrent"]); return { ...records.get(10) }; },
      async get(id) {
        calls.push(["get", id]);
        if (!records.has(id)) throw new Error("No tab");
        return { ...records.get(id) };
      },
      async query(query) {
        calls.push(["query", query]);
        return [...records.values()].filter((tab) => tab.windowId === query.windowId).map((tab) => ({ ...tab }));
      },
      async update(id, properties) {
        calls.push(["update", id, properties]);
        if (!records.has(id)) throw new Error("No tab");
        if (properties.active) {
          for (const tab of records.values()) if (tab.windowId === records.get(id).windowId) tab.active = false;
        }
        Object.assign(records.get(id), properties);
        return { ...records.get(id) };
      },
      async remove(id) { calls.push(["remove", id]); records.delete(id); },
      onCreated: createEvent(),
      onUpdated: createEvent(),
      onRemoved: createEvent(),
      onActivated: createEvent(),
      onMoved: createEvent(),
      onAttached: createEvent(),
      onDetached: createEvent(),
      onReplaced: createEvent(),
    },
    search: { async search(properties) { calls.push(["search", properties]); } },
  };
  return { api, records, calls };
}

async function initialized() {
  const browser = fakeBrowser();
  const controller = createTabController(browser.api, PAGE);
  await controller.initialize();
  return { ...browser, controller };
}

function removals(calls) { return calls.filter((call) => call[0] === "remove"); }
function mutations(calls) { return calls.filter((call) => ["update", "remove", "search"].includes(call[0])); }

test("identity uses the page's own tab even when initialization happens in the background", async () => {
  const { api, records, calls } = fakeBrowser();
  records.get(10).active = false;
  records.get(20).active = true;
  const controller = createTabController(api, PAGE);
  const result = await controller.initialize();
  assert.equal(result.self.id, 10);
  assert.deepEqual(result.tabs.map((tab) => tab.id), [10, 20]);
  assert.deepEqual(calls.find((call) => call[0] === "query"), ["query", { windowId: 1 }]);
  await assert.rejects(controller.switchTo(20), /Return to this search tab/);
  assert.deepEqual(mutations(calls), []);
});

test("missing current-tab identity fails without guessing an active tab", async () => {
  const { api, calls } = fakeBrowser();
  api.tabs.getCurrent = async () => undefined;
  const controller = createTabController(api, PAGE);
  await assert.rejects(controller.initialize(), /Open a new Firefox tab/);
  assert.deepEqual(mutations(calls), []);
});

test("source identity tolerates preview query strings and hash fragments", async () => {
  const { api, records } = fakeBrowser();
  records.get(10).url = `${PAGE}?preview=1#test`;
  const controller = createTabController(api, `${PAGE}?other=1`);
  await controller.initialize();
  await controller.navigate("https://example.org");
  assert.equal(records.get(10).url, "https://example.org/");
});

test("switch activates and confirms the target before removing only the owned source", async () => {
  const { controller, calls, records } = await initialized();
  assert.deepEqual(await controller.switchTo(20), { closed: true });
  assert.equal(records.get(20).active, true);
  assert.equal(records.has(10), false);
  assert.equal(records.has(30), true);
  const activatedAt = calls.findIndex((call) => call[0] === "update");
  const removedAt = calls.findIndex((call) => call[0] === "remove");
  assert.ok(activatedAt < removedAt);
  assert.ok(calls.slice(activatedAt + 1, removedAt).some((call) => call[0] === "get" && call[1] === 20));
  assert.deepEqual(removals(calls), [["remove", 10]]);
});

test("a result that closes before Enter never closes the search tab", async () => {
  const { controller, calls, records } = await initialized();
  records.delete(20);
  await assert.rejects(controller.switchTo(20), /That tab has closed/);
  assert.equal(records.has(10), true);
  assert.deepEqual(removals(calls), []);
});

test("activation rejection preserves the source", async () => {
  const { controller, api, calls, records } = await initialized();
  api.tabs.update = async () => { throw new Error("Tab closed during activation"); };
  await assert.rejects(controller.switchTo(20), /could not activate/);
  assert.equal(records.has(10), true);
  assert.deepEqual(removals(calls), []);
});

test("a resolved activation without an active target never closes the source", async () => {
  const { controller, api, calls, records } = await initialized();
  api.tabs.update = async (id) => ({ ...records.get(id) });
  await assert.rejects(controller.switchTo(20), /could not be activated/);
  assert.deepEqual(removals(calls), []);
});

test("a target closing during activation is rechecked before source removal", async () => {
  const { controller, api, calls, records } = await initialized();
  const update = api.tabs.update;
  api.tabs.update = async (...args) => { const result = await update(...args); records.delete(20); return result; };
  await assert.rejects(controller.switchTo(20), /That tab has closed/);
  assert.equal(records.has(10), true);
  assert.deepEqual(removals(calls), []);
});

test("cross-window destinations are rejected without activation or closing", async () => {
  const { controller, calls } = await initialized();
  await assert.rejects(controller.switchTo(30), /another window/);
  assert.deepEqual(mutations(calls), []);
});

test("source navigation during activation is preserved", async () => {
  const { controller, api, calls, records } = await initialized();
  const update = api.tabs.update;
  api.tabs.update = async (...args) => { const result = await update(...args); records.get(10).url = "https://important.example/"; return result; };
  const result = await controller.switchTo(20);
  assert.equal(result.closed, false);
  assert.match(result.warning, /search tab changed/);
  assert.equal(records.get(10).url, "https://important.example/");
  assert.deepEqual(removals(calls), []);
});

test("a source moved to another window is never reused", async () => {
  const { controller, records, calls } = await initialized();
  records.get(10).windowId = 2;
  await assert.rejects(controller.navigate("https://example.org/"), /search tab changed/);
  assert.deepEqual(mutations(calls), []);
});

test("focus changes while resolving the result do not activate it", async () => {
  const { controller, api, records, calls } = await initialized();
  const get = api.tabs.get;
  api.tabs.get = async (id) => {
    const result = await get(id);
    if (id === 20) { records.get(10).active = false; records.get(20).active = true; }
    return result;
  };
  await assert.rejects(controller.switchTo(20), /Return to this search tab/);
  assert.deepEqual(mutations(calls), []);
});

test("failure to remove the source returns a warning after successful activation", async () => {
  const { controller, api, records } = await initialized();
  api.tabs.remove = async () => { throw new Error("Remove denied"); };
  const result = await controller.switchTo(20);
  assert.equal(result.closed, false);
  assert.match(result.warning, /could not close/);
  assert.equal(records.get(20).active, true);
  assert.equal(records.has(10), true);
});

test("navigation replaces the source document without opening or closing a tab", async () => {
  const { controller, calls } = await initialized();
  await controller.navigate("https://example.org/docs");
  assert.deepEqual(mutations(calls), [["update", 10, { url: "https://example.org/docs", loadReplace: true }]]);
});

test("privileged navigation rejects unsafe schemes and embedded credentials at the API boundary", async () => {
  const { controller, calls } = await initialized();
  for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/file", "about:config", "https://me:secret@example.org/"]) {
    await assert.rejects(controller.navigate(url), /Only HTTP and HTTPS/);
  }
  assert.deepEqual(mutations(calls), []);
});

test("pending source navigation is not overwritten by a delayed search", async () => {
  const { controller, records, calls } = await initialized();
  records.get(10).pendingUrl = "https://important.example/";
  await assert.rejects(controller.search("coffee"), /search tab changed/);
  assert.deepEqual(mutations(calls), []);
});

test("search uses the owned tab and Firefox's default engine unless configured", async () => {
  const { controller, calls } = await initialized();
  await controller.search("  best coffee  ");
  await controller.search("tea", "DuckDuckGo");
  assert.deepEqual(mutations(calls), [
    ["search", { query: "best coffee", tabId: 10 }],
    ["search", { query: "tea", tabId: 10, engine: "DuckDuckGo" }],
  ]);
});

test("concurrent submissions cannot issue a second navigation", async () => {
  const { controller, api, calls } = await initialized();
  let finish;
  api.tabs.update = () => new Promise((resolve) => { finish = resolve; });
  const first = controller.navigate("https://example.org");
  await assert.rejects(controller.navigate("https://elsewhere.org"), /already in progress/);
  while (!finish) await new Promise((resolve) => setTimeout(resolve, 0));
  finish();
  await first;
  assert.deepEqual(removals(calls), []);
});

test("subscriptions are scoped to the source window and are removed on disposal", async () => {
  const { controller, api } = await initialized();
  const changes = [];
  const unsubscribe = controller.subscribe((change) => changes.push(change));
  api.tabs.onCreated.emit({ id: 40, windowId: 2 });
  api.tabs.onCreated.emit({ id: 50, windowId: 1 });
  api.tabs.onRemoved.emit(20, { windowId: 1 });
  assert.deepEqual(changes, [{ type: "created", tabId: 50 }, { type: "removed", tabId: 20 }]);
  unsubscribe();
  api.tabs.onActivated.emit({ tabId: 20, windowId: 1 });
  assert.equal(changes.length, 2);
  controller.dispose();
  assert.equal(api.tabs.onCreated.size, 0);
  assert.equal(api.tabs.onUpdated.size, 0);
  await assert.rejects(controller.refresh(), /no longer active/);
});

test("source replacement events invalidate future mutations", async () => {
  const { controller, api, calls } = await initialized();
  api.tabs.onReplaced.emit(99, 10);
  await assert.rejects(controller.navigate("https://example.org"), /search tab changed/);
  assert.deepEqual(mutations(calls), []);
});

test("source navigation events during the final destination check prevent closing it", async () => {
  const { controller, api, records, calls } = await initialized();
  const get = api.tabs.get;
  let targetReads = 0;
  api.tabs.get = async (id) => {
    const result = await get(id);
    if (id === 20 && ++targetReads === 3) {
      const source = records.get(10);
      source.url = "https://important.example/";
      api.tabs.onUpdated.emit(10, { url: source.url }, { ...source });
    }
    return result;
  };
  await assert.rejects(controller.switchTo(20), /search tab changed/);
  assert.equal(records.has(10), true);
  assert.deepEqual(removals(calls), []);
});

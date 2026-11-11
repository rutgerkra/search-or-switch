import test from "node:test";
import assert from "node:assert/strict";
import { createPopupController } from "../popup-tabs.js";

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(...args) { for (const listener of listeners) listener(...args); },
    get size() { return listeners.size; },
  };
}

function fakeBrowser({ currentWindowId = 1 } = {}) {
  const records = new Map([
    [10, { id: 10, windowId: 1, active: true, url: "https://current.example/", title: "Current" }],
    [20, { id: 20, windowId: 1, active: false, url: "https://example.com/", title: "Example" }],
    [30, { id: 30, windowId: 2, active: true, url: "https://elsewhere.example/" }],
  ]);
  const calls = [];
  let nextId = 40;
  const api = {
    tabs: {
      async query(query) {
        calls.push(["query", query]);
        const windowId = query.currentWindow ? currentWindowId : query.windowId;
        return [...records.values()].filter((tab) => tab.windowId === windowId && (!query.active || tab.active)).map((tab) => ({ ...tab }));
      },
      async get(id) {
        calls.push(["get", id]);
        if (!records.has(id)) throw new Error("No tab");
        return { ...records.get(id) };
      },
      async create(properties) {
        calls.push(["create", properties]);
        const tab = { id: nextId++, ...properties };
        if (properties.active) for (const existing of records.values()) if (existing.windowId === tab.windowId) existing.active = false;
        records.set(tab.id, tab);
        return { ...tab };
      },
      async update(id, properties) {
        calls.push(["update", id, properties]);
        if (!records.has(id)) throw new Error("No tab");
        if (properties.active) for (const tab of records.values()) if (tab.windowId === records.get(id).windowId) tab.active = false;
        Object.assign(records.get(id), properties);
        return { ...records.get(id) };
      },
      async remove(id) { calls.push(["remove", id]); records.delete(id); },
      onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event(),
      onMoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
    },
    search: { async search(properties) {
      calls.push(["search", properties]);
      records.get(properties.tabId).url = "https://search.example/results?q=" + encodeURIComponent(properties.query);
    } },
  };
  return { api, records, calls };
}

async function initialized() {
  const fake = fakeBrowser();
  const controller = createPopupController(fake.api);
  const initial = await controller.initialize();
  return { ...fake, controller, initial };
}

async function initializedNewTab(url = "about:newtab", properties = {}) {
  const fake = fakeBrowser();
  Object.assign(fake.records.get(10), { url, status: "complete", pinned: false }, properties);
  const controller = createPopupController(fake.api);
  const initial = await controller.initialize();
  return { ...fake, controller, initial };
}

const mutations = (calls) => calls.filter((call) => ["create", "update", "remove", "search"].includes(call[0]));
const creations = (calls) => calls.filter((call) => call[0] === "create");
const removals = (calls) => calls.filter((call) => call[0] === "remove");

test("opening and filtering the popup never creates or closes any tab", async () => {
  const { controller, initial, calls } = await initialized();
  assert.equal(initial.context.id, 10);
  assert.deepEqual(initial.tabs.map((tab) => tab.id), [10, 20]);
  await controller.refresh();
  await controller.refresh();
  assert.deepEqual(mutations(calls), []);
  assert.equal(calls.filter((call) => call[1]?.currentWindow).length, 1);
  assert.deepEqual(calls.filter((call) => call[0] === "query").slice(1).map((call) => call[1]), [
    { windowId: 1 }, { windowId: 1 }, { windowId: 1 },
  ]);
});

test("switching activates an existing result without creating or removing tabs", async () => {
  const { controller, calls, records } = await initialized();
  const switched = await controller.switchTo(20);
  assert.equal(switched.id, 20);
  assert.equal(records.get(20).active, true);
  assert.deepEqual(mutations(calls), [["update", 20, { active: true }]]);
  assert.equal(records.get(10).url, "https://current.example/");
});

test("the original context tab closing does not invalidate the popup window", async () => {
  const { controller, api, calls, records } = await initialized();
  records.delete(10);
  api.tabs.onRemoved.emit(10, { windowId: 1 });
  assert.deepEqual((await controller.refresh()).map((tab) => tab.id), [20]);
  await controller.switchTo(20);
  assert.deepEqual(creations(calls), []);
  assert.deepEqual(removals(calls), []);
});

test("a closed or cross-window result cannot create a tab or change another window", async () => {
  const { controller, calls, records } = await initialized();
  records.delete(20);
  await assert.rejects(controller.switchTo(20), /That tab has closed/);
  await assert.rejects(controller.switchTo(30), /another window/);
  assert.deepEqual(mutations(calls), []);
});

test("switch activation failure never removes a pre-existing tab", async () => {
  const { controller, api, calls } = await initialized();
  api.tabs.update = async () => { throw new Error("Activation denied"); };
  await assert.rejects(controller.switchTo(20), /could not activate/);
  assert.deepEqual(creations(calls), []);
  assert.deepEqual(removals(calls), []);
});

test("URL commit opens exactly one active destination in the captured window", async () => {
  const { controller, calls, records } = await initialized();
  const created = await controller.navigate("https://example.org/docs");
  assert.equal(created.id, 40);
  assert.deepEqual(mutations(calls), [["create", { url: "https://example.org/docs", active: true, windowId: 1 }]]);
  assert.equal(records.get(10).url, "https://current.example/");
  assert.equal(records.has(20), true);
});

test("unsafe URL commits are rejected before creating tabs", async () => {
  const { controller, calls } = await initialized();
  for (const url of ["javascript:alert(1)", "data:text/html,test", "file:///tmp/file", "about:config", "https://me:secret@example.org"]) {
    await assert.rejects(controller.navigate(url), /Only HTTP and HTTPS/);
  }
  await assert.rejects(controller.navigate("not a URL"), /valid web address/);
  assert.deepEqual(mutations(calls), []);
});

test("search creates one inactive owned tab, searches there, then activates it", async () => {
  const { controller, calls, records } = await initialized();
  const created = await controller.search("  best coffee  ");
  assert.equal(created.id, 40);
  assert.deepEqual(mutations(calls), [
    ["create", { url: "about:blank", active: false, windowId: 1 }],
    ["search", { query: "best coffee", tabId: 40 }],
    ["update", 40, { active: true }],
  ]);
  assert.equal(records.get(40).active, true);
  assert.equal(records.get(10).url, "https://current.example/");
});

test("a legacy engine argument cannot override Firefox's default search engine", async () => {
  const { controller, calls } = await initialized();
  await controller.search("tea", "Legacy engine");
  assert.deepEqual(calls.find((call) => call[0] === "search"), ["search", { query: "tea", tabId: 40 }]);
});

test("an explicit engine search creates one owned tab and uses the selected Firefox engine", async () => {
  const { controller, calls, records } = await initialized();
  const result = await controller.searchEngine("  tea  ", "DuckDuckGo");
  assert.equal(result.id, 40);
  assert.deepEqual(mutations(calls), [
    ["create", { url: "about:blank", active: false, windowId: 1 }],
    ["search", { query: "tea", engine: "DuckDuckGo", tabId: 40 }],
    ["update", 40, { active: true }],
  ]);
  assert.equal(records.get(10).url, "https://current.example/");
});

test("an explicit engine search requires a nonempty engine name before any tab mutation", async () => {
  const { controller, calls } = await initializedNewTab("about:home");
  for (const engineName of [undefined, null, "", "  ", 42, {}]) {
    await assert.rejects(controller.searchEngine("tea", engineName), /Choose a Firefox search engine/);
  }
  assert.deepEqual(mutations(calls), []);
});

test("empty queries and unavailable search API do not leave blank tabs", async () => {
  const { controller, api, calls } = await initialized();
  await assert.rejects(controller.search("  "), /Enter something/);
  api.search = undefined;
  await assert.rejects(controller.search("tea"), /search is unavailable/);
  assert.deepEqual(mutations(calls), []);
});

test("search failure removes only its own still-blank tab", async () => {
  const { controller, api, calls, records } = await initialized();
  api.search.search = async () => { throw new Error("Engine unavailable"); };
  await assert.rejects(controller.search("tea"), /could not complete/);
  assert.deepEqual(removals(calls), [["remove", 40]]);
  assert.equal(records.has(40), false);
  assert.equal(records.has(10), true);
  assert.equal(records.has(20), true);
  assert.equal(records.get(10).active, true);
});

test("search failure preserves a created tab that already navigated", async () => {
  const { controller, api, calls, records } = await initialized();
  api.search.search = async ({ tabId }) => { records.get(tabId).url = "https://important.example/"; throw new Error("Late failure"); };
  await assert.rejects(controller.search("tea"), /could not complete/);
  assert.equal(records.get(40).url, "https://important.example/");
  assert.deepEqual(removals(calls), []);
});

test("search failure preserves a blank tab with a pending navigation", async () => {
  const { controller, api, calls, records } = await initialized();
  api.search.search = async ({ tabId }) => { records.get(tabId).pendingUrl = "https://important.example/"; throw new Error("Late failure"); };
  await assert.rejects(controller.search("tea"), /could not complete/);
  assert.equal(records.has(40), true);
  assert.deepEqual(removals(calls), []);
});

test("search failure preserves an owned tab the user moved to another window", async () => {
  const { controller, api, calls, records } = await initialized();
  api.search.search = async ({ tabId }) => { records.get(tabId).windowId = 2; throw new Error("Moved"); };
  await assert.rejects(controller.search("tea"), /could not complete/);
  assert.equal(records.has(40), true);
  assert.deepEqual(removals(calls), []);
});

test("a user navigation before the search starts is never overwritten", async () => {
  const { controller, api, calls, records } = await initialized();
  const create = api.tabs.create;
  api.tabs.create = async (...args) => {
    const created = await create(...args);
    records.get(created.id).url = "https://important.example/";
    return created;
  };
  await assert.rejects(controller.search("tea"), /could not complete/);
  assert.deepEqual(calls.filter((call) => call[0] === "search"), []);
  assert.equal(records.get(40).url, "https://important.example/");
  assert.deepEqual(removals(calls), []);
});

test("results are preserved if activating the search tab fails", async () => {
  const { controller, api, calls, records } = await initialized();
  api.tabs.update = async () => { throw new Error("Activation denied"); };
  await assert.rejects(controller.search("tea"), /loaded results have been kept open/);
  assert.match(records.get(40).url, /search.example/);
  assert.deepEqual(removals(calls), []);
});

test("blank-tab cleanup failure does not hide the original search error", async () => {
  const { controller, api } = await initialized();
  api.search.search = async () => { throw new Error("Search denied"); };
  api.tabs.remove = async () => { throw new Error("Cleanup denied"); };
  await assert.rejects(controller.search("tea"), /could not complete this search/);
});

test("concurrent commits create only one destination", async () => {
  const { controller, api, calls } = await initialized();
  let finish;
  const create = api.tabs.create;
  api.tabs.create = async (...args) => {
    const tab = await create(...args);
    await new Promise((resolve) => { finish = resolve; });
    return tab;
  };
  const first = controller.navigate("https://example.org");
  await assert.rejects(controller.search("tea"), /already in progress/);
  finish();
  await first;
  assert.equal(creations(calls).length, 1);
});

test("subscriptions remain in the captured window and disposal removes them", async () => {
  const { controller, api } = await initialized();
  const changes = [];
  const unsubscribe = controller.subscribe((change) => changes.push(change));
  api.tabs.onCreated.emit({ id: 40, windowId: 2 });
  api.tabs.onCreated.emit({ id: 50, windowId: 1 });
  api.tabs.onRemoved.emit(10, { windowId: 1 });
  assert.deepEqual(changes, [{ type: "created", tabId: 50 }, { type: "removed", tabId: 10 }]);
  unsubscribe();
  api.tabs.onActivated.emit({ tabId: 20, windowId: 1 });
  assert.equal(changes.length, 2);
  controller.dispose();
  assert.equal(api.tabs.onCreated.size, 0);
  assert.equal(api.tabs.onUpdated.size, 0);
  await assert.rejects(controller.navigate("https://example.org"), /popup has closed/);
});

test("a closed popup window fails refresh without falling back to another window", async () => {
  const { controller, records } = await initialized();
  records.delete(10);
  records.delete(20);
  await assert.rejects(controller.refresh(), /window is no longer available/);
});

test("window ID zero is valid for the native popup", async () => {
  const { api, calls, records } = fakeBrowser({ currentWindowId: 0 });
  records.set(0, { id: 0, windowId: 0, active: true, url: "https://zero.example/" });
  const controller = createPopupController(api);
  assert.equal((await controller.initialize()).context.windowId, 0);
  await controller.navigate("https://destination.example/");
  assert.deepEqual(calls[0], ["query", { active: true, currentWindow: true }]);
  assert.deepEqual(creations(calls).map((call) => call[1].windowId), [0]);
});

test("URL commits replace only the captured native new-tab or home placeholder", async () => {
  for (const url of ["about:newtab", "about:home"]) {
    const { controller, calls, records, initial } = await initializedNewTab(url);
    assert.equal(initial.context.url, url);
    const result = await controller.navigate("https://destination.example/path");
    assert.equal(result.id, 10);
    assert.deepEqual(mutations(calls), [["update", 10, { url: "https://destination.example/path" }]]);
    assert.equal(records.size, 3);
    assert.equal(records.get(20).url, "https://example.com/");
  }
});

test("reused searches always use Firefox's default without creating, activating or removing another tab", async () => {
  for (const url of ["about:newtab", "about:home"]) {
    const { controller, calls, records } = await initializedNewTab(url);
    const result = await controller.search("  coffee  ", "DuckDuckGo");
    assert.equal(result.id, 10);
    assert.deepEqual(mutations(calls), [["search", { query: "coffee", tabId: 10 }]]);
    assert.match(records.get(10).url, /search.example/);
    assert.equal(records.size, 3);
  }
});

test("an explicit engine search reuses the captured Home tab without other tab mutations", async () => {
  const { controller, calls, records } = await initializedNewTab("about:home");
  const result = await controller.searchEngine("  coffee  ", "DuckDuckGo");
  assert.equal(result.id, 10);
  assert.deepEqual(mutations(calls), [["search", { query: "coffee", engine: "DuckDuckGo", tabId: 10 }]]);
  assert.match(records.get(10).url, /search.example/);
  assert.equal(records.size, 3);
});

test("about:blank and decorated or privileged browser pages are never reused", async () => {
  for (const url of ["about:blank", "about:newtab#draft", "about:home?state=1", "about:config", "moz-extension://other/newtab.html"]) {
    const { controller, calls, records } = await initializedNewTab(url);
    await controller.navigate("https://destination.example/");
    assert.deepEqual(mutations(calls), [["create", { url: "https://destination.example/", active: true, windowId: 1 }]]);
    assert.equal(records.get(10).url, url);
  }
});

test("about:blank search creates its own destination and preserves the pre-existing blank tab", async () => {
  const { controller, calls, records } = await initializedNewTab("about:blank");
  await controller.search("coffee");
  assert.deepEqual(mutations(calls), [
    ["create", { url: "about:blank", active: false, windowId: 1 }],
    ["search", { query: "coffee", tabId: 40 }],
    ["update", 40, { active: true }],
  ]);
  assert.equal(records.get(10).url, "about:blank");
});

test("a normal origin becoming a new-tab page after opening the popup is not a reuse candidate", async () => {
  const { controller, calls, records } = await initialized();
  Object.assign(records.get(10), { url: "about:newtab", status: "complete" });
  await controller.navigate("https://destination.example/");
  assert.equal(creations(calls).length, 1);
  assert.equal(records.get(10).url, "about:newtab");
});

test("placeholder reuse requires completed and unpinned state when the popup opens", async () => {
  for (const properties of [{ status: "loading" }, { status: undefined }, { pinned: true }, { pendingUrl: "https://pending.example/" }]) {
    const { controller, calls, records } = await initializedNewTab("about:newtab", properties);
    Object.assign(records.get(10), { status: "complete", pinned: false, pendingUrl: undefined });
    await controller.navigate("https://destination.example/");
    assert.equal(creations(calls).length, 1);
    assert.equal(records.get(10).url, "about:newtab");
  }
});

test("fresh validation rejects navigated, moved, inactive, pinned, loading or pending origins", async () => {
  for (const properties of [
    { url: "https://important.example/" }, { url: "about:home" }, { windowId: 2 },
    { active: false }, { pinned: true }, { status: "loading" }, { status: undefined },
    { pendingUrl: "https://pending.example/" }, { pendingUrl: "about:newtab" },
  ]) {
    const { controller, calls, records } = await initializedNewTab();
    Object.assign(records.get(10), properties);
    await controller.navigate("https://destination.example/");
    assert.deepEqual(mutations(calls), [["create", { url: "https://destination.example/", active: true, windowId: 1 }]]);
    assert.equal(records.get(10).url, properties.url ?? "about:newtab");
  }
});

test("a vanished origin falls back to a new destination without selecting another blank tab", async () => {
  const { controller, calls, records } = await initializedNewTab();
  records.delete(10);
  Object.assign(records.get(20), { url: "about:newtab", status: "complete", active: true });
  await controller.navigate("https://destination.example/");
  assert.deepEqual(mutations(calls), [["create", { url: "https://destination.example/", active: true, windowId: 1 }]]);
  assert.equal(records.get(20).url, "about:newtab");
});

test("a navigation episode disables reuse even when the origin returns to the same placeholder", async () => {
  for (const changes of [{ url: "https://important.example/" }, { url: "about:newtab" }, { status: "loading" }]) {
    const { controller, api, calls, records } = await initializedNewTab();
    api.tabs.onUpdated.emit(10, changes, { ...records.get(10), ...changes });
    Object.assign(records.get(10), { url: "about:newtab", status: "complete" });
    await controller.search("coffee");
    assert.equal(creations(calls).length, 1);
    assert.equal(calls.find((call) => call[0] === "search")[1].tabId, 40);
    assert.equal(records.get(10).url, "about:newtab");
  }
});

test("moving or switching away and back disables placeholder reuse", async () => {
  for (const emitChange of [
    (api) => { api.tabs.onActivated.emit({ tabId: 20, windowId: 1 }); api.tabs.onActivated.emit({ tabId: 10, windowId: 1 }); },
    (api) => { api.tabs.onDetached.emit(10, { oldWindowId: 1 }); api.tabs.onAttached.emit(10, { newWindowId: 1 }); },
    (api) => api.tabs.onReplaced.emit(99, 10),
    (api) => api.tabs.onUpdated.emit(10, { pinned: true }, { id: 10, windowId: 1 }),
  ]) {
    const { controller, api, calls } = await initializedNewTab();
    emitChange(api);
    await controller.navigate("https://destination.example/");
    assert.equal(creations(calls).length, 1);
    assert.deepEqual(removals(calls), []);
  }
});

test("a navigation event during fresh lookup prevents reuse of its stale tab snapshot", async () => {
  const { controller, api, calls, records } = await initializedNewTab();
  const get = api.tabs.get;
  api.tabs.get = async (id) => {
    const snapshot = await get(id);
    if (id === 10) {
      records.get(10).url = "https://important.example/";
      api.tabs.onUpdated.emit(10, { url: records.get(10).url }, { ...records.get(10) });
    }
    return snapshot;
  };
  await controller.navigate("https://destination.example/");
  assert.deepEqual(mutations(calls), [["create", { url: "https://destination.example/", active: true, windowId: 1 }]]);
  assert.equal(records.get(10).url, "https://important.example/");
});

test("failed reuse never removes the original placeholder or creates a fallback destination", async () => {
  const { controller, api, calls, records } = await initializedNewTab();
  api.tabs.update = async () => { throw new Error("Navigation failed"); };
  await assert.rejects(controller.navigate("https://destination.example/"), /current tab/);
  assert.deepEqual(creations(calls), []);
  assert.deepEqual(removals(calls), []);
  assert.equal(records.get(10).url, "about:newtab");
});

test("failed reused searches preserve the existing tab whether or not results started loading", async () => {
  for (const startedLoading of [false, true]) {
    const { controller, api, calls, records } = await initializedNewTab();
    api.search.search = async ({ tabId }) => {
      if (startedLoading) records.get(tabId).url = "https://search.example/partial-results";
      throw new Error("Search failed");
    };
    await assert.rejects(controller.search("coffee"), /search in the current tab/);
    assert.deepEqual(creations(calls), []);
    assert.deepEqual(removals(calls), []);
    assert.equal(records.get(10).url, startedLoading ? "https://search.example/partial-results" : "about:newtab");
  }
});

test("switching to an existing tab keeps the original placeholder open", async () => {
  const { controller, calls, records } = await initializedNewTab();
  await controller.switchTo(20);
  assert.deepEqual(mutations(calls), [["update", 20, { active: true }]]);
  assert.equal(records.get(10).url, "about:newtab");
});

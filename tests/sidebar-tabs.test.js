import test from "node:test";
import assert from "node:assert/strict";
import { createSidebarController } from "../experiments/sidebar/sidebar-tabs.js";

function event() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit(...args) { for (const listener of listeners) listener(...args); },
    get size() { return listeners.size; },
  };
}

function fakeBrowser() {
  const calls = [];
  const tabs = new Map([
    [10, { id: 10, windowId: 1, active: true, url: "https://current.example/" }],
    [20, { id: 20, windowId: 1, active: false, url: "https://other.example/" }],
    [30, { id: 30, windowId: 2, active: true, url: "https://elsewhere.example/" }],
  ]);
  let nextId = 100;
  const api = {
    windows: {
      async getCurrent() { calls.push(["ownWindow"]); return { id: 1, type: "normal", focused: false }; },
      async getLastFocused() { throw new Error("Must not use focus to identify sidebar window"); },
      async create() { throw new Error("A sidebar must not create windows"); },
      async update() { throw new Error("A sidebar must not focus windows"); },
      async remove() { throw new Error("A sidebar must not close windows"); },
    },
    tabs: {
      async query(query) {
        calls.push(["query", query]);
        const windowId = query.currentWindow ? 2 : query.windowId;
        return [...tabs.values()].filter((tab) => tab.windowId === windowId && (!query.active || tab.active)).map((tab) => ({ ...tab }));
      },
      async get(id) {
        calls.push(["get", id]);
        if (!tabs.has(id)) throw new Error("Tab closed");
        return { ...tabs.get(id) };
      },
      async update(id, properties) {
        calls.push(["updateTab", id, properties]);
        if (!tabs.has(id)) throw new Error("Tab closed");
        if (properties.active) for (const tab of tabs.values()) if (tab.windowId === tabs.get(id).windowId) tab.active = false;
        Object.assign(tabs.get(id), properties);
        return { ...tabs.get(id) };
      },
      async create(properties) {
        calls.push(["createTab", properties]);
        const tab = { id: nextId++, ...properties };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async remove(id) { calls.push(["removeTab", id]); tabs.delete(id); },
      onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event(),
      onMoved: event(), onAttached: event(), onDetached: event(), onReplaced: event(),
    },
    search: { async search(properties) {
      calls.push(["search", properties]);
      tabs.get(properties.tabId).url = "https://search.example/results";
    } },
  };
  return { api, calls, tabs };
}

test("a sidebar in window A stays bound to A while window B is focused", async () => {
  const { api, calls } = fakeBrowser();
  const controller = createSidebarController(api);
  const initial = await controller.initialize();
  assert.equal(initial.context.windowId, 1);
  assert.deepEqual(initial.tabs.map((tab) => tab.id), [10, 20]);
  assert.deepEqual((await controller.refresh()).map((tab) => tab.id), [10, 20]);
  assert.deepEqual(calls.filter(([name]) => name === "query").map(([, query]) => query), [
    { active: true, windowId: 1 }, { windowId: 1 }, { windowId: 1 },
  ]);
  assert.equal(calls.filter(([name]) => name === "ownWindow").length, 1);
});

test("opening, refreshing and switching the sidebar creates no tabs or windows", async () => {
  const { api, calls, tabs } = fakeBrowser();
  const controller = createSidebarController(api);
  await controller.initialize();
  await controller.refresh();
  await controller.switchTo(20);
  assert.deepEqual(calls.filter(([name]) => name === "createTab" || name === "removeTab"), []);
  assert.equal(tabs.size, 3);
  assert.equal(tabs.get(20).active, true);
  assert.equal(tabs.get(10).url, "https://current.example/");
  assert.equal(controller.focusContext, undefined);
});

test("URL and search commits reuse the shared safety behavior in the sidebar's own window", async () => {
  const { api, calls, tabs } = fakeBrowser();
  const controller = createSidebarController(api);
  await controller.initialize();
  await controller.navigate("https://destination.example/");
  const results = await controller.search("coffee", "DuckDuckGo");
  assert.equal(results.windowId, 1);
  assert.deepEqual(calls.filter(([name]) => name === "createTab").map(([, properties]) => properties), [
    { url: "https://destination.example/", active: true, windowId: 1 },
    { url: "about:blank", active: false, windowId: 1 },
  ]);
  assert.deepEqual(calls.find(([name]) => name === "search"), ["search", { query: "coffee", tabId: 101, engine: "DuckDuckGo" }]);
  assert.equal(tabs.has(10), true);
  assert.equal(tabs.has(20), true);
  assert.equal(tabs.get(30).active, true);
});

test("failure to read the sidebar's own window never falls back to another focused window", async () => {
  const { api, calls } = fakeBrowser();
  api.windows.getCurrent = async () => { throw new Error("Window lookup failed"); };
  const controller = createSidebarController(api);
  await assert.rejects(controller.initialize(), /could not identify this sidebar's window/);
  assert.deepEqual(calls, []);
  await assert.rejects(controller.navigate("https://destination.example/"), /sidebar is still loading/);
});

test("invalid window identities and non-browser windows fail before querying tabs", async () => {
  for (const ownWindow of [undefined, { id: -1, type: "normal" }, { id: 1.5, type: "normal" }, { id: "1", type: "normal" }, { id: 1, type: "popup" }]) {
    const { api, calls } = fakeBrowser();
    api.windows.getCurrent = async () => ownWindow;
    const controller = createSidebarController(api);
    await assert.rejects(controller.initialize(), /sidebar in a Firefox browser window/);
    assert.deepEqual(calls, []);
  }
});

test("concurrent initialization reads the owning window only once", async () => {
  const { api, calls } = fakeBrowser();
  const controller = createSidebarController(api);
  const [first, second] = await Promise.all([controller.initialize(), controller.initialize()]);
  assert.deepEqual(first, second);
  assert.equal(calls.filter(([name]) => name === "ownWindow").length, 1);
});

test("disposing during own-window lookup prevents further tab queries", async () => {
  const { api, calls } = fakeBrowser();
  let finish;
  api.windows.getCurrent = () => new Promise((resolve) => { finish = resolve; });
  const controller = createSidebarController(api);
  const loading = controller.initialize();
  controller.dispose();
  finish({ id: 1, type: "normal" });
  await assert.rejects(loading, /sidebar has closed/);
  assert.deepEqual(calls, []);
  assert.equal(api.tabs.onCreated.size, 0);
});

test("subscribers receive changes only from the owning window and are removed on disposal", async () => {
  const { api } = fakeBrowser();
  const controller = createSidebarController(api);
  const changes = [];
  const unsubscribe = controller.subscribe((change) => changes.push(change));
  await controller.initialize();
  api.tabs.onCreated.emit({ id: 40, windowId: 2 });
  api.tabs.onCreated.emit({ id: 50, windowId: 1 });
  assert.deepEqual(changes, [{ type: "created", tabId: 50 }]);
  unsubscribe();
  api.tabs.onRemoved.emit(20, { windowId: 1 });
  assert.equal(changes.length, 1);
  controller.dispose();
  assert.equal(api.tabs.onCreated.size, 0);
  assert.equal(api.tabs.onUpdated.size, 0);
  await assert.rejects(controller.refresh(), /sidebar has closed/);
});

test("a cross-window result remains rejected by the shared controller", async () => {
  const { api, calls } = fakeBrowser();
  const controller = createSidebarController(api);
  await controller.initialize();
  await assert.rejects(controller.switchTo(30), /another window/);
  assert.deepEqual(calls.filter(([name]) => name === "updateTab" || name === "createTab" || name === "removeTab"), []);
});

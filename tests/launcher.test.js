import test from "node:test";
import assert from "node:assert/strict";
import { createLauncher } from "../experiments/floating/launcher.js";

const extensionURL = "moz-extension://test-id/popup.html";

function fakeBrowser(initialWindows = []) {
  const windows = new Map(initialWindows.map((window) => [window.id, structuredClone(window)]));
  const calls = [];
  const listeners = new Set();
  let nextId = 100;
  const api = {
    runtime: { getURL: (path) => `moz-extension://test-id/${path}` },
    windows: {
      async get(id, options) {
        calls.push(["get", id, options]);
        if (!windows.has(id)) throw new Error("Window not found");
        return structuredClone(windows.get(id));
      },
      async getAll(options) {
        calls.push(["getAll", options]);
        return [...windows.values()].filter((window) => options.windowTypes.includes(window.type)).map((window) => structuredClone(window));
      },
      async getLastFocused(options) {
        calls.push(["getLastFocused", options]);
        const candidates = [...windows.values()].filter((window) => options.windowTypes.includes(window.type));
        return structuredClone(candidates.find((window) => window.focused) ?? candidates[0]);
      },
      async create(properties) {
        calls.push(["create", properties]);
        for (const window of windows.values()) window.focused = false;
        const window = { id: nextId++, ...properties, tabs: [{ id: 500, url: properties.url }] };
        windows.set(window.id, window);
        return structuredClone(window);
      },
      async update(id, properties) {
        calls.push(["update", id, properties]);
        if (!windows.has(id)) throw new Error("Window not found");
        for (const window of windows.values()) window.focused = false;
        Object.assign(windows.get(id), properties);
        return structuredClone(windows.get(id));
      },
      async remove(id) {
        calls.push(["remove", id]);
        if (!windows.delete(id)) throw new Error("Window not found");
        for (const listener of listeners) listener(id);
      },
      onRemoved: {
        addListener: (listener) => listeners.add(listener),
        removeListener: (listener) => listeners.delete(listener),
      },
    },
  };
  return { api, windows, calls, listeners };
}

const normalWindow = (id = 1, extra = {}) => ({ id, type: "normal", width: 1200, height: 900, left: 100, top: 80, incognito: false, focused: true, tabs: [{ id: 1, url: "https://example.com" }], ...extra });
const ownedWindow = (id = 10, extra = {}) => ({ id, type: "popup", focused: false, tabs: [{ id: 5, url: `${extensionURL}?windowId=1` }], ...extra });

test("creates a centered 600 by 520 floating window without touching a normal tab", async () => {
  const { api, calls } = fakeBrowser([normalWindow()]);
  const launcher = createLauncher(api);
  assert.deepEqual(await launcher.open(), { action: "created", windowId: 100 });
  assert.deepEqual(calls.find(([name]) => name === "create")[1], {
    url: `${extensionURL}?windowId=1`, type: "popup", width: 600, height: 520,
    left: 400, top: 270, focused: true, incognito: false,
  });
  assert.equal(calls.some(([name]) => name === "remove" || name === "update"), false);
  launcher.dispose();
});

test("centering retains negative coordinates for a monitor left of the primary display", async () => {
  const { api, calls } = fakeBrowser([normalWindow(2, { left: -1440, top: -900, width: 1440, height: 900 })]);
  await createLauncher(api).open();
  const geometry = calls.find(([name]) => name === "create")[1];
  assert.equal(geometry.left, -1020);
  assert.equal(geometry.top, -710);
});

test("caps the launcher to a smaller parent window", async () => {
  const { api, calls } = fakeBrowser([normalWindow(1, { width: 480, height: 420, left: -480, top: 30 })]);
  await createLauncher(api).open();
  const geometry = calls.find(([name]) => name === "create")[1];
  assert.deepEqual({ width: geometry.width, height: geometry.height, left: geometry.left, top: geometry.top }, { width: 480, height: 420, left: -480, top: 30 });
});

test("uses an invoking tab's normal window and private context rather than the last-focused window", async () => {
  const { api, calls } = fakeBrowser([normalWindow(1), normalWindow(8, { focused: false, incognito: true, left: 1500 })]);
  await createLauncher(api).open({ id: 88, windowId: 8 });
  const properties = calls.find(([name]) => name === "create")[1];
  assert.equal(properties.url, `${extensionURL}?windowId=8`);
  assert.equal(properties.left, 1800);
  assert.equal(properties.incognito, true);
  assert.equal(calls.some(([name]) => name === "getLastFocused"), false);
});

test("recovers when the invoking window vanished or is not a normal browsing window", async () => {
  for (const windowId of [999, 10]) {
    const { api, calls } = fakeBrowser([normalWindow(1), { id: 10, type: "popup", tabs: [] }]);
    await createLauncher(api).open({ windowId });
    assert.equal(calls.find(([name]) => name === "create")[1].url, `${extensionURL}?windowId=1`);
  }
});

test("concurrent shortcut calls share one operation and create only one window", async () => {
  const { api, calls } = fakeBrowser([normalWindow()]);
  const launcher = createLauncher(api);
  const first = launcher.open();
  const second = launcher.open();
  assert.equal(first, second);
  await Promise.all([first, second]);
  assert.equal(calls.filter(([name]) => name === "create").length, 1);
  assert.equal(calls.filter(([name]) => name === "remove").length, 0);
});

test("repeated invocation toggles only its own focused launcher", async () => {
  const { api, calls, windows } = fakeBrowser([normalWindow()]);
  const launcher = createLauncher(api);
  await launcher.open();
  assert.deepEqual(await launcher.open(), { action: "closed", windowId: 100 });
  assert.equal(windows.has(1), true);
  assert.deepEqual(calls.filter(([name]) => name === "remove"), [["remove", 100]]);
});

test("finds an existing launcher after a background restart and focuses it without creating another", async () => {
  const { api, calls } = fakeBrowser([normalWindow(), ownedWindow(7)]);
  assert.deepEqual(await createLauncher(api).open(), { action: "focused", windowId: 7 });
  assert.deepEqual(calls.find(([name]) => name === "update"), ["update", 7, { focused: true }]);
  assert.equal(calls.some(([name]) => name === "create" || name === "remove"), false);
});

test("an unfocused launcher from window A is replaced when window B invokes the command", async () => {
  const { api, calls, windows } = fakeBrowser([
    normalWindow(1, { focused: false }),
    normalWindow(2, { left: 1500, incognito: true }),
    ownedWindow(7),
    { id: 8, type: "popup", focused: false, tabs: [{ url: "https://unrelated.example/" }] },
  ]);
  assert.deepEqual(await createLauncher(api).open({ windowId: 2 }), { action: "created", windowId: 100 });
  assert.deepEqual(calls.filter(([name]) => name === "remove"), [["remove", 7]]);
  const created = calls.find(([name]) => name === "create")[1];
  assert.equal(created.url, `${extensionURL}?windowId=2`);
  assert.equal(created.left, 1800);
  assert.equal(created.incognito, true);
  assert.equal(calls.some(([name]) => name === "update" || name === "getLastFocused"), false);
  assert.equal(windows.has(1), true);
  assert.equal(windows.has(2), true);
  assert.equal(windows.has(8), true);
});

test("an invoking tab in the same parent reuses the launcher even if another window was last focused", async () => {
  const { api, calls } = fakeBrowser([
    normalWindow(1, { focused: false }),
    normalWindow(2),
    ownedWindow(7),
  ]);
  assert.deepEqual(await createLauncher(api).open({ windowId: 1 }), { action: "focused", windowId: 7 });
  assert.deepEqual(calls.find(([name]) => name === "update"), ["update", 7, { focused: true }]);
  assert.equal(calls.some(([name]) => name === "create" || name === "remove" || name === "getLastFocused"), false);
});

test("a launcher whose original parent closed is replaced for the remaining normal window", async () => {
  const { api, calls, windows } = fakeBrowser([normalWindow(2), ownedWindow(7)]);
  assert.deepEqual(await createLauncher(api).open(), { action: "created", windowId: 100 });
  assert.equal(calls.find(([name]) => name === "create")[1].url, `${extensionURL}?windowId=2`);
  assert.deepEqual(calls.filter(([name]) => name === "remove"), [["remove", 7]]);
  assert.equal(windows.has(2), true);
  assert.equal(calls.some(([name]) => name === "update"), false);
});

test("a recovered launcher with missing, invalid, or ambiguous parent context is replaced", async () => {
  for (const suffix of ["", "?windowId=invalid", "?windowId=1&windowId=2"]) {
    const { api, calls } = fakeBrowser([normalWindow(1), ownedWindow(7, { tabs: [{ url: `${extensionURL}${suffix}` }] })]);
    assert.equal((await createLauncher(api).open()).action, "created");
    assert.deepEqual(calls.filter(([name]) => name === "remove"), [["remove", 7]]);
    assert.equal(calls.find(([name]) => name === "create")[1].url, `${extensionURL}?windowId=1`);
  }
});

test("a recovered focused launcher toggles closed", async () => {
  const { api, calls } = fakeBrowser([normalWindow(), ownedWindow(7, { focused: true })]);
  assert.deepEqual(await createLauncher(api).open(), { action: "closed", windowId: 7 });
  assert.deepEqual(calls.find(([name]) => name === "remove"), ["remove", 7]);
});

test("ignores unrelated popups, lookalike URLs, and extension pages in normal windows", async () => {
  const unrelated = [
    { id: 2, type: "popup", focused: true, tabs: [{ url: "https://example.com/popup.html" }] },
    ownedWindow(3, { tabs: [{ url: `${extensionURL}-other?windowId=1` }] }),
    ownedWindow(4, { tabs: [{ url: "moz-extension://other-id/popup.html?windowId=1" }] }),
    normalWindow(5, { tabs: [{ url: extensionURL }] }),
  ];
  const { api, calls, windows } = fakeBrowser([normalWindow(), ...unrelated]);
  await createLauncher(api).open();
  assert.equal(calls.some(([name]) => name === "remove" || name === "update"), false);
  for (const window of unrelated) assert.equal(windows.has(window.id), true);
});

test("a stale owned-window ID is discarded if the window closed while idle", async () => {
  const { api, calls, windows } = fakeBrowser([normalWindow()]);
  const launcher = createLauncher(api);
  await launcher.open();
  windows.delete(100); // No event: simulates an idle background page missing removal.
  assert.deepEqual(await launcher.open(), { action: "created", windowId: 101 });
  assert.equal(calls.filter(([name]) => name === "create").length, 2);
});

test("an owned window navigated to an unrelated URL is never toggled closed", async () => {
  const { api, calls, windows } = fakeBrowser([normalWindow()]);
  const launcher = createLauncher(api);
  await launcher.open();
  windows.get(100).tabs[0].url = "https://example.com/";
  await launcher.open();
  assert.equal(windows.has(100), true);
  assert.equal(calls.some(([name]) => name === "remove"), false);
  assert.equal(calls.filter(([name]) => name === "create").length, 2);
});

test("creation errors allow a later invocation to retry", async () => {
  const { api, calls } = fakeBrowser([normalWindow()]);
  const create = api.windows.create;
  api.windows.create = async () => { throw new Error("Creation failed"); };
  const launcher = createLauncher(api);
  await assert.rejects(launcher.open(), /Creation failed/);
  api.windows.create = create;
  assert.equal((await launcher.open()).action, "created");
  assert.equal(calls.filter(([name]) => name === "create").length, 1);
});

test("dispose removes listeners and prevents further actions without closing any window", async () => {
  const { api, calls, listeners } = fakeBrowser([normalWindow()]);
  const launcher = createLauncher(api);
  assert.equal(listeners.size, 1);
  launcher.dispose();
  launcher.dispose();
  assert.equal(listeners.size, 0);
  await assert.rejects(launcher.open(), /disposed/);
  assert.equal(calls.length, 0);
});

test("disposal during an asynchronous lookup prevents window creation", async () => {
  const { api, calls } = fakeBrowser([normalWindow()]);
  const launcher = createLauncher(api);
  const pending = launcher.open();
  launcher.dispose();
  await assert.rejects(pending, /disposed/);
  assert.equal(calls.some(([name]) => name === "create" || name === "remove" || name === "update"), false);
});

test("absence of a normal Firefox window produces an error without creating or closing windows", async () => {
  const { api, calls } = fakeBrowser([{ id: 1, type: "popup", tabs: [] }]);
  await assert.rejects(createLauncher(api).open(), /browsing window/);
  assert.equal(calls.some(([name]) => name === "create" || name === "remove" || name === "update"), false);
});

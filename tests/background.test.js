import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../experiments/sidebar/background.js", import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function harness(toggle = () => Promise.resolve()) {
  const calls = [];
  const handlers = {};
  let userGesture = false;
  const browser = {
    action: {
      onClicked: { addListener: (handler) => { handlers.click = handler; } },
      setBadgeText: (value) => { calls.push(["badge", value]); return Promise.resolve(); },
      setTitle: (value) => { calls.push(["title", value]); return Promise.resolve(); },
    },
    commands: { onCommand: { addListener: (handler) => { handlers.command = handler; } } },
    sidebarAction: {
      toggle: () => {
        assert.equal(userGesture, true, "toggle must run before the event callback returns");
        calls.push(["toggle"]);
        return toggle();
      },
    },
    get windows() { throw new Error("The sidebar background must not access browser windows"); },
    get tabs() { throw new Error("The sidebar background must not access browser tabs"); },
  };
  vm.runInNewContext(source, { browser, Promise }, { filename: "background.js" });
  function invoke(event, ...args) {
    userGesture = true;
    try { return handlers[event](...args); }
    finally { userGesture = false; }
  }
  return { browser, calls, handlers, invoke };
}

async function settle() {
  // Toggle observation and asynchronous badge/title feedback use separate microtasks.
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function status(calls, name) {
  return calls.filter(([type]) => type === name).map(([, value]) => value);
}

test("registers both event handlers synchronously without opening anything", () => {
  const { handlers, calls } = harness();
  assert.equal(typeof handlers.click, "function");
  assert.equal(typeof handlers.command, "function");
  assert.deepEqual(calls, []);
});

test("toolbar click toggles immediately while its returned promise remains pending", async () => {
  const pending = deferred();
  const { calls, invoke } = harness(() => pending.promise);
  assert.equal(invoke("click", { id: 1, windowId: 5 }), undefined);
  assert.deepEqual(calls, [["toggle"]]);
  await settle();
  assert.deepEqual(calls, [["toggle"]]);
  pending.resolve();
  await settle();
  assert.equal(status(calls, "badge").at(-1).text, "");
  assert.equal(status(calls, "title").at(-1).title, "Search or Switch");
});

test("the open-search command also toggles immediately without awaiting initialization", async () => {
  const pending = deferred();
  const { calls, invoke } = harness(() => pending.promise);
  assert.equal(invoke("command", "open-search", { windowId: 5 }), undefined);
  assert.deepEqual(calls, [["toggle"]]);
  pending.resolve();
  await settle();
  assert.equal(status(calls, "badge").at(-1).text, "");
});

test("other extension commands do not toggle or alter status", async () => {
  const { calls, invoke } = harness();
  invoke("command", "unrelated-command");
  await settle();
  assert.deepEqual(calls, []);
});

test("a rejected toggle reports a badge and retry tooltip without logging tab data", async () => {
  const { calls, invoke } = harness(() => Promise.reject(new Error("private internal details")));
  invoke("click");
  await settle();
  assert.equal(status(calls, "badge").at(-1).text, "!");
  assert.match(status(calls, "title").at(-1).title, /Click to try again/);
  assert.equal(JSON.stringify(calls).includes("private internal details"), false);
});

test("a synchronous toggle exception is handled for both entry points", async () => {
  for (const event of ["click", "command"]) {
    const { calls, invoke } = harness(() => { throw new Error("No user gesture"); });
    assert.doesNotThrow(() => invoke(event, "open-search"));
    assert.deepEqual(calls, [["toggle"]]);
    await settle();
    assert.equal(status(calls, "badge").at(-1).text, "!");
    assert.match(status(calls, "title").at(-1).title, /Click to try again/);
  }
});

test("a successful retry clears the failure badge and tooltip", async () => {
  let attempts = 0;
  const { calls, invoke } = harness(() => ++attempts === 1
    ? Promise.reject(new Error("Temporary failure"))
    : Promise.resolve());
  invoke("click");
  await settle();
  assert.equal(status(calls, "badge").at(-1).text, "!");
  invoke("command", "open-search");
  await settle();
  assert.equal(status(calls, "badge").at(-1).text, "");
  assert.equal(status(calls, "title").at(-1).title, "Search or Switch");
});

test("a late failure from an earlier toggle cannot overwrite a successful retry", async () => {
  const earlier = deferred();
  let attempts = 0;
  const { calls, invoke } = harness(() => ++attempts === 1 ? earlier.promise : Promise.resolve());
  invoke("click");
  invoke("command", "open-search");
  await settle();
  earlier.reject(new Error("Earlier request failed late"));
  await settle();
  assert.deepEqual(status(calls, "badge").map((value) => value.text), [""]);
  assert.equal(status(calls, "title").at(-1).title, "Search or Switch");
});

test("a late success from an earlier toggle cannot hide a newer synchronous failure", async () => {
  const earlier = deferred();
  let attempts = 0;
  const { calls, invoke } = harness(() => {
    if (++attempts === 1) return earlier.promise;
    throw new Error("Newer failure");
  });
  invoke("click");
  invoke("command", "open-search");
  await settle();
  earlier.resolve();
  await settle();
  assert.deepEqual(status(calls, "badge").map((value) => value.text), ["!"]);
});

test("badge and tooltip API failures are swallowed after a handled toggle failure", async () => {
  const { browser, calls, invoke } = harness(() => Promise.reject(new Error("Toggle failed")));
  browser.action.setBadgeText = () => { throw new Error("Badge unavailable"); };
  browser.action.setTitle = () => Promise.reject(new Error("Title unavailable"));
  invoke("click");
  await settle();
  assert.deepEqual(calls, [["toggle"]]);
});

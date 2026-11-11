import test from "node:test";
import assert from "node:assert/strict";
import { captureShortcut, createShortcutSettings, formatShortcut, getDefaultShortcut, validateShortcut } from "../shortcut-settings.js";

const mac = { isMac: true };
const win = { isMac: false, isWindows: true };
const linux = { isMac: false, isWindows: false };
const key = (value, modifiers = {}) => ({ key: value, ...modifiers });

test("defaults and native formatting distinguish Command from physical Mac Control", () => {
  assert.equal(getDefaultShortcut(mac), "Command+Shift+K");
  assert.equal(getDefaultShortcut(win), "Ctrl+Shift+K");
  assert.equal(getDefaultShortcut(linux), "Ctrl+Shift+Space");
  assert.equal(formatShortcut("Command+Shift+K", mac), "⇧⌘K");
  assert.equal(formatShortcut("Ctrl+Shift+K", mac), "⇧⌘K");
  assert.equal(formatShortcut("MacCtrl+Alt+Up", mac), "⌃⌥↑");
  assert.equal(formatShortcut("Ctrl+Shift+Space", win), "Ctrl+Shift+Space");
  assert.equal(formatShortcut("Alt+PageDown", win), "Alt+Page Down");
});

test("an unassigned API value displays Not assigned without inventing a default", () => {
  for (const value of ["", undefined, null, "  "]) assert.equal(formatShortcut(value, mac), "Not assigned");
});

test("capture serializes Meta, physical Control, Alt, and Shift into Firefox tokens", () => {
  assert.deepEqual(captureShortcut(key("k", { metaKey: true, shiftKey: true }), mac), {
    type: "shortcut", shortcut: "Command+Shift+K", display: "⇧⌘K",
  });
  assert.deepEqual(captureShortcut(key("k", { ctrlKey: true, shiftKey: true }), mac), {
    type: "shortcut", shortcut: "MacCtrl+Shift+K", display: "⌃⇧K",
  });
  assert.deepEqual(captureShortcut(key("7", { metaKey: true, altKey: true }), mac), {
    type: "shortcut", shortcut: "Command+Alt+7", display: "⌥⌘7",
  });
  assert.deepEqual(captureShortcut(key(" ", { ctrlKey: true, shiftKey: true }), win), {
    type: "shortcut", shortcut: "Ctrl+Shift+Space", display: "Ctrl+Shift+Space",
  });
  assert.deepEqual(captureShortcut(key("k", { ctrlKey: true, shiftKey: true }), win), {
    type: "shortcut", shortcut: "Ctrl+Shift+K", display: "Ctrl+Shift+K",
  });
});

test("special keys and Firefox 135+ function keys use the commands API spelling", () => {
  for (const [eventKey, shortcut] of [["ArrowUp", "Alt+Shift+Up"], ["ArrowDown", "Alt+Shift+Down"], [",", "Alt+Shift+Comma"], [".", "Alt+Shift+Period"], ["Home", "Alt+Shift+Home"], ["Delete", "Alt+Shift+Delete"]]) {
    const result = captureShortcut(key(eventKey, { altKey: true, shiftKey: true }), win);
    assert.equal(result.type, "shortcut", eventKey);
    assert.equal(result.shortcut, shortcut);
  }
  assert.equal(captureShortcut(key("F2"), win).shortcut, "F2");
  assert.equal(captureShortcut(key("F19", { ctrlKey: true }), win).shortcut, "Ctrl+F19");
  assert.equal(captureShortcut(key("MediaTrackNext"), win).shortcut, "MediaNextTrack");
  assert.equal(validateShortcut("F20", win).valid, false);
});

test("Option-produced symbols can use the underlying letter without accepting arbitrary punctuation", () => {
  assert.equal(captureShortcut(key("˚", { altKey: true, code: "KeyK" }), mac).shortcut, "Alt+K");
  assert.equal(captureShortcut(key("/", { altKey: true }), mac).type, "invalid");
});

test("modifier-only, IME, AltGraph, dead keys, and repeats are ignored", () => {
  for (const event of [key("Control"), key("Meta"), key("Shift"), key("Alt"), key("Dead"), key("Process"), key("k", { isComposing: true }), key("k", { keyCode: 229 }), key("k", { repeat: true }), key("k", { getModifierState: () => true })]) {
    assert.deepEqual(captureShortcut(event, mac), { type: "ignore" });
  }
});

test("Escape cancels and Tab leaves recording without either helper trapping the event", () => {
  const preventDefault = () => assert.fail("capture must leave event prevention to its caller");
  assert.deepEqual(captureShortcut(key("Escape", { preventDefault }), mac), { type: "cancel" });
  assert.deepEqual(captureShortcut(key("Tab", { shiftKey: true, preventDefault }), mac), { type: "leave" });
});

test("grammar rejects missing/duplicate/extra modifiers and unsupported keys", () => {
  for (const shortcut of ["", "K", "Shift+K", "Ctrl+Ctrl+K", "Ctrl+Alt+Shift+K", "Shift+Alt+K", "Ctrl+Enter", "Ctrl+Tab", "Ctrl+/", "Ctrl+k", "Ctrl+MediaStop", " Ctrl+Shift+Space"]) {
    assert.equal(validateShortcut(shortcut, win).valid, false, shortcut);
  }
  assert.equal(validateShortcut("Ctrl+Command+K", mac).valid, false);
  assert.equal(captureShortcut(key("k", { metaKey: true, ctrlKey: true, altKey: true, shiftKey: true }), mac).type, "invalid");
});

test("known native Firefox bindings are rejected while the extension defaults remain valid", () => {
  for (const shortcut of ["Command+K", "Ctrl+K", "Command+L", "Command+T", "Command+W", "Command+N", "Command+R", "Command+S", "Command+P", "Command+F", "Command+Q", "Command+Shift+T", "Command+Shift+N", "Command+Shift+P", "Command+Alt+K"]) {
    assert.deepEqual(validateShortcut(shortcut, mac), { valid: false, message: "Firefox uses this shortcut. Try another combination." }, shortcut);
  }
  for (const shortcut of ["Ctrl+L", "Ctrl+T", "Ctrl+W", "Ctrl+R", "Ctrl+Shift+T"]) assert.equal(validateShortcut(shortcut, win).valid, false);
  assert.equal(validateShortcut(getDefaultShortcut(mac), mac).valid, true);
  assert.equal(validateShortcut(getDefaultShortcut(win), win).valid, true);
  assert.equal(validateShortcut(getDefaultShortcut(linux), linux).valid, true);
  assert.equal(validateShortcut("Ctrl+Shift+K", linux).valid, false);
  assert.equal(validateShortcut("MacCtrl+K", mac).valid, true);
  // The helper checks known Firefox bindings, not operating-system reservations.
  assert.equal(validateShortcut("Command+Shift+Q", mac).valid, true);
});

function fakeCommands(initial = "Command+Shift+K") {
  let shortcut = initial;
  const calls = [];
  const commands = {
    async getAll() { calls.push(["getAll"]); return [{ name: "unrelated", shortcut: "Alt+Shift+8" }, { name: "_execute_action", shortcut }]; },
    async update(details) { calls.push(["update", details]); shortcut = details.shortcut; },
    async reset(name) { calls.push(["reset", name]); shortcut = "Command+Shift+K"; },
  };
  return { commands, calls };
}

test("read returns Firefox's actual assigned or blank value", async () => {
  const current = fakeCommands("Alt+Shift+8");
  assert.deepEqual(await createShortcutSettings(current.commands, mac).read(), { shortcut: "Alt+Shift+8", display: "⌥⇧8" });
  const blank = fakeCommands("");
  assert.deepEqual(await createShortcutSettings(blank.commands, mac).read(), { shortcut: "", display: "Not assigned" });
});

test("save updates only _execute_action and reads back the API's effective shortcut", async () => {
  const { commands, calls } = fakeCommands();
  assert.deepEqual(await createShortcutSettings(commands, mac).save("Alt+Shift+8"), { shortcut: "Alt+Shift+8", display: "⌥⇧8" });
  assert.deepEqual(calls, [["update", { name: "_execute_action", shortcut: "Alt+Shift+8" }], ["getAll"]]);
});

test("invalid or known native assignments never reach commands.update", async () => {
  const { commands, calls } = fakeCommands();
  const controller = createShortcutSettings(commands, mac);
  await assert.rejects(controller.save("Command+K"), /Firefox uses this shortcut/);
  await assert.rejects(controller.save("K"), /Use Ctrl/);
  assert.deepEqual(calls, []);
});

test("reset calls Firefox reset for the popup command and reports the returned default", async () => {
  const { commands, calls } = fakeCommands("Alt+Shift+8");
  assert.deepEqual(await createShortcutSettings(commands, mac).reset(), { shortcut: "Command+Shift+K", display: "⇧⌘K" });
  assert.deepEqual(calls, [["reset", "_execute_action"], ["getAll"]]);
});

test("clear explicitly unassigns only the popup command and reads back the empty assignment", async () => {
  const { commands, calls } = fakeCommands("Alt+Shift+8");
  assert.deepEqual(await createShortcutSettings(commands, mac).clear(), { shortcut: "", display: "Not assigned" });
  assert.deepEqual(calls, [["update", { name: "_execute_action", shortcut: "" }], ["getAll"]]);
});

test("missing APIs or the extension's command produce clear errors", async () => {
  assert.throws(() => createShortcutSettings(undefined, mac), /unavailable/);
  assert.throws(() => createShortcutSettings({ getAll() {} }, mac), /unavailable/);
  const { commands } = fakeCommands();
  commands.getAll = async () => [{ name: "unrelated", shortcut: "Alt+Shift+8" }];
  await assert.rejects(createShortcutSettings(commands, mac).read(), /could not find this extension's popup shortcut/);
});

test("API failures are readable and do not poison later queued operations", async () => {
  const { commands } = fakeCommands();
  const controller = createShortcutSettings(commands, mac);
  const update = commands.update;
  commands.update = async () => { throw new Error("Internal API detail"); };
  await assert.rejects(controller.save("Alt+Shift+8"), /could not save/);
  await assert.rejects(controller.clear(), /could not clear/);
  commands.update = update;
  assert.equal((await controller.save("Alt+Shift+8")).shortcut, "Alt+Shift+8");
  commands.reset = async () => { throw new Error("Internal API detail"); };
  await assert.rejects(controller.reset(), /could not reset/);
  commands.getAll = async () => { throw new Error("Internal API detail"); };
  await assert.rejects(controller.read(), /could not read/);
});

test("read/save/reset serialize so delayed API reads cannot race later changes", async () => {
  const { commands, calls } = fakeCommands("Alt+Shift+9");
  const getAll = commands.getAll;
  let release;
  commands.getAll = () => new Promise((resolve) => { release = () => resolve([{ name: "_execute_action", shortcut: "Alt+Shift+9" }]); });
  const controller = createShortcutSettings(commands, mac);
  const reading = controller.read();
  const saving = controller.save("Alt+Shift+8");
  const resetting = controller.reset();
  await Promise.resolve();
  assert.deepEqual(calls, []);
  commands.getAll = getAll;
  release();
  assert.equal((await reading).shortcut, "Alt+Shift+9");
  assert.equal((await saving).shortcut, "Alt+Shift+8");
  assert.equal((await resetting).shortcut, "Command+Shift+K");
  assert.deepEqual(calls, [["update", { name: "_execute_action", shortcut: "Alt+Shift+8" }], ["getAll"], ["reset", "_execute_action"], ["getAll"]]);
});

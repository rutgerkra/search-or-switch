const COMMAND_NAME = "_execute_action";
const PRIMARY_MODIFIERS = new Set(["Ctrl", "Alt", "Command", "MacCtrl"]);
const MODIFIERS = new Set([...PRIMARY_MODIFIERS, "Shift"]);
const NAMED_KEYS = new Set(["Comma", "Period", "Home", "End", "PageUp", "PageDown", "Space", "Insert", "Delete", "Up", "Down", "Left", "Right"]);
const MEDIA_KEYS = new Set(["MediaNextTrack", "MediaPlayPause", "MediaPrevTrack", "MediaStop"]);
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph", "Fn", "FnLock", "CapsLock", "NumLock", "ScrollLock"]);
const KEY_NAMES = {
  " ": "Space", Spacebar: "Space", ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  ",": "Comma", ".": "Period", MediaTrackNext: "MediaNextTrack", MediaTrackPrevious: "MediaPrevTrack",
};
const DISPLAY_KEYS = { Comma: ",", Period: ".", PageUp: "Page Up", PageDown: "Page Down", Up: "↑", Down: "↓", Left: "←", Right: "→" };
const GRAMMAR_MESSAGE = "Use Ctrl, Alt, or Command with a letter, number, or supported key.";
const CONFLICT_MESSAGE = "Firefox uses this shortcut. Try another combination.";

export function getDefaultShortcut({ isMac = false, isWindows = false } = {}) {
  return isMac ? "Command+Shift+K" : isWindows ? "Ctrl+Shift+K" : "Ctrl+Shift+Space";
}

function isFunctionKey(key) {
  return /^F(?:[1-9]|1\d)$/.test(key);
}

function supportedKey(key) {
  return /^[A-Z0-9]$/.test(key) || NAMED_KEYS.has(key) || isFunctionKey(key);
}

function effectiveModifiers(modifiers, isMac) {
  return modifiers.map((modifier) => isMac && modifier === "Ctrl" ? "Command" : modifier);
}

function knownFirefoxConflict(modifiers, key, isMac, isWindows) {
  const effective = effectiveModifiers(modifiers, isMac);
  const main = isMac ? "Command" : "Ctrl";
  const hasOnly = (...expected) => effective.length === expected.length && expected.every((modifier) => effective.includes(modifier));
  if (hasOnly(main) && (new Set(["A", "C", "F", "G", "K", "L", "N", "O", "P", "Q", "R", "S", "T", "V", "W", "X", "Z"]).has(key) || /^[0-9]$/.test(key))) return true;
  if (hasOnly(main, "Shift") && ["N", "P", "R", "T", "W", "Z"].includes(key)) return true;
  if (!isMac && hasOnly("Ctrl", "Shift") && (["J", "Q"].includes(key) || (key === "K" && !isWindows))) return true;
  if (isMac && hasOnly("Command", "Alt") && ["C", "I", "K"].includes(key)) return true;
  if (!isMac && hasOnly("Alt") && ["Left", "Right", "Home"].includes(key)) return true;
  if (isMac && hasOnly("Command") && ["Left", "Right", "Up", "Down"].includes(key)) return true;
  if (!effective.length && ["F5", "F6"].includes(key)) return true;
  return false;
}

/** Checks a Firefox commands shortcut, plus a small set of known native conflicts. */
export function validateShortcut(shortcut, { isMac = false, isWindows = false } = {}) {
  if (typeof shortcut !== "string" || !shortcut || shortcut.trim() !== shortcut) return { valid: false, message: GRAMMAR_MESSAGE };
  const tokens = shortcut.split("+");
  const key = tokens.at(-1);
  const modifiers = tokens.slice(0, -1);
  const standalone = !modifiers.length && (isFunctionKey(key) || MEDIA_KEYS.has(key));
  const combination = modifiers.length >= 1 && modifiers.length <= 2
    && PRIMARY_MODIFIERS.has(modifiers[0])
    && modifiers.every((modifier) => MODIFIERS.has(modifier))
    && new Set(modifiers).size === modifiers.length
    && new Set(effectiveModifiers(modifiers, isMac)).size === modifiers.length
    && supportedKey(key);
  if (!standalone && !combination) return { valid: false, message: GRAMMAR_MESSAGE };
  if (knownFirefoxConflict(modifiers, key, isMac, isWindows)) return { valid: false, message: CONFLICT_MESSAGE };
  return { valid: true };
}

/** Formats API values for display, including an explicitly unassigned shortcut. */
export function formatShortcut(shortcut, { isMac = false } = {}) {
  if (typeof shortcut !== "string" || !shortcut.trim()) return "Not assigned";
  const tokens = shortcut.split("+");
  const key = tokens.pop();
  const label = DISPLAY_KEYS[key] ?? key;
  if (!isMac) return [...tokens.map((modifier) => modifier === "MacCtrl" ? "Ctrl" : modifier), label].join("+");
  const modifiers = new Set(effectiveModifiers(tokens, true));
  const symbols = [["MacCtrl", "⌃"], ["Alt", "⌥"], ["Shift", "⇧"], ["Command", "⌘"]]
    .filter(([modifier]) => modifiers.has(modifier)).map(([, symbol]) => symbol).join("");
  return `${symbols}${label}`;
}

/** Pure recorder: callers decide which events to prevent; Tab is never trapped here. */
export function captureShortcut(event, { isMac = false, isWindows = false } = {}) {
  if (!event || event.isComposing || event.keyCode === 229 || event.repeat
    || ["Process", "Dead", "Unidentified"].includes(event.key)
    || event.getModifierState?.("AltGraph")) return { type: "ignore" };
  if (event.key === "Escape" || event.key === "Esc") return { type: "cancel" };
  if (event.key === "Tab") return { type: "leave" };
  if (MODIFIER_KEYS.has(event.key)) return { type: "ignore" };

  let key = KEY_NAMES[event.key] ?? event.key;
  if (typeof key === "string" && /^[a-z]$/i.test(key)) key = key.toUpperCase();
  // Option/Alt can produce a symbol rather than the underlying letter on macOS.
  if (!supportedKey(key) && !MEDIA_KEYS.has(key) && event.altKey && /^Key[A-Z]$/.test(event.code ?? "")) key = event.code.slice(3);
  const modifiers = [];
  if (event.metaKey) modifiers.push("Command");
  if (event.ctrlKey) modifiers.push(isMac ? "MacCtrl" : "Ctrl");
  if (event.altKey) modifiers.push("Alt");
  if (event.shiftKey) modifiers.push("Shift");
  const shortcut = [...modifiers, key].join("+");
  const result = validateShortcut(shortcut, { isMac, isWindows });
  return result.valid
    ? { type: "shortcut", shortcut, display: formatShortcut(shortcut, { isMac }) }
    : { type: "invalid", message: result.message };
}

/** Serializes changes to this extension's popup command and reads back Firefox's value. */
export function createShortcutSettings(commands, { isMac = false, isWindows = false } = {}) {
  if (!["getAll", "update", "reset"].every((name) => typeof commands?.[name] === "function")) {
    throw new Error("Firefox shortcut settings are unavailable.");
  }
  let queue = Promise.resolve();
  function enqueue(operation) {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  }
  async function readCurrent() {
    let registered;
    try { registered = await commands.getAll(); }
    catch { throw new Error("Firefox could not read the shortcut. Try again."); }
    const command = registered?.find((item) => item.name === COMMAND_NAME);
    if (!command) throw new Error("Firefox could not find this extension's popup shortcut.");
    const shortcut = typeof command.shortcut === "string" ? command.shortcut : "";
    return { shortcut, display: formatShortcut(shortcut, { isMac }) };
  }
  return {
    read: () => enqueue(readCurrent),
    save(shortcut) {
      const validation = validateShortcut(shortcut, { isMac, isWindows });
      if (!validation.valid) return Promise.reject(new Error(validation.message));
      return enqueue(async () => {
        try { await commands.update({ name: COMMAND_NAME, shortcut }); }
        catch { throw new Error("Firefox could not save this shortcut. Try another combination."); }
        return readCurrent();
      });
    },
    clear: () => enqueue(async () => {
      try { await commands.update({ name: COMMAND_NAME, shortcut: "" }); }
      catch { throw new Error("Firefox could not clear the shortcut. Try again."); }
      return readCurrent();
    }),
    reset: () => enqueue(async () => {
      try { await commands.reset(COMMAND_NAME); }
      catch { throw new Error("Firefox could not reset the shortcut. Try again."); }
      return readCurrent();
    }),
  };
}

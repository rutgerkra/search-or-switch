import { getTabDisplay, rankTabs, rankHistory, resolveInput } from "./core.js";
import { createHistorySearch } from "./history-search.js";
import { createPopupController } from "./popup-tabs.js";
import { getInputPresentation } from "./popup-input.js";
import { createFaviconCache } from "./favicon-cache.js";
import { captureShortcut, createShortcutSettings, formatShortcut, getDefaultShortcut } from "./shortcut-settings.js";

const $ = (id) => document.getElementById(id);
const input = $("query");
const list = $("results");
const queryIcon = $("query-icon");
const api = globalThis.browser;
const preview = !api?.runtime?.id;
if (preview) document.documentElement.dataset.preview = "true";
const state = { tabs: [], history: [], self: null, rows: [], selected: -1, query: "", previewSelection: false, selectionLost: false, composing: false, busy: false, ready: false };
let faviconCache = createFaviconCache(undefined, { persist: false });
let controller;
let historySearch;
const historyRemovers = [];
let refreshTimer;
let refreshVersion = 0;
let announceTimer;
let disposed = false;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const defaultShortcut = getDefaultShortcut({ isMac });
let previewShortcut = defaultShortcut;
const shortcutCommands = preview ? {
  async getAll() { return [{ name: "_execute_action", shortcut: previewShortcut }]; },
  async update({ shortcut }) { previewShortcut = shortcut; },
  async reset() { previewShortcut = defaultShortcut; },
} : api.commands;
const shortcuts = ["getAll", "update", "reset"].every((name) => typeof shortcutCommands?.[name] === "function")
  ? createShortcutSettings(shortcutCommands, { isMac }) : null;
let currentShortcut = "";
let stagedShortcut = "";
let shortcutLoaded = false;
let shortcutBusy = false;
let shortcutVersion = 0;
$("shortcut-reset").title = `Restore default shortcut (${formatShortcut(defaultShortcut, { isMac })})`;

function showError(message) {
  $("error").textContent = message;
  $("error").hidden = !message;
}

function announce(message) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => { $("announcer").textContent = message; }, 150);
}

function icon(kind) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.5");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", kind === "url" ? "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18Z" : "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0");
  svg.append(path);
  return svg;
}

function paintSiteIcon(container, kind, url, preferredIcon) {
  const favicon = url && faviconCache.get(url, preferredIcon);
  if (favicon && container.firstElementChild?.getAttribute("src") === favicon) return;
  container.dataset.kind = favicon ? "favicon" : kind;
  container.replaceChildren(icon(kind));
  if (!favicon) return;
  const image = document.createElement("img");
  image.alt = "";
  image.width = image.height = 16;
  image.addEventListener("error", () => {
    if (!container.contains(image)) return;
    container.dataset.kind = kind;
    container.replaceChildren(icon(kind));
  }, { once: true });
  image.src = favicon;
  container.replaceChildren(image);
}

function paintRowIcon(container, row) {
  const website = row.type === "tab" || row.target?.type === "url";
  paintSiteIcon(container, website ? "url" : "search", row.type === "tab" ? row.tab.url : row.target?.url, row.tab?.favIconUrl);
}

function updateFavicons() {
  updateInputPresentation();
  for (const [index, child] of [...list.children].entries()) {
    paintRowIcon(child.querySelector(".site-icon"), state.rows[index]);
  }
}

function makeRow(row, index) {
  const el = document.createElement("div");
  el.id = `result-${index}`;
  el.className = `result${row.type === "action" ? " action-result" : ""}`;
  el.setAttribute("role", "option");
  el.setAttribute("aria-selected", String(index === state.selected));
  el.dataset.index = String(index);
  el.dataset.type = row.type;
  const siteIcon = document.createElement("span");
  siteIcon.className = "site-icon";
  siteIcon.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "result-copy";
  const title = document.createElement("span");
  title.className = "result-title";
  const description = document.createElement("span");
  description.className = "result-description";
  const meta = document.createElement("span");
  meta.className = "result-meta";
  meta.setAttribute("aria-hidden", "true");
  const metaLabel = document.createElement("span");
  metaLabel.className = "result-meta-label";
  const arrow = document.createElement("span");
  arrow.className = "selected-arrow";
  arrow.textContent = "↵";

  if (row.type === "tab" || row.type === "history") {
    const display = getTabDisplay(row.tab || row.history);
    title.textContent = display.title;
    description.textContent = display.label;
    metaLabel.textContent = row.type === "history" ? "History" : row.tab.active ? "Current tab" : row.tab.discarded ? "Sleeping tab" : row.tab.pinned ? "Pinned tab" : "Switch to tab";
    if (row.type === "history") el.setAttribute("aria-label", `${display.title}, ${display.label}, from history`);
  } else {
    const target = row.target;
    el.dataset.action = target.type;
    title.textContent = target.type === "url" ? `Open ${target.label}` : target.type === "invalid" ? "Check this address" : target.query;
    description.textContent = target.type === "url" ? "Open address" : target.type === "invalid" ? target.message : "";
    if (target.type === "search") el.setAttribute("aria-label", `${target.query}, web search`);
    else metaLabel.textContent = `${isMac ? "⌘" : "Ctrl"} ↵`;
  }
  paintRowIcon(siteIcon, row);
  copy.append(title);
  if (description.textContent) copy.append(description);
  if (metaLabel.textContent) meta.append(metaLabel);
  meta.append(arrow);
  el.append(siteIcon, copy, meta);
  return el;
}

function updateInputPresentation() {
  if (state.composing) return;
  const row = state.rows[state.selected];
  const presentation = getInputPresentation({ query: state.query, row, previewSelection: state.previewSelection });
  if (input.value !== presentation.value) {
    input.value = presentation.value;
    input.setSelectionRange(input.value.length, input.value.length);
  }
  input.dataset.action = presentation.kind;
  $("clear").hidden = !input.value;
  const website = presentation.kind === "tab" || presentation.kind === "url";
  paintSiteIcon(queryIcon, website ? "url" : "search", website ? presentation.url : undefined, row?.tab?.favIconUrl);
}

function setSelection(index, scroll = false, previewSelection = state.previewSelection) {
  state.selected = state.rows.length && Number.isInteger(index) ? ((index % state.rows.length) + state.rows.length) % state.rows.length : -1;
  if (previewSelection && state.selected >= 0 && state.selectionLost) {
    state.selectionLost = false;
    showError("");
  }
  state.previewSelection = previewSelection;
  for (const [i, child] of [...list.children].entries()) child.setAttribute("aria-selected", String(i === state.selected));
  const selected = state.rows[state.selected];
  if (selected) {
    input.setAttribute("aria-activedescendant", `result-${state.selected}`);
    if (scroll) list.children[state.selected]?.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
  }
  updateInputPresentation();
}

function render(preserveSelection = false) {
  if (state.composing) return;
  const previousKey = preserveSelection ? state.rows[state.selected]?.key : undefined;
  const query = state.query.trim();
  const allMatches = rankTabs(state.tabs, query, { excludeTabId: state.self?.id, windowId: state.self?.windowId, limit: Number.MAX_SAFE_INTEGER });
  const matches = allMatches;
  state.rows = matches.map((tab) => ({ type: "tab", tab, key: `tab-${tab.id}` }));
  const historyMatches = rankHistory(state.history, query, { tabs: state.tabs });
  state.rows.push(...historyMatches.map((item) => ({ type: "history", history: item, target: { type: "url", url: item.url }, key: `history-${item.url}` })));
  const target = resolveInput(query);
  if (target.type !== "empty") state.rows.push({ type: "action", target, key: "action" });
  const previousIndex = previousKey ? state.rows.findIndex((row) => row.key === previousKey) : -1;
  const selectionLost = state.previewSelection && previousKey && previousKey !== "action" && previousIndex < 0;
  if (selectionLost) state.selectionLost = true;
  const selection = previousIndex >= 0 ? previousIndex : state.selectionLost ? null : query ? 0 : null;
  const previewSelection = previousIndex >= 0 && state.previewSelection;
  state.selected = selection ?? -1;
  list.replaceChildren(...state.rows.map(makeRow));
  list.setAttribute("aria-busy", String(state.busy || !state.ready));
  input.setAttribute("aria-expanded", String(state.rows.length > 0));
  $("empty-state").hidden = state.rows.length > 0;
  $("empty-state").textContent = state.ready ? "No open tabs." : "Finding your open tabs…";
  setSelection(selection, false, previewSelection);
  if (selectionLost) showError(previousKey.startsWith("history-") ? "That history result is no longer available. Choose another result." : "That tab is no longer available. Choose another result.");
  const actionAnnouncement = target.type === "invalid" ? target.message : `${target.type === "url" ? "Open address" : "Web search"} also available.`;
  announce(query ? `${allMatches.length} matching tabs. ${historyMatches.length} history results. ${actionAnnouncement}` : `${allMatches.length} open tabs in this window.`);
}

function requestHistory({ clear = true } = {}) {
  if (clear) state.history = [];
  if (!historySearch) return;
  void historySearch.search(state.query).then((result) => {
    if (!result || disposed || result.query !== state.query.trim()) return;
    state.history = result.items;
    if (state.busy || state.composing) return;
    render(state.previewSelection || state.selectionLost);
    if (result.unavailable) showError("History could not be loaded.");
  });
}

async function refresh() {
  const version = ++refreshVersion;
  try {
    const tabs = await controller.refresh();
    if (!disposed && version === refreshVersion) {
      state.tabs = tabs;
      void faviconCache.remember(tabs);
      render(true);
    }
  } catch (error) {
    if (!disposed) showError(error.message);
  }
}

async function closePopup() {
  try {
    // Close only this action popup after its destination has opened.
    window.close();
  } catch {
    showError("Firefox could not close the popup. Use its close button to dismiss it.");
  }
}

async function choose(forceNavigation = false) {
  if (state.busy || !state.ready) return;
  const row = forceNavigation ? { type: "action", target: resolveInput(input.value) } : state.rows[state.selected];
  if (!row || row.target?.type === "empty") return;
  showError("");
  if (row.target?.type === "invalid") {
    showError(row.target.message);
    return;
  }
  if (preview) {
    showError("This is a visual preview.");
    return;
  }
  state.busy = true;
  list.setAttribute("aria-busy", "true");
  try {
    if (row.type === "tab") {
      await controller.switchTo(row.tab.id);
    } else if (row.target.type === "url") {
      await controller.navigate(row.target.url);
    } else {
      await controller.search(row.target.query);
    }
    input.value = "";
    showError("");
    await closePopup();
  } catch (error) {
    showError(error.message || "Something went wrong. Your original tabs have been kept open.");
    await refresh();
  } finally {
    state.busy = false;
    list.setAttribute("aria-busy", "false");
  }
}

function acceptInput() {
  state.query = input.value;
  state.previewSelection = false;
  state.selectionLost = false;
  showError("");
  requestHistory();
  render();
}
input.addEventListener("input", acceptInput);
input.addEventListener("compositionstart", () => { state.composing = true; });
input.addEventListener("compositionend", () => { state.composing = false; acceptInput(); });
input.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const direction = event.key === "ArrowDown" ? 1 : -1;
    const next = state.selected < 0 ? direction > 0 ? 0 : state.rows.length - 1 : state.selected + direction;
    setSelection(next, true, true);
  } else if (event.key === "Enter") {
    event.preventDefault();
    void choose(event.metaKey || event.ctrlKey);
  } else if (event.key === "Escape") {
    event.preventDefault();
    if (state.busy) {
      announce("Opening your destination. Please wait.");
      return;
    }
    if (preview) {
      input.value = "";
      state.query = "";
      state.previewSelection = false;
      showError("");
      render();
    } else {
      void closePopup();
    }
  }
});
list.addEventListener("mousedown", (event) => { if (event.target.closest("[role=option]")) event.preventDefault(); });
list.addEventListener("click", (event) => {
  const row = event.target.closest("[role=option]");
  if (!row || state.busy) return;
  setSelection(Number(row.dataset.index), false, true);
  void choose();
});
$("clear").addEventListener("click", () => { input.value = ""; acceptInput(); input.focus(); });
function showShortcutError(message = "") {
  $("shortcut-error").textContent = message;
  $("shortcut-error").hidden = !message;
  $("shortcut-input").setAttribute("aria-invalid", String(Boolean(message)));
}

function showShortcutStatus(message = "") {
  $("shortcut-status").textContent = message;
  $("shortcut-status").hidden = !message;
}

function setShortcutBusy(busy) {
  shortcutBusy = busy;
  const editing = !$("shortcut-input").hidden;
  $("shortcut-edit").disabled = busy || !shortcutLoaded;
  $("shortcut-edit").hidden = editing;
  $("shortcut-clear").hidden = editing || !shortcutLoaded || !currentShortcut;
  $("shortcut-clear").disabled = busy || !shortcutLoaded;
  $("shortcut-reset").hidden = editing || !shortcutLoaded || Boolean(currentShortcut);
  $("shortcut-reset").disabled = busy || !shortcutLoaded;
  $("shortcut-cancel").hidden = !editing;
  $("shortcut-cancel").disabled = busy;
  $("shortcut-input").disabled = busy;
}

function closeShortcutEditor(focus = false) {
  stagedShortcut = "";
  $("shortcut-row").dataset.editing = "false";
  $("shortcut-input").hidden = true;
  $("shortcut-current").hidden = false;
  $("shortcut-input").value = "";
  showShortcutError();
  setShortcutBusy(shortcutBusy);
  if (focus && !$("settings").hidden) $("shortcut-edit").focus();
}

async function shortcutOperation(operation, success = "", focusTarget = "shortcut-edit") {
  const version = ++shortcutVersion;
  let focusAfterSave = false;
  setShortcutBusy(true);
  showShortcutError();
  showShortcutStatus();
  try {
    if (!shortcuts) throw new Error("Firefox’s shortcut controls are unavailable. Reopen the popup to try again.");
    const result = await operation();
    if (disposed || version !== shortcutVersion) return;
    currentShortcut = result.shortcut;
    shortcutLoaded = true;
    $("shortcut-current").textContent = result.shortcut ? result.display : "Add shortcut";
    $("shortcut-current").dataset.empty = String(!result.shortcut);
    $("shortcut-current").title = result.display;
    closeShortcutEditor();
    focusAfterSave = Boolean(success);
    showShortcutStatus(success ? preview ? "Preview updated." : success : "");
  } catch (error) {
    if (disposed || version !== shortcutVersion) return;
    if (!shortcutLoaded) $("shortcut-current").textContent = "Unavailable";
    showShortcutError(error.message);
  } finally {
    if (!disposed && version === shortcutVersion) {
      setShortcutBusy(false);
      if (focusAfterSave && !$("settings").hidden) $(focusTarget).focus();
    }
  }
}

$("settings-open").addEventListener("click", () => {
  closeShortcutEditor();
  $("search-view").hidden = true;
  $("settings").hidden = false;
  $("settings-close").focus();
  void shortcutOperation(() => shortcuts.read());
});
function closePreferences() {
  shortcutVersion += 1;
  shortcutBusy = false;
  closeShortcutEditor();
  $("settings").hidden = true;
  $("search-view").hidden = false;
  if (!disposed) input.focus();
}
$("settings-close").addEventListener("click", closePreferences);
$("shortcut-edit").addEventListener("click", () => {
  stagedShortcut = "";
  $("shortcut-row").dataset.editing = "true";
  $("shortcut-current").hidden = true;
  $("shortcut-input").hidden = false;
  $("shortcut-input").value = "";
  showShortcutError();
  showShortcutStatus();
  setShortcutBusy(false);
  $("shortcut-input").focus();
});
$("shortcut-input").addEventListener("keydown", (event) => {
  if (shortcutBusy) return;
  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && stagedShortcut) {
    event.preventDefault();
    event.stopPropagation();
    commitShortcut();
    return;
  }
  const result = captureShortcut(event, { isMac });
  if (result.type === "leave") return;
  event.preventDefault();
  event.stopPropagation();
  if (result.type === "ignore") return;
  if (result.type === "cancel") { closeShortcutEditor(true); return; }
  stagedShortcut = result.type === "shortcut" ? result.shortcut : "";
  $("shortcut-input").value = result.type === "shortcut" ? result.display : "";
  showShortcutError(result.type === "invalid" ? result.message : "");
  setShortcutBusy(false);
}, true);
function commitShortcut() {
  if (shortcutBusy || !stagedShortcut || $("shortcut-input").hidden) return;
  if (formatShortcut(stagedShortcut, { isMac }) === formatShortcut(currentShortcut, { isMac })) closeShortcutEditor(true);
  else void shortcutOperation(() => shortcuts.save(stagedShortcut), "Shortcut saved.");
}
$("shortcut-input").addEventListener("keyup", (event) => {
  if ($("shortcut-input").hidden) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) commitShortcut();
}, true);
$("shortcut-cancel").addEventListener("click", () => closeShortcutEditor(true));
$("shortcut-clear").addEventListener("click", () => { void shortcutOperation(() => shortcuts.clear(), "Shortcut cleared.", "shortcut-reset"); });
$("shortcut-reset").addEventListener("click", () => { void shortcutOperation(() => shortcuts.reset(), "Default shortcut restored.", "shortcut-clear"); });
$("settings").addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  event.preventDefault();
  event.stopPropagation();
  if (shortcutBusy) return;
  if (!$("shortcut-input").hidden) closeShortcutEditor(true);
  else closePreferences();
});

async function initialize() {
  input.focus();
  requestAnimationFrame(() => {
    if (document.activeElement === document.body || document.activeElement === input) {
      input.focus();
    }
  });
  render();
  if (preview) {
    const { previewTabs, previewHistory, previewSelf } = await import("./preview.js");
    historySearch = createHistorySearch({ async search() { return previewHistory; } });
    requestHistory();
    state.tabs = previewTabs;
    void faviconCache.remember(previewTabs);
    state.self = { windowId: previewSelf.windowId };
    $("below-palette").textContent = "Preview · example tabs and history";
    state.ready = true;
    render();
    return;
  }
  try {
    controller = createPopupController(api);
    // Remove the obsolete engine override; Firefox owns search-engine choice.
    void Promise.resolve().then(() => api.storage?.local?.remove?.("searchEngine")).catch(() => {});
    const result = await controller.initialize();
    if (disposed) return;
    state.tabs = result.tabs;
    state.self = { windowId: result.context.windowId };
    historySearch = typeof api.history?.search === "function" ? createHistorySearch(api.history) : null;
    requestHistory();
    for (const [event, listener] of [
      [api.history?.onVisited, () => requestHistory({ clear: false })],
      [api.history?.onVisitRemoved, () => { requestHistory(); render(true); }],
    ]) {
      if (!event?.addListener) continue;
      event.addListener(listener);
      historyRemovers.push(() => event.removeListener(listener));
    }
    faviconCache = createFaviconCache(api.storage?.local, { persist: !result.context.incognito });
    state.ready = true;
    void faviconCache.load().then(() => {
      if (disposed) return;
      void faviconCache.remember(state.tabs);
      updateFavicons();
    });
    controller.subscribe(() => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 70); });
    render();
  } catch (error) {
    list.setAttribute("aria-busy", "false");
    $("empty-state").textContent = "Your tabs could not be loaded. Close and reopen the popup to try again.";
    showError(error.message);
  }
}

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  disposed = true;
  clearTimeout(refreshTimer);
  clearTimeout(announceTimer);
  controller?.dispose();
  historySearch?.dispose();
  for (const remove of historyRemovers) remove();
});
window.addEventListener("pageshow", (event) => { if (event.persisted && controller) void refresh(); });
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !event.defaultPrevented && $("settings").hidden && !preview) {
    event.preventDefault();
    if (state.busy) { announce("Opening your destination. Please wait."); return; }
    void closePopup();
  }
});
void initialize();

import { getTabDisplay, rankTabs, resolveInput } from "./core.js";
import { createTabController } from "./tabs.js";

const $ = (id) => document.getElementById(id);
const input = $("query");
const list = $("results");
const api = globalThis.browser;
const preview = !api?.runtime?.id;
const state = { tabs: [], self: null, rows: [], selected: 0, busy: false, ready: false, engine: "" };
let controller;
let refreshTimer;
let refreshVersion = 0;
let announceTimer;
let disposed = false;
let preferenceLoad = Promise.resolve();
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$("force-key").textContent = isMac ? "⌘" : "Ctrl";

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
  path.setAttribute("d", kind === "url" ? "M14 4h6v6M20 4 10 14M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5" : "m16 16 5 5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0");
  svg.append(path);
  return svg;
}

function makeRow(row, index) {
  const el = document.createElement("div");
  el.id = `result-${index}`;
  el.className = `result${row.type !== "tab" ? " action-result" : ""}`;
  el.setAttribute("role", "option");
  el.setAttribute("aria-selected", String(index === state.selected));
  el.dataset.index = String(index);
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

  if (row.type === "tab") {
    const display = getTabDisplay(row.tab);
    title.textContent = display.title;
    description.textContent = display.label;
    siteIcon.textContent = display.hostname.replace(/^www\./, "").charAt(0).toUpperCase() || "↗";
    const hue = [...display.hostname].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 5;
    siteIcon.dataset.tone = String(hue);
    metaLabel.textContent = row.tab.discarded ? "Sleeping tab" : row.tab.pinned ? "Pinned tab" : "Switch to tab";
  } else {
    const target = row.target;
    siteIcon.append(icon(target.type));
    title.textContent = target.type === "url" ? `Open ${target.label}` : target.type === "invalid" ? "Check this address" : `Search for “${target.query}”`;
    description.textContent = target.type === "url" ? "Navigate in this tab" : target.type === "invalid" ? target.message : `Search the web · ${state.engine || "Firefox default"}`;
    metaLabel.textContent = `${isMac ? "⌘" : "Ctrl"} ↵`;
  }
  copy.append(title, description);
  meta.append(metaLabel, arrow);
  el.append(siteIcon, copy, meta);
  return el;
}

function setSelection(index, scroll = false) {
  state.selected = state.rows.length ? (index + state.rows.length) % state.rows.length : -1;
  for (const [i, child] of [...list.children].entries()) child.setAttribute("aria-selected", String(i === state.selected));
  const selected = state.rows[state.selected];
  if (selected) {
    input.setAttribute("aria-activedescendant", `result-${state.selected}`);
    $("enter-action").textContent = selected.type === "tab" ? "Switch to tab" : selected.target.type === "url" ? "Open address" : selected.target.type === "invalid" ? "Check address" : "Search the web";
    if (scroll) list.children[state.selected]?.scrollIntoView({ block: "nearest" });
  } else {
    input.removeAttribute("aria-activedescendant");
    $("enter-action").textContent = "Type to begin";
  }
}

function render(preserveSelection = false) {
  const previousKey = preserveSelection ? state.rows[state.selected]?.key : undefined;
  const query = input.value.trim();
  const allMatches = rankTabs(state.tabs, query, { excludeTabId: state.self?.id, windowId: state.self?.windowId, limit: Number.MAX_SAFE_INTEGER });
  const matches = allMatches.slice(0, query ? 7 : 6);
  state.rows = matches.map((tab) => ({ type: "tab", tab, key: `tab-${tab.id}` }));
  const target = resolveInput(query);
  if (target.type !== "empty") state.rows.push({ type: "action", target, key: "action" });
  const previousIndex = previousKey ? state.rows.findIndex((row) => row.key === previousKey) : -1;
  state.selected = previousIndex >= 0 ? previousIndex : 0;
  list.replaceChildren(...state.rows.map(makeRow));
  list.setAttribute("aria-busy", String(state.busy || !state.ready));
  input.setAttribute("aria-expanded", String(state.rows.length > 0));
  $("results-label").firstChild.textContent = query ? "MATCHING TABS " : "OPEN TABS ";
  $("count").textContent = String(allMatches.length);
  $("scope-label").textContent = allMatches.length > matches.length ? `Showing ${matches.length} of ${allMatches.length}` : "This window";
  $("clear").hidden = !input.value;
  $("empty-state").hidden = state.rows.length > 0;
  $("empty-state").textContent = state.ready ? "No open tabs yet. Type an address or a search to begin." : "Finding your open tabs…";
  setSelection(state.selected);
  const actionAnnouncement = target.type === "invalid" ? target.message : `${target.type === "url" ? "Open address" : "Web search"} also available.`;
  announce(query ? `${allMatches.length} matching tabs. ${actionAnnouncement}` : `${allMatches.length} open tabs in this window.`);
}

async function refresh() {
  const version = ++refreshVersion;
  try {
    const tabs = await controller.refresh();
    if (!disposed && version === refreshVersion) {
      state.tabs = tabs;
      render(true);
    }
  } catch (error) {
    if (!disposed) showError(error.message);
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
    showError("This is a visual preview with example tabs. Load manifest.json in Firefox to switch tabs, navigate, and search.");
    return;
  }
  state.busy = true;
  list.setAttribute("aria-busy", "true");
  try {
    if (row.type === "tab") {
      const result = await controller.switchTo(row.tab.id);
      if (result.warning) showError(result.warning);
    } else if (row.target.type === "url") {
      await controller.navigate(row.target.url);
    } else {
      await preferenceLoad;
      await controller.search(row.target.query, state.engine || undefined);
    }
  } catch (error) {
    showError(error.message || "Something went wrong. Your search tab has been kept open.");
    await refresh();
  } finally {
    state.busy = false;
    list.setAttribute("aria-busy", "false");
  }
}

input.addEventListener("input", () => { showError(""); render(); });
input.addEventListener("keydown", (event) => {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    setSelection(state.selected + (event.key === "ArrowDown" ? 1 : -1), true);
  } else if (event.key === "Enter") {
    event.preventDefault();
    void choose(event.metaKey || event.ctrlKey);
  } else if (event.key === "Escape") {
    event.preventDefault();
    input.value = "";
    showError("");
    render();
  }
});
list.addEventListener("mousedown", (event) => { if (event.target.closest("[role=option]")) event.preventDefault(); });
list.addEventListener("click", (event) => {
  const row = event.target.closest("[role=option]");
  if (!row || state.busy) return;
  setSelection(Number(row.dataset.index));
  void choose();
});
$("clear").addEventListener("click", () => { input.value = ""; showError(""); render(); input.focus(); });
$("settings-open").addEventListener("click", () => $("settings").showModal());
$("settings-close").addEventListener("click", () => $("settings").close());
$("settings").addEventListener("close", () => input.focus());
$("settings").addEventListener("click", (event) => { if (event.target === $("settings")) {
  const rect = $("settings").getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $("settings").close();
} });
$("engine").addEventListener("change", async () => {
  const nextEngine = $("engine").value;
  try {
    if (!preview) await api.storage.local.set({ searchEngine: nextEngine });
    state.engine = nextEngine;
    $("save-status").textContent = preview ? "Preview preference updated for this page." : "Saved on this device.";
    render(true);
  } catch {
    $("engine").value = state.engine;
    $("save-status").textContent = "Could not save your preference. Please try again.";
  }
});

async function loadPreferences() {
  if (preview) return;
  const results = await Promise.allSettled([api.search.get(), api.storage.local.get("searchEngine")]);
  const engines = results[0].status === "fulfilled" ? results[0].value : [];
  for (const engine of engines) {
    const option = document.createElement("option");
    option.value = engine.name;
    option.textContent = engine.name;
    $("engine").append(option);
  }
  const saved = results[1].status === "fulfilled" ? results[1].value.searchEngine : "";
  state.engine = typeof saved === "string" && engines.some((engine) => engine.name === saved) ? saved : "";
  $("engine").value = state.engine;
  if (results.some((result) => result.status === "rejected")) $("save-status").textContent = "Some preferences could not load. Firefox default search is available.";
  if (!disposed) render(true);
}

async function initialize() {
  input.focus();
  requestAnimationFrame(() => { if (document.activeElement === document.body || document.activeElement === input) input.focus(); });
  render();
  if (preview) {
    const { previewTabs, previewSelf } = await import("./preview.js");
    state.tabs = previewTabs;
    state.self = previewSelf;
    $("window-label").lastChild.textContent = "Preview · example tabs";
    $("below-palette").textContent = "Visual preview · Load the extension in Firefox to make it yours.";
    state.ready = true;
    render();
    return;
  }
  controller = createTabController(api, location.href);
  preferenceLoad = loadPreferences();
  try {
    const result = await controller.initialize();
    if (disposed) return;
    state.tabs = result.tabs;
    state.self = result.self;
    state.ready = true;
    controller.subscribe(() => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refresh, 70); });
    render();
    await preferenceLoad;
  } catch (error) {
    list.setAttribute("aria-busy", "false");
    $("empty-state").textContent = "Your tabs could not be loaded. Reload this page to try again.";
    showError(error.message);
  }
}

window.addEventListener("pagehide", (event) => {
  if (event.persisted) return;
  disposed = true;
  clearTimeout(refreshTimer);
  clearTimeout(announceTimer);
  controller?.dispose();
});
window.addEventListener("pageshow", (event) => { if (event.persisted && controller) void refresh(); });
void initialize();

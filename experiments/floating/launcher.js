/** Owns the extension's floating launcher window, never a normal browsing window. */
export function createLauncher(api) {
  const launcherURL = api.runtime.getURL("popup.html");
  let launcherWindowId = null;
  let pending = null;
  let disposed = false;

  function launcherTab(window) {
    return window?.tabs?.find((tab) => typeof tab.url === "string"
      && tab.url.split(/[?#]/, 1)[0] === launcherURL);
  }

  function isLauncher(window) {
    return window?.type === "popup"
      && Number.isInteger(window.id)
      && Boolean(launcherTab(window));
  }

  function hasParent(window, parent) {
    const parameters = new URL(launcherTab(window).url).searchParams;
    return parameters.getAll("windowId").length === 1
      && parameters.get("windowId") === String(parent.id);
  }

  function ensureActive() {
    if (disposed) throw new Error("The launcher has been disposed.");
  }

  async function findLauncher() {
    if (launcherWindowId !== null) {
      try {
        const known = await api.windows.get(launcherWindowId, { populate: true });
        if (isLauncher(known)) return known;
      } catch {
        // A launcher can close while the background page is idle.
      }
      launcherWindowId = null;
    }

    // Recover ownership after Firefox has unloaded/restarted the background page.
    const windows = await api.windows.getAll({ populate: true, windowTypes: ["popup"] });
    const existing = windows.find((window) => isLauncher(window) && window.focused)
      ?? windows.find(isLauncher);
    if (existing) launcherWindowId = existing.id;
    return existing;
  }

  async function findParent(sourceTab) {
    if (Number.isInteger(sourceTab?.windowId)) {
      try {
        const source = await api.windows.get(sourceTab.windowId);
        if (source.type === "normal" && Number.isInteger(source.id)) return source;
      } catch {
        // The invoking tab/window may have closed before the command was handled.
      }
    }
    const parent = await api.windows.getLastFocused({ windowTypes: ["normal"] });
    if (!parent || parent.type !== "normal" || !Number.isInteger(parent.id)) {
      throw new Error("Open a Firefox browsing window before opening Search or Switch.");
    }
    return parent;
  }

  async function openOnce(sourceTab) {
    const existing = await findLauncher();
    ensureActive();
    if (existing?.focused) {
      await api.windows.remove(existing.id);
      launcherWindowId = null;
      return { action: "closed", windowId: existing.id };
    }
    const parent = await findParent(sourceTab);
    ensureActive();
    if (existing) {
      if (hasParent(existing, parent)) {
        await api.windows.update(existing.id, { focused: true });
        return { action: "focused", windowId: existing.id };
      }
      // Reusing a launcher from another window would keep stale tab/search context.
      // Only this extension-owned popup is replaced; normal browsing windows stay intact.
      await api.windows.remove(existing.id);
      launcherWindowId = null;
      ensureActive();
    }

    const parentWidth = dimension(parent.width, 600);
    const parentHeight = dimension(parent.height, 520);
    const width = Math.min(600, parentWidth);
    const height = Math.min(520, parentHeight);
    const created = await api.windows.create({
      url: `${launcherURL}?windowId=${parent.id}`,
      type: "popup",
      width,
      height,
      // Negative positions are valid for monitors to the left/above the primary one.
      left: Math.round(coordinate(parent.left) + (parentWidth - width) / 2),
      top: Math.round(coordinate(parent.top) + (parentHeight - height) / 2),
      focused: true,
      incognito: Boolean(parent.incognito),
    });
    launcherWindowId = created.id;
    return { action: "created", windowId: created.id };
  }

  function onRemoved(windowId) {
    if (windowId === launcherWindowId) launcherWindowId = null;
  }
  api.windows.onRemoved?.addListener(onRemoved);

  function open(sourceTab) {
    if (disposed) return Promise.reject(new Error("The launcher has been disposed."));
    // Repeated commands during lookup/creation share one operation instead of toggling it.
    if (pending) return pending;
    pending = openOnce(sourceTab).finally(() => { pending = null; });
    return pending;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    api.windows.onRemoved?.removeListener(onRemoved);
  }

  return { open, dispose };
}

function dimension(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.max(1, Math.round(value)) : fallback;
}

function coordinate(value) {
  return Number.isFinite(value) ? value : 0;
}

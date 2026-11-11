const REUSABLE_NEW_TAB_URLS = new Set(["about:newtab", "about:home"]);

/** Firefox operations for the native popup. Existing tabs are never owned or removed. */
export function createPopupController(api) {
  let context;
  let initializing;
  let disposed = false;
  let busy = false;
  let reuseAvailable = false;
  let knownIds = new Set();
  const subscribers = new Set();
  const eventRemovers = [];

  function assertAvailable() {
    if (disposed) throw new Error("This popup has closed. Open Search or Switch again to continue.");
    if (!api?.tabs) throw new Error("Open Search or Switch through the Firefox extension to access your tabs.");
  }

  function assertReady() {
    assertAvailable();
    if (!context) throw new Error("Your tabs are still loading. Please try again.");
  }

  function emit(type, tabId) {
    if (disposed) return;
    for (const listener of subscribers) listener({ type, tabId });
  }

  function listen(event, listener) {
    if (!event?.addListener) return;
    event.addListener(listener);
    eventRemovers.push(() => event.removeListener(listener));
  }

  function attachEvents() {
    listen(api.tabs.onCreated, (tab) => {
      if (tab.windowId === context.windowId) emit("created", tab.id);
    });
    listen(api.tabs.onUpdated, (tabId, changes, tab) => {
      if (tabId === context.id && ("url" in changes || changes.status === "loading" || changes.pinned === true)) {
        reuseAvailable = false;
      }
      if (tab.windowId === context.windowId) emit("updated", tabId);
    });
    listen(api.tabs.onRemoved, (tabId, info) => {
      if (tabId === context.id) reuseAvailable = false;
      if (info.windowId === context.windowId) emit("removed", tabId);
    });
    listen(api.tabs.onActivated, (info) => {
      if (info.windowId === context.windowId && info.tabId !== context.id) reuseAvailable = false;
      if (info.windowId === context.windowId) emit("activated", info.tabId);
    });
    listen(api.tabs.onMoved, (tabId, info) => {
      if (tabId === context.id) reuseAvailable = false;
      if (info.windowId === context.windowId) emit("moved", tabId);
    });
    listen(api.tabs.onAttached, (tabId, info) => {
      if (tabId === context.id) reuseAvailable = false;
      if (info.newWindowId === context.windowId) emit("attached", tabId);
    });
    listen(api.tabs.onDetached, (tabId, info) => {
      if (tabId === context.id) reuseAvailable = false;
      if (info.oldWindowId === context.windowId) emit("detached", tabId);
    });
    listen(api.tabs.onReplaced, (addedId, removedId) => {
      if (removedId === context.id) reuseAvailable = false;
      if (knownIds.has(removedId)) emit("replaced", addedId);
    });
  }

  async function refresh() {
    assertReady();
    let tabs;
    try {
      tabs = await api.tabs.query({ windowId: context.windowId });
    } catch {
      throw new Error("Firefox could not load this window's tabs. Open the popup again to retry.");
    }
    assertReady();
    if (!tabs.length) throw new Error("This Firefox window is no longer available. Open Search or Switch in another window.");
    knownIds = new Set(tabs.map((tab) => tab.id));
    return tabs;
  }

  async function initialize() {
    assertAvailable();
    if (!initializing) {
      initializing = (async () => {
        let activeTabs;
        try {
          activeTabs = await api.tabs.query({ active: true, currentWindow: true });
        } catch {
          throw new Error("Firefox could not identify the original browser window. Open Search or Switch again to retry.");
        }
        assertAvailable();
        const active = activeTabs[0];
        if (!Number.isInteger(active?.id) || active.id < 0 || !Number.isInteger(active?.windowId) || active.windowId < 0) {
          throw new Error("The original browser window is no longer available. Open Search or Switch from a Firefox browser window.");
        }
        context = { ...active };
        reuseAvailable = isReusableNewTab(context);
        attachEvents();
        return { context: { ...context }, tabs: await refresh() };
      })();
    }
    return initializing;
  }

  async function exclusively(action) {
    assertReady();
    if (busy) throw new Error("Another action is already in progress. Please wait a moment.");
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
  }

  async function existingTab(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) throw new Error("Choose an open tab to switch to.");
    let tab;
    try {
      tab = await api.tabs.get(tabId);
    } catch {
      throw new Error("That tab has closed. Choose another result.");
    }
    if (tab.windowId !== context.windowId) throw new Error("That tab moved to another window. Choose a tab in this window.");
    return tab;
  }

  async function switchTo(tabId) {
    return exclusively(async () => {
      await existingTab(tabId);
      assertReady();
      try {
        await api.tabs.update(tabId, { active: true });
      } catch {
        throw new Error("Firefox could not activate that tab. Choose another result or try again.");
      }
      const activated = await existingTab(tabId);
      if (!activated.active) throw new Error("That tab could not be activated. Please try again.");
      return activated;
    });
  }

  async function reusableContextTab() {
    if (!reuseAvailable) return null;
    let current;
    try {
      current = await api.tabs.get(context.id);
    } catch {
      reuseAvailable = false;
      return null;
    }
    assertReady();
    if (!reuseAvailable || current.id !== context.id || current.windowId !== context.windowId ||
      current.url !== context.url || !isReusableNewTab(current)) {
      reuseAvailable = false;
      return null;
    }
    return current;
  }

  async function navigate(url) {
    return exclusively(async () => {
      let destination;
      try {
        destination = new URL(url);
      } catch {
        throw new Error("Enter a valid web address to continue.");
      }
      if (!["https:", "http:"].includes(destination.protocol) || destination.username || destination.password) {
        throw new Error("Only HTTP and HTTPS web addresses without embedded passwords can be opened.");
      }
      const reusable = await reusableContextTab();
      assertReady();
      if (reusable && reuseAvailable) {
        reuseAvailable = false;
        try {
          return await api.tabs.update(reusable.id, { url: destination.href });
        } catch {
          // A rejected mutation can still have started a navigation. Never
          // remove this pre-existing tab or create a second destination here.
          throw new Error("Firefox could not open that address in the current tab. Any loaded page has been kept open.");
        }
      }
      try {
        return await api.tabs.create({ url: destination.href, active: true, windowId: context.windowId });
      } catch {
        throw new Error("Firefox could not open that address in a new tab. Please try again.");
      }
    });
  }

  // A failed search may leave the tab we created behind. Remove it only while
  // it is still our untouched blank tab; never discard results or user changes.
  async function removeOwnedBlank(tabId) {
    try {
      const tab = await api.tabs.get(tabId);
      if (tab.windowId === context.windowId && isUntouchedBlank(tab)) await api.tabs.remove(tabId);
    } catch {
      // A vanished tab or failed cleanup must not replace the original error.
    }
  }

  async function search(query) {
    return exclusively(async () => {
      if (typeof query !== "string" || !query.trim()) throw new Error("Enter something to search for.");
      if (!api.search?.search) throw new Error("Firefox search is unavailable. Check the extension's search permission.");
      const reusable = await reusableContextTab();
      assertReady();
      if (reusable && reuseAvailable) {
        reuseAvailable = false;
        try {
          await api.search.search({ query: query.trim(), tabId: reusable.id });
          return await existingTab(reusable.id);
        } catch {
          // Reused tabs existed before the popup opened and are never owned
          // by the failed-search cleanup below, even if they still look blank.
          throw new Error("Firefox could not complete this search in the current tab. Any loaded page has been kept open.");
        }
      }
      let created;
      let phase = "creating";
      try {
        created = await api.tabs.create({ url: "about:blank", active: false, windowId: context.windowId });
        if (!Number.isInteger(created?.id) || created.id < 0) throw new Error("Missing search tab identity");
        phase = "searching";
        const destination = await existingTab(created.id);
        if (!isUntouchedBlank(destination)) throw new Error("The new search tab changed before searching");
        assertReady();
        await api.search.search({ query: query.trim(), tabId: created.id });
        phase = "activating";
        await existingTab(created.id);
        await api.tabs.update(created.id, { active: true });
        const activated = await existingTab(created.id);
        if (!activated.active) throw new Error("Search tab was not activated");
        return activated;
      } catch {
        if (Number.isInteger(created?.id) && created.id >= 0) await removeOwnedBlank(created.id);
        if (phase === "creating") throw new Error("Firefox could not create a search tab. Please try again.");
        if (phase === "activating") throw new Error("Firefox could not activate the search tab. Any loaded results have been kept open.");
        throw new Error("Firefox could not complete this search. Please try again.");
      }
    });
  }

  function subscribe(listener) {
    assertAvailable();
    if (typeof listener !== "function") throw new TypeError("A tab change listener must be a function.");
    subscribers.add(listener);
    return () => subscribers.delete(listener);
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    for (const remove of eventRemovers) remove();
    subscribers.clear();
  }

  return { initialize, refresh, switchTo, navigate, search, subscribe, dispose };
}

function isUntouchedBlank(tab) {
  return tab.url === "about:blank" && (!tab.pendingUrl || tab.pendingUrl === "about:blank");
}

function isReusableNewTab(tab) {
  // about:blank may contain script-written content. Firefox also lacks
  // Tab.pendingUrl, so a completed load is required in addition to the URL.
  return REUSABLE_NEW_TAB_URLS.has(tab.url) && tab.status === "complete" &&
    tab.active === true && !tab.pinned && !tab.pendingUrl;
}

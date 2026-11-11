/**
 * The page owns one tab, identified by getCurrent(), never by the active tab.
 * Keep all destructive operations here so UI events cannot accidentally close
 * a different tab after the user changes focus or a destination disappears.
 */
export function createTabController(api, pageUrl) {
  const expectedPage = pageIdentity(pageUrl);
  let self;
  let initializing;
  let disposed = false;
  let busy = false;
  let sourceInvalid = false;
  let knownIds = new Set();
  const subscribers = new Set();
  const eventRemovers = [];

  function assertAvailable() {
    if (disposed) throw new Error("This search page is no longer active. Reload it to continue.");
    if (!api?.tabs) throw new Error("Open this page through the Firefox extension to access your tabs.");
  }

  function assertInitialized() {
    assertAvailable();
    if (!self) throw new Error("Your tabs are still loading. Please try again.");
    if (sourceInvalid) throw new Error("This search tab changed. Reload it to continue.");
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
      if (tab.windowId === self.windowId) emit("created", tab.id);
    });
    listen(api.tabs.onUpdated, (tabId, changes, tab) => {
      if (tabId === self.id && changes.url && pageIdentity(changes.url) !== expectedPage) {
        sourceInvalid = true;
      }
      if (tab.windowId === self.windowId) emit("updated", tabId);
    });
    listen(api.tabs.onRemoved, (tabId, info) => {
      if (tabId === self.id) sourceInvalid = true;
      if (info.windowId === self.windowId) emit("removed", tabId);
    });
    listen(api.tabs.onActivated, (info) => {
      if (info.windowId === self.windowId) emit("activated", info.tabId);
    });
    listen(api.tabs.onMoved, (tabId, info) => {
      if (info.windowId === self.windowId) emit("moved", tabId);
    });
    listen(api.tabs.onAttached, (tabId, info) => {
      if (info.newWindowId === self.windowId) emit("attached", tabId);
    });
    listen(api.tabs.onDetached, (tabId, info) => {
      if (tabId === self.id) sourceInvalid = true;
      if (info.oldWindowId === self.windowId) emit("detached", tabId);
    });
    listen(api.tabs.onReplaced, (addedId, removedId) => {
      if (removedId === self.id) sourceInvalid = true;
      if (knownIds.has(removedId)) emit("replaced", addedId);
    });
  }

  async function ownedSource(requireActive = false) {
    assertInitialized();
    let tab;
    try {
      tab = await api.tabs.get(self.id);
    } catch {
      throw new Error("This search tab is no longer available. Open a new tab to continue.");
    }
    assertInitialized();
    if (
      tab.id !== self.id ||
      tab.windowId !== self.windowId ||
      pageIdentity(tab.url) !== expectedPage ||
      (tab.pendingUrl && pageIdentity(tab.pendingUrl) !== expectedPage)
    ) {
      throw new Error("This search tab changed. Reload it before choosing a destination.");
    }
    if (requireActive && !tab.active) {
      throw new Error("Return to this search tab before choosing a destination.");
    }
    return tab;
  }

  async function targetTab(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0 || tabId === self.id) {
      throw new Error("Choose another open tab to switch to.");
    }
    let target;
    try {
      target = await api.tabs.get(tabId);
    } catch {
      throw new Error("That tab has closed. Choose another result.");
    }
    if (target.windowId !== self.windowId) {
      throw new Error("That tab moved to another window. Choose a tab in this window.");
    }
    return target;
  }

  async function exclusively(action) {
    assertInitialized();
    if (busy) throw new Error("Another action is already in progress. Please wait a moment.");
    busy = true;
    try {
      return await action();
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    assertInitialized();
    try {
      const tabs = await api.tabs.query({ windowId: self.windowId });
      assertInitialized();
      knownIds = new Set(tabs.map((tab) => tab.id));
      return tabs;
    } catch (error) {
      if (disposed || sourceInvalid) throw error;
      throw new Error("Firefox could not load your open tabs. Please try again.");
    }
  }

  async function initialize() {
    assertAvailable();
    if (!initializing) {
      initializing = (async () => {
        let current;
        try {
          current = await api.tabs.getCurrent();
        } catch {
          throw new Error("Firefox could not identify this search tab. Reload it to try again.");
        }
        assertAvailable();
        if (
          !Number.isInteger(current?.id) || current.id < 0 ||
          !Number.isInteger(current?.windowId) || current.windowId < 0 ||
          !expectedPage || pageIdentity(current.url) !== expectedPage
        ) {
          throw new Error("Open a new Firefox tab to use Search or Switch.");
        }
        self = { ...current };
        attachEvents();
        return { self: { ...self }, tabs: await refresh() };
      })();
    }
    return initializing;
  }

  async function switchTo(tabId) {
    return exclusively(async () => {
      await ownedSource(true);
      await targetTab(tabId);
      // Target lookup may be slow; check focus again immediately before acting.
      await ownedSource(true);
      try {
        await api.tabs.update(tabId, { active: true });
      } catch {
        throw new Error("Firefox could not activate that tab. Your search tab has been kept open.");
      }
      const activated = await targetTab(tabId);
      if (!activated.active) {
        throw new Error("That tab could not be activated. Your search tab has been kept open.");
      }

      let source;
      try {
        source = await ownedSource();
      } catch {
        return { closed: false, warning: "Switched tabs. The search tab changed, so it was kept open." };
      }
      if (source.active) {
        return { closed: false, warning: "The search tab became active again, so it was kept open." };
      }
      // Confirm once more after checking the source. A result may have closed
      // or moved while its activation was being processed.
      const finalTarget = await targetTab(tabId);
      if (!finalTarget.active) {
        throw new Error("The destination changed before switching finished. Your search tab has been kept open.");
      }
      assertInitialized();
      try {
        await api.tabs.remove(self.id);
      } catch {
        return { closed: false, warning: "Switched tabs, but Firefox could not close the search tab. You can close it manually." };
      }
      return { closed: true };
    });
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
      const source = await ownedSource(true);
      try {
        await api.tabs.update(source.id, { url: destination.href, loadReplace: true });
      } catch {
        throw new Error("Firefox could not open that address. Your search tab has been kept open.");
      }
    });
  }

  async function search(query, engine) {
    return exclusively(async () => {
      if (typeof query !== "string" || !query.trim()) throw new Error("Enter something to search for.");
      if (!api.search?.search) throw new Error("Firefox search is unavailable. Check the extension's search permission.");
      const source = await ownedSource(true);
      const properties = { query: query.trim(), tabId: source.id };
      if (typeof engine === "string" && engine.trim()) properties.engine = engine.trim();
      try {
        await api.search.search(properties);
      } catch {
        throw new Error("Firefox could not complete this search. Try again or choose another search engine.");
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

function pageIdentity(value) {
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

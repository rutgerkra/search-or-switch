import { createPopupController } from "./popup-tabs.js";

/** Bind each sidebar instance to its own browser window, regardless of focus. */
export function createSidebarController(api) {
  let controller;
  let initializing;
  let disposed = false;
  const listeners = new Set();

  function assertActive() {
    if (disposed) throw new Error("This sidebar has closed. Reopen Search or Switch to continue.");
  }

  async function initialize() {
    assertActive();
    if (!initializing) {
      initializing = (async () => {
        let ownWindow;
        try {
          // In a sidebar document Firefox returns that document's window, even
          // when a different browser window currently has keyboard focus.
          ownWindow = await api.windows.getCurrent();
        } catch {
          throw new Error("Firefox could not identify this sidebar's window. Close and reopen Search or Switch to retry.");
        }
        assertActive();
        if (!Number.isInteger(ownWindow?.id) || ownWindow.id < 0 || ownWindow.type !== "normal") {
          throw new Error("Open the Search or Switch sidebar in a Firefox browser window.");
        }
        controller = createPopupController(api, { windowId: ownWindow.id });
        for (const entry of listeners) entry.unsubscribe = controller.subscribe(entry.listener);
        return controller.initialize();
      })();
    }
    return initializing;
  }

  async function forward(method, args) {
    assertActive();
    if (!controller) throw new Error("This sidebar is still loading. Please try again.");
    return controller[method](...args);
  }

  function subscribe(listener) {
    assertActive();
    if (typeof listener !== "function") throw new TypeError("A tab change listener must be a function.");
    const entry = { listener, unsubscribe: controller?.subscribe(listener) };
    listeners.add(entry);
    return () => {
      entry.unsubscribe?.();
      listeners.delete(entry);
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    controller?.dispose();
    listeners.clear();
  }

  return {
    initialize,
    refresh: (...args) => forward("refresh", args),
    switchTo: (...args) => forward("switchTo", args),
    navigate: (...args) => forward("navigate", args),
    search: (...args) => forward("search", args),
    subscribe,
    dispose,
  };
}

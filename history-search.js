/** Debounced, read-only Firefox history lookup. Superseded work never reaches the UI. */
export function createHistorySearch(history, { delay = 120 } = {}) {
  let active;
  let disposed = false;

  function cancel() {
    if (!active) return;
    clearTimeout(active.timer);
    active.resolve(null);
    active = undefined;
  }

  function search(value) {
    cancel();
    const query = String(value ?? "").trim();
    if (disposed || !query) return Promise.resolve(null);
    return new Promise((resolve) => {
      const request = { resolve };
      active = request;
      request.timer = setTimeout(async () => {
        let result;
        try {
          const items = await history.search({ text: query, startTime: 0, maxResults: 100 });
          result = { query, items: Array.isArray(items) ? items : [] };
        } catch {
          result = { query, items: [], unavailable: true };
        }
        if (active !== request || disposed) return;
        active = undefined;
        resolve(result);
      }, delay);
    });
  }

  return { search, dispose() { disposed = true; cancel(); } };
}

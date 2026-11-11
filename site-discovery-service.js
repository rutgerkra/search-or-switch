import { createDiscoveredSite, parseOpenSearch, SITE_SEARCH_PERMISSIONS } from "./site-search.js";

const STORAGE_KEY = "siteSearchDiscoveryV1";
const MAX_SITES = 128;
const MAX_DESCRIPTION_SIZE = 256 * 1024;
const FETCH_TIMEOUT = 8000;

function metadataURL(value) {
  if (typeof value !== "string" || value.length > 4096) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) return null;
    return url;
  } catch { return null; }
}

function validatedSite(record) {
  try { return createDiscoveredSite(record); }
  catch { return null; }
}

function normalPage(tab) {
  if (!tab || tab.incognito || !Number.isInteger(tab.id) || tab.status !== "complete") return false;
  try {
    const url = new URL(tab.url);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
}

/** Owns the optional, local learned-site catalog independently of a popup. */
export function createSiteSearchService(api, { fetch: fetchMetadata = globalThis.fetch } = {}) {
  let disposed = false;
  let enabled = true;
  let learned = [];
  let loading;
  let started = false;
  let generation = 0;
  let preferenceRevision = 0;
  let writes = Promise.resolve();
  const removers = [];
  const requests = new Set();

  function invalidate() {
    generation += 1;
    for (const request of requests) request.abort();
    requests.clear();
  }

  function load() {
    if (!loading) loading = (async () => {
      try {
        const stored = (await api?.storage?.local?.get?.(STORAGE_KEY))?.[STORAGE_KEY];
        enabled = stored?.enabled !== false;
        const unique = new Map();
        for (const record of Array.isArray(stored?.learned) ? stored.learned : []) {
          const site = validatedSite(record);
          if (site) unique.set(site.origin, site);
        }
        learned = [...unique.values()].slice(-MAX_SITES);
      }
      catch { /* An unavailable local catalog must not block ordinary search. */ }
    })();
    return loading;
  }

  async function hasAccess() {
    try { return !disposed && await api?.permissions?.contains?.(SITE_SEARCH_PERMISSIONS) === true; }
    catch { return false; }
  }

  function save() {
    const snapshot = { enabled, learned: learned.map((site) => ({ ...site })) };
    const operation = writes.then(async () => {
      try { await api?.storage?.local?.set?.({ [STORAGE_KEY]: snapshot }); }
      catch { throw new Error("Firefox could not save site-discovery preferences. Try again."); }
      try { await api?.runtime?.sendMessage?.({ type: "site-search:changed" }); }
      catch { /* No open popup needs the update. */ }
    });
    writes = operation.catch(() => {});
    return operation;
  }

  async function description(url, sourceURL, token) {
    if (typeof fetchMetadata !== "function" || token !== generation) return null;
    const controller = new AbortController();
    requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT);
    try {
      const response = await fetchMetadata(url.href, {
        credentials: "omit", referrerPolicy: "no-referrer", redirect: "error", cache: "no-store", signal: controller.signal,
      });
      if (!response?.ok || response.redirected || Number(response.headers?.get?.("content-length")) > MAX_DESCRIPTION_SIZE) return null;
      let xml;
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        xml = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_DESCRIPTION_SIZE || controller.signal.aborted) {
            await reader.cancel();
            return null;
          }
          xml += decoder.decode(value, { stream: true });
        }
        xml += decoder.decode();
      } else {
        xml = await response.text();
      }
      if (token !== generation || controller.signal.aborted || xml.length > MAX_DESCRIPTION_SIZE) return null;
      return parseOpenSearch(xml, url.href, sourceURL);
    } catch { return null; }
    finally {
      clearTimeout(timeout);
      controller.abort();
      requests.delete(controller);
    }
  }

  async function currentSource(tab, token) {
    try {
      const current = await api.tabs.get(tab.id);
      return !disposed && enabled && normalPage(current) && current.url === tab.url && await hasAccess() && token === generation;
    } catch { return false; }
  }

  async function scan(tab, token = generation) {
    if (token !== generation || disposed || !enabled || !normalPage(tab) || !await hasAccess()) return;
    if (token !== generation) return;
    let results;
    try { results = await api?.scripting?.executeScript?.({ target: { tabId: tab.id }, files: ["site-discovery.js"] }); }
    catch { return; }
    if (token !== generation || disposed || !enabled) return;
    const payload = results?.find((item) => item.frameId === 0)?.result;
    if (!await currentSource(tab, token) || token !== generation) return;
    const forms = Array.isArray(payload?.forms) ? payload.forms : [];
    const origin = new URL(tab.url).origin;
    let site;
    for (const value of (Array.isArray(payload?.openSearch) ? payload.openSearch : []).slice(0, 4)) {
      const url = metadataURL(value);
      if (!url || !await currentSource(tab, token)) continue;
      site = await description(url, tab.url, token);
      if (site) break;
    }
    if (!site) {
      const candidates = [...new Map(forms.slice(0, 16).map((form) => validatedSite({ name: new URL(origin).hostname, origin, template: form?.template }))
        .filter(Boolean).map((candidate) => [candidate.template, candidate])).values()];
      if (candidates.length !== 1) return;
      site = candidates[0];
    }
    if (!await currentSource(tab, token) || token !== generation || disposed || !enabled) return;
    learned = [...learned.filter((item) => item.origin !== origin), site].slice(-MAX_SITES);
    await save();
  }

  async function scanTabs(token) {
    let tabs;
    try { tabs = await api?.tabs?.query?.({}); }
    catch { return; }
    if (token !== generation) return;
    await Promise.all((tabs ?? []).filter(normalPage).map((tab) => scan(tab, token)));
  }

  async function read() {
    await load();
    const permitted = await hasAccess();
    return { enabled, permitted, learned: learned.map((site) => ({ ...site })) };
  }

  async function setEnabled(value) {
    invalidate();
    const token = generation;
    const revision = ++preferenceRevision;
    await load();
    if (value && !await hasAccess()) throw new Error("Allow website access in Firefox to enable automatic site discovery.");
    if (revision !== preferenceRevision || disposed) return read();
    const previous = enabled;
    enabled = value === true;
    try { await save(); }
    catch (error) {
      if (value && revision === preferenceRevision) { enabled = previous; invalidate(); }
      throw error;
    }
    if (enabled && token === generation) await scanTabs(token);
    return read();
  }

  async function clear() {
    invalidate();
    await load();
    learned = [];
    await save();
    return read();
  }

  function handleMessage(message, sender) {
    if (disposed || sender?.tab || sender?.url !== api?.runtime?.getURL?.("popup.html")
      || api?.runtime?.id && sender?.id !== api.runtime.id) return undefined;
    if (message?.type === "site-search:list") return read();
    if (message?.type === "site-search:set-enabled") return setEnabled(message.enabled);
    if (message?.type === "site-search:clear") return clear();
    return undefined;
  }

  function start() {
    if (!started && !disposed) {
      started = true;
      const onUpdated = async (_tabId, changes, tab) => {
        const token = generation;
        const source = { ...tab };
        await load();
        if (changes.status === "complete" && token === generation) {
          try { await scan(source, token); }
          catch { /* Automatic discovery failures must not reject tab events. */ }
        }
      };
      if (api?.tabs?.onUpdated?.addListener) {
        api.tabs.onUpdated.addListener(onUpdated);
        removers.push(() => api.tabs.onUpdated.removeListener(onUpdated));
      }
      if (api?.runtime?.onMessage?.addListener) {
        api.runtime.onMessage.addListener(handleMessage);
        removers.push(() => api.runtime.onMessage.removeListener(handleMessage));
      }
      const removed = () => {
        invalidate();
        return api?.runtime?.sendMessage?.({ type: "site-search:changed" })?.catch?.(() => {});
      };
      if (api?.permissions?.onRemoved?.addListener) {
        api.permissions.onRemoved.addListener(removed);
        removers.push(() => api.permissions.onRemoved.removeListener(removed));
      }
      const added = async () => {
        const token = generation;
        await load();
        try {
          if (enabled && token === generation && await hasAccess()) await scanTabs(token);
          await api?.runtime?.sendMessage?.({ type: "site-search:changed" });
        } catch { /* Firefox permission events must remain usable after local failures. */ }
      };
      if (api?.permissions?.onAdded?.addListener) {
        api.permissions.onAdded.addListener(added);
        removers.push(() => api.permissions.onAdded.removeListener(added));
      }
    }
    return read();
  }

  return { start, read, setEnabled, clear, handleMessage, dispose() {
    disposed = true;
    invalidate();
    for (const remove of removers) remove();
  } };
}

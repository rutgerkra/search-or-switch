const STORAGE_KEY = "faviconCacheV1";
const MAX_ENTRIES = 64;
const MAX_ICON_LENGTH = 64 * 1024;
const INLINE_IMAGE = /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|jpeg|gif|webp|avif|svg\+xml)(?:;charset=utf-8)?;base64,((?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?)$/i;
const INLINE_SVG = /^data:image\/svg\+xml(?:;charset=utf-8|;utf8)?,(.+)$/is;

function safeOrigin(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function safeIcon(value) {
  if (typeof value !== "string" || value.length > MAX_ICON_LENGTH) return null;
  const match = INLINE_IMAGE.exec(value) || INLINE_SVG.exec(value);
  return match?.[1] ? value : null;
}

/** Reuses Firefox-supplied inline images. SVG is displayed only through <img>,
 * never injected as markup, so scripts and external resources cannot run. */
export function createFaviconCache(cacheStorage, { persist = true, maxEntries = MAX_ENTRIES } = {}) {
  const limit = typeof maxEntries === "number" && Number.isFinite(maxEntries)
    ? Math.max(0, Math.min(MAX_ENTRIES, Math.floor(maxEntries)))
    : MAX_ENTRIES;
  const entries = new Map();
  let loading;
  let saving = false;
  let savePending = false;

  function rememberEntry(origin, icon) {
    entries.delete(origin);
    entries.set(origin, icon);
    while (entries.size > limit) entries.delete(entries.keys().next().value);
  }

  function save() {
    if (!persist) return;
    savePending = true;
    if (saving) return;
    saving = true;
    // Serialize and coalesce writes so a slow older write cannot win. Nothing
    // awaits persistence in the UI, and storage failures remain non-fatal.
    void (async () => {
      try {
        while (savePending) {
          savePending = false;
          const records = [...entries].map(([origin, icon]) => ({ origin, icon }));
          try {
            await cacheStorage?.set?.({ [STORAGE_KEY]: records });
          } catch {
            // A missing API, exhausted quota, or a closed popup is harmless.
          }
        }
      } finally {
        saving = false;
      }
    })();
  }

  function load() {
    if (!loading) {
      loading = (async () => {
        if (!persist) return;
        try {
          const stored = (await cacheStorage?.get?.(STORAGE_KEY))?.[STORAGE_KEY];
          if (!Array.isArray(stored)) return;
          // Tabs observed while storage was loading are newer than its snapshot.
          const recent = [...entries];
          entries.clear();
          for (const record of stored) {
            const origin = safeOrigin(record?.origin);
            const icon = safeIcon(record?.icon);
            if (origin && origin === record.origin && icon) rememberEntry(origin, icon);
          }
          for (const [origin, icon] of recent) rememberEntry(origin, icon);
          if (recent.length) save();
        } catch {
          // Loading cached decoration must never prevent opening the popup.
        }
      })();
    }
    return loading;
  }

  function remember(tabs) {
    if (!Array.isArray(tabs)) return;
    let changed = false;
    for (const tab of tabs) {
      if (!tab || (persist && tab.incognito)) continue;
      const origin = safeOrigin(tab.url);
      const icon = safeIcon(tab.favIconUrl);
      if (!origin || !icon) continue;
      rememberEntry(origin, icon);
      changed = true;
    }
    if (changed) save();
  }

  function get(url, preferredIcon) {
    const origin = safeOrigin(url);
    if (!origin) return null;
    return safeIcon(preferredIcon) || entries.get(origin) || null;
  }

  return { load, remember, get };
}

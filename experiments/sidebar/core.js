/** Pure, local-only matching and destination parsing shared by the new-tab UI. */

const WEB_PROTOCOLS = new Set(["https:", "http:"]);
const BLOCKED_SCHEMES = /^(?:javascript|data|vbscript|file|about|chrome|resource|moz-extension|chrome-extension|view-source|blob):/i;
const SEARCH_OPERATOR = /^(?:site|intitle|allintitle|inurl|allinurl|intext|allintext|filetype|ext|related|cache|before|after):/i;

function webURL(value) {
  try {
    const url = new URL(value);
    return WEB_PROTOCOLS.has(url.protocol) && url.hostname ? url : null;
  } catch {
    return null;
  }
}

function normalize(value) {
  return String(value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();
}

function safePath(url) {
  const path = url.pathname === "/" ? "" : url.pathname;
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

/** Returns display text without exposing URL credentials, query strings, or fragments. */
export function getTabDisplay(tab = {}) {
  const url = webURL(tab.url);
  const hostname = url ? url.hostname.replace(/^www\./i, "") : "";
  const path = url ? safePath(url) : "";
  const host = url ? url.host.replace(/^www\./i, "") : "";
  const label = host ? `${host}${path}` : "Unavailable page";
  return {
    title: typeof tab.title === "string" && tab.title.trim() ? tab.title.trim() : label,
    hostname,
    path,
    label,
  };
}

function scoreTab(tab, query) {
  const display = getTabDisplay(tab);
  const title = normalize(display.title);
  const hostname = normalize(display.hostname);
  if (title === query || hostname === query) return 0;
  if (title.startsWith(query)) return 1;
  if (hostname.startsWith(query)) return 2;
  if (title.includes(query) || hostname.includes(query)) return 3;
  if (normalize(tab.url).includes(query)) return 4;
  // Multi-word queries can match a title and host in combination.
  const haystack = `${title} ${hostname} ${normalize(display.path)}`;
  if (query.split(/\s+/).every((word) => haystack.includes(word))) return 5;
  return Infinity;
}

/** Matches tabs from one window and keeps duplicate-site tabs individually selectable. */
export function rankTabs(tabs, query = "", { excludeTabId, windowId, limit = 8 } = {}) {
  const normalizedQuery = normalize(query.trim());
  const maximum = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 8;
  return tabs
    .filter((tab) => Number.isInteger(tab.id)
      && tab.id !== excludeTabId
      && (windowId === undefined || tab.windowId === windowId)
      && webURL(tab.url))
    .map((tab, index) => ({ tab, index, score: normalizedQuery ? scoreTab(tab, normalizedQuery) : 0 }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((left, right) => left.score - right.score
      || (right.tab.lastAccessed ?? 0) - (left.tab.lastAccessed ?? 0)
      || (left.tab.index ?? left.index) - (right.tab.index ?? right.index))
    .slice(0, maximum)
    .map(({ tab }) => tab);
}

function invalid(message) {
  return { type: "invalid", message };
}

function destination(url) {
  if (url.username || url.password) {
    return invalid("URLs with a username or password are not supported.");
  }
  return { type: "url", url: url.href, label: `${url.host}${safePath(url)}` };
}

function bareHost(input) {
  const authority = input.split(/[/?#]/, 1)[0];
  // A port belongs to the host rather than being an arbitrary URL scheme.
  const host = authority.startsWith("[")
    ? authority.match(/^\[[^\]]+\]/)?.[0]
    : authority.replace(/:\d*$/, "");
  if (!host || authority.includes("@")) return null;
  const isLocalhost = /^(?:[\w-]+\.)*localhost\.?$/i.test(host);
  const isIPv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  const isIPv6 = /^\[[0-9a-f:.]+\]$/i.test(host);
  const isDomain = /^[^\s.:/]+(?:\.[^\s.:/]+)*\.[\p{L}][\p{L}\p{N}-]*\.?$/u.test(host);
  return isLocalhost || isIPv4 || isIPv6 || isDomain ? { isLocalhost, host } : null;
}

/** Resolves user intent without ever allowing an executable or privileged scheme. */
export function resolveInput(value) {
  const input = String(value ?? "").trim();
  if (!input) return { type: "empty" };
  if (BLOCKED_SCHEMES.test(input)) {
    return invalid("Use an http or https address, or enter a web search.");
  }

  if (/^https?:/i.test(input)) {
    if (!/^https?:\/\/[^/?#\\]/i.test(input) || /[\s\\]/.test(input)) {
      return invalid("Enter a complete URL, such as https://example.com.");
    }
    const url = webURL(input);
    return url ? destination(url) : invalid("That web address is not valid.");
  }

  // Spaces signal search intent, including queries containing a dotted phrase.
  if (/\s/.test(input) || SEARCH_OPERATOR.test(input)) return { type: "search", query: input };

  const bare = bareHost(input);
  if (bare) {
    const protocol = bare.isLocalhost || /^127\./.test(bare.host) || bare.host === "[::1]" ? "http:" : "https:";
    const url = webURL(`${protocol}//${input}`);
    return url ? destination(url) : invalid("That web address is not valid.");
  }

  if (/^[a-z][a-z\d+.-]*:/i.test(input) || input.startsWith("//")) {
    return invalid("Use an http or https address, or enter a web search.");
  }
  return { type: "search", query: input };
}

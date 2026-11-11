import { resolveInput } from "./core.js";

/**
 * Derives the displayed input without changing the authored query used to filter tabs.
 * The highlighted row determines the icon/Enter intent; only explicit arrow preview
 * replaces the field text. A subsequent real input event can promote that displayed
 * text to a new authored query in the UI.
 *
 * @returns {{value: string, kind: 'empty'|'tab'|'url'|'search'|'invalid', url: string|null}}
 */
export function getInputPresentation({ query = "", row = null, previewSelection = false } = {}) {
  const authoredQuery = String(query ?? "");
  const intent = resolveInput(authoredQuery);
  const fallback = {
    value: authoredQuery,
    kind: intent.type,
    url: intent.type === "url" ? intent.url : null,
  };

  // A freshly opened, empty field remains a search field until the user chooses a row.
  if (intent.type === "empty" && !previewSelection) return fallback;

  if (row?.type === "tab") {
    const url = safeWebURL(row.tab?.url);
    return {
      value: previewSelection && url ? url : authoredQuery,
      kind: "tab",
      url,
    };
  }

  if (row?.type === "action" || row?.type === "history") {
    if (row.target?.type === "url") {
      const url = safeWebURL(row.target.url);
      return {
        value: previewSelection && url ? url : authoredQuery,
        kind: url ? "url" : "invalid",
        url,
      };
    }
    if (row.target?.type === "search" || row.target?.type === "invalid") {
      return { value: authoredQuery, kind: row.target.type, url: null };
    }
  }

  return fallback;
}

function safeWebURL(value) {
  if (typeof value !== "string" || !/^https?:\/\/[^/?#\\]/i.test(value) || /[\s\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) return null;
    // Preserve the complete browser URL, including encoded paths, query, and fragment.
    return value;
  } catch {
    return null;
  }
}

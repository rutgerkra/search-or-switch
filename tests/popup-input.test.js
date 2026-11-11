import test from "node:test";
import assert from "node:assert/strict";
import { getInputPresentation } from "../popup-input.js";
import { rankTabs, resolveInput } from "../core.js";

const tabRow = (url = "https://example.com/docs") => ({ type: "tab", tab: { id: 1, windowId: 4, title: "Example docs", url } });
const searchRow = (query = "example") => ({ type: "action", target: { type: "search", query } });

test("an untouched empty input keeps a magnifier intent and no implicit URL", () => {
  assert.deepEqual(getInputPresentation(), { value: "", kind: "empty", url: null });
  assert.deepEqual(getInputPresentation({ query: "", row: tabRow() }), { value: "", kind: "empty", url: null });
  assert.deepEqual(getInputPresentation({ query: "  ", row: tabRow() }), { value: "  ", kind: "empty", url: null });
});

test("a highlighted tab controls intent while ordinary typing keeps the authored query visible", () => {
  assert.deepEqual(getInputPresentation({ query: "  ExAmPle  ", row: tabRow() }), {
    value: "  ExAmPle  ", kind: "tab", url: "https://example.com/docs",
  });
});

test("arrow preview fills the entire selected URL without dropping its scheme, encoding, query, or fragment", () => {
  const url = "https://example.com:8443/a%20document?query=one%20two&mode=edit#section-2";
  assert.deepEqual(getInputPresentation({ query: "document", row: tabRow(url), previewSelection: true }), {
    value: url, kind: "tab", url,
  });
});

test("arrow preview can choose a recent tab while the authored query is empty", () => {
  assert.deepEqual(getInputPresentation({ query: "", row: tabRow(), previewSelection: true }), {
    value: "https://example.com/docs", kind: "tab", url: "https://example.com/docs",
  });
});

test("moving between tab previews and back to search restores the exact authored query without mutation", () => {
  const query = "  example notes  ";
  const first = Object.freeze({ type: "tab", tab: Object.freeze({ url: "https://example.com/first" }) });
  const second = Object.freeze({ type: "tab", tab: Object.freeze({ url: "https://example.com/second" }) });
  const search = Object.freeze({ type: "action", target: Object.freeze({ type: "search", query: "example notes" }) });
  const rows = Object.freeze([first, second, search, first]);
  const values = rows.map((row) => getInputPresentation({ query, row, previewSelection: true }).value);
  assert.deepEqual(values, ["https://example.com/first", "https://example.com/second", query, "https://example.com/first"]);
  assert.equal(search.target.query, "example notes");
  assert.equal(first.tab.url, "https://example.com/first");
});

test("URL preview does not narrow the original list of matching tabs", () => {
  const query = "example";
  const tabs = [
    { id: 1, windowId: 4, title: "Example docs", url: "https://example.com/docs" },
    { id: 2, windowId: 4, title: "Example notes", url: "https://example.com/notes" },
  ];
  const before = rankTabs(tabs, query);
  const presented = getInputPresentation({ query, row: { type: "tab", tab: before[0] }, previewSelection: true });
  assert.notEqual(presented.value, query);
  assert.deepEqual(rankTabs(tabs, query).map(({ id }) => id), [1, 2]);
});

test("a URL action previews its normalized destination and keeps URL intent while typing", () => {
  const row = { type: "action", target: resolveInput("example.com/docs") };
  assert.deepEqual(getInputPresentation({ query: "example.com/docs", row }), {
    value: "example.com/docs", kind: "url", url: "https://example.com/docs",
  });
  assert.deepEqual(getInputPresentation({ query: "example.com/docs", row, previewSelection: true }), {
    value: "https://example.com/docs", kind: "url", url: "https://example.com/docs",
  });
});

test("search and invalid action rows restore the authored query after a URL preview", () => {
  assert.deepEqual(getInputPresentation({ query: "coffee near me", row: searchRow(), previewSelection: true }), {
    value: "coffee near me", kind: "search", url: null,
  });
  const row = { type: "action", target: { type: "invalid", message: "Invalid address" } };
  assert.deepEqual(getInputPresentation({ query: "https://", row, previewSelection: true }), {
    value: "https://", kind: "invalid", url: null,
  });
});

test("missing, malformed, privileged, or credential-bearing tab URLs never replace the authored text", () => {
  for (const url of [undefined, "not a URL", "https:///example.com", "https://example.com\\path", "javascript:alert(1)", "about:config", "file:///secret.txt", "https://user:password@example.com"]) {
    assert.deepEqual(getInputPresentation({ query: "original", row: { type: "tab", tab: { url } }, previewSelection: true }), {
      value: "original", kind: "tab", url: null,
    }, String(url));
  }
});

test("invalid URL action data falls back to authored text and invalid intent", () => {
  for (const url of [undefined, "javascript:alert(1)", "https://"]) {
    const row = { type: "action", target: { type: "url", url } };
    assert.deepEqual(getInputPresentation({ query: "original", row, previewSelection: true }), {
      value: "original", kind: "invalid", url: null,
    });
  }
});

test("an absent or stale row falls back to the currently authored intent", () => {
  assert.deepEqual(getInputPresentation({ query: "coffee near me", row: null, previewSelection: true }), {
    value: "coffee near me", kind: "search", url: null,
  });
  assert.deepEqual(getInputPresentation({ query: "example.com", row: { type: "unknown" }, previewSelection: true }), {
    value: "example.com", kind: "url", url: "https://example.com/",
  });
});

test("editing a displayed preview promotes its text to a new query with a new destination", () => {
  const previous = getInputPresentation({ query: "example", row: tabRow(), previewSelection: true });
  const edited = `${previous.value}/edited`;
  assert.deepEqual(getInputPresentation({ query: edited, row: null, previewSelection: false }), {
    value: "https://example.com/docs/edited", kind: "url", url: "https://example.com/docs/edited",
  });
});

test("forced navigation can resolve the currently displayed URL rather than the original search text", () => {
  const presented = getInputPresentation({ query: "example", row: tabRow(), previewSelection: true });
  assert.equal(resolveInput(presented.value).type, "url");
  assert.equal(resolveInput(presented.value).url, "https://example.com/docs");
  const restored = getInputPresentation({ query: "example", row: searchRow(), previewSelection: true });
  assert.deepEqual(resolveInput(restored.value), { type: "search", query: "example" });
});

test("history selection previews a destination URL, then the search action restores the authored query", () => {
  const url = "https://example.com/visited?mode=full#section";
  const row = { type: "history", target: { type: "url", url } };
  assert.deepEqual(getInputPresentation({ query: "example", row }), { value: "example", kind: "url", url });
  assert.deepEqual(getInputPresentation({ query: "example", row, previewSelection: true }), { value: url, kind: "url", url });
  assert.deepEqual(getInputPresentation({ query: "example", row: searchRow(), previewSelection: true }), { value: "example", kind: "search", url: null });
});

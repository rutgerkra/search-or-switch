import test from "node:test";
import assert from "node:assert/strict";
import { createHistorySearch } from "../history-search.js";

test("history lookup skips empty input and searches all dates with a bounded result count", async () => {
  const calls = [];
  const source = createHistorySearch({ async search(query) { calls.push(query); return [{ url: "https://example.com" }]; } }, { delay: 0 });
  assert.equal(await source.search("  "), null);
  assert.deepEqual(calls, []);
  assert.deepEqual(await source.search("  example  "), { query: "example", items: [{ url: "https://example.com" }] });
  assert.deepEqual(calls, [{ text: "example", startTime: 0, maxResults: 100 }]);
  source.dispose();
});

test("typing replaces a pending lookup rather than querying for every keystroke", async () => {
  const calls = [];
  const source = createHistorySearch({ async search(query) { calls.push(query.text); return []; } }, { delay: 0 });
  const first = source.search("a");
  const second = source.search("at");
  const latest = source.search("atlas");
  assert.equal(await first, null);
  assert.equal(await second, null);
  assert.deepEqual(await latest, { query: "atlas", items: [] });
  assert.deepEqual(calls, ["atlas"]);
  source.dispose();
});

test("a slow previous query cannot publish after a newer query resolves", async () => {
  let started;
  const running = new Promise((resolve) => { started = resolve; });
  let finishOld;
  const source = createHistorySearch({ search({ text }) {
    if (text === "old") { started(); return new Promise((resolve) => { finishOld = resolve; }); }
    return Promise.resolve([{ title: "New result" }]);
  } }, { delay: 0 });
  const old = source.search("old");
  await running;
  const latest = source.search("new");
  assert.equal(await old, null);
  assert.deepEqual(await latest, { query: "new", items: [{ title: "New result" }] });
  finishOld([{ title: "Old result" }]);
  source.dispose();
});

test("API failures stay local and return a usable empty result", async () => {
  for (const api of [undefined, { async search() { throw new Error("private data must not surface"); } }]) {
    const source = createHistorySearch(api, { delay: 0 });
    assert.deepEqual(await source.search("query"), { query: "query", items: [], unavailable: true });
    source.dispose();
  }
});

test("clearing the query and disposing the popup discard pending requests", async () => {
  const calls = [];
  const source = createHistorySearch({ async search(query) { calls.push(query); return []; } }, { delay: 0 });
  const cleared = source.search("first");
  assert.equal(await source.search(""), null);
  assert.equal(await cleared, null);
  const closed = source.search("second");
  source.dispose();
  assert.equal(await closed, null);
  assert.equal(await source.search("third"), null);
  assert.deepEqual(calls, []);
});

import test from "node:test";
import assert from "node:assert/strict";
import { getTabDisplay, rankTabs, rankHistory, resolveInput } from "../core.js";

test("display text hides query strings, fragments, and URL credentials", () => {
  assert.deepEqual(getTabDisplay({ title: "  Project plan  ", url: "https://alice:secret@www.example.com:8443/project%20plan?token=secret#private" }), {
    title: "Project plan", hostname: "example.com", path: "/project plan", label: "example.com:8443/project plan",
  });
});

test("missing titles and invalid URLs have usable display fallbacks", () => {
  assert.equal(getTabDisplay({ url: "https://example.com/docs" }).title, "example.com/docs");
  assert.deepEqual(getTabDisplay({}), { title: "Unavailable page", hostname: "", path: "", label: "Unavailable page" });
  assert.equal(getTabDisplay({ title: "Settings", url: "about:config" }).hostname, "");
});

const tab = (id, title, url, extra = {}) => ({ id, title, url, windowId: 4, index: id, ...extra });

test("ranking follows exact, title prefix, hostname prefix, contains, then URL", () => {
  const tabs = [
    tab(1, "Unrelated", "https://elsewhere.com/path/arc"),
    tab(2, "My Arc notes", "https://notes.com/"),
    tab(3, "Home", "https://archive.org/"),
    tab(4, "Arc reference", "https://docs.com/"),
    tab(5, "Arc", "https://browser.com/"),
  ];
  assert.deepEqual(rankTabs(tabs, "arc").map(({ id }) => id), [5, 4, 3, 2, 1]);
});

test("exact hostname matches ignore a leading www", () => {
  assert.equal(rankTabs([tab(1, "Other", "https://www.example.com/")], "example.com").length, 1);
});

test("matching is case and accent insensitive, with multi-word matching across fields", () => {
  const tabs = [tab(1, "Café project", "https://notes.example.com/work")];
  assert.equal(rankTabs(tabs, "CAFE").length, 1);
  assert.equal(rankTabs(tabs, "cafe example").length, 1);
});

test("ranking excludes self, other windows, inaccessible pages, and missing IDs", () => {
  const tabs = [
    tab(1, "Self", "https://self.com/"),
    tab(2, "Wrong window", "https://other.com/", { windowId: 9 }),
    tab(3, "Settings", "about:preferences"),
    tab(4, "Extension", "moz-extension://example/newtab.html"),
    tab(5, "File", "file:///private/secret.txt"),
    tab(6, "Missing URL", undefined),
    tab(undefined, "Missing ID", "https://example.com/"),
    tab(7, "Visible", "https://example.com/"),
  ];
  assert.deepEqual(rankTabs(tabs, "", { excludeTabId: 1, windowId: 4 }).map(({ id }) => id), [7]);
});

test("empty query orders by recency and retains separate tabs from the same site", () => {
  const tabs = [
    tab(1, "Plan", "https://example.com/plan", { lastAccessed: 5 }),
    tab(2, "Tasks", "https://example.com/tasks", { lastAccessed: 20 }),
    tab(3, "Other", "https://other.com/", { lastAccessed: 10 }),
  ];
  assert.deepEqual(rankTabs(tabs).map(({ id }) => id), [2, 3, 1]);
  assert.deepEqual(rankTabs(tabs, "example").map(({ id }) => id), [2, 1]);
  assert.equal(rankTabs(tabs, "", { limit: 1 }).length, 1);
  assert.equal(rankTabs(tabs, "", { limit: 0 }).length, 0);
  assert.equal(rankTabs(tabs, "no match").length, 0);
});

test("explicit web URLs retain their destination but not secrets in the label", () => {
  assert.deepEqual(resolveInput(" https://example.com/docs?query=private#section "), {
    type: "url", url: "https://example.com/docs?query=private#section", label: "example.com/docs",
  });
});

test("bare domains, paths, and international domains receive HTTPS", () => {
  assert.equal(resolveInput("example.com").url, "https://example.com/");
  assert.equal(resolveInput("www.example.com:8443/path?q=yes").url, "https://www.example.com:8443/path?q=yes");
  assert.equal(resolveInput("münchen.de").url, "https://xn--mnchen-3ya.de/");
  assert.equal(resolveInput("example.com.").url, "https://example.com./");
});

test("localhost and loopback accept ports and use HTTP", () => {
  assert.equal(resolveInput("localhost:3000/app").url, "http://localhost:3000/app");
  assert.equal(resolveInput("dev.localhost:8080").url, "http://dev.localhost:8080/");
  assert.equal(resolveInput("127.0.0.1:5173").url, "http://127.0.0.1:5173/");
  assert.equal(resolveInput("[::1]:3000").url, "http://[::1]:3000/");
  assert.equal(resolveInput("192.168.1.2").url, "https://192.168.1.2/");
});

test("ordinary text, search operators, emails, and dotted multi-word queries remain searches", () => {
  for (const query of ["best coffee near me", "example.com documentation", "site:example.com", "user@example.com", "rust", "v1.2", "1.2"]) {
    assert.deepEqual(resolveInput(query), { type: "search", query });
  }
});

test("executable, privileged, and unsupported schemes are never navigation destinations", () => {
  for (const value of ["javascript:alert(1)", "JaVaScRiPt: alert(1)", "data:text/html,<h1>Hi</h1>", "file:///etc/passwd", "about:config", "view-source:https://example.com", "moz-extension://id/newtab.html", "ftp://example.com", "custom:handler", "//example.com"]) {
    assert.equal(resolveInput(value).type, "invalid", value);
  }
});

test("invalid explicit URLs, credentials, and invalid ports fail safely", () => {
  for (const value of ["https:example.com", "https://", "https:///example.com", "https://example.com\\other", "https://example.com/a b", "https://alice:secret@example.com", "example.com:99999", "localhost:99999", "999.999.999.999"]) {
    assert.equal(resolveInput(value).type, "invalid", value);
  }
});

test("empty input never creates a destination", () => {
  assert.deepEqual(resolveInput("  \n "), { type: "empty" });
  assert.deepEqual(resolveInput(null), { type: "empty" });
});

test("history ranking prefers matching titles and hosts, then more recent visits", () => {
  const items = [
    { title: "Old Atlas guide", url: "https://old.example/", lastVisitTime: 10 },
    { title: "New Atlas guide", url: "https://new.example/", lastVisitTime: 50 },
    { title: "Unrelated", url: "https://atlas.example/", lastVisitTime: 5 },
    { title: "Atlas", url: "https://exact.example/", lastVisitTime: 1 },
    { title: "Different topic", url: "https://other.example/", lastVisitTime: 100 },
  ];
  assert.deepEqual(rankHistory(items, "atlas").map((item) => item.url), ["https://exact.example/", "https://atlas.example/", "https://new.example/", "https://old.example/"]);
});

test("history removes open URLs and duplicate fragment variants while retaining different pages", () => {
  const items = [
    { title: "Atlas open", url: "https://example.com/open#old", lastVisitTime: 30 },
    { title: "Atlas guide", url: "https://example.com/guide#new", lastVisitTime: 20 },
    { title: "Atlas guide", url: "https://example.com/guide#old", lastVisitTime: 10 },
    { title: "Atlas notes", url: "https://example.com/notes", lastVisitTime: 5 },
  ];
  const tabs = [{ url: "https://example.com/open#current" }];
  assert.deepEqual(rankHistory(items, "atlas", { tabs }).map((item) => item.url), ["https://example.com/guide#new", "https://example.com/notes"]);
});

test("history never suggests credentials, internal pages, malformed addresses or unsupported schemes", () => {
  const urls = ["javascript:alert(1)", "file:///private/atlas", "about:config", "https://user:secret@example.com/", "https:///example.com", "https://example.com\\atlas", undefined];
  assert.deepEqual(rankHistory(urls.map((url) => ({ title: "Atlas", url })), "atlas"), []);
});

test("history is query-only, bounded, and matches words across titles and hostnames", () => {
  const items = Array.from({ length: 20 }, (_, index) => ({ title: "Café guide", url: `https://example.com/${index}`, lastVisitTime: index }));
  assert.equal(rankHistory(items, "").length, 0);
  assert.equal(rankHistory(items, "cafe example").length, 6);
  assert.equal(rankHistory(items, "cafe example", { limit: 2 }).length, 2);
  assert.equal(rankHistory(items, "cafe example", { limit: 0 }).length, 0);
});

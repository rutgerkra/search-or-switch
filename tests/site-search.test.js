import test from "node:test";
import assert from "node:assert/strict";
import { createDiscoveredSite, getFirefoxSearchSites, matchSiteSearch, resolveSiteSearch, SITE_SEARCH_PERMISSIONS } from "../site-search.js";

test("Firefox engines expose local names and aliases while retaining their search destination", () => {
  assert.deepEqual(getFirefoxSearchSites([
    { name: "Duck Duck Go", alias: "@ddg", favIconUrl: "https://example.com/icon.png" },
    { name: "Wikipedia", aliases: ["@wiki", "wiki"] },
    { name: "  " },
  ]), [
    { id: "engine:Duck Duck Go", name: "Duck Duck Go", keyword: "duckduckgo", aliases: ["@ddg"], engine: "Duck Duck Go" },
    { id: "engine:Wikipedia", name: "Wikipedia", keyword: "wikipedia", aliases: ["@wiki", "wiki"], engine: "Wikipedia" },
  ]);
});

test("learned definitions retain only reusable fields and one stable identity per source origin", () => {
  const first = createDiscoveredSite({
    name: "  Example   Search  ", origin: "https://www.example.com/path?private=query#part",
    template: "https://search.example.net/find?q={searchTerms}&lang=en", query: "private query", icon: "https://example.com/icon.png",
  });
  assert.deepEqual(first, {
    id: "learned:https://www.example.com", name: "Example Search", keyword: "example.com",
    origin: "https://www.example.com", template: "https://search.example.net/find?q={searchTerms}&lang=en",
  });
  assert.equal(createDiscoveredSite({ name: "New label", origin: "https://www.example.com/other", template: "https://www.example.com/search/{searchTerms}" }).id, first.id);
  assert.deepEqual(SITE_SEARCH_PERMISSIONS, { origins: ["http://*/*", "https://*/*"] });
});

test("learning excludes static credential and account parameters while retaining ordinary reusable filters", () => {
  const definition = { name: "Example", origin: "https://example.com", template: "https://example.com/?q={searchTerms}" };
  for (const key of ["token", "CSRF_token", "session-id", "auth", "user", "e_mail", "accountId", "api.key", "password", "access_token"]) {
    assert.equal(createDiscoveredSite({ ...definition, template: `https://example.com/?q={searchTerms}&${key}=private-value` }), null, key);
  }
  assert.equal(createDiscoveredSite({ ...definition, template: "https://example.com/?token={searchTerms}&source=browser&client=firefox&lang=en&title=all" })?.template,
    "https://example.com/?token={searchTerms}&source=browser&client=firefox&lang=en&title=all");
});

test("learning excludes compound credential and account parameter names", () => {
  const accepted = ["api_token", "account_number"].map((key) => createDiscoveredSite({
    name: "Example", origin: "https://example.com", template: `https://example.com/?q={searchTerms}&${key}=private-value`,
  }) !== null);
  assert.deepEqual(accepted, [false, false]);
});

test("learning rejects unsafe protocols, credentials, and authority or fragment placeholders", () => {
  const definition = { name: "Search", origin: "https://example.com", template: "https://example.com/?q={searchTerms}" };
  for (const origin of ["javascript:alert(1)", "file:///tmp/search", "https://user:secret@example.com", "not a URL", null]) {
    assert.equal(createDiscoveredSite({ ...definition, origin }), null, String(origin));
  }
  for (const template of ["javascript:{searchTerms}", "http://user:secret@example.com/?q={searchTerms}", "https://{searchTerms}.example.com/", "https://example.com/#{searchTerms}", "https://example.com/?q=fixed", null]) {
    assert.equal(createDiscoveredSite({ ...definition, template }), null, String(template));
  }
});

test("missing discovery data cannot become a learned search", () => {
  for (const definition of [null, undefined, {}, [], "https://example.com"]) {
    assert.equal(createDiscoveredSite(definition), null);
  }
});

test("a search placeholder cannot hide behind a second fragment delimiter", () => {
  assert.equal(createDiscoveredSite({ name: "Example", origin: "https://example.com", template: "https://example.com/#static#{searchTerms}" }), null);
});

test("learning rejects unknown required placeholders and normalizes optional OpenSearch parameters", () => {
  const definition = { name: "YouTube", origin: "https://www.youtube.com", template: "https://www.youtube.com/results?search_query={searchTerms}&page={startPage?}&index={startIndex?}" };
  assert.equal(createDiscoveredSite(definition)?.template, "https://www.youtube.com/results?search_query={searchTerms}");
  assert.equal(createDiscoveredSite({ ...definition, template: "https://www.youtube.com/results?q={searchTerms}&private={customToken}" }), null);
  assert.equal(createDiscoveredSite({ ...definition, template: "https://www.youtube.com/results?q={searchTerms}&private={broken" }), null);
});

test("learned labels are bounded plain text suitable for the site chip", () => {
  const definition = { name: "Example", origin: "https://example.com", template: "https://example.com/?q={searchTerms}" };
  for (const name of ["", "   ", "<script>Example</script>", "Search\u0000", "x".repeat(81), null]) {
    assert.equal(createDiscoveredSite({ ...definition, name }), null, String(name));
  }
});

test("standard required OpenSearch placeholders have reusable UTF-8 defaults", () => {
  const site = createDiscoveredSite({ name: "Example", origin: "https://example.com", template: "https://example.com/?q={searchTerms}&encoding={inputEncoding}&output={outputEncoding}&lang={language}&page={startPage}&start={startIndex}&count={count}" });
  assert.deepEqual(resolveSiteSearch(site, "café"), { type: "url", url: "https://example.com/?q=caf%C3%A9&encoding=UTF-8&output=UTF-8&lang=*&page=1&start=1&count=20" });
});

test("optional placeholders preserve literal static URL data", () => {
  const site = createDiscoveredSite({ name: "Example", origin: "https://example.com", template: "https://example.com/a&&b/{language?}?page={startPage?}&q={searchTerms}&static=a&&b#part" });
  assert.equal(site?.template, "https://example.com/a&&b/?q={searchTerms}&static=a&&b#part");
});

test("a learned search encodes the query as data in path and query templates", () => {
  const query = "cats & dogs /?# café";
  const site = createDiscoveredSite({ name: "Example", origin: "https://example.com", template: "https://example.com/search/{searchTerms}?q={searchTerms}&lang=en" });
  assert.deepEqual(resolveSiteSearch(site, query), {
    type: "url", url: "https://example.com/search/cats%20%26%20dogs%20%2F%3F%23%20caf%C3%A9?q=cats%20%26%20dogs%20%2F%3F%23%20caf%C3%A9&lang=en",
  });
  assert.deepEqual(resolveSiteSearch(site, ""), { type: "url", url: "https://example.com/" });
});

test("installed searches keep the selected Firefox engine and leave empty queries uncommitted", () => {
  const [site] = getFirefoxSearchSites([{ name: "Wikipedia", alias: "@wiki" }]);
  assert.deepEqual(resolveSiteSearch(site, "red panda"), { type: "search", query: "red panda", engine: "Wikipedia" });
  assert.deepEqual(resolveSiteSearch(site, "   "), { type: "empty" });
});

test("committing invalid or tampered definitions reports a readable failure", () => {
  for (const site of [null, {}, { name: "Unsafe", origin: "https://example.com", template: "javascript:{searchTerms}" }, { name: "Unsafe", origin: "https://example.com", template: "https://{searchTerms}.example.com/" }]) {
    assert.throws(() => resolveSiteSearch(site, "cats"), /This site search is no longer valid/);
  }
  const site = createDiscoveredSite({ name: "Example", origin: "https://example.com", template: "https://example.com/?q={searchTerms}" });
  assert.throws(() => resolveSiteSearch(site, "\ud800"), /could not encode/);
});

test("a site hint uses the authored prefix and deterministic shortest keyword ranking", () => {
  const youtube = { id: "learned:https://youtube.com", keyword: "youtube.com" };
  const your = { id: "engine:your", keyword: "your", aliases: ["@you"] };
  const you = { id: "engine:you", keyword: "you", aliases: ["@video"] };
  const otherYou = { id: "engine:zzz", keyword: "you" };
  const sites = [youtube, your, otherYou, you];
  assert.equal(matchSiteSearch(sites, "  YoU  "), you);
  assert.equal(matchSiteSearch(sites, "@VID"), you);
  assert.equal(matchSiteSearch(sites, "youtube.com cats"), null);
  assert.equal(matchSiteSearch(sites, ""), null);
  assert.equal(matchSiteSearch(sites, "   "), null);
  assert.equal(matchSiteSearch([{ id: "z", keyword: "youtube" }, { id: "a", keyword: "youkuuu" }], "you").id, "a");
});

test("short matching aliases participate in hint ranking alongside domain keywords", () => {
  const engine = { id: "engine-long", keyword: "longenginename", aliases: ["go"] };
  const site = { id: "site-short", keyword: "google.com" };
  assert.equal(matchSiteSearch([site, engine], "g"), engine);
  const lexical = { id: "lexical", keyword: "longname", aliases: ["gi"] };
  assert.equal(matchSiteSearch([engine, lexical], "g"), lexical);
});

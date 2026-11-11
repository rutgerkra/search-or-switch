export const SITE_SEARCH_PERMISSIONS = { origins: ["http://*/*", "https://*/*"] };
const STANDARD_VALUES = { inputEncoding: "UTF-8", outputEncoding: "UTF-8", language: "*", startPage: "1", startIndex: "1", count: "20" };
// Keep compound static credential/account keys aligned with injected discovery.
const SENSITIVE_PARAMETER = /(?:token|csrf|xsrf|session|password|passwd|secret|auth|account|email|userid|username|apikey|accesskey|privatekey|credential)|^(?:user|pass|sess(?:id|key)?)$/i;

function httpURL(value) {
  if (typeof value !== "string" || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && url.hostname && !url.username && !url.password ? url : null;
  } catch { return null; }
}

/** A learned search contains reusable markup data, never a visited URL or query. */
export function createDiscoveredSite(definition) {
  if (!definition || typeof definition !== "object") return null;
  const { name, origin, template: authoredTemplate } = definition;
  let template = authoredTemplate;
  const source = httpURL(origin);
  if (!source || typeof name !== "string" || typeof template !== "string" || !template.includes("{searchTerms}")) return null;
  const tokens = [...template.matchAll(/\{([^{}]+)\}/g)].map((match) => match[1]);
  if (/[{}]/.test(template.replace(/\{[^{}]+\}/g, "")) || tokens.some((token) => token !== "searchTerms" && !Object.hasOwn(STANDARD_VALUES, token) && !/^[A-Za-z][\w:.]*\?$/.test(token))) return null;
  const destination = httpURL(template.replaceAll("{searchTerms}", "site-search-terms"));
  const authority = template.match(/^https?:\/\/([^/?#]*)/i)?.[1];
  if (!destination || !authority || /[{}@]/.test(authority) || /[{}]/.test(template.split("#").slice(1).join("#"))) return null;
  let optionalMarker = "FFARCSITEOPTIONALTOKEN";
  while (template.includes(optionalMarker)) optionalMarker += "X";
  template = template.replace(/\{[A-Za-z][\w:.]*\?\}/g, optionalMarker);
  const [main, ...fragment] = template.split("#");
  const question = main.indexOf("?");
  if (question !== -1) {
    const parameters = main.slice(question + 1).split("&").filter((parameter) => parameter !== optionalMarker && parameter.split("=").slice(1).join("=") !== optionalMarker);
    template = main.slice(0, question) + (parameters.length ? `?${parameters.join("&")}` : "") + (fragment.length ? `#${fragment.join("#")}` : "");
  }
  template = template.replaceAll(optionalMarker, "");
  template = template.replace(/\{([^{}]+)\}/g, (match, token) => STANDARD_VALUES[token] ?? match);
  const reusable = httpURL(template);
  if (!reusable || [...reusable.searchParams].some(([key, value]) => value && !value.includes("{searchTerms}") && SENSITIVE_PARAMETER.test(key.toLowerCase().replace(/[^a-z0-9]/g, "")))) return null;
  const label = name.trim().replace(/\s+/g, " ");
  if (!label || label.length > 80 || /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(label)) return null;
  return {
    id: `learned:${source.origin}`,
    name: label,
    keyword: source.hostname.replace(/^www\./, ""),
    origin: source.origin,
    template,
  };
}

/** Parse metadata with Firefox's XML parser; no page markup or entered values are kept. */
export function parseOpenSearch(xml, descriptorURL, sourceURL) {
  if (typeof xml !== "string" || typeof DOMParser !== "function") return null;
  const descriptor = httpURL(descriptorURL);
  if (!descriptor) return null;
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const namespace = "http://a9.com/-/spec/opensearch/1.1/";
  const root = document.documentElement;
  if (root?.localName !== "OpenSearchDescription" || root.namespaceURI !== namespace) return null;
  const children = [...root.children].filter((element) => element.namespaceURI === namespace);
  const labels = children.filter((element) => element.localName === "ShortName");
  if (labels.length !== 1 || labels[0].children.length) return null;
  for (const element of children.filter((element) => element.localName === "InputEncoding")) {
    if (element.textContent.trim().toUpperCase() !== "UTF-8") return null;
  }
  const name = labels[0].textContent;
  for (const element of children.filter((element) => element.localName === "Url")) {
    if (element.getAttribute("type") !== "text/html" || !["", "get"].includes((element.getAttribute("method") ?? "").trim().toLowerCase())) continue;
    const authored = element.getAttribute("template");
    if (typeof authored !== "string" || /[{}]/.test(authored.replace(/\{[^{}]+\}/g, ""))) continue;
    let marker = "ffarcsitetoken";
    while (authored.toLowerCase().includes(marker)) marker += "x";
    const tokens = [];
    const masked = authored.replace(/\{[^{}]+\}/g, (token) => `${marker}${tokens.push(token) - 1}end`);
    let template;
    try {
      template = new URL(masked, descriptor.href).href.replace(new RegExp(`${marker}(\\d+)end`, "g"), (match, index) => tokens[Number(index)] ?? match);
    } catch { continue; }
    const site = createDiscoveredSite({ name, origin: sourceURL, template });
    if (site) return site;
  }
  return null;
}

/** Firefox keeps ownership of installed engines; the catalog stores only their names. */
export function getFirefoxSearchSites(engines) {
  return (Array.isArray(engines) ? engines : []).filter((engine) => typeof engine?.name === "string" && engine.name.trim())
    .map((engine) => ({
      id: `engine:${engine.name}`,
      name: engine.name,
      keyword: engine.name.toLowerCase().replace(/\s+/g, ""),
      aliases: [...new Set([engine.alias, ...(Array.isArray(engine.aliases) ? engine.aliases : [])]
        .filter((alias) => typeof alias === "string" && alias.trim()).map((alias) => alias.trim().toLowerCase()))],
      engine: engine.name,
    }));
}

/** The hint is independent of ordinary result selection and never uses usage history. */
export function matchSiteSearch(sites, query) {
  const prefix = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!prefix) return null;
  const compareText = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  return (Array.isArray(sites) ? sites : []).filter((site) => typeof site?.keyword === "string")
    .flatMap((site) => [site.keyword, ...(Array.isArray(site.aliases) ? site.aliases : [])]
      .filter((keyword) => typeof keyword === "string" && keyword.toLowerCase().startsWith(prefix))
      .map((keyword) => ({ site, keyword: keyword.toLowerCase() })))
    .sort((left, right) => left.keyword.length - right.keyword.length
      || compareText(left.keyword, right.keyword)
      || compareText(String(left.site.id), String(right.site.id)))[0]?.site ?? null;
}

/** Resolves a committed query without opening tabs or changing Firefox's default engine. */
export function resolveSiteSearch(site, query) {
  if (!site || typeof query !== "string") throw new Error("This site search is no longer valid. Choose another site.");
  if (typeof site.engine === "string" && site.engine.trim()) return query.trim() ? { type: "search", query, engine: site.engine } : { type: "empty" };
  const definition = createDiscoveredSite(site);
  if (!definition) throw new Error("This site search is no longer valid. Choose another site.");
  if (!query.trim()) return { type: "url", url: `${definition.origin}/` };
  let encoded;
  try { encoded = encodeURIComponent(query); }
  catch { throw new Error("Firefox could not encode this site-search query. Try typing it again."); }
  const destination = httpURL(definition.template.replaceAll("{searchTerms}", encoded));
  if (!destination) throw new Error("This site search is no longer valid. Choose another site.");
  return { type: "url", url: destination.href };
}

/* A one-shot, top-frame markup scan. No handlers, observers, or entered values. */
(() => {
  const empty = { openSearch: [], forms: [] };
  if (globalThis.browser?.extension?.inIncognitoContext || window.top !== window) return empty;
  let base;
  try { base = new URL(document.baseURI); }
  catch { return empty; }
  if (!["http:", "https:"].includes(base.protocol)) return empty;

  const sensitive = /(?:token|csrf|xsrf|session|password|passwd|secret|auth|account|email|userid|username|apikey|accesskey)/i;
  function webURL(value) {
    if (typeof value !== "string" || /[\u0000-\u001f\u007f\\]/.test(value)) return null;
    try {
      const url = new URL(value, base);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
      // Firefox content-script Xrays do not expose URLSearchParams iterators.
      let rejected = false;
      url.searchParams.forEach((_value, name) => { if (sensitive.test(name.replace(/[^a-z0-9]/gi, ""))) rejected = true; });
      if (rejected) return null;
      return url;
    } catch { return null; }
  }

  const openSearch = [];
  for (const link of document.querySelectorAll("link[rel][href]")) {
    if (!link.getAttribute("rel").toLowerCase().split(/\s+/).includes("search")
      || link.getAttribute("type")?.toLowerCase().split(";")[0].trim() !== "application/opensearchdescription+xml") continue;
    const url = webURL(link.getAttribute("href"));
    if (url && !url.hash && !openSearch.includes(url.href)) openSearch.push(url.href);
    if (openSearch.length === 4) break;
  }

  function hiddenDefault(name, value) {
    if (name === "title") return value === "Special:Search";
    if (["lang", "language", "locale", "hl"].includes(name)) return /^[a-z]{2,3}(?:[-_][a-z0-9]{2,8})*$/i.test(value);
    if (["ie", "oe"].includes(name)) return /^utf-?8$/i.test(value);
    return name === "utf8" && value === "✓";
  }

  const forms = new Map();
  const recognizable = /^(?:q|query|search|search_query|searchterm|searchterms|search_term|search_terms|term|keyword|keywords)$/i;
  const sentinel = "FFARCSITETERMSPLACEHOLDER9";
  // HTMLFormElement.elements omits image submitters, including form= associations.
  const images = [...document.querySelectorAll("input")].filter((input) => input.type === "image");
  for (const form of [...document.forms].slice(0, 32)) {
    if ((form.getAttribute("method") || "get").trim().toLowerCase() !== "get") continue;
    const controls = [...new Set([...form.elements, ...images.filter((input) => input.form === form)])]
      .filter((control) => !control.matches(":disabled"));
    if (controls.some((control) => (control.tagName === "BUTTON" || control.tagName === "INPUT" && ["submit", "image"].includes(control.type))
      && (control.hasAttribute("formmethod") || control.hasAttribute("formaction")))) continue;
    if (controls.some((control) => control.tagName === "INPUT" && ["password", "file"].includes(control.type))) continue;
    const inputs = controls.filter((control) => control.tagName === "INPUT" && control.getAttribute("name"));
    const textInputs = inputs.filter((input) => ["text", "search", "email", "url", "tel", "number"].includes(input.type));
    const semantic = form.getAttribute("role")?.toLowerCase() === "search" || form.closest('[role="search"]');
    const queries = textInputs.filter((input) => input.type === "search" || semantic && input.type === "text" && recognizable.test(input.getAttribute("name")));
    if (queries.length !== 1 || textInputs.length !== 1) continue;
    const query = queries[0];
    const queryName = query.getAttribute("name");
    if (!/^[a-z][a-z0-9_.-]{0,63}$/i.test(queryName)) continue;
    const rawAction = form.getAttribute("action") || "";
    const action = webURL(rawAction);
    if (!action || action.origin !== base.origin || action.href.includes(sentinel)) continue;
    action.search = "";
    action.hash = "";
    const parameters = new URLSearchParams();
    let valid = true;
    for (const control of controls) {
      const name = control.getAttribute("name");
      if (!name || control === query) {
        if (control === query) parameters.append(queryName, sentinel);
        continue;
      }
      if (control.tagName === "BUTTON" || control.tagName === "INPUT" && ["submit", "button", "reset", "image"].includes(control.type)) {
        // A named submitter contributes parameters; its chosen semantics are ambiguous.
        if (["submit", "image"].includes(control.type)) { valid = false; break; }
        continue;
      }
      if (control.tagName !== "INPUT" || control.type !== "hidden" || parameters.has(name) || name === queryName) { valid = false; break; }
      const value = control.getAttribute("value") ?? "";
      if (!hiddenDefault(name.toLowerCase(), value)) { valid = false; break; }
      parameters.append(name, value);
    }
    if (!valid) continue;
    action.search = parameters.toString();
    const template = action.href.replace(sentinel, "{searchTerms}");
    forms.set(template, { template });
    if (forms.size === 16) break;
  }
  return { openSearch, forms: [...forms.values()] };
})();

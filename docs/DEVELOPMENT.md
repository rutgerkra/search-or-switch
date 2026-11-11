# Development reference

A keyboard-first Firefox toolbar popup: **one shortcut → type → Enter → close**. Find an open tab, reopen a page from history, or open an address or web search.

Default shortcuts are **⇧⌘K** on macOS, **Ctrl+Shift+K** on Windows, and **Ctrl+Shift+Space** on Linux; the toolbar button also opens the popup. The popup requests input focus as it opens. Opening and typing create no tabs. Committing an address or search reuses the current Firefox Home/New Tab page when it is still available; otherwise it creates one destination tab in the current window. Selecting an existing tab activates it and dismisses the popup.

The interface uses Firefox-style controls, neutral colors, system fonts, and light/dark appearance. Firefox anchors the native popup to its toolbar. Escape or clicking elsewhere dismisses it.

Built with plain HTML, CSS, and JavaScript. No runtime dependencies, remote assets, background page, or build step are required to load the extension. Targets **Firefox Desktop 140+**. The shortcut, URL previews, search restoration, globe fallback, cached icons, and Enter-to-dismiss behavior were verified with desktop keyboard input in Firefox 160 on macOS.

## Try it in Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…** and select this folder’s `manifest.json`.
3. Press **⇧⌘K** (macOS), **Ctrl+Shift+K** (Windows), or **Ctrl+Shift+Space** (Linux), or click **Search or Switch** in the toolbar. Pin its button from Firefox’s extensions menu if needed.
4. Type, use the arrow keys to choose a result, and press Enter.

Pinning the button gives the popup its wider layout. When the button is unpinned, Firefox displays it inside the narrower Extensions menu; the shortcut works in either placement.

Open **Preferences** to edit the shortcut. Its single row follows Firefox’s `about:keyboard` layout: action label, shortcut field, pencil, and ×. The pencil records a replacement in that same field; releasing a valid combination saves it. The × clears the assignment and changes to a Restore icon, which restores the extension’s default. While recording, × cancels the edit. Buttons have accessible names and tooltips, and errors appear below the row. The back button returns to the preserved search view; Firefox can dismiss its native popup directly on Escape. Firefox manages the assignment through its commands API. Firefox’s normal **⌘T / Ctrl+T** behavior stays unchanged.

The macOS default avoids Firefox’s built-in ⌘K search shortcut; it requires no browser shortcut customization. The standard extension API cannot automatically disable a built-in browser binding. See [Mozilla’s shortcut documentation](https://support.mozilla.org/en-US/kb/keyboard-shortcuts-perform-firefox-tasks-quickly).

Temporary installation lasts until Firefox restarts. After editing the files, click **Reload** in `about:debugging` and reopen the popup. Permanent distribution requires Mozilla signing; the ZIP produced by this project is unsigned.

## Interaction

| Key or action | Behavior |
| --- | --- |
| Type | Filter open-tab titles, hostnames, and URLs locally. The field starts with “Search or Enter URL...”. |
| ↑ / ↓ | Preview the selected tab/address URL in the field. The search action restores your typed query. Selection wraps. |
| Enter | Commit the highlighted tab or action, then close. Does nothing in the initial empty field. |
| ⌘Enter / Ctrl+Enter | Open the currently displayed address/search even when tabs match. Reuse the current Home/New Tab placeholder when available. |
| Escape or click elsewhere | Dismiss the popup. |
| Preferences | View, record, clear, or restore the popup shortcut in a native-style row. |

Recent tabs appear immediately, with no initial selection and a magnifier in the empty field. Typing selects the best match. Arrow-key URL previews preserve the original query used to filter the list; choosing the search action restores that query. Editing a previewed URL makes the edited text the new query. The input icon follows the highlighted action: a magnifier for search, a cached site icon when available, or a globe for an address.

Matching tabs are ranked ahead of an address or web-search choice. The search option displays only a magnifying glass and the typed query, with no prefix or subtitle. Only HTTP(S) tabs from the current window are listed. Tabs from the same site remain separate, with a title and path to identify them. Browser-internal pages, extension pages, local files, and other windows are excluded from results. Row labels omit query strings and fragments; a selected URL preview preserves the full address.

Before switching, the extension verifies that the destination still exists in the same window. Switching never removes an existing browsing tab. A closed or moved destination produces an error so another result can be selected.

Address and search commits reuse only the tab captured when the popup opened, and only when it remains an active, unpinned, fully loaded `about:newtab` or `about:home` page in the same window. Navigation, activation-away, removal, movement, or replacement disables reuse. A changed or unavailable placeholder falls back to a new destination tab. Ordinary websites, pinned pages, and `about:blank` documents are preserved. A failed operation never removes a reused placeholder.

Bare domains become HTTPS addresses. Localhost and loopback addresses use HTTP. Ordinary phrases become searches. Executable or privileged schemes, malformed HTTP URLs, and embedded URL credentials are rejected.

Searches always use Firefox’s current default search engine. The extension does not enumerate engines or store an engine override. The obsolete local `searchEngine` preference is removed on a best-effort basis when the popup loads.

As you type, matching open tabs appear first, followed by up to six history results and the address/search action. History matches URLs and titles across all dates, with a short debounce and at most 100 candidates per query. URLs already open in this window and duplicate fragment variants are omitted from history suggestions. Arrow keys preview the selected history URL; returning to the search action restores the original query. Enter opens the history destination, reusing an available Home/New Tab placeholder. An empty query shows open tabs only. History results use cached site icons or the globe fallback.

History lookups run locally through Firefox’s read-only search API; the extension never adds, deletes, logs, or stores history records. Late replies cannot replace a newer query or a deliberate arrow-key selection. Removing history refreshes the list and invalidates a deleted selection. Browser API errors leave open tabs and web search usable. Loading this version requires Firefox’s `history` permission.

## Development

Use Node.js 22.12 or newer. No `npm install` is needed.

```sh
npm test             # Matching, tab operations, and other unit tests
npm run test:ui      # Optional headless Firefox UI checks (requires puppeteer-core)
npm run check        # Manifest, syntax, CSP, and UI reference checks
npm run dev          # http://127.0.0.1:4173 — popup preview with example tabs
npm run build        # dist/extension + dist/search-or-switch-0.1.0.zip
npm run test:firefox  # Isolated Firefox smoke checks (Python 3, desktop Firefox)
```

The normal-browser preview embeds `popup.html` in a 560 × 480 frame, shrinking its width on narrow screens just as the native popup does. The surrounding `preview.html` page places its example-data label outside the panel, so the popup shares the extension’s markup, styles, and available content space. It uses illustrative tabs, bundled example icons, and an in-memory shortcut assignment, and never changes Firefox shortcuts or performs real tab/navigation actions. Load the extension in Firefox to test its native popup and keyboard behavior.

The optional UI checks use desktop Firefox and `puppeteer-core` (tested with 25.17.0, which declares Node.js 22.12+). Install the test tool with `npm install --no-save --package-lock=false puppeteer-core@25.17.0`, or set `PUPPETEER_MODULE` to an existing module path. Set `FIREFOX_BIN` if needed. The checks run the actual popup in isolated headless Firefox with browser API fakes, local fixtures, and no remote requests. They cover tab actions and URL previews, Home/New Tab reuse, blank-document preservation, inline shortcut editing, and favicon rendering in the input and result rows. Favicon cases include Firefox’s base64 SVG format, URL-encoded SVG, cached destinations, and broken-image fallback.

The optional native smoke script uses Python’s standard library and a separate, disposable Firefox profile. Set `FIREFOX_BIN` if Firefox is not on PATH or in its standard macOS location. It opens a visible isolated Firefox window by default; set `FFARC_HEADLESS=1` to try a headless environment. Local HTTP fixtures avoid external searches. If Marionette cannot enter the popup’s remote frame, it explicitly reports content checks as **SKIP**. A run with skips does not verify typing or selection. Unit tests use browser API fakes.

Desktop keyboard verification of the installed Firefox 160 extension passed **open shortcut → type → arrow preview → Enter** using local pages. Arrow keys updated the full displayed URL, returning to the search action restored the original query, and Enter activated the selected existing tab and closed the popup. A local PNG favicon supplied by Firefox appeared in the input without an image request from the popup; a non-supported icon fell back to the globe. The temporary test tab was closed afterward. No input click, focus command, or second shortcut was used. The full flow was checked with the previous ⌘⇧Y binding. The current ⇧⌘K default was then verified to open the popup and accept untargeted typing, with Escape dismissing it. Firefox’s original ⌘K Search binding was restored and separately verified. Earlier basic-flow checks also passed beside `about:debugging` and ordinary webpages.

Firefox must finish opening the native popup before it can receive typing; input sent before its first render can be lost. Real search-engine submission and Firefox 140 still need native coverage. URL creation and search dispatch are covered with browser API fakes.

The shortcut row was visually referenced against Firefox 160’s `about:keyboard` page, including its rounded field and pencil/clear controls. In the installed extension, × cleared the assignment, Restore brought back ⇧⌘K, and recording ⇧⌘U saved it when the keys were released. The replacement reopened the popup successfully. Clearing and restoring afterward left ⇧⌘K in place. The temporary debugging tab was closed and the original tabs were preserved. Unit tests and isolated Firefox UI checks cover clear failures, cancellation, recording, and the single-row layout at 300px.

The full-view Preferences layout was verified in Firefox 160, including the narrower unpinned popup. Its back button restored the selected tab’s address and subsequent arrow navigation restored the original typed query. The layout also passes light, dark, and narrow preview checks.

Favicon diagnosis in Firefox 160 found that Tweakers supplied a base64 SVG while The Verge supplied a PNG. Rejecting SVG prevented Tweakers’ input icon from appearing, and result rows had no image rendering at all. Both formats now display in the native popup rows; typing a Tweakers match also shows its SVG in the input. Regression checks cover both SVG encodings, PNG, cached address options, image failure, and icons retained after closing an observed tab.

History suggestions passed isolated Firefox UI checks and a live Firefox 160 check after the history permission was approved: a local preview page was visited, its favicon cached, and its tab closed. The native popup found that closed page through history, showed the cached icon in the input and result row, previewed its full URL with arrow keys, and reopened it with Enter while dismissing the popup. The test tab was closed afterward and the original browsing tabs were preserved.

Native Firefox 160 verification also confirmed that committing a local address from `about:newtab` replaced that same tab and dismissed the popup, with the browsing-tab count remaining at one. The original New Tab page was restored afterward. Home/New Tab reuse for both URL and search dispatch is additionally covered by the UI API-fake checks.

| File | Responsibility |
| --- | --- |
| `manifest.json` | Firefox metadata, permissions, native toolbar popup, `_execute_action` shortcut, and CSP. |
| `popup.html`, `popup.css` | Accessible combobox/listbox UI, stable popup layout, and light/dark appearance. |
| `popup.js` | Focus requests, selection, keyboard/mouse interaction, preferences, and live tab updates. |
| `popup-input.js` | Keeps the authored filtering query separate from selected URL previews and input icon intent. |
| `history-search.js` | Debounces bounded history queries and discards replies superseded by typing or popup closure. |
| `shortcut-settings.js` | Captures and validates combinations; reads, saves, clears, and restores only this extension’s popup command. |
| `favicon-cache.js` | Keeps bounded, browser-supplied inline icons by origin for the input and result rows, without network requests. |
| `popup-tabs.js` | Current-window identity, safe tab activation, and new-tab navigation/search. |
| `core.js` | Pure ranking, privacy-safe display labels, and destination parsing. |
| `preview.js` | Example tabs for browser preview only. |
| `preview.html`, `preview.css` | Development-only page that frames the actual popup and labels the example data outside it. |
| `icons/` | Bundled extension artwork. |
| `tests/` | Node tests with deterministic race and failure coverage. |
| `scripts/` | Checks, local preview, packaging, and optional Firefox smoke testing. |

The package contains the popup runtime, shared modules, preview data, icons, and license.

## Privacy and permissions

- **tabs:** Read titles and URLs to match your open tabs locally.
- **history:** Find matching previously visited URLs and titles while you type. Results stay in popup memory and are never written back to history.
- **search:** Submit queries through Firefox’s current default search engine.
- **storage:** Keep a bounded icon cache in `storage.local` across browser sessions. Private-window icons stay in that popup’s memory only. Shortcut assignments are managed by Firefox’s commands API.

Tab matching stays local. Tab titles and full URLs are not logged or saved. The icon cache stores at most 64 site origins and inline images, each encoded image limited to 64 KiB, with no URL paths or queries. SVG icons are displayed exclusively as images, never inserted as document markup. It makes no favicon requests. Only a query you deliberately submit is passed to Firefox’s chosen search engine. There are no analytics. The content security policy blocks network connections from the extension UI.

Firefox does not expose its full internal Places favicon cache through a public extension API. Icons for previously visited sites are available when an open tab supplies an inline icon or the extension cached one while the popup was open. Cached icons survive closing a tab and restarting Firefox. History search does not provide favicon images. See [Mozilla’s favicon API tracking issue](https://bugzilla.mozilla.org/show_bug.cgi?id=1315616).

## Firefox verification

Before release, verify the following in current stable Firefox and Firefox 140:

- **Shortcut → type → Enter** works with physical keyboard input and dismisses the popup after a successful action.
- Opening, typing, and dismissing the popup create no tabs.
- Switching activates an existing tab in the same window without removing browsing tabs.
- Addresses and searches reuse the captured Home/New Tab placeholder when it is still eligible; otherwise they create exactly one destination tab in the same window.
- Arrow keys, click, Escape, forced address/search actions, and preferences work.
- Arrow previews preserve the original result list, restore the query on the search action, and use edited preview text as the new query.
- Input icons track the highlighted action; cached site icons stay local and private-window icons are not persisted.
- Closed or moved results, multiple windows, pinned/discarded tabs, and no matches behave predictably.
- Screen-reader announcements, visible focus, and light/dark appearance remain usable.
- Firefox’s normal new-tab shortcut and new-tab page are unchanged.

API references: [toolbar popup](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/action), [keyboard commands](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/commands), [tab updates](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/update), [creating tabs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/tabs/create), [Firefox search](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/search/search), [temporary installation](https://extensionworkshop.com/documentation/develop/temporary-installation-in-firefox/).

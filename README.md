# Search or Switch

[![Checks](https://github.com/rutgerkra/search-or-switch/actions/workflows/ci.yml/badge.svg)](https://github.com/rutgerkra/search-or-switch/actions/workflows/ci.yml)

An Arc-inspired, keyboard-first tab switcher for Firefox. Open the popup, type, and press Enter to switch to an open tab, revisit a page, open a URL, or search the web.

![Search or Switch showing tabs and browsing-history suggestions](docs/preview-history.png)

## Features

- Search open tabs in the current window, with browsing-history suggestions below them.
- Preview destinations with the arrow keys, including locally cached favicons.
- Search using Firefox’s default search engine.
- Create a tab only when you commit an address or search. Reuse the current Firefox Home/New Tab page when available.
- Open with **Shift+Cmd+K** on macOS or **Ctrl+Shift+Space** on Windows/Linux, or use the toolbar button.
- Edit, clear, or restore the shortcut in Firefox-style Preferences.
- Follow the system’s light or dark appearance.

Built with plain HTML, CSS, and JavaScript, with no runtime dependencies or remote assets.

## Try it

This project is in development and is not yet published on Mozilla Add-ons. It targets **Firefox Desktop 140+**.

1. Download or clone this repository.
2. In Firefox, open `about:debugging#/runtime/this-firefox`.
3. Choose **Load Temporary Add-on…** and select `manifest.json` from the project folder.
4. Press **Shift+Cmd+K** / **Ctrl+Shift+Space**, or click **Search or Switch** in the toolbar.

Pin the toolbar button for the wider popup layout. A temporary installation lasts until Firefox restarts. After changing source files, click **Reload** in `about:debugging` and reopen the popup.

## Controls

| Action | Behavior |
| --- | --- |
| Type | Match tab and history titles, hostnames, and URLs. |
| ↑ / ↓ | Select a result and preview its full URL in the input. Returning to the search action restores your original query. |
| Enter | Commit the selected result and close the popup. |
| Cmd+Enter / Ctrl+Enter | Open the displayed address or search, even when a tab matches. |
| Escape | Dismiss the popup. |
| Preferences | Edit, clear, or restore the extension’s shortcut. |

Firefox anchors the popup to its toolbar. Opening, typing, and dismissing it create no tabs. Switching to a tab preserves existing browsing tabs. Firefox’s normal new-tab shortcut and page remain unchanged.

## Privacy and permissions

Matching happens locally. There are no analytics, remote suggestions, or favicon requests.

| Permission | Purpose |
| --- | --- |
| `tabs` | Match open-tab titles and URLs in the current window. |
| `history` | Find previously visited pages while you type. The extension never adds, deletes, or stores history records. |
| `search` | Submit a query you commit to Firefox’s default search engine. |
| `storage` | Keep a bounded cache of browser-supplied favicons. |

The icon cache contains at most 64 site origins and inline images, each limited to 64 KiB. It stores no URL paths or queries. Private-window icons stay in popup memory. History results and tab titles are not persisted. The extension UI’s content security policy blocks network connections.

Firefox’s public history API does not supply favicons. History results show a cached icon when the extension has observed one from an open tab; otherwise they show a globe.

## Development

Use **Node.js 22.12 or newer**. The default checks require no package installation.

```sh
git clone https://github.com/rutgerkra/search-or-switch.git
cd search-or-switch
npm test             # Unit tests
npm run check        # Manifest, syntax, CSP, and UI references
npm run dev          # Browser preview at http://127.0.0.1:4173
npm run build        # Unpacked extension and unsigned ZIP in dist/
```

The preview embeds the actual popup page at its native dimensions, with the example-data label outside the panel. It uses example data and does not control real tabs. Loading `manifest.json` directly in Firefox requires no build step. The ZIP is unsigned; permanent Firefox distribution requires Mozilla signing.

Optional isolated Firefox UI checks use `puppeteer-core`:

```sh
npm install --no-save --package-lock=false puppeteer-core@25.17.0
npm run test:ui
npm run test:firefox  # Python 3 and desktop Firefox; disposable profile
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and validation guidance, and the [development reference](docs/DEVELOPMENT.md) for implementation details.

The test suite includes unit tests and 36 isolated Firefox UI checks. The native shortcut, typing, selection, history, and tab-reuse flows have been tested in Firefox 160 on macOS. Firefox 140 and other operating systems still need native verification.

## License

[MIT](LICENSE) © 2026 Rutger Kraaijer.

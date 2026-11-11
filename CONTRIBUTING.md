# Contributing

Keep changes focused. For larger behavior changes, open an issue describing the interaction you want to improve before starting a pull request.

## Local setup

Use Node.js 22.12 or newer and Firefox Desktop 140 or newer. There are no runtime dependencies, and the default checks require no `npm install`.

```sh
npm test
npm run check
npm run build
npm run dev
```

Load the root `manifest.json` through `about:debugging#/runtime/this-firefox` to test the actual extension. The browser preview uses example data and cannot verify native popup focus or real tab operations.

## Validation

Run the unit tests, source checks, and build before submitting a change. For interface or interaction changes, also run the isolated Firefox UI checks:

```sh
npm install --no-save --package-lock=false puppeteer-core@25.17.0
npm run test:ui
```

Set `PUPPETEER_MODULE` to an existing Puppeteer Core module if preferred, and `FIREFOX_BIN` if Firefox is not in its standard location. Optional native smoke checks use Python 3 and a disposable profile:

```sh
npm run test:firefox
```

Set `FFARC_HEADLESS=1` to try the native smoke script headlessly. It reports checks it cannot perform as `SKIP`; a skipped content check does not verify typing or selection.

For keyboard or navigation changes, verify **shortcut → type → arrow selection → Enter** with physical keyboard input in Firefox. Confirm that the input receives focus immediately and the popup closes after a successful action. Include your Firefox version, operating system, and relevant validation in the pull request.

## Design constraints

- Preserve the query the user typed while arrow keys preview URLs.
- Create no tabs until the user commits an address or search.
- Switch to existing tabs without closing browsing tabs.
- Reuse only the eligible Firefox Home/New Tab placeholder captured when the popup opened.
- Keep matching and caches local. Display safe browser-supplied icons without remote requests.
- Use Firefox-style controls, accessible names, visible focus, and system light/dark appearance.

See [the development reference](docs/DEVELOPMENT.md) for implementation details.

Do not include private browsing history, credentials, or account details in issue descriptions, logs, or screenshots. Contributions are licensed under the project’s [MIT license](LICENSE).

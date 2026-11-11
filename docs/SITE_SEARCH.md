# Site-search feature spec

This is the originating spec for the site-search change. It describes the intended implementation and known platform exception. Native verification is limited to the checks explicitly recorded below; see [DEVELOPMENT.md](DEVELOPMENT.md) for validation status.

## Interaction

Preserve the ordinary popup flow: open tabs and history remain searchable, ordinary web searches use Firefox’s current default engine, and no tab is created before a committed action. Navigation reuses only the eligible Home/New Tab placeholder captured when the popup opened, otherwise creating one destination tab. Switching to an existing tab preserves browsing tabs.

Offer one Arc-style site hint independently of the highlighted ordinary result. A learned site matches a domain keyword prefix, such as `you` for YouTube. Firefox-installed engine names and aliases are available immediately, without automatic discovery or page access. Choose the shortest matching keyword first; break equal-length ties with stable keyword lexical order. Arc experiments support shortest-first behavior, but its exact internal tie rule has not been verified. Lexical ordering is this extension’s deterministic rule.

| Action | Result |
| --- | --- |
| Tab while a site hint is offered | Enter the offered site as a chip with an empty query field. |
| Type in site mode | Edit the query for that site; hide tab and history results. |
| Enter | Open the site’s native results page and dismiss the popup after success. |
| Cmd+Enter / Ctrl+Enter | Commit to the selected site, preserving site mode’s destination. |
| Backspace with an empty site query | Leave site mode and restore the original prefix that selected the site. |
| Click the site chip | Leave site mode and restore the original prefix. |
| Escape in site mode | Intended: leave site mode and clear the input, then dismiss on the next Escape. Native Firefox closes immediately; see the platform exception below. |
| Reopen the popup | Start in ordinary mode with no remembered chip or query. |

Entering site mode must not depend on the currently highlighted tab, history result, or default-search action. The chip identifies the chosen site throughout query entry. There are no remote suggestions or remote icon requests.

### Native Escape exception

First-Escape exit/clear is the requested interaction, implemented on a best-effort basis when the host delivers the key. Firefox’s native action popup consumes physical Escape and closes before the extension’s DOM handler receives it. Mozilla intentionally preserves this behavior ([decision](https://bugzilla.mozilla.org/show_bug.cgi?id=1443758#c5), [popup keyboard handling](https://searchfox.org/firefox-main/source/layout/xul/nsXULPopupManager.cpp#2401)). Empty Backspace and clicking the chip provide reliable ways to leave site mode without closing the popup.

Physical keyboard verification in Firefox 160 on macOS passed shortcut → immediate `goo` typing → Tab into a site chip, and confirmed native Escape dismissal. The standalone-page UI check verifies the extension’s DOM handler only; it is not evidence that native Escape can be intercepted. Native result-page commits and discovery are still pending.

## Automatic discovery

Preferences contains one **Automatic site discovery** toggle, on by default. The checkbox reflects the saved preference, whether or not optional normal HTTP(S) page access has been granted. When discovery is on without that access, show **Allow website access**. Clicking it makes the one-time Firefox permission request. Granting access starts the initial scan of existing non-private tabs and permits learning on future visits. Declining preserves the prior preference state and starts no learning. Turning the toggle on with access already granted also scans existing normal tabs. Installed engines remain usable without page access. A discovered search becomes enabled immediately.

Accept only:

- Standard OpenSearch GET templates for `text/html` results pages.
- Unambiguous GET search forms whose reusable search destination can be determined from markup.

Do not infer POST searches, JavaScript search behavior, ambiguous forms, or private-page searches. Do not read or save user-entered input values. Only safe static markup defaults, such as Wikipedia's `title=Special:Search`, may enter a reusable template. Discovery is automatic: there is no manual site-management list, editor, add-site form, or per-site approval step.

Turning discovery off or revoking HTTP(S) access stops learning while retaining learned definitions. Existing learned searches remain usable. A separate **Clear learned searches** control removes only learned definitions; it leaves the toggle, website-access grants, and Firefox-installed engines unchanged. If discovery remains on with access granted, later visits may learn those sites again.

### Missing-access prompt

When discovery is enabled but website access is missing, show a compact, non-blocking prompt directly below the main search field, with ordinary results still usable beneath it. Use short copy: “Allow website access to discover search shortcuts as you browse.” Place **Allow website access** and **Turn off discovery** next to each other horizontally. Use the panel’s Firefox-style controls, spacing, colors, visible focus indicators, and system light/dark appearance.

Keep the prompt visible across popup openings and permission refusals until access is granted or discovery is turned off. Allow requests Firefox’s native permission dialog directly from the user action; Firefox explains the full permission scope. A deliberate refusal adds no visible error. Unexpected failures show a concise inline error in the prompt. Turning discovery off uses the existing global preference and retains learned searches.

Preserve initial input focus, the authored query, and Tab-to-site behavior. ArrowDown from the search field enters the prompt with **Allow website access** focused. Left/Right switches between its two buttons; Enter/Space activates the focused button. ArrowDown from either button continues to the first result, while ArrowUp returns to the search field with the query intact. ArrowUp from the first result returns to the prompt. Both buttons are also reachable through Tab/Shift+Tab, with no focus trap. After a permission attempt or turning discovery off, restore search-field focus without replacing the authored query.

## Runtime and data boundaries

Use a Firefox MV3 module event page in `background.js`. Keep site-search state, keyword selection, and safe definition parsing in `site-search.js`; permission-aware discovery and metadata fetching in `site-discovery-service.js`; and injected DOM extraction in `site-discovery.js`.

The extension requires `scripting` and requests optional host access for normal HTTP(S) pages through **Allow website access** in the main prompt or Preferences. The default-on preference alone grants no access and performs no learning. Background fetches are limited to HTTP(S) discovery metadata. The popup retains its own `connect-src 'none'` policy. No remote suggestions, scripts, artwork, or icons are needed.

Store learned definitions locally: names, keywords, site origins, and reusable templates. Store the discovery preference locally as well. Do not save entered queries, search-query history, entered form values, account/session parameters, full visited URLs, or sync data. Private tabs never contribute learned definitions. The existing bounded browser-supplied favicon cache keeps its separate privacy rules.

Installed Firefox engines remain managed by Firefox. Clearing learned definitions must not remove, edit, or disable them, and selecting one for a site search must not change Firefox’s default engine.

## Acceptance checks

- Offer the matching site hint even when an ordinary tab or history result is selected; verify shortest-first and stable lexical ranking.
- Enter site mode with Tab and leave with empty Backspace or the chip; verify query handling, hidden ordinary results, and a fresh popup on reopening. Verify Escape’s DOM exit/clear handler where the host delivers it, and document native Firefox’s immediate dismissal.
- Submit installed-engine and learned-site queries with Enter and Cmd/Ctrl+Enter; verify the selected destination, popup dismissal, and existing tab-reuse rules.
- Keep ordinary default-engine search, tab switching, and no-tab-before-commit behavior intact.
- Verify discovery is checked by default and performs no learning without page access. Approve **Allow website access**, scan existing normal tabs and future visits, and learn supported OpenSearch and GET-form definitions immediately. Declining must preserve the preference and leave installed engines usable.
- With access missing, verify the persistent, horizontal main prompt, arrow and Tab navigation, quiet refusals, visible retry errors, and query/focus preservation. Turning discovery off must retain learned searches. Search focus must return after permission completes, including while an initial scan is still pending.
- Reject unsupported or ambiguous definitions, exclude private tabs, and preserve the documented local-data boundaries.
- Stop learning on toggle-off or permission revocation; retain learned definitions. Clear only learned definitions, preserve the toggle, grants, and installed engines, and allow later relearning while enabled with access.

Unit and isolated UI checks can verify model, parsing, races, and browser API behavior. Physical keyboard input in the installed Firefox extension is required to verify native focus, shortcut handling, site-mode interaction, result-page navigation, and permission UI. The native status above is limited to the shortcut, typing, chip entry, and Escape checks actually completed.

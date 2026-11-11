# Arc command-bar findings

Investigation date: 2026-11-11. Installed Arc **1.172.1 (90370)** on macOS **26.7.1 (25G241)**. These are completed native-UI experiments, supplemented by read-only shipped-binary metadata and first-party documentation. This is a bounded behavioral investigation, not a claim of exhaustive parity or recovered source code.

## Main findings

Arc does not follow a universal “URL → search → matches” or “best tab → search → remaining matches” order. Controlled local pages produced two counterexamples:

- With Alpha open and Beta active, entering `http://127.0.0.1:47319/alpha` gave **URL (selected) → Alpha / Switch to Tab → search**. The globe, switch label, and magnifier were visually checked. Enter on the URL created a second Alpha tab; choosing the switch result later selected the original tab without adding a third.
- With Alpha open and Beta active, `FFArc Nebula` and the exact title `FFArc Nebula Alpha 7319` put the **authored-query row first and selected**, above Alpha / Switch to Tab. Shorter `FFArc` and `Nebula` instead promoted Alpha above that query row. Thus an available matching tab does not always become the default. The multiword query rows were not committed; their search semantics are inferred, while their priority over the explicit Switch to Tab action is directly observed.
- Closed fixture history could also become the default: `Lyra` promoted its matching history page, but its full multiword title put the query row first.
- Authored query, inline completion, selected row, and committed action are separate state. A completed `/alpha` field still retained authored `/a` for the search alternative. Cmd+Enter opened a background duplicate and kept the command bar open in that case; Ctrl+Enter did not do the same.
- The shipped bundle contains a domain-specific deduplication list and a ranking-candidate data schema. These are concrete static-analysis leads, not evidence of an active model's weights or runtime decisions.

These are high-confidence observations for the tested inputs and profile, not a recovered scoring formula. They do not authorize changing the already approved Firefox implementation.

## Observation method and privacy

A new Arc window was used with the existing profile and search configuration unchanged. Synthetic pages were served only on loopback at `http://127.0.0.1:47319`; they contained a title, matching heading, and one sentence, without external resources. ASCII inputs used native typing, and the completed Japanese-input test used paste. Entry used native Cmd+T/Cmd+L and keyboard events, followed by accessibility-state inspection. Selected row, field text, selected text range when exposed, and committed page/tab were recorded separately. Visual checks were used where accessibility exposed identical text for search and URL actions.

The existing profile is not a clean or controlled corpus. Its private rows, titles, URLs, and history are omitted. No screenshots are saved with this report. Remote suggestions were visible in some tests; their backend, latency, and settings were not controlled. Committed searches went to **DuckDuckGo**; that is the observed engine for these tests, not a settings audit. No preference, permissions, signature, or security changes were made. No REA or decompiler was installed or run. Existing Firefox code, tests, and dirty files were untouched.

Two computer-use conflict warnings occurred. State was refreshed after each; exploration ended after the second, followed by cleanup. Non-ASCII typing calls that failed to produce the intended field text were excluded from behavioral conclusions. The Japanese paste was checked against the exact intended field text. There was no IME/composition test. One later Cmd+L AX snapshot reported only a port substring selected, unlike an earlier full-URL selection; the Cmd+L test therefore establishes navigation semantics, not a universal text-selection range.

Fixture pages actually visited:

| Path | HTML title | Purpose |
| --- | --- | --- |
| `/alpha` | `FFArc Nebula Alpha 7319` | Open-tab matching and exact-URL duplication |
| `/beta` | `FFArc Nebula Beta 7319` | Active-tab contrast and arrow preview |
| `/history` | `FFArc Lyra History 7319` | Visited, then closed before history-only queries |

No tab was created just by displaying query results. Tabs were added by the tested commits. The two search-result tabs were closed immediately after reading their URLs; the history fixture was closed before its queries; all four remaining fixture tabs were closed at the end. Final AX state contained no fixture tab/page and no command bar. The new window was retained because it contained non-fixture content. The loopback server exited, and a final listener check found nothing on port 47319. Synthetic visits/searches may remain in history/archive; existing history was not cleared.

## Direct observations

Unless a row states otherwise, entry is Cmd+T with all prior field text replaced, and confidence is high for the visible state in this Arc build. “Search” is confirmed where an icon or committed search URL was checked. “Query row” preserves the AX evidence where that action was not independently committed or visually classified. A displayed globe is not proof of the final committed URL. These observations do not identify the remote/local provenance of every suggestion.

| ID | Input and state | Result |
| --- | --- | --- |
| O01 | `ffarcquasar7319`, before synthetic fixture visits | One selected query-text row; no matching tab/history rows. No commit. |
| O02 | `https://example.com/ffarc-order-check-7319`, unmatched | Two rows with the input text; first selected. Destination versus search semantics are not established by AX text alone. |
| O03 | `ffarc7319.example`; `ffarc7319.local`; `localhost:47319`, before fixture visits | Each gave two input-text rows, first selected. No navigation performed in these tests. |
| O04 | `?google.com` | One selected row displaying the literal input. Enter opened `https://duckduckgo.com/?q=%3Fgoogle.com&ia=web`: the leading `?` was preserved in the search query, not stripped. |
| O05 | `site:example.com ffarc7319` | Search selected first; a second globe action with the same text appeared. Icons visually verified. Neither committed in this test. |
| O06 | `http://example.com:99999` | First selected row displayed full input; second displayed `example.com:99999`. No commit; cannot call the invalid port valid based on this display. |
| O07 | `user@example.com` | First selected row displayed `example.com`; second displayed the full email-like input. No commit; final URL and credentials semantics unestablished. |
| O08 | `FFArc Nebula`, Alpha open, Beta active | Query row selected first; Alpha / Switch to Tab second; Beta as a URL/history-style row third. Order remained the same on a later observation. |
| O09 | `FFArc Nebula Alpha 7319`, Alpha open, Beta active | Query row selected first; Alpha / Switch to Tab second; Ask ChatGPT action also appeared. That action was not invoked. |
| O10 | `FFArc`; `Nebula`, Alpha open, Beta active | Alpha / Switch to Tab selected first; query row second; current Beta appeared as a URL/history-style row, not a Switch to Tab result. Other profile/remote rows omitted. |
| O11 | `127.0.0.1:47319/alpha`; `http://127.0.0.1:47319/alpha`, Alpha open, Beta active | URL selected first; Alpha / Switch to Tab second; search third. Explicit form visually verified. |
| O12 | Enter on O11 explicit URL | A new Alpha tab was created. Sidebar then contained two Alpha tabs and one Beta. A subsequent `FFArc` default Switch to Tab chose the original Alpha without increasing the count. |
| O13 | O08, Down then Up | Down selected Alpha and changed field to `127.0.0.1:47319/alpha`; Up selected the query row and restored authored `FFArc Nebula`. Preview omitted `http://`. |
| O14 | O08, Up from first row; Down from last | Up wrapped to Beta, field `127.0.0.1:47319/beta`; Down wrapped to the query row, restoring authored text. |
| O15 | `/history` visited and closed; `Lyra`, then `FFArc Lyra History 7319` | Short query: matching history page selected first, query row second. Full title: query row selected first, history page second. History can own the default; no competing open Lyra tab existed. |
| O16 | `127.0.0.1:47319/a`, an Alpha active and another Alpha open | Field completed to `127.0.0.1:47319/alpha`, with `lpha` selected. Order visually confirmed as Switch to Tab → search for authored `/a` → URL for authored `/a`. A syntactically URL-like prefix can therefore default to a matching tab. |
| O17 | O16, separate Right, Tab, and Backspace trials | Right and Tab left the completed `/alpha` field with no selected suffix reported. Backspace removed `lpha`, leaving `/a`; the Switch to Tab row moved below the two authored-input rows. No commit after those editing keys. |
| O18 | O16, Down then Enter | Field restored authored `127.0.0.1:47319/a`. Enter opened `https://duckduckgo.com/?q=127.0.0.1%3A47319%2Fa&ia=web`, confirming that explicit search used `/a`, not the completed `/alpha`. |
| O19 | O16, separate Cmd+Enter and Ctrl+Enter trials | Cmd+Enter added a background Alpha: fixture count rose from three to four, active Alpha stayed selected, and bar stayed open. Ctrl+Enter afterward left fixture count, active page, and open bar unchanged. High confidence for these observed effects; not a general modifier specification. |
| O20 | Cmd+L on current fixture, then replace field with already-open `http://127.0.0.1:47319/beta` and Enter | Initial field showed the full current URL. Replacing it navigated the current Alpha tab to Beta: four fixture tabs before and after, now two Alpha and two Beta. Cmd+T URL commit had instead added a tab (O12). |
| O21 | `ffarc7319`; `ffarc7319/path`; `ffarc7319:47319`; `[::1]:47319`; `127.0.0.1:47319/alpha?x=1#fragment` | Single label gave one selected query-text row. The other four gave two authored-input rows, first selected. These were display-only trials; scheme fixup, IPv6 reachability, and committed destinations remain unestablished. |
| O22 | Incomplete `http://` | An existing profile result was selected first, with the authored query row below it. Private result details omitted. No commit. Incomplete scheme did not simply produce an empty/invalid-only UI in this profile. |
| O23 | Pasted `例え.テスト`, exact field text verified after conflict warning | One selected query-text row. No commit or icon verification; this does not establish Unicode domain normalization or IDN navigation behavior. |
| O24 | Cmd+T while the bar was already open | Dismissed the bar. An initial batch that accidentally toggled it closed was excluded and rerun with Escape followed by Cmd+T for each input. |

## Read-only shipped-artifact evidence

These are local primary artifacts from the same installation. No function body was decompiled, no process was attached, and no runtime model evaluation was traced.

### Domain-specific deduplication configuration

The installed [command_bar_behavior.json](/Applications/Arc.app/Contents/Resources/ARC_CommandBar.bundle/Contents/Resources/command_bar_behavior.json) contains one key, `dedupByTitleAndHostList`, with:

`figma.com`, `maps.google.com`, `notion.so`, `app.notion.com`, `zoom.us`, `opentable.com`, `zillow.com`, `github.com`, `app.mode.com`, `console.cloud.google.com`.

SHA-256: `45f53d197e00dda1808625cb170867a0b39575db97f79e3c7367d254d9dcb3bd`.

**High confidence:** these exact domains ship in this configuration. **Inference, medium confidence:** they are intended to receive special title-and-host deduplication. The consuming code, domain/subdomain matching rules, eligibility, and runtime applicability were not traced. The generic loopback duplicate result in O12 cannot establish behavior for the listed hosts. Same-title pages on those hosts are a meaningful missed comparison case, not an already proven Arc rule.

### Ranking candidate schema

The installed [ArcCore binary](/Applications/Arc.app/Contents/Frameworks/ArcCore.framework/Versions/A/ArcCore), universal-file SHA-256 `aacb29669c253804ed263f5105a9869dcda0b6a083a58ef7b96bb10da4287dd5`, exports Objective-C classes including `ArcAutocompleteMatch`, `ArcAutocompleteResult`, `ArcBrowserContextAutocomplete`, and the `ArcCommandBarRanking…` family with suffixes `Candidate`, `Evaluation`, `Example`, `Input`, `Model`, `Result`, `Tensor`, and `TrainingResult`.

Its arm64 Objective-C/C++ metadata exposes these candidate properties:

| Identity/content | Candidate signal fields |
| --- | --- |
| `candidateID`, `archetype`, `destination`, `title`, `url` | `lastNavSeconds`, `freqEver`, `typedCount`, `siteEngagement`, `isExactURLMatch`, `isBaseDomainMatch`, `isTitlePrefix`, `titleEmbedding` |

**High confidence:** the shipped schema contains these names and the underlying C++ structure. **Not established:** whether a learned model is active for these tests, field values, feature computation, score weights, thresholds, fallback ordering, training use, or personalization. The existence of `TrainingResult` or `titleEmbedding` alone does not prove any particular runtime mechanism. The schema makes title/URL exactness, usage, and contextual ranking worth controlled follow-up; it does not explain the observed multiword-query promotion by itself.

Reproduction commands, all read-only:

```sh
cat /Applications/Arc.app/Contents/Resources/ARC_CommandBar.bundle/Contents/Resources/command_bar_behavior.json
xcrun nm -gj -arch arm64 /Applications/Arc.app/Contents/Frameworks/ArcCore.framework/Versions/A/ArcCore | rg -i 'OBJC_CLASS_\$_Arc(Autocomplete|BrowserContextAutocomplete|CommandBarRanking)'
xcrun otool -arch arm64 -ov /Applications/Arc.app/Contents/Frameworks/ArcCore.framework/Versions/A/ArcCore | rg -m1 -A160 -B2 'name .*ArcCommandBarRankingCandidate$'
```

## Product implications and recommendations

1. **Keep the approved Firefox ordering described as a deliberate approximation.** O08–O12 and O16 are counterexamples to a single universal Arc ordering rule. Do not silently replace the approved implementation with a guessed formula. First decide which observed exceptions are in scope.
2. **Maintain separate authored text, displayed text, selection/completion, and action identity.** O13–O19 make this distinction observable: arrow preview restores the query; the search alternative uses authored `/a`; a modifier can create a background tab while keeping the bar open. A matching screenshot of the field alone is insufficient parity evidence.
3. **Test short and multiword queries separately for tabs and history.** O08–O10 and O15 show different defaults with the same fixture available. Query length/tokenization, provider eligibility, and intent are candidate explanations, not established causes.
4. **Treat exact open URLs, duplicate URLs, and the active tab as separate use cases.** O11–O12 show navigation can deliberately duplicate an open URL while a distinct switch action reuses a tab. O10 shows the active page can still appear as a URL/history-style result. The tie-breaker among duplicate tabs remains unknown.
5. **Add domain-specific deduplication to the comparison backlog.** The shipped host list provides a focused static lead. Test same title/same host/different path, same title/different host, and duplicate URLs on both listed and unlisted hosts with permitted non-sensitive pages. Do not extrapolate the loopback behavior to all sites.
6. **Keep site search and commands as explicit product-scope choices.** Arc's first-party action list includes navigation, organization, settings, and tool actions. Historical notes document shortcut-plus-Tab Site Search and Tab-based action exploration; this investigation only observed an Ask ChatGPT suggestion, without entering or invoking those modes. [Arc command-bar actions](https://start.arc.net/command-bar-actions), [2023 macOS release notes](https://resources.arc.net/hc/en-us/articles/20498377604887-Arc-for-macOS-2023-Release-Notes)
7. **Test modifiers individually.** Cmd+Enter and Ctrl+Enter differed here. Historical Arc notes describe Shift+Enter Instant Links, conditional on that feature; it was not invoked and should not be inferred equivalent to either observed modifier. [2024–2026 macOS release notes](https://resources.arc.net/hc/en-us/articles/20498293324823-Arc-for-macOS-2024-2026-Release-Notes)
8. **Preserve existing validation and privacy choices.** The email-like and invalid-port rows are display evidence only. Their presence is not permission to support credentials, unsafe schemes, invalid ports, or broader profile/window access in Firefox. `?google.com` does match the extension's literal-prefix search behavior in the observed profile.

## Coverage and remaining unknowns

The [earlier 26-group matrix](ARC_COMMAND_BAR_RESEARCH.md) remains the wider comparison plan. “Partial” below means at least one actual UI case ran; it does not mean the group is complete.

| Matrix group | Completed coverage / limit |
| --- | --- |
| URL ordering | Partial: unmatched URL display, exact open URL, URL-prefix completion; O02, O11–O12, O16. |
| Text ordering | Partial: short, multiword, and exact title; O08–O10. |
| No match | Partial: unique text, synthetic domains, explicit URL; O01–O03. |
| History only | Partial: visited/closed Lyra, short versus full title; O15. |
| Provider competition | **Unrun** controlled strong-history/weak-tab comparison. |
| Equal candidates | Partial: duplicate Alpha URL and switching; no controlled recency/title/position tie-breaker. |
| URL variants | Partial display cases and local HTTP commits; no comprehensive normalization matrix. |
| Local addresses | Partial: localhost port, IPv4, IPv6 display, single label/path/port; no single-label navigation or default-scheme commit. |
| Ambiguous text | Partial: `?`, `site:`, email-like text and path/port; O04–O07, O21. |
| Incomplete/invalid | Partial display only; incomplete scheme and invalid port, O06/O22. |
| Restricted schemes | **Unrun.** |
| Unicode/composition | Partial paste display; no IME, normalization, accents comparison, or commit; O23. |
| Empty input | Opening state seen; empty Enter, whitespace, and empty-arrow behavior **unrun**. |
| Inline completion | Partial: prefix, Right, Tab, Backspace, search commit; O16–O18. End/Delete and post-accept edit semantics unrun. |
| Arrow previews | Partial: Up/Down, restoration, both wrap boundaries; O13–O14/O18. |
| Modifiers | Partial: Cmd+Enter/Ctrl+Enter on one completed prefix; O19. Shift/Option unrun. |
| Rapid/asynchronous input | No controlled latency/immediate-Enter/stale-reply test. One settled order recheck is not timing coverage. |
| Tab mutations | **Unrun** while the bar remained open. |
| Entry points | Partial: Cmd+T versus Cmd+L URL commit, and Cmd+T dismissal; O12/O20/O24. Toolbar invocation unrun. |
| Window/profile scope | **Unrun** controlled comparison. New window reused existing profile; no separate Space/profile/incognito fixture. |
| Site hints | **Unrun** controlled comparison. |
| Site mode lifecycle | **Unrun.** |
| Firefox discovery prompt | Not an Arc behavior; existing extension contract unchanged and not tested here. |
| Suggestions/actions | Partial: remote suggestions and Ask ChatGPT row observed; offline/settings toggles and action execution unrun. |
| Commit lifecycle | Partial: new URL, duplicate URL, switch, explicit search, current-URL edit, background commit; failure/repeated-Enter handling unrun. |
| Accessibility/native host | Native shortcuts and AX state used; screen reader, zoom/narrow UI, IME, and immediate-focus timing unrun. |

The largest unresolved questions are the provider-mixing formula, short-versus-multiword default thresholds, duplicate-tab tie-breakers, cross-Space/profile scope, host-list deduplication semantics, and site-mode lifecycle. A future pass should use an agreed isolated corpus and fixed settings, then target the shipped ranking/deduplication seams only where an observed discrepancy needs explanation.

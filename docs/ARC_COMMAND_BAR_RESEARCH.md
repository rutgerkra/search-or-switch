# Arc command-bar research: REA feasibility and behavior coverage

Researched 2026-11-11. REA source inspected at [commit `2fe0c9e`](https://github.com/morluto/rea/tree/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd), whose package version is 6.8.0. This is an assessment and proposed investigation, not a completed decompilation. No REA installation, downloaded-code execution, debugger launch, Arc modification, or new UI experiment was performed for this note.

## Answer

**REA could help explain specific parts of Arc's search and URL bar and expose additional cases. It cannot credibly guarantee full recovery of every rule or missed case.** It orchestrates analysis engines and retains evidence; it does not turn a shipping native binary into its original source or a proof of complete behavioral equivalence. Its native workflow combines function inventories, decompiler output, references, metadata, and bounded runtime observations, all with explicit coverage limits. [REA native investigation](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/docs/guides/native/native-investigation.md)

For this extension, the highest-value next step is a reproducible Arc behavior matrix. Use focused static analysis when observations leave a concrete ambiguity, such as whether exact host matches suppress tab switches, how history competes with tabs, or what a special prefix activates. The deliverable should be a versioned behavior specification with known exceptions and executable Firefox regression cases. “All agreed cases match this Arc version” is achievable; “all possible Arc behavior has been recovered” is not established by these tools.

## Evidence and practical limits

| Capability | What it can establish | Boundary for this investigation |
| --- | --- | --- |
| Installation inventory | Paths, headers, runtime candidates, supporting components | Does not establish which component executes command-bar logic; default scan is bounded and child symlinks are not followed. [Docs](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/docs/desktop-applications.md), [source](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/src/artifacts/DesktopApplicationReader.ts#L265) |
| Native static analysis | Function pseudocode, instructions, strings, call/reference candidates through Hopper, Ghidra, IDA, or Kuna | Provider availability and recovered functions bound coverage. Decompiled code and static references do not establish which branch ran for a particular input. [Docs](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/docs/guides/native/native-investigation.md#start-with-a-function) |
| Objective-C / Swift metadata | Useful names, implementations, simple witnesses, and supported class vtables | REA explicitly does not decode generic/resilient Swift tables and other metadata families, including async/coroutine/override coverage. A missing decoded method is not proof that the behavior is absent. [Source](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/src/native/AppleDispatchCoverage.ts#L180) |
| Native UI observations | Selected-window screenshots and accessibility information; supported AX scenarios | Requires Screen Recording/Accessibility access. AX scenarios do not inject arbitrary global keys, so they alone do not verify physical Cmd+T, arrows, Tab, Escape, or IME behavior. State changes are not automatically restored. [Docs](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/docs/guides/native/native-investigation.md#native-desktop-observation) |
| Native call tracing | Named entry hits, integer argument registers, caller frames in a process REA launches under LLDB | No existing-process attach, return values, stack/FP arguments, or inlined entry hits. Pausing changes timing. Hardened runtime without `get-task-allow` blocks this documented route. [Source](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/src/native/NativeCallObservation.ts#L35), [debugger requirement](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/src/native/LldbCallTracer.ts#L213) |
| Web/CDP analysis | An eligible page's DOM, scripts, accessibility, and observed network events | Page inspection does not automatically expose the browser's native command bar. First establish where the relevant UI and logic live. This is an inference from the documented page-target scope, not a claim that Arc cannot expose any useful debugging page. [Docs](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/docs/guides/web/browser-observation.md#shipped-surfaces) |

Local read-only checks found:

- `/Applications/Arc.app` is version **1.172.1**, build **90370**, identifier `company.thebrowser.Browser`. Its main executable is a universal x86_64/arm64 Mach-O; the framework inventory includes `ArcCore.framework`. These establish the installed artifact, not the exact component implementing ranking.
- `codesign -dv /Applications/Arc.app` reports `flags=0x10000(runtime)`. `codesign -d --entitlements - /Applications/Arc.app` succeeds and lists no `com.apple.security.get-task-allow`. **Inference, high confidence:** REA's documented LLDB path is unavailable for this signed installation under normal protections. No debugger launch was attempted. Apple's debugger entitlement documentation independently describes the task-port restriction. [Apple](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.cs.debugger)
- No `rea`, `ghidra`, or `analyzeHeadless` command was on PATH; the standard Hopper/Ghidra app locations checked were absent. This is not an exhaustive inventory of every custom install location. Xcode's LLDB and Java 21 are present.
- Default PATH Node is 20.6.0; MISE also has 22.14.0. `/private/tmp/ff-arc-tools/node_modules/.bin/node` is **22.23.4**, which satisfies the inspected REA package requirement (`^22.23.4 || ^24.22.1 || >=26.12.1`). A compatible Node is available by explicit path; REA and a native analysis provider would still need setup. [REA package manifest](https://github.com/morluto/rea/blob/2fe0c9eb6a5fa3f8fa181fee3b6465f0f240f6bd/package.json#L45)

Do not make re-signing Arc, weakening host protections, or replacing the user's browser an implicit prerequisite. The useful static and behavioral work can proceed independently of native call tracing.

## What the present evidence supports

These are **session observations supplied by the primary investigator**, not new experiments performed while writing this note:

| Input | Observed result order in installed Arc | Confidence and limit |
| --- | --- | --- |
| `google.com` | Direct URL first and selected; web search second; matching tabs/history afterward | High for this input and current profile; does not establish every URL classification case. |
| `https://example.com/ffarc-order-check` with no matches | URL first; web search second | High for an explicit URL with no matches. |
| `calendar` | Best matching tab first and selected; web search second; history afterward | High for this word and current data; does not establish a cross-provider scoring formula. |

The approved extension rule is therefore URL → search → matches for recognized URLs; best match → search → remaining matches for ordinary text; search first when ordinary text has no matches. Preserve the empty-input, validation, and dedicated site-search flows. The working-tree implementation expresses this in [popup.js](../popup.js), while classification and provider-local ranking live in [core.js](../core.js).

This is an intentionally narrow inference from observed cases. It does **not** prove that all Arc versions, profiles, suggestions settings, or entry points obey one universal ordering rule.

Chromium's public controller illustrates why timing and default selection deserve separate tests: it aggregates multiple providers, handles synchronous/asynchronous passes, optionally reranks, and preserves a prior default match. Its input tests also include ambiguous hostnames, forced-query prefixes, ports, URL fixups, and platform differences. These are candidate cases to investigate, **not proof that Arc's wrapper uses the same rules or current Chromium revision**. [Controller source](https://chromium.googlesource.com/chromium/src/+/HEAD/components/omnibox/browser/autocomplete_controller.cc#1635), [input tests](https://github.com/chromium/chromium/blob/main/components/omnibox/browser/autocomplete_input_unittest.cc)

## Behavioral categories that need explicit decisions

Review of [core.js](../core.js), [popup.js](../popup.js), [popup-input.js](../popup-input.js), [history-search.js](../history-search.js), and the [site-search spec](SITE_SEARCH.md) identifies these important gaps in the **Arc comparison**, even where extension regression tests already exist:

1. **History-only defaults and provider competition.** Tabs and history are ranked separately; the extension places all matching tabs before history. Determine whether a very strong history match ever outranks a weak tab match in Arc. Equal-title tabs use recency and position locally; that is not yet an observed Arc formula.
2. **Ambiguous input.** Single-label intranet hosts, unknown suffixes, partial schemes, path-only input, email-like text, leading query prefixes, Unicode/IDN, whitespace, and invalid ports can cross the URL/search boundary. The extension deliberately rejects credential URLs and executable/privileged schemes; discovering more permissive Arc behavior does not authorize removing those constraints.
3. **Selection versus input editing.** Record typed text, highlighted row, inline completion, selected text range, arrow preview, and committed destination separately. A screenshot of a row alone cannot establish what Enter or editing the preview will do.
4. **Arrival and mutation timing.** The extension queries history after a 120 ms debounce and rejects stale replies. Test immediate Enter, late results, active arrow selection, moved/closed tabs, and rapid query edits. Otherwise the same string can appear to have inconsistent ordering.
5. **Search scope and context.** Current-window tabs, other windows, pinned/favorite tabs, Spaces/profiles, incognito windows, and Cmd+T versus editing the current URL may differ. The extension's current-window contract is explicit; it is not evidence of Arc's scope.
6. **Additional command-bar modes.** Arc's first-party command list documents actions including navigation, Space operations, and settings. Its historical release notes document Tab into actions, removable suggestions, site search, and Shift+Enter Instant Links. These justify discovery cases, but their current availability must be rechecked in installed Arc. They are product-scope choices, not automatically required features for this tab/search extension. [Arc actions](https://start.arc.net/command-bar-actions), [2023 notes](https://start.arc.net/release-notes), [2024–2026 notes](https://resources.arc.net/hc/en-us/articles/20498293324823-Arc-for-macOS-2024-2026-Release-Notes)
7. **Platform exceptions already accepted.** While the extension's discovery-access prompt is visible, the first Down from an automatically selected result focuses **Allow website access**, rather than moving straight to web search. Also, native Firefox Escape dismisses its action popup before the DOM handler can perform a site-mode exit. Preserve and test both exceptions. [Prompt contract and Escape exception](SITE_SEARCH.md)

## Proposed investigation stages

1. **Freeze the observation context.** Record Arc build, OS, entry shortcut, active Space/profile/window, engine, suggestion-related settings, network state, and anonymized fixture tabs/history. Use synthetic destinations and a dedicated test context where possible. Keep real profile contents out of the report.
2. **Characterize behavior first.** Execute the matrix below in Arc with physical keyboard events. Capture result order, initial selection, field text/selection, mode, and final action. Observe immediately and after suggestions settle; repeat cases that change. A selected row is separate from focus and separate from preview text.
3. **Inventory and target static analysis if needed.** Set up a pinned REA version with an explicit compatible Node and a supported provider. Inspect the bundle, Mach-O/signature, then selected strings/symbols/Swift or Objective-C metadata. Follow references only for named questions such as URL classification, result grouping, or site-hint ranking. Save binary digest, architecture, provider/version, function addresses, evidence, and unresolved calls. Avoid an unbounded “decompile everything” first step.
4. **Correlate evidence.** Compare specific observations with recovered candidate functions and an identified Chromium version if one can be established. A matching function name or constant is a clue; strengthen it with callers, values, control flow, and an observable counterexample. Treat remote suggestion behavior and unavailable server-side decisions as unknown unless directly observed.
5. **Implement agreed differences and verify Firefox.** Convert confirmed cases into local regression cases. Validate native focus, shortcut, popup dismissal, modifiers, and tab reuse in Firefox as well as a preview. Retain documented privacy and Firefox API constraints. REA evidence is input to this work, not a substitute for running the extension.
6. **Stop on a concrete coverage claim.** Complete when every agreed matrix case has an outcome and all included behaviors pass in the target Firefox versions. List observed differences, deliberately excluded Arc features, and unknown internal rules. Reopen a rule when a reproducible counterexample appears.

Native call tracing is optional and currently fails the signature precondition identified above. REA UI capture is also optional; supported computer-use tools can perform the physical-keyboard characterization. Installing REA is useful only if it resolves questions left after the behavior pass.

## Comparison and regression matrix

Unless marked **observed**, these are proposed cases, not claims of verified Arc behavior. Run ordering cases with the discovery prompt hidden first, then repeat the prompt-specific row. For each case record `input / initial selection / result order / displayed text and selected range / mode / focus / key / destination / tab count and identity`.

| Group | Cases or controlled fixture | What to establish |
| --- | --- | --- |
| URL ordering — observed | `google.com`; explicit unmatched example URL above | URL first and selected, search second; matches remain available. |
| Text ordering — observed example | `calendar`; then synthetic exact title, prefix title, host, path matches | Best match first, search second; identify which provider owns the default. |
| No match | Unique ordinary word; unmatched bare domain; unmatched explicit URL | Sole search for text; URL plus search for recognized URL. |
| History only | Closed fixture page; zero matching open tabs | Whether history becomes default; search row position. |
| Provider competition | Exact history title versus weak open-tab substring; reverse strength | Whether Arc mixes relevance across providers or groups all tabs first. |
| Equal candidates | Duplicate URL tabs; same-title/different-host tabs; controlled visit/activation order | Recency, pinned state, location, stability, and duplicate handling. |
| URL variants | HTTP/HTTPS; bare host with path, port, query, fragment; trailing dot | Classification, displayed normalization, committed destination, search alternative. |
| Local addresses | `localhost:3000`; loopback IPv4/IPv6; LAN address; single-label intranet host | URL versus query and default scheme. |
| Ambiguous text | Dotted phrase with spaces; email-like text; search operators; leading `?`; path-like text | Whether a search can be forced and whether special prefixes change mode. |
| Incomplete/invalid input | Partial scheme, missing host, bad port, backslash, space in explicit URL | Recovery or validation; keep extension validation contract. |
| Restricted schemes | Internal browser, file, custom handler, executable scheme, credential-bearing URL | Record Arc's classification without opening unsafe destinations; keep extension restrictions. |
| Unicode and composition | Accents, IDN, composed/decomposed text, CJK IME, emoji | Matching and display; Enter during composition must not commit prematurely. |
| Empty input | Fresh opening; whitespace; clearing text; first Down/Up | Suggestions, selection, focus, and no navigation from untouched empty Enter. |
| Inline completion | Type prefix; Right/End/Tab; Backspace/Delete; select all and replace | Difference between authored query, accepted completion, preview, and search terms. |
| Arrow previews | Down/Up through URL, tab, history, search; wrap boundaries; edit preview | Exact URL preview and restoration of original query; search intent stays explicit. |
| Modifiers | Enter, Cmd+Enter/Ctrl+Enter, Shift+Enter, Option+Enter where offered | Selected action versus forced destination; foreground/background or special mode. No inferred equivalence between modifier keys. |
| Rapid input / asynchronous data | Immediate Enter; wait for history; type/delete quickly; navigate before late response | Default stability, preservation of explicit selection, no stale commit. |
| Tab mutations | Selected result closes/moves/changes URL; new tab arrives while popup open | Safe selection recovery and current-window identity. |
| Entry points | Cmd+T, Cmd+L/current URL editing, toolbar invocation if available | New destination versus replace-current semantics; initial field state. |
| Window/profile scope | Another window; another Space/profile; private window; pinned and discarded tabs | Search isolation and scope; flag Firefox extension differences. |
| Site hints | Prefix collides with tab and history; two matching site keywords; exact alias | Hint independent of selected row; shortest-first and unknown Arc tie rule. |
| Site mode lifecycle | Tab entry; empty query Enter; query Enter; modifier Enter; empty Backspace; chip click; Escape; reopen | Destination, query restoration, mode exit, native-popup exception. |
| Discovery prompt — accepted exception | Prompt visible with first result automatically selected; Down, Left/Right, Down, Up | First Down focuses Allow; subsequent navigation and query preservation follow [spec](SITE_SEARCH.md). |
| Suggestions and actions | Online/offline; suggestions enabled/disabled; command-like query; Tab immediately after opening | Remote/local source differences and optional action mode; current availability of historical features. |
| Commit lifecycle | Switch tab; open URL/search from Home/New Tab versus ordinary tab; repeated Enter during dispatch; API failure | No tab before commit; correct tab reuse; one action; popup closes only after successful commit. |
| Accessibility/native host | Physical shortcut and immediate typing, screen-reader announcement, zoom/narrow popup, Escape | Actual focus and host interception; preview-only tests are insufficient. |

## Confidence summary

- **High:** REA's inspected capability boundaries, local Arc version/signature facts, compatible explicit Node path, and current extension rules.
- **High but narrow:** the three Arc inputs already observed in this session.
- **Medium:** focused static analysis will locate useful command-bar candidates; symbol/optimization state and component ownership have not been inspected.
- **Unestablished:** Arc's full ranking formula, all tie breakers, complete scope/mode inventory, server-side behavior, and exhaustive parity. No new Arc UI matrix or native REA analysis has been run for this note.

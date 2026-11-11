# Publishing to Mozilla Add-ons

After the one-time setup, a successful **Checks** run for a push to `main` triggers **Publish to Mozilla Add-ons**. The publishing workflow checks out the exact tested commit, builds and validates the extension with Mozilla's pinned `web-ext` tool, saves the unsigned submission package as an Actions artifact, and submits an update to the existing public listing. Pull requests and failed checks never publish.

## One-time setup

1. Create a Mozilla Account and submit the first version through the [Add-ons Developer Hub](https://addons.mozilla.org/developers/). Choose **On this site** for a public listing. Run `npm run build` and upload the ZIP in `dist/`, or use the unsigned ZIP from the existing **Checks** workflow. Complete the listing, privacy disclosures, and review. Keep the ID from `manifest.json`: `search-or-switch@ffarc.local`.
2. Once the initial listing is available, generate an API key (JWT issuer) and API secret at [Mozilla API credentials](https://addons.mozilla.org/developers/addon/api/key/), using the account that owns the listing.
3. Add repository secrets under [Settings → Secrets and variables → Actions](https://github.com/rutgerkra/search-or-switch/settings/secrets/actions):

   | Secret | Value |
   | --- | --- |
   | `AMO_API_KEY` | Mozilla's JWT issuer / API key |
   | `AMO_API_SECRET` | Mozilla's JWT secret / API secret |

   Enter the values directly in GitHub. Do not commit them or paste them into an issue or chat.

4. Open [Publish to Mozilla Add-ons](https://github.com/rutgerkra/search-or-switch/actions/workflows/publish.yml), choose **Run workflow**, and select `main`. This verifies the setup and submits the current code. Later successful pushes to `main` submit automatically.

If either secret is missing, the workflow records a notice and skips submission. Adding secrets does not trigger a run; use **Run workflow** or push an update afterward. The workflow updates an existing listing; it deliberately omits the metadata needed to create a new listing automatically.

## Versions and updates

Keep the checked-in manifest version in three-part form, such as `0.1.0`. Release builds append the publishing workflow's run number, producing versions such as `0.1.0.12` and `0.1.0.13`. Only the packaged manifest changes; the workflow never commits version bumps back to `main`. Local builds retain the checked-in version. Increase the base version in both `manifest.json` and `package.json` when you want a new major, minor, or patch series.

Uploads are serialized and an in-progress upload is allowed to finish. GitHub retains the latest pending run; commits already superseded on `main` are skipped. The source commit remains recorded in the Actions run, and the exact versioned ZIP is retained for 30 days.

Use **Run workflow** for a new submission attempt; it allocates a new version. Re-running an existing run reuses its version, which AMO may reject if it already accepted that version. If an upload times out, check the Developer Hub before submitting again. Renaming or recreating the publishing workflow can reset its run counter; increase the base version before publishing if the resulting version would be older than an existing submission. To roll back behavior, revert the relevant code on `main` so the fix is submitted with a higher version.

The workflow uses `web-ext sign --channel listed --approval-timeout 0`: success means Mozilla accepted the submission, not that review or public availability is complete. Track the version in the Developer Hub. Mozilla controls review and signing; Firefox distributes approved updates through the existing listing.

## Validation and reviewer notes

Normal development checks remain dependency-free. To reproduce a release package locally with Node.js 22.12 or newer:

```sh
npm test
RELEASE_BUILD_NUMBER=12 npm run build
npm exec --yes --package=web-ext@10.8.0 -- web-ext lint --source-dir dist/extension --no-config-discovery
```

The package contains readable source files without bundling or minification. `.github/amo-metadata.json` supplies the MIT license and reviewer instructions with each update; keep those instructions aligned with the extension's behavior. If a future build transforms JavaScript, add the matching source archive and reproducible build instructions required by Mozilla.

References: [web-ext submission options](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign), [submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/), and [source submission requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/).

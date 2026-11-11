# Publishing to Mozilla Add-ons

After the one-time setup, a successful **Checks** run for a push to `main` triggers **Publish to Mozilla Add-ons**. It submits only when the version in `manifest.json` is newer than all existing Mozilla submissions. The publishing workflow checks out the exact tested commit, builds and validates the extension with Mozilla's pinned `web-ext` tool, saves the unsigned submission package as an Actions artifact, and submits an update to the existing public listing. Pull requests and failed checks never publish.

## One-time setup

1. Create a Mozilla Account and submit the first version through the [Add-ons Developer Hub](https://addons.mozilla.org/developers/). Choose **On this site** for a public listing. Run `npm run build` and upload the ZIP in `dist/`, or use the unsigned ZIP from the existing **Checks** workflow. Complete the listing, privacy disclosures, and review. Keep the ID from `manifest.json`: `search-or-switch@ffarc.local`.
2. Once the initial listing is available, generate an API key (JWT issuer) and API secret at [Mozilla API credentials](https://addons.mozilla.org/developers/addon/api/key/), using the account that owns the listing.
3. Add repository secrets under [Settings → Secrets and variables → Actions](https://github.com/rutgerkra/search-or-switch/settings/secrets/actions):

   | Secret | Value |
   | --- | --- |
   | `AMO_API_KEY` | Mozilla's JWT issuer / API key |
   | `AMO_API_SECRET` | Mozilla's JWT secret / API secret |

   Enter the values directly in GitHub. Do not commit them or paste them into an issue or chat.

4. Increase the version in `manifest.json` and `package.json` above the version used for the initial listing, then push to `main`. After checks pass, the publishing workflow submits that version. You can also open [Publish to Mozilla Add-ons](https://github.com/rutgerkra/search-or-switch/actions/workflows/publish.yml), choose **Run workflow**, and select `main` to retry a version that has not been submitted yet.

If either secret is missing, the workflow records a notice and skips submission. Adding secrets does not trigger a run; use **Run workflow** or push an update afterward. The workflow updates an existing listing; it deliberately omits the metadata needed to create a new listing automatically.

## Versions and updates

Choose the release version yourself. For example, change `0.1.0` to `0.1.1` in `manifest.json` and `package.json`, then push to `main`. The packaged manifest uses exactly that version. There are no generated suffixes or automatic version commits. Ordinary code or documentation updates with an unchanged version do not submit another release.

Before uploading, the workflow uses an authenticated Mozilla version lookup that includes pending, disabled, and unlisted submissions. An equal or older manifest version is skipped, including a version already awaiting review. The comparison uses numeric components, so `0.1.10` is newer than `0.1.9`. Failed lookups stop the workflow rather than treating the version as new.

Uploads are serialized and an in-progress upload is allowed to finish. GitHub retains the latest pending run; commits already superseded on `main` are skipped. The source commit remains recorded in the Actions run, and the exact versioned ZIP is retained for 30 days.

Use **Run workflow** to retry an unsubmitted version after fixing a setup or network problem. Manual runs use the same version check; they do not create a version or force duplicate uploads. If an upload times out, check the Developer Hub before retrying. To roll back behavior, revert the relevant code and increase the manifest version before pushing to `main`.

The workflow uses `web-ext sign --channel listed --approval-timeout 0`: success means Mozilla accepted the submission, not that review or public availability is complete. Track the version in the Developer Hub. Mozilla controls review and signing; Firefox distributes approved updates through the existing listing.

## Validation and reviewer notes

Normal development checks remain dependency-free. To reproduce a release package locally with Node.js 22.12 or newer:

```sh
npm test
npm run build
npm exec --yes --package=web-ext@10.8.0 -- web-ext lint --source-dir dist/extension --no-config-discovery
```

The package contains readable source files without bundling or minification. `.github/amo-metadata.json` supplies the MIT license and reviewer instructions with each update; keep those instructions aligned with the extension's behavior. If a future build transforms JavaScript, add the matching source archive and reproducible build instructions required by Mozilla.

References: [web-ext submission options](https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign), [submission guide](https://extensionworkshop.com/documentation/publish/submitting-an-add-on/), and [source submission requirements](https://extensionworkshop.com/documentation/publish/source-code-submission/).

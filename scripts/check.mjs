import { readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";

const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions.toSorted(), ["history", "search", "storage", "tabs"]);
assert.equal(manifest.action.default_popup, "popup.html");
assert(!manifest.sidebar_action, "The primary extension uses a native toolbar popup.");
assert(!manifest.background, "The native popup does not need a background page.");
assert(!manifest.chrome_url_overrides, "The popup must not replace Firefox’s new-tab page.");
assert.deepEqual(Object.keys(manifest.commands), ["_execute_action"]);
assert.equal(manifest.commands._execute_action.suggested_key.mac, "Command+Shift+K");
assert.equal(manifest.commands._execute_action.suggested_key.default, "Ctrl+Shift+Space");
assert.equal(manifest.commands._execute_action.suggested_key.windows, "Ctrl+Shift+K");
for (const file of ["popup.html", "popup.css", "icons/icon.svg", "popup.js", "popup-input.js", "history-search.js", "favicon-cache.js", "shortcut-settings.js", "core.js", "popup-tabs.js", "preview.js"]) await access(file);
for (const file of ["popup.js", "popup-input.js", "history-search.js", "favicon-cache.js", "shortcut-settings.js", "core.js", "popup-tabs.js", "preview.js", "scripts/serve.mjs", "scripts/build.mjs", "scripts/popup-ui-smoke.mjs"]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}
const html = await readFile("popup.html", "utf8");
assert(!/<script\b(?![^>]*\bsrc=)/i.test(html), "All scripts must be external for extension CSP.");
assert(!/\son\w+=/i.test(html), "Inline event handlers are not permitted.");
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
assert.equal(ids.length, new Set(ids).size, "HTML IDs must be unique.");
const js = await readFile("popup.js", "utf8");
for (const [, id] of js.matchAll(/\$\("([^"]+)"\)/g)) assert(ids.includes(id), `Missing element #${id}`);
console.log("Manifest, files, JavaScript syntax, CSP, and UI references checked.");

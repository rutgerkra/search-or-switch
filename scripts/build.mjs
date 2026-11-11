import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { releaseVersion } from "./release-version.mjs";

execFileSync(process.execPath, ["scripts/check.mjs"], { stdio: "inherit" });
const manifest = JSON.parse(await readFile("manifest.json", "utf8"));
manifest.version = releaseVersion(manifest.version, process.env.RELEASE_BUILD_NUMBER);
const output = resolve("dist");
const staged = resolve(output, "extension");
const archive = resolve(output, `search-or-switch-${manifest.version}.zip`);
await mkdir(output, { recursive: true });
await rm(staged, { recursive: true, force: true });
await mkdir(staged);
for (const file of ["LICENSE", "manifest.json", "popup.html", "popup.css", "popup.js", "popup-input.js", "history-search.js", "favicon-cache.js", "shortcut-settings.js", "core.js", "popup-tabs.js", "site-search.js", "site-discovery-service.js", "site-discovery.js", "background.js", "preview.js", "icons"]) {
  await cp(file, resolve(staged, file), { recursive: true });
}
await writeFile(resolve(staged, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
await rm(archive, { force: true });
execFileSync("zip", ["-q", "-r", archive, "."], { cwd: staged, stdio: "inherit" });
console.log(`Unpacked extension: ${staged}\nUnsigned extension archive: ${archive}`);

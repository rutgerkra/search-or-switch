import { createHmac, randomUUID } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function versionParts(version) {
  if (typeof version !== "string" || !/^(0|[1-9][0-9]{0,8})(\.(0|[1-9][0-9]{0,8})){0,3}$/.test(version)) {
    throw new Error("Expected a Firefox version with one to four numeric components.");
  }
  return [...version.split(".").map(Number), 0, 0, 0].slice(0, 4);
}

function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function authorization(apiKey, apiSecret) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: apiKey, jti: randomUUID(), iat: issuedAt, exp: issuedAt + 60,
  })}`;
  const signature = createHmac("sha256", apiSecret).update(unsigned).digest("base64url");
  return `JWT ${unsigned}.${signature}`;
}

export async function checkAmoVersion({ manifest, apiKey, apiSecret, fetchImpl = fetch }) {
  const version = manifest.version;
  versionParts(version);
  const id = manifest.browser_specific_settings?.gecko?.id;
  if (!id) throw new Error("The manifest must include a Firefox add-on ID.");
  if (!apiKey || !apiSecret) throw new Error("Mozilla API credentials are required.");

  // Include pending and disabled submissions so an accepted upload is never repeated.
  // Construct pagination URLs locally; never forward credentials to a response URL.
  for (let page = 1; ; page += 1) {
    const url = new URL(`https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(id)}/versions/`);
    url.search = new URLSearchParams({ filter: "all_with_unlisted", page_size: "50", page: String(page) });
    const response = await fetchImpl(url, {
      headers: { Authorization: authorization(apiKey, apiSecret) },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 404) throw new Error("Create the initial Mozilla Add-ons listing before publishing updates.");
    if (!response.ok) throw new Error(`Mozilla version lookup failed (HTTP ${response.status}); no submission attempted.`);
    const data = await response.json();
    if (!Array.isArray(data.results) || (data.next && data.results.length === 0)) {
      throw new Error("Mozilla returned an invalid version list; no submission attempted.");
    }
    for (const previous of data.results) {
      if (compareVersions(version, previous.version) <= 0) {
        return { publish: false, reason: `Mozilla submission skipped: manifest version ${version} is not newer than existing submission ${previous.version}.` };
      }
    }
    if (!data.next) return { publish: true, reason: `Manifest version ${version} is new and eligible for submission.` };
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkAmoVersion({
      manifest: JSON.parse(await readFile("manifest.json", "utf8")),
      apiKey: process.env.AMO_API_KEY,
      apiSecret: process.env.AMO_API_SECRET,
    });
    if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `publish=${result.publish}\n`);
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${result.reason}\n`);
    console.log(result.reason);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

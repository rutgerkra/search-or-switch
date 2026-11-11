import test from "node:test";
import assert from "node:assert/strict";
import { releaseVersion } from "../scripts/release-version.mjs";

test("local builds retain the manifest version", () => {
  assert.equal(releaseVersion("0.1.0"), "0.1.0");
  assert.equal(releaseVersion("0.1.0", ""), "0.1.0");
});

test("successive workflow runs create increasing Firefox versions", () => {
  assert.equal(releaseVersion("0.1.0", "9"), "0.1.0.9");
  assert.equal(releaseVersion("0.1.0", "10"), "0.1.0.10");
  assert.equal(releaseVersion("0.2.0", "11"), "0.2.0.11");
});

test("automatic releases reject ambiguous or invalid version components", () => {
  for (const build of ["0", "01", "-1", "1.2", "1000000000", "12\n", "latest"]) {
    assert.throws(() => releaseVersion("0.1.0", build), /RELEASE_BUILD_NUMBER/);
  }
  for (const version of ["0.1", "0.1.0.1", "0.01.0", "1.0.0-beta"]) {
    assert.throws(() => releaseVersion(version, "1"));
  }
});

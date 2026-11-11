const component = "(?:0|[1-9][0-9]{0,8})";
const versionPattern = new RegExp(`^${component}(?:\\.${component}){0,3}$`);
const baseVersionPattern = new RegExp(`^${component}\\.${component}\\.${component}$`);

export function releaseVersion(version, buildNumber) {
  if (!versionPattern.test(version)) throw new Error("Invalid Firefox extension version.");
  if (buildNumber === undefined || buildNumber === "") return version;
  if (!baseVersionPattern.test(version)) {
    throw new Error("Automatic releases require a three-part manifest version, such as 0.1.0.");
  }
  if (!/^[1-9][0-9]{0,8}$/.test(buildNumber)) {
    throw new Error("RELEASE_BUILD_NUMBER must be a positive integer of at most nine digits.");
  }
  return `${version}.${buildNumber}`;
}

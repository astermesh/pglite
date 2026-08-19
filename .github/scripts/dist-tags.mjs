// The run never writes a dist tag. npm's OIDC exchange authenticates `publish`
// and nothing else, so every package is published with its line tag already
// attached and no credential is stored anywhere to move one afterwards. What is
// left here is the reading half: a check that the family the run published is
// the family the line tag now names.
//
// `latest` is deliberately absent. Promoting a line to `latest` is a dist-tag
// write too, so it is a deliberate act by a person with npm access rather than
// something a run can do.

export function parseDistTagListing(output, packageName) {
  const tags = new Map();

  for (const record of output.split(/\r?\n/)) {
    const line = record.trim();
    if (line === "") continue;

    const match = /^([^:\s]+):\s+(\S+)$/.exec(line);
    if (!match) {
      throw new Error(`invalid dist-tag record for ${packageName}: ${line}`);
    }

    const [, tag, version] = match;
    if (tags.has(tag)) {
      throw new Error(`duplicate dist-tag for ${packageName}: ${tag}`);
    }
    tags.set(tag, version);
  }

  return tags;
}

export function readDistTags(runNpm, packageName) {
  return parseDistTagListing(
    runNpm(["dist-tag", "ls", packageName]),
    packageName,
  );
}

export function distTagMismatch({ packageName, tags, version, distTag }) {
  const tagged = tags.get(distTag);
  if (tagged === version) return undefined;
  return `${packageName} dist-tag ${distTag} names ${
    tagged ?? "nothing"
  }, not ${version}`;
}

export function verifyDistTags({ packages, distTag, runNpm }) {
  // Every package is checked, and the first failure does not stop the rest.
  // This is the step that makes a half-published family visible: publication is
  // per package, so a run that dies mid-family leaves the line tag naming a mix
  // of old and new, and the operator needs the whole list to know what the
  // rerun has to cover.
  const mismatches = packages
    .map((pkg) =>
      distTagMismatch({
        packageName: pkg.name,
        tags: readDistTags(runNpm, pkg.name),
        version: pkg.version,
        distTag,
      }),
    )
    .filter((mismatch) => mismatch !== undefined);

  if (mismatches.length > 0) {
    throw new Error(
      `${distTag} does not name this release:\n${mismatches.join("\n")}`,
    );
  }
}

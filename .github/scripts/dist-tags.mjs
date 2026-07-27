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

export function planDistTagUpdates({
  tags,
  version,
  distTag,
  promoteLatest,
}) {
  const additions = [];
  if (tags.get(distTag) !== version) additions.push(distTag);
  if (promoteLatest && tags.get("latest") !== version) {
    additions.push("latest");
  }

  const removals = [];
  for (const [tag, taggedVersion] of tags) {
    if (tag.startsWith("staging-") && taggedVersion === version) {
      removals.push(tag);
    }
  }

  return { additions, removals };
}

export function validateFinalDistTags({
  packageName,
  tags,
  version,
  distTag,
  promoteLatest,
}) {
  if (tags.get(distTag) !== version) {
    throw new Error(
      `${packageName} dist-tag ${distTag} does not point to ${version}`,
    );
  }
  if (promoteLatest && tags.get("latest") !== version) {
    throw new Error(
      `${packageName} dist-tag latest does not point to ${version}`,
    );
  }

  const stale = planDistTagUpdates({
    tags,
    version,
    distTag,
    promoteLatest,
  }).removals;
  if (stale.length > 0) {
    throw new Error(
      `${packageName}@${version} still has staging dist-tags: ${stale.join(
        ", ",
      )}`,
    );
  }
}

export function finalizeDistTags({
  packages,
  distTag,
  promoteLatest,
  runNpm,
}) {
  const initialPlans = packages.map((pkg) => ({
    pkg,
    ...planDistTagUpdates({
      tags: readDistTags(runNpm, pkg.name),
      version: pkg.version,
      distTag,
      promoteLatest,
    }),
  }));

  for (const { pkg, additions } of initialPlans) {
    const spec = `${pkg.name}@${pkg.version}`;
    for (const tag of additions) {
      runNpm(["dist-tag", "add", spec, tag]);
    }
  }

  const cleanupPlans = packages.map((pkg) => ({
    pkg,
    ...planDistTagUpdates({
      tags: readDistTags(runNpm, pkg.name),
      version: pkg.version,
      distTag,
      promoteLatest,
    }),
  }));

  for (const { pkg, removals } of cleanupPlans) {
    for (const tag of removals) {
      runNpm(["dist-tag", "rm", pkg.name, tag]);
    }
  }

  for (const pkg of packages) {
    validateFinalDistTags({
      packageName: pkg.name,
      tags: readDistTags(runNpm, pkg.name),
      version: pkg.version,
      distTag,
      promoteLatest,
    });
  }
}

import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const stableVersionPattern = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;
export const commitPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
export const releaseLinePattern = /^astermesh\/v([0-9]+)\.([0-9]+)$/;
const distTagPattern = /^[a-z0-9][a-z0-9._-]*$/;
const packageNamePattern = /^@astermesh\/pglite(?:-[a-z0-9][a-z0-9-]*)?$/;
const upstreamNamePattern = /^@electric-sql\/pglite(?:-[a-z0-9][a-z0-9-]*)?$/;
const packageDirectoryPattern = /^packages\/[a-z0-9][a-z0-9-]*$/;

export function parseStableVersion(version, label = "version") {
  const match = stableVersionPattern.exec(version);
  if (!match) {
    throw new Error(`${label} must be stable semver: ${version}`);
  }
  return match.slice(1).map(Number);
}

export function tarballFilename(name, version) {
  return `${name.slice(1).replace("/", "-")}-${version}.tgz`;
}

function requireString(value, label, pattern) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`invalid ${label}: ${String(value)}`);
  }
  return value;
}

export function validateReleaseConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release config must be an object");
  }
  if (value.schemaVersion !== 1) {
    throw new Error(
      `unsupported release config schema: ${value.schemaVersion}`,
    );
  }

  const releaseLine = requireString(
    value.releaseLine,
    "release line",
    releaseLinePattern,
  );
  const distTag = requireString(value.distTag, "dist tag", distTagPattern);
  const [, major, minor] = releaseLinePattern.exec(releaseLine);
  const expectedDistTag = `line-${major}-${minor}`;
  if (distTag !== expectedDistTag) {
    throw new Error(
      `${releaseLine} must use dist tag ${expectedDistTag}, not ${distTag}`,
    );
  }
  if (distTag === "latest" || distTag.startsWith("staging-")) {
    throw new Error(`reserved dist tag: ${distTag}`);
  }
  if (!Array.isArray(value.packages) || value.packages.length === 0) {
    throw new Error("release config must list at least one package");
  }
  const upstreamWrapperCommit = requireString(
    value.upstreamWrapperCommit,
    "upstream wrapper commit",
    commitPattern,
  );

  const directories = new Set();
  const names = new Set();
  const upstreamNames = new Set();
  const packages = value.packages.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`invalid package entry at index ${index}`);
    }
    const directory = requireString(
      entry.directory,
      `package directory at index ${index}`,
      packageDirectoryPattern,
    );
    if (isAbsolute(directory) || directory.split("/").includes("..")) {
      throw new Error(`unsafe package directory: ${directory}`);
    }
    const name = requireString(
      entry.name,
      `package name at index ${index}`,
      packageNamePattern,
    );
    const upstreamName = requireString(
      entry.upstreamName,
      `upstream package name at index ${index}`,
      upstreamNamePattern,
    );

    for (const [set, candidate, label] of [
      [directories, directory, "directory"],
      [names, name, "package name"],
      [upstreamNames, upstreamName, "upstream package name"],
    ]) {
      if (set.has(candidate))
        throw new Error(`duplicate ${label}: ${candidate}`);
      set.add(candidate);
    }
    if (
      entry.postgresLicense !== undefined &&
      typeof entry.postgresLicense !== "boolean"
    ) {
      throw new Error(`invalid postgresLicense for ${name}`);
    }

    return {
      directory,
      name,
      upstreamName,
      postgresLicense: entry.postgresLicense === true,
    };
  });

  if (!names.has("@astermesh/pglite")) {
    throw new Error("release config must include @astermesh/pglite");
  }

  return {
    schemaVersion: 1,
    releaseLine,
    distTag,
    upstreamWrapperCommit,
    packages,
  };
}

export function loadReleaseConfig(workspace = process.cwd()) {
  const path = resolve(workspace, ".astermesh/release.json");
  return validateReleaseConfig(JSON.parse(readFileSync(path, "utf8")));
}

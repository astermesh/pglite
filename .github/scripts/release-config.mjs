import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export const stableVersionPattern = /^([0-9]+)\.([0-9]+)\.([0-9]+)$/;
export const commitPattern = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
// A release line names the platform its patches serve, an upstream major.minor,
// and optionally the build variant that distinguishes it: `simbox/v0.3`,
// `simbox/v0.3-postgis`. Neither the owner nor the platform is fixed here — the
// line manifest declares it and the branch it is read from confirms it.
export const releaseLinePattern =
  /^([a-z][a-z0-9-]*)\/v([0-9]+)\.([0-9]+)(?:-([a-z0-9][a-z0-9-]*))?$/;
export const releaseConfigPath = ".release/line.json";
const distTagPattern = /^[a-z0-9][a-z0-9._-]*$/;
const packageNamePattern =
  /^@([a-z0-9][a-z0-9-]*)\/pglite(?:-[a-z0-9][a-z0-9-]*)?$/;
const upstreamNamePattern = /^@electric-sql\/pglite(?:-[a-z0-9][a-z0-9-]*)?$/;
const packageDirectoryPattern = /^packages\/[a-z0-9][a-z0-9-]*$/;
// The registry a line publishes to. It is declared by the line rather than compiled into
// the tooling, so a line can move between registries — as the family did, from GitHub
// Packages to the public npm registry — without a second pass through every script and
// workflow. https only: the guard exists to stop an accidental publication, and a plaintext
// scheme would be a way around it.
const registryPattern = /^https:\/\/[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(\/[A-Za-z0-9._~-]+)*\/?$/;
// Lines written before the field existed target GitHub Packages.
export const defaultRegistry = "https://npm.pkg.github.com";

export function parseReleaseLine(line, label = "release line") {
  if (typeof line !== "string") {
    throw new Error(`invalid ${label}: ${String(line)}`);
  }
  const match = releaseLinePattern.exec(line);
  if (!match) throw new Error(`invalid ${label}: ${line}`);
  const [, platform, major, minor, variant] = match;
  return { platform, major: Number(major), minor: Number(minor), variant };
}

export function releaseLineDistTag({ major, minor, variant }) {
  const line = `line-${major}-${minor}`;
  return variant ? `${line}-${variant}` : line;
}

export function packageScope(name, label = "package name") {
  const match = packageNamePattern.exec(String(name));
  if (!match) throw new Error(`invalid ${label}: ${String(name)}`);
  return match[1];
}

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
  const line = parseReleaseLine(releaseLine);
  const expectedDistTag = releaseLineDistTag(line);
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
  const registry =
    value.registry === undefined
      ? defaultRegistry
      : requireString(value.registry, "registry", registryPattern);

  const directories = new Set();
  const names = new Set();
  const upstreamNames = new Set();
  const scopes = new Set();
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
    scopes.add(packageScope(name));
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

  // One family, one scope: a package scope must match the repository owner, so
  // a split scope means one of the packages cannot belong to this fork.
  if (scopes.size !== 1) {
    throw new Error(
      `release config mixes package scopes: ${[...scopes].sort().join(", ")}`,
    );
  }
  const [scope] = scopes;
  const rootPackage = `@${scope}/pglite`;
  if (!names.has(rootPackage)) {
    throw new Error(`release config must include ${rootPackage}`);
  }

  return {
    schemaVersion: 1,
    releaseLine,
    scope,
    rootPackage,
    distTag,
    registry,
    upstreamWrapperCommit,
    packages,
  };
}

export function loadReleaseConfig(workspace = process.cwd()) {
  const path = resolve(workspace, releaseConfigPath);
  return validateReleaseConfig(JSON.parse(readFileSync(path, "utf8")));
}

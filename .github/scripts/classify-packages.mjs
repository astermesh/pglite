import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { fingerprintTarball } from "./artifact-fingerprint.mjs";
import { parseStableVersion, stableVersionPattern } from "./release-config.mjs";

export function classifyPackage(pkg, publishedVersions, publishedFingerprint) {
  const release = parseStableVersion(pkg.version, `${pkg.name} version`);
  if (publishedVersions.includes(pkg.version)) {
    if (publishedFingerprint !== pkg.fingerprint) {
      throw new Error(
        `${pkg.name}@${pkg.version} already exists with different contents`,
      );
    }
    return "existing";
  }

  const newestPatch = publishedVersions
    .filter((version) => stableVersionPattern.test(version))
    .map((version) =>
      parseStableVersion(version, `${pkg.name} published version`),
    )
    .filter((version) => version[0] === release[0] && version[1] === release[1])
    .reduce((newest, version) => Math.max(newest, version[2]), -1);
  if (release[2] <= newestPatch) {
    throw new Error(
      `${pkg.name}@${pkg.version} is not newer than its published release line`,
    );
  }
  return "publish";
}

function npm(args, options = {}) {
  const result = spawnSync(
    "npm",
    [...args, "--registry=https://npm.pkg.github.com"],
    { encoding: "utf8", ...options },
  );
  if (result.status === 0) return result.stdout;
  if (result.stderr.includes("E404")) return undefined;
  process.stderr.write(result.stderr);
  throw new Error(`npm command failed: npm ${args.join(" ")}`);
}

export function parsePublishedVersions(output, name) {
  if (typeof output !== "string" || output.trim() === "") {
    throw new Error(`empty published versions response for ${name}`);
  }
  let report;
  try {
    report = JSON.parse(output);
  } catch {
    throw new Error(`invalid published versions response for ${name}`);
  }
  const versions = Array.isArray(report) ? report : [report];
  const seen = new Set();
  for (const version of versions) {
    if (typeof version !== "string" || !stableVersionPattern.test(version)) {
      throw new Error(`invalid published version for ${name}: ${version}`);
    }
    if (seen.has(version)) {
      throw new Error(`duplicate published version for ${name}: ${version}`);
    }
    seen.add(version);
  }
  return versions;
}

export function readPublishedVersions(runNpm, name) {
  const output = runNpm([
    "view",
    `${name}@>=0.0.0`,
    "version",
    "--json",
  ]);
  if (output === undefined) return [];
  return parsePublishedVersions(output, name);
}

function publishedFingerprint(pkg) {
  const directory = mkdtempSync(resolve(tmpdir(), "pglite-registry-"));
  try {
    const output = npm(
      [
        "pack",
        `${pkg.name}@${pkg.version}`,
        "--pack-destination",
        directory,
        "--json",
      ],
      { cwd: directory },
    );
    if (output === undefined) return undefined;
    const report = JSON.parse(output);
    if (!Array.isArray(report) || report.length !== 1) {
      throw new Error(`unexpected npm pack report for ${pkg.name}`);
    }
    return fingerprintTarball(resolve(directory, report[0].filename));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

const contextPath = process.env.RELEASE_CONTEXT;
const packedPath = process.env.PACKED_PACKAGES;
const planPath = process.env.PUBLISH_PACKAGES;

if (contextPath && packedPath && planPath) {
  const context = JSON.parse(readFileSync(contextPath, "utf8"));
  const packed = JSON.parse(readFileSync(packedPath, "utf8"));
  const byName = new Map(packed.map((pkg) => [pkg.name, pkg]));
  const selected = [];

  for (const expected of context.packages) {
    const pkg = byName.get(expected.name);
    if (!pkg || pkg.version !== expected.version) {
      throw new Error(`packed package is missing: ${expected.name}`);
    }
    const versions = readPublishedVersions(npm, pkg.name);
    const fingerprint = versions.includes(pkg.version)
      ? publishedFingerprint(pkg)
      : undefined;
    const classification = classifyPackage(pkg, versions, fingerprint);
    console.log(`${classification}: ${pkg.name}@${pkg.version}`);
    if (classification === "publish") selected.push(pkg);
  }
  if (byName.size !== context.packages.length) {
    throw new Error("packed package set differs from release context");
  }

  writeFileSync(planPath, `${JSON.stringify(selected, null, 2)}\n`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      [
        `count=${selected.length}`,
        `matrix=${JSON.stringify({ include: selected })}`,
        "",
      ].join("\n"),
    );
  }
}

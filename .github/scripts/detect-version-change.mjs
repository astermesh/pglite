import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

import { loadReleaseConfig } from "./release-config.mjs";

const zeroCommit = /^0+$/;

export function changedPackageVersions(packages, readBefore, readAfter) {
  const changed = [];
  for (const pkg of packages) {
    const path = `${pkg.directory}/package.json`;
    const before = readBefore(path);
    const after = readAfter(path);
    if (!after || after.name !== pkg.name) {
      throw new Error(`current package identity is invalid: ${path}`);
    }
    if (
      !before ||
      before.name !== after.name ||
      before.version !== after.version
    ) {
      changed.push({
        name: after.name,
        before: before?.version,
        after: after.version,
      });
    }
  }
  return changed;
}

function gitJson(commit, path) {
  try {
    return JSON.parse(
      execFileSync("git", ["show", `${commit}:${path}`], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }),
    );
  } catch {
    return undefined;
  }
}

const beforeCommit = process.env.BEFORE_SHA;
const afterCommit = process.env.AFTER_SHA;

if (beforeCommit && afterCommit) {
  const config = loadReleaseConfig();
  const changed = zeroCommit.test(beforeCommit)
    ? []
    : changedPackageVersions(
        config.packages,
        (path) => gitJson(beforeCommit, path),
        (path) => gitJson(afterCommit, path),
      );
  const shouldPublish = changed.length > 0;
  console.log(
    shouldPublish
      ? `package version changes: ${JSON.stringify(changed)}`
      : "no package version changes",
  );
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(
      process.env.GITHUB_OUTPUT,
      `publish=${shouldPublish ? "true" : "false"}\n`,
    );
  }
}

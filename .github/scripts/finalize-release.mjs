import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

import { verifyDistTags } from "./dist-tags.mjs";
import { planPackageTag, remoteTagCommit } from "./remote-tag.mjs";

const context = JSON.parse(readFileSync(process.env.RELEASE_CONTEXT, "utf8"));
const summaryPath = process.env.RELEASE_SUMMARY;

if (!summaryPath) throw new Error("RELEASE_SUMMARY is required");
// Whichever registry the line declared when the context was resolved. Failing
// closed here rather than defaulting: this step still writes Git tags, and it
// must not certify a release it read from a registry the run never targeted.
if (typeof context.registry !== "string" || context.registry === "") {
  throw new Error("release context declares no registry");
}

function npm(args) {
  const result = spawnSync(
    "npm",
    [...args, `--registry=${context.registry}`],
    { encoding: "utf8" },
  );
  if (result.status === 0) return result.stdout;
  process.stderr.write(result.stderr);
  throw new Error(`npm command failed: npm ${args.join(" ")}`);
}

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

for (const pkg of context.packages) {
  const published = JSON.parse(
    npm(["view", `${pkg.name}@${pkg.version}`, "version", "--json"]),
  );
  if (published !== pkg.version) {
    throw new Error(`registry is missing ${pkg.name}@${pkg.version}`);
  }
}

const gitTagPlans = context.packages.map((pkg) => {
  const tag = `${pkg.name}@${pkg.version}`;
  const remote = git([
    "ls-remote",
    "--tags",
    "origin",
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ]);
  const remoteCommit = remoteTagCommit(remote, tag);
  const manifest = remoteCommit
    ? JSON.parse(
        git(["show", `${remoteCommit}:${pkg.directory}/package.json`]),
      )
    : undefined;
  const plan = planPackageTag({
    tag,
    remoteCommit,
    currentCommit: context.wrapper.fork.commit,
    packageName: pkg.name,
    packageVersion: pkg.version,
    manifest,
  });
  return { plan, tag };
});

// Before any Git tag is pushed: a Git tag asserts that this commit is the
// release, and it should not outlive a registry state that disagrees.
verifyDistTags({
  packages: context.packages,
  distTag: context.distTag,
  runNpm: npm,
});

const missingGitTags = [];
for (const { plan, tag } of gitTagPlans) {
  if (plan.action === "keep") continue;
  git(["tag", tag, plan.commit]);
  missingGitTags.push(tag);
}
if (missingGitTags.length > 0) {
  git([
    "push",
    "--atomic",
    "origin",
    ...missingGitTags.map((tag) => `refs/tags/${tag}`),
  ]);
}

const summary = {
  schemaVersion: 1,
  releaseLine: context.releaseLine,
  distTag: context.distTag,
  registry: context.registry,
  packages: context.packages.map(({ name, version }) => ({ name, version })),
  wrapperCommit: context.wrapper.fork.commit,
  engineCommit: context.engine.fork.commit,
};
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  commitPattern,
  loadReleaseConfig,
  parseStableVersion,
  releaseLinePattern,
} from "./release-config.mjs";

const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const releaseLine = process.env.RELEASE_LINE;
const contextPath = process.env.RELEASE_CONTEXT;
const releaseConfig = loadReleaseConfig(workspace);

if (!contextPath) throw new Error("RELEASE_CONTEXT is required");

const lineMatch = releaseLinePattern.exec(releaseLine);
if (!lineMatch) throw new Error(`invalid release line: ${releaseLine}`);
if (releaseConfig.releaseLine !== releaseLine) {
  throw new Error(
    `release config belongs to ${releaseConfig.releaseLine}, not ${releaseLine}`,
  );
}
const lineVersion = lineMatch.slice(1).map(Number);

function git(args, options = {}) {
  return execFileSync("git", args, {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

function engineGit(args) {
  return execFileSync("git", ["-C", "postgres-pglite", ...args], {
    cwd: workspace,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

function readJson(path) {
  return JSON.parse(readFileSync(resolve(workspace, path), "utf8"));
}

function readGitJson(commit, path) {
  return JSON.parse(git(["show", `${commit}:${path}`]));
}

git([
  "fetch",
  "--no-tags",
  "origin",
  `+refs/heads/${releaseLine}:refs/remotes/origin/${releaseLine}`,
]);
git([
  "fetch",
  "--no-tags",
  "https://github.com/electric-sql/pglite.git",
  "+refs/heads/main:refs/remotes/upstream/main",
]);

const sourceCommit = git(["rev-parse", "HEAD"]);
if (!commitPattern.test(sourceCommit)) {
  throw new Error(`invalid wrapper commit: ${sourceCommit}`);
}
try {
  git([
    "merge-base",
    "--is-ancestor",
    sourceCommit,
    `refs/remotes/origin/${releaseLine}`,
  ]);
} catch {
  throw new Error(`${sourceCommit} is not part of ${releaseLine}`);
}

const inferredUpstreamWrapperCommit = git([
  "merge-base",
  sourceCommit,
  "refs/remotes/upstream/main",
]);
const upstreamWrapperCommit = releaseConfig.upstreamWrapperCommit;
if (!commitPattern.test(upstreamWrapperCommit)) {
  throw new Error(`invalid upstream wrapper commit: ${upstreamWrapperCommit}`);
}
if (inferredUpstreamWrapperCommit !== upstreamWrapperCommit) {
  throw new Error(
    `release config declares upstream ${upstreamWrapperCommit}, ` +
      `but source resolves to ${inferredUpstreamWrapperCommit}`,
  );
}

const configuredNames = new Set(
  releaseConfig.packages.map((definition) => definition.name),
);
const publicFamilyNames = readdirSync(resolve(workspace, "packages"), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => `packages/${entry.name}/package.json`)
  .flatMap((path) => {
    if (!existsSync(resolve(workspace, path))) return [];
    const manifest = readJson(path);
    return manifest.private === false &&
      /^@astermesh\/pglite(?:-|$)/.test(manifest.name)
      ? [manifest.name]
      : [];
  });
for (const name of publicFamilyNames) {
  if (!configuredNames.has(name)) {
    throw new Error(`public package is missing from release config: ${name}`);
  }
}
if (publicFamilyNames.length !== releaseConfig.packages.length) {
  throw new Error("release config contains a package that is not public");
}

const packages = releaseConfig.packages.map((definition) => {
  const path = `${definition.directory}/package.json`;
  const manifest = readJson(path);
  const upstreamManifest = readGitJson(upstreamWrapperCommit, path);

  if (manifest.name !== definition.name) {
    throw new Error(`unexpected package name in ${path}: ${manifest.name}`);
  }
  if (manifest.private !== false) {
    throw new Error(`package must be public in ${path}`);
  }
  if (manifest.publishConfig?.registry !== "https://npm.pkg.github.com") {
    throw new Error(`package must target GitHub Packages in ${path}`);
  }
  if (upstreamManifest.name !== definition.upstreamName) {
    throw new Error(
      `unexpected upstream package name in ${path}: ${upstreamManifest.name}`,
    );
  }

  const version = parseStableVersion(
    manifest.version,
    `${manifest.name} version`,
  );
  parseStableVersion(
    upstreamManifest.version,
    `${upstreamManifest.name} upstream version`,
  );

  if (
    definition.name === "@astermesh/pglite" &&
    (version[0] !== lineVersion[0] || version[1] !== lineVersion[1])
  ) {
    throw new Error(
      `${manifest.name} ${manifest.version} does not belong to ${releaseLine}`,
    );
  }

  return {
    directory: definition.directory,
    name: definition.name,
    version: manifest.version,
    upstreamName: definition.upstreamName,
    upstreamVersion: upstreamManifest.version,
    postgresLicense: definition.postgresLicense === true,
  };
});

const upstreamEnginePin = git([
  "ls-tree",
  upstreamWrapperCommit,
  "postgres-pglite",
])
  .split(/\s+/)
  .at(2);
const wrapperEngineCommit = git(["ls-tree", sourceCommit, "postgres-pglite"])
  .split(/\s+/)
  .at(2);
const engineCommit = engineGit(["rev-parse", "HEAD"]);

for (const [label, commit] of [
  ["upstream engine pin", upstreamEnginePin],
  ["wrapper engine gitlink", wrapperEngineCommit],
  ["checked-out engine", engineCommit],
]) {
  if (!commitPattern.test(commit)) {
    throw new Error(`invalid ${label}: ${commit}`);
  }
}
if (wrapperEngineCommit !== engineCommit) {
  throw new Error("checked-out engine does not match the wrapper gitlink");
}

engineGit([
  "fetch",
  "--no-tags",
  "origin",
  `+refs/heads/${releaseLine}:refs/remotes/origin/${releaseLine}`,
]);
try {
  engineGit([
    "merge-base",
    "--is-ancestor",
    engineCommit,
    `refs/remotes/origin/${releaseLine}`,
  ]);
} catch {
  throw new Error(`${engineCommit} is not part of the engine ${releaseLine}`);
}

for (;;) {
  try {
    engineGit(["merge-base", "--is-ancestor", upstreamEnginePin, engineCommit]);
    break;
  } catch {
    if (engineGit(["rev-parse", "--is-shallow-repository"]) !== "true") {
      throw new Error(
        `engine ${engineCommit} is not based on ${upstreamEnginePin}`,
      );
    }
    engineGit([
      "fetch",
      "--no-tags",
      "--deepen=50",
      "origin",
      `+refs/heads/${releaseLine}:refs/remotes/origin/${releaseLine}`,
    ]);
  }
}

const buildConfig = readFileSync(
  resolve(workspace, "postgres-pglite/.buildconfig"),
  "utf8",
);
const valueFromConfig = (name) =>
  buildConfig.match(new RegExp(`^${name}=(.+)$`, "m"))?.[1];
const postgresqlVersion = valueFromConfig("PG_VERSION");
const emscriptenSdkVersion = valueFromConfig("SDK_VERSION");
const buildScript = readFileSync(
  resolve(workspace, "postgres-pglite/build-with-docker.sh"),
  "utf8",
);
const builderImage = buildScript.match(
  /^\s*(electricsql\/pglite-builder:[^\s]+)\s*\\/m,
)?.[1];

if (!postgresqlVersion || !emscriptenSdkVersion || !builderImage) {
  throw new Error("incomplete engine build identity");
}

const context = {
  schemaVersion: 1,
  releaseLine,
  distTag: releaseConfig.distTag,
  packages,
  wrapper: {
    upstream: {
      repository: "https://github.com/electric-sql/pglite",
      commit: upstreamWrapperCommit,
    },
    astermesh: {
      repository: "https://github.com/astermesh/pglite",
      commit: sourceCommit,
    },
  },
  engine: {
    upstream: {
      repository: "https://github.com/electric-sql/postgres-pglite",
      commit: upstreamEnginePin,
    },
    astermesh: {
      repository: "https://github.com/astermesh/postgres-pglite",
      commit: engineCommit,
    },
  },
  build: {
    postgresqlVersion,
    emscriptenSdkVersion,
    builderImage: {
      reference: builderImage,
    },
  },
};

writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);

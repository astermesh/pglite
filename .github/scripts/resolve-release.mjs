import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import {
  commitPattern,
  loadReleaseConfig,
  parseReleaseLine,
  parseStableVersion,
} from "./release-config.mjs";
import { validateReleaseSource } from "./release-source.mjs";
import {
  resolveSubmoduleRepository,
  runContextRepository,
} from "./repository-identity.mjs";

const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const releaseLine = process.env.RELEASE_LINE;
const contextPath = process.env.RELEASE_CONTEXT;
const releaseConfig = loadReleaseConfig(workspace);

if (!contextPath) throw new Error("RELEASE_CONTEXT is required");

function booleanEnv(name) {
  const value = process.env[name];
  if (value !== "true" && value !== "false") {
    throw new Error(`${name} must be true or false`);
  }
  return value === "true";
}

const publish = booleanEnv("PUBLISH_MODE");
const sourceOverride = booleanEnv("SOURCE_OVERRIDE");
const line = parseReleaseLine(releaseLine);
if (releaseConfig.releaseLine !== releaseLine) {
  throw new Error(
    `release config belongs to ${releaseConfig.releaseLine}, not ${releaseLine}`,
  );
}
const familyNamePattern = new RegExp(`^@${releaseConfig.scope}/pglite(?:-|$)`);

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

function isAncestor(ancestor, descendant) {
  try {
    git(["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

const releaseLineRef = `refs/remotes/origin/${releaseLine}`;
validateReleaseSource({
  publish,
  sourceOverride,
  sourceCommit,
  releaseLine,
  sourceIsOnLine: isAncestor(sourceCommit, releaseLineRef),
  sourceExtendsLine: isAncestor(releaseLineRef, sourceCommit),
});

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
    return manifest.private === false && familyNamePattern.test(manifest.name)
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
  // The guard against an accidental publication elsewhere, now aimed by the
  // line rather than by this file: a manifest must name the registry its line
  // declares, so moving the line moves the check with it.
  if (manifest.publishConfig?.registry !== releaseConfig.registry) {
    throw new Error(
      `package must target ${releaseConfig.registry} in ${path}`,
    );
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
    definition.name === releaseConfig.rootPackage &&
    (version[0] !== line.major || version[1] !== line.minor)
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

// Owner and engine repository come from the run context and the submodule
// link, never from hard-coded text: the fork must survive a move between
// organizations without another tooling pass.
const wrapperRepository = runContextRepository();
const engineRepository = resolveSubmoduleRepository(
  wrapperRepository,
  git(["config", "--file", ".gitmodules", "submodule.postgres-pglite.url"]),
);

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
  scope: releaseConfig.scope,
  distTag: releaseConfig.distTag,
  registry: releaseConfig.registry,
  packages,
  wrapper: {
    upstream: {
      repository: "https://github.com/electric-sql/pglite",
      commit: upstreamWrapperCommit,
    },
    fork: {
      repository: wrapperRepository,
      commit: sourceCommit,
    },
  },
  engine: {
    upstream: {
      repository: "https://github.com/electric-sql/postgres-pglite",
      commit: upstreamEnginePin,
    },
    fork: {
      repository: engineRepository,
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

// The three values later jobs need before they have the context file in hand:
// the tag a package is published under, the registry it is published to, and
// the scope its `.npmrc` is set up for. Emitting them here is what keeps the
// workflow from naming any of the three itself.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    [
      `dist_tag=${releaseConfig.distTag}`,
      `registry=${releaseConfig.registry}`,
      `scope=${releaseConfig.scope}`,
      "",
    ].join("\n"),
  );
}

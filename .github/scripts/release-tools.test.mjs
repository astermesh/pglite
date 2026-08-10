import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  fingerprintDirectory,
  fingerprintTarball,
} from "./artifact-fingerprint.mjs";
import {
  classifyPackage,
  parsePublishedVersions,
  readPublishedVersions,
} from "./classify-packages.mjs";
import { changedPackageVersions } from "./detect-version-change.mjs";
import {
  finalizeDistTags,
  parseDistTagListing,
  planDistTagUpdates,
  readDistTags,
  validateFinalDistTags,
} from "./dist-tags.mjs";
import { validateReleaseConfig } from "./release-config.mjs";
import { validateReleaseSource } from "./release-source.mjs";
import { planPackageTag, remoteTagCommit } from "./remote-tag.mjs";

const validConfig = {
  schemaVersion: 1,
  releaseLine: "astermesh/v0.3",
  distTag: "line-0-3",
  upstreamWrapperCommit: "4555814e2b0beac8af5d5d760907040b7b8f61df",
  packages: [
    {
      directory: "packages/pglite",
      name: "@astermesh/pglite",
      upstreamName: "@electric-sql/pglite",
      postgresLicense: true,
    },
    {
      directory: "packages/pglite-react",
      name: "@astermesh/pglite-react",
      upstreamName: "@electric-sql/pglite-react",
    },
  ],
};

function fakeDistTagRegistry(initialTags) {
  const calls = [];
  const tagsByPackage = new Map(
    Object.entries(initialTags).map(([name, tags]) => [
      name,
      new Map(Object.entries(tags)),
    ]),
  );

  function runNpm(args) {
    calls.push(args);
    const [command, action, specOrName, tag] = args;
    assert.equal(command, "dist-tag");

    if (action === "ls") {
      const tags = tagsByPackage.get(specOrName);
      assert.ok(tags, `unexpected package: ${specOrName}`);
      return [...tags]
        .map(([name, version]) => `${name}: ${version}`)
        .join("\n");
    }

    if (action === "add") {
      const separator = specOrName.lastIndexOf("@");
      const packageName = specOrName.slice(0, separator);
      const version = specOrName.slice(separator + 1);
      const tags = tagsByPackage.get(packageName);
      assert.ok(tags, `unexpected package: ${packageName}`);
      tags.set(tag, version);
      return "";
    }

    if (action === "rm") {
      const tags = tagsByPackage.get(specOrName);
      assert.ok(tags, `unexpected package: ${specOrName}`);
      tags.delete(tag);
      return "";
    }

    throw new Error(`unexpected npm command: ${args.join(" ")}`);
  }

  return { calls, runNpm, tagsByPackage };
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.notEqual(startIndex, -1, `missing workflow section: ${start.trim()}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing workflow section: ${end.trim()}`);
  return source.slice(startIndex, endIndex);
}

test("verification mode cannot reach release write capabilities", () => {
  const workflow = readFileSync(
    new URL("../workflows/build.yml", import.meta.url),
    "utf8",
  );
  const permissions = section(workflow, "permissions:\n", "\non:\n");
  const dispatch = section(
    workflow,
    "  workflow_dispatch:\n",
    "  workflow_call:\n",
  );
  const call = section(workflow, "  workflow_call:\n", "\nconcurrency:\n");
  const build = section(workflow, "\n  build:\n", "\n  verify:\n");
  const verify = section(workflow, "\n  verify:\n", "\n  approval:\n");
  const approval = section(workflow, "\n  approval:\n", "\n  publish:\n");
  const beforePublish = workflow.slice(0, workflow.indexOf("\n  publish:\n"));
  const publish = section(workflow, "\n  publish:\n", "\n  finalize:\n");
  const finalize = workflow.slice(workflow.indexOf("\n  finalize:\n"));

  assert.equal(
    permissions,
    "permissions:\n  contents: read\n  packages: read\n",
  );
  assert.match(dispatch, /publish:[\s\S]*default: false[\s\S]*type: boolean/);
  assert.match(dispatch, /source_ref:[\s\S]*default: ""[\s\S]*type: string/);
  assert.match(call, /publish:[\s\S]*required: true[\s\S]*type: boolean/);
  assert.match(call, /source_ref:[\s\S]*default: ""[\s\S]*type: string/);
  assert.match(
    workflow,
    /SOURCE_REF: \$\{\{ inputs\.source_ref \|\| inputs\.ref \}\}/,
  );
  assert.match(
    workflow,
    /SOURCE_OVERRIDE: \$\{\{ inputs\.source_ref != '' \}\}/,
  );
  assert.match(workflow, /PUBLISH_MODE: \$\{\{ inputs\.publish \}\}/);
  assert.ok(
    build.indexOf("Upload package family") <
      build.indexOf("Classify package versions"),
    "package artifacts must be uploaded before registry classification",
  );

  assert.doesNotMatch(
    beforePublish,
    /^\s+(artifact-metadata|attestations|id-token|packages): write$/m,
  );
  assert.match(
    verify,
    /permissions:\n      contents: read\n      packages: read/,
  );
  assert.doesNotMatch(
    verify,
    /artifact-metadata: write|attestations: write|id-token: write|packages: write/,
  );
  assert.match(verify, /Upload verified fork lineage/);
  assert.match(verify, /npm publish "\$TARBALL" \\\n            --dry-run/);

  assert.match(approval, /inputs\.publish/);
  assert.match(approval, /- build/);
  assert.match(approval, /- verify/);
  assert.match(approval, /environment: packages-production/);
  assert.match(approval, /permissions: \{\}/);
  assert.match(
    approval,
    /run_attempt: \$\{\{ steps\.approved\.outputs\.run_attempt \}\}/,
  );
  assert.match(approval, /run_attempt=\$GITHUB_RUN_ATTEMPT/);

  assert.match(publish, /inputs\.publish/);
  assert.match(publish, /- verify/);
  assert.match(publish, /- approval/);
  assert.match(
    publish,
    /needs\.approval\.outputs\.run_attempt == github\.run_attempt/,
  );
  assert.match(publish, /Download verified fork lineage/);
  assert.doesNotMatch(publish, /write-lineage\.mjs/);
  assert.match(
    publish,
    /predicate-path: \$\{\{ runner\.temp \}\}\/lineage\/fork-lineage\.json/,
  );
  assert.match(publish, /artifact-metadata: write/);
  assert.match(publish, /attestations: write/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /packages: write/);
  assert.doesNotMatch(publish, /environment:/);

  assert.match(finalize, /inputs\.publish/);
  assert.match(finalize, /- verify/);
  assert.match(finalize, /- approval/);
  assert.match(finalize, /- publish/);
  assert.match(
    finalize,
    /needs\.approval\.outputs\.run_attempt == github\.run_attempt/,
  );
  assert.doesNotMatch(finalize, /environment:/);
});

test("release-tooling CI verifies the live package query read-only", () => {
  const workflow = readFileSync(
    new URL("../workflows/test-release-tooling.yml", import.meta.url),
    "utf8",
  );

  assert.match(
    workflow,
    /permissions:\n  contents: read\n  packages: read\n/,
  );
  assert.match(workflow, /registry-url: "https:\/\/npm\.pkg\.github\.com"/);
  assert.match(workflow, /scope: "@astermesh"/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  assert.match(
    workflow,
    /npm view '@astermesh\/pglite@>=0\.0\.0' version --json --registry=https:\/\/npm\.pkg\.github\.com/,
  );
  assert.match(workflow, /parsePublishedVersions\(process\.argv\[1\]/);
  assert.doesNotMatch(workflow, /packages: write/);
});

test("release source overrides are verification-only line descendants", () => {
  const base = {
    sourceCommit: "a".repeat(40),
    releaseLine: "astermesh/v0.3",
  };

  assert.equal(
    validateReleaseSource({
      ...base,
      publish: true,
      sourceOverride: false,
      sourceIsOnLine: true,
      sourceExtendsLine: false,
    }),
    "landed",
  );
  assert.equal(
    validateReleaseSource({
      ...base,
      publish: false,
      sourceOverride: true,
      sourceIsOnLine: false,
      sourceExtendsLine: true,
    }),
    "candidate",
  );
  assert.throws(
    () =>
      validateReleaseSource({
        ...base,
        publish: true,
        sourceOverride: true,
        sourceIsOnLine: true,
        sourceExtendsLine: true,
      }),
    /source_ref is allowed only when publish is false/,
  );
  assert.throws(
    () =>
      validateReleaseSource({
        ...base,
        publish: false,
        sourceOverride: false,
        sourceIsOnLine: false,
        sourceExtendsLine: true,
      }),
    /not an allowed source/,
  );
  assert.throws(
    () =>
      validateReleaseSource({
        ...base,
        publish: false,
        sourceOverride: true,
        sourceIsOnLine: false,
        sourceExtendsLine: false,
      }),
    /not an allowed source/,
  );
  assert.throws(
    () =>
      validateReleaseSource({
        ...base,
        publish: true,
        sourceOverride: false,
        sourceIsOnLine: false,
        sourceExtendsLine: true,
      }),
    /not an allowed source/,
  );
});

test("release config owns and validates the complete package list", () => {
  assert.deepEqual(validateReleaseConfig(validConfig), {
    ...validConfig,
    packages: [
      validConfig.packages[0],
      { ...validConfig.packages[1], postgresLicense: false },
    ],
  });
  assert.throws(
    () =>
      validateReleaseConfig({
        ...validConfig,
        packages: [validConfig.packages[0], validConfig.packages[0]],
      }),
    /duplicate directory/,
  );
  assert.throws(
    () => validateReleaseConfig({ ...validConfig, distTag: "latest" }),
    /must use dist tag/,
  );
  assert.throws(
    () =>
      validateReleaseConfig({
        ...validConfig,
        upstreamWrapperCommit: "main",
      }),
    /invalid upstream wrapper commit/,
  );
});

test("artifact fingerprint ignores filesystem metadata but detects content", () => {
  const first = mkdtempSync(resolve(tmpdir(), "fingerprint-first-"));
  const second = mkdtempSync(resolve(tmpdir(), "fingerprint-second-"));
  try {
    for (const root of [first, second]) {
      mkdirSync(resolve(root, "dist"));
      writeFileSync(resolve(root, "package.json"), '{"name":"example"}\n');
      writeFileSync(resolve(root, "dist/index.js"), "export default 1\n");
      chmodSync(resolve(root, "dist/index.js"), 0o755);
    }
    assert.equal(fingerprintDirectory(first), fingerprintDirectory(second));
    writeFileSync(resolve(second, "dist/index.js"), "export default 2\n");
    assert.notEqual(fingerprintDirectory(first), fingerprintDirectory(second));
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("tarball fingerprint ignores archive metadata", () => {
  const root = mkdtempSync(resolve(tmpdir(), "fingerprint-tarballs-"));
  try {
    for (const name of ["first", "second"]) {
      const packageRoot = resolve(root, name, "package");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        resolve(packageRoot, "package.json"),
        '{"name":"example"}\n',
      );
      execFileSync("tar", [
        "-czf",
        resolve(root, `${name}.tgz`),
        "-C",
        resolve(root, name),
        "package",
      ]);
    }
    assert.equal(
      fingerprintTarball(resolve(root, "first.tgz")),
      fingerprintTarball(resolve(root, "second.tgz")),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("tarball fingerprint normalizes nested archive metadata", () => {
  const root = mkdtempSync(resolve(tmpdir(), "nested-fingerprint-"));
  const makePackage = (name, timestamp, content) => {
    const packageRoot = resolve(root, name, "package");
    const extensionRoot = resolve(root, `${name}-extension`);
    mkdirSync(resolve(packageRoot, "dist"), { recursive: true });
    mkdirSync(resolve(extensionRoot, "lib"), { recursive: true });
    const library = resolve(extensionRoot, "lib/extension.so");
    writeFileSync(library, content);
    chmodSync(library, 0o755);
    utimesSync(library, timestamp, timestamp);
    const nested = resolve(packageRoot, "dist/extension.tar.gz");
    execFileSync("tar", ["-czf", nested, "-C", extensionRoot, "."]);
    const outer = resolve(root, `${name}.tgz`);
    execFileSync("tar", [
      "-czf",
      outer,
      "-C",
      resolve(root, name),
      "package",
    ]);
    return { nested, outer };
  };

  try {
    const first = makePackage("first", new Date(0), "same content\n");
    const second = makePackage(
      "second",
      new Date("2026-07-28T01:06:00Z"),
      "same content\n",
    );
    const changed = makePackage(
      "changed",
      new Date("2026-07-28T01:06:00Z"),
      "changed content\n",
    );

    assert.notDeepEqual(readFileSync(first.nested), readFileSync(second.nested));
    assert.equal(
      fingerprintTarball(first.outer),
      fingerprintTarball(second.outer),
    );
    assert.notEqual(
      fingerprintTarball(first.outer),
      fingerprintTarball(changed.outer),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry versions use a stable range and fail closed", () => {
  const calls = [];
  const versions = readPublishedVersions(
    (args) => {
      calls.push(args);
      return '["0.3.16","0.3.17"]\n';
    },
    "@astermesh/pglite",
  );

  assert.deepEqual(calls, [
    [
      "view",
      "@astermesh/pglite@>=0.0.0",
      "version",
      "--json",
    ],
  ]);
  assert.deepEqual(versions, ["0.3.16", "0.3.17"]);
  assert.deepEqual(
    parsePublishedVersions('"0.3.17"\n', "@astermesh/pglite"),
    ["0.3.17"],
  );
  assert.deepEqual(
    readPublishedVersions(() => undefined, "@astermesh/pglite"),
    [],
  );
  assert.throws(
    () => parsePublishedVersions("", "@astermesh/pglite"),
    /empty published versions response/,
  );
  assert.throws(
    () => parsePublishedVersions("{", "@astermesh/pglite"),
    /invalid published versions response/,
  );
  assert.throws(
    () => parsePublishedVersions('{"version":"0.3.17"}', "@astermesh/pglite"),
    /invalid published version/,
  );
  assert.throws(
    () =>
      parsePublishedVersions(
        '["0.3.17","0.3.17"]',
        "@astermesh/pglite",
      ),
    /duplicate published version/,
  );
});

test("registry classification rejects reused and regressed versions", () => {
  const pkg = {
    name: "@astermesh/pglite",
    version: "0.3.17",
    fingerprint: "sha256:local",
  };
  assert.equal(classifyPackage(pkg, ["0.3.18-beta.1"], undefined), "publish");
  assert.equal(classifyPackage(pkg, ["0.3.17"], "sha256:local"), "existing");
  assert.throws(
    () => classifyPackage(pkg, ["0.3.17"], "sha256:remote"),
    /different contents \(built sha256:local, published sha256:remote\)/,
  );
  assert.throws(() => classifyPackage(pkg, ["0.3.18"], undefined), /not newer/);
});

test("registry dist-tags use the documented listing command and format", () => {
  const calls = [];
  const tags = readDistTags(
    (args) => {
      calls.push(args);
      return [
        "line-0-3: 0.3.17",
        "staging-30300319510: 0.3.17",
        "",
      ].join("\n");
    },
    "@astermesh/pglite",
  );
  assert.deepEqual(calls, [["dist-tag", "ls", "@astermesh/pglite"]]);
  assert.deepEqual(
    tags,
    new Map([
      ["line-0-3", "0.3.17"],
      ["staging-30300319510", "0.3.17"],
    ]),
  );
  assert.deepEqual(
    parseDistTagListing(
      [
        "line-0-3: 0.3.17",
        "staging-30300319510: 0.3.17",
        "",
      ].join("\n"),
      "@astermesh/pglite",
    ),
    new Map([
      ["line-0-3", "0.3.17"],
      ["staging-30300319510", "0.3.17"],
    ]),
  );
  assert.deepEqual(
    parseDistTagListing("", "@astermesh/pglite"),
    new Map(),
  );
  assert.throws(
    () => parseDistTagListing("not a tag record", "@astermesh/pglite"),
    /invalid dist-tag record/,
  );
  assert.throws(
    () =>
      parseDistTagListing(
        "line-0-3: 0.3.17\nline-0-3: 0.3.18\n",
        "@astermesh/pglite",
      ),
    /duplicate dist-tag/,
  );
});

test("dist-tag finalization recovers from a partial previous attempt", () => {
  const common = {
    version: "0.3.17",
    distTag: "line-0-3",
    promoteLatest: false,
  };
  const partiallyFinalized = parseDistTagListing(
    "line-0-3: 0.3.17\nstaging-30300319510: 0.3.17\n",
    "@astermesh/pglite",
  );
  const stagedOnly = parseDistTagListing(
    "staging-30300319510: 0.3.17\n",
    "@astermesh/pglite-react",
  );

  assert.deepEqual(
    planDistTagUpdates({ ...common, tags: partiallyFinalized }),
    {
      additions: [],
      removals: ["staging-30300319510"],
    },
  );
  assert.deepEqual(planDistTagUpdates({ ...common, tags: stagedOnly }), {
    additions: ["line-0-3"],
    removals: ["staging-30300319510"],
  });
  assert.deepEqual(
    planDistTagUpdates({ ...common, tags: new Map() }),
    {
      additions: ["line-0-3"],
      removals: [],
    },
  );

  const finalized = new Map([["line-0-3", "0.3.17"]]);
  assert.deepEqual(planDistTagUpdates({ ...common, tags: finalized }), {
    additions: [],
    removals: [],
  });
  assert.doesNotThrow(() =>
    validateFinalDistTags({
      ...common,
      packageName: "@astermesh/pglite",
      tags: finalized,
    }),
  );
  assert.throws(
    () =>
      validateFinalDistTags({
        ...common,
        packageName: "@astermesh/pglite",
        tags: partiallyFinalized,
      }),
    /still has staging dist-tags/,
  );
});

test("package-family tag finalization is ordered and idempotent", () => {
  const packages = [
    { name: "@astermesh/pglite", version: "0.3.17" },
    { name: "@astermesh/pglite-react", version: "0.2.34" },
    { name: "@astermesh/pglite-vue", version: "0.2.34" },
  ];
  const registry = fakeDistTagRegistry({
    "@astermesh/pglite": {
      "line-0-3": "0.3.17",
      "staging-30300319510": "0.3.17",
      "staging-future": "0.3.18",
    },
    "@astermesh/pglite-react": {
      "staging-30300319510": "0.2.34",
    },
    "@astermesh/pglite-vue": {},
  });
  const finalize = () =>
    finalizeDistTags({
      packages,
      distTag: "line-0-3",
      promoteLatest: false,
      runNpm: registry.runNpm,
    });

  finalize();

  const mutations = registry.calls.filter(([, action]) => action !== "ls");
  assert.deepEqual(mutations, [
    [
      "dist-tag",
      "add",
      "@astermesh/pglite-react@0.2.34",
      "line-0-3",
    ],
    [
      "dist-tag",
      "add",
      "@astermesh/pglite-vue@0.2.34",
      "line-0-3",
    ],
    [
      "dist-tag",
      "rm",
      "@astermesh/pglite",
      "staging-30300319510",
    ],
    [
      "dist-tag",
      "rm",
      "@astermesh/pglite-react",
      "staging-30300319510",
    ],
  ]);
  assert.deepEqual(
    Object.fromEntries(registry.tagsByPackage.get("@astermesh/pglite")),
    {
      "line-0-3": "0.3.17",
      "staging-future": "0.3.18",
    },
  );
  assert.deepEqual(
    Object.fromEntries(registry.tagsByPackage.get("@astermesh/pglite-react")),
    { "line-0-3": "0.2.34" },
  );
  assert.deepEqual(
    Object.fromEntries(registry.tagsByPackage.get("@astermesh/pglite-vue")),
    { "line-0-3": "0.2.34" },
  );

  finalize();
  assert.deepEqual(
    registry.calls.filter(([, action]) => action !== "ls"),
    mutations,
  );
});

test("package-family tag finalization can promote latest", () => {
  const registry = fakeDistTagRegistry({
    "@astermesh/pglite": {
      latest: "0.3.16",
      "line-0-3": "0.3.17",
      "staging-30300319510": "0.3.17",
    },
  });

  finalizeDistTags({
    packages: [{ name: "@astermesh/pglite", version: "0.3.17" }],
    distTag: "line-0-3",
    promoteLatest: true,
    runNpm: registry.runNpm,
  });

  assert.deepEqual(
    Object.fromEntries(registry.tagsByPackage.get("@astermesh/pglite")),
    {
      latest: "0.3.17",
      "line-0-3": "0.3.17",
    },
  );
});

test("package-family tag finalization validates all listings before writes", () => {
  const mutations = [];
  const runNpm = (args) => {
    const [, action, packageName] = args;
    if (action !== "ls") {
      mutations.push(args);
      return "";
    }
    if (packageName === "@astermesh/pglite") {
      return "staging-30300319510: 0.3.17\n";
    }
    return "not a dist-tag record\n";
  };

  assert.throws(
    () =>
      finalizeDistTags({
        packages: [
          { name: "@astermesh/pglite", version: "0.3.17" },
          { name: "@astermesh/pglite-react", version: "0.2.34" },
        ],
        distTag: "line-0-3",
        promoteLatest: false,
        runNpm,
      }),
    /invalid dist-tag record for @astermesh\/pglite-react/,
  );
  assert.deepEqual(mutations, []);
});

test("package-family tag finalization enforces registry postconditions", () => {
  const mutations = [];
  const runNpm = (args) => {
    const [, action] = args;
    if (action === "ls") {
      return "staging-30300319510: 0.3.17\n";
    }
    mutations.push(args);
    return "";
  };

  assert.throws(
    () =>
      finalizeDistTags({
        packages: [{ name: "@astermesh/pglite", version: "0.3.17" }],
        distTag: "line-0-3",
        promoteLatest: false,
        runNpm,
      }),
    /dist-tag line-0-3 does not point to 0.3.17/,
  );
  assert.deepEqual(mutations, [
    ["dist-tag", "add", "@astermesh/pglite@0.3.17", "line-0-3"],
    [
      "dist-tag",
      "rm",
      "@astermesh/pglite",
      "staging-30300319510",
    ],
  ]);
});

test("remote package tags resolve to their commit targets", () => {
  const tag = "@astermesh/pglite@0.3.17";
  const tagObject = "a".repeat(40);
  const commit = "b".repeat(40);

  assert.equal(remoteTagCommit("", tag), undefined);
  assert.equal(remoteTagCommit(`${commit}\trefs/tags/${tag}\n`, tag), commit);
  assert.equal(
    remoteTagCommit(
      [
        `${tagObject}\trefs/tags/${tag}`,
        `${commit}\trefs/tags/${tag}^{}`,
        "",
      ].join("\n"),
      tag,
    ),
    commit,
  );
  assert.throws(
    () => remoteTagCommit(`invalid\trefs/tags/${tag}\n`, tag),
    /invalid remote tag record/,
  );
});

test("existing package tags retain their original matching release commit", () => {
  const originalCommit = "a".repeat(40);
  assert.deepEqual(
    planPackageTag({
      tag: "@astermesh/pglite@0.3.17",
      remoteCommit: originalCommit,
      currentCommit: "b".repeat(40),
      packageName: "@astermesh/pglite",
      packageVersion: "0.3.17",
      manifest: {
        name: "@astermesh/pglite",
        version: "0.3.17",
      },
    }),
    { action: "keep", commit: originalCommit },
  );
});

test("missing package tags are created for the current release", () => {
  const currentCommit = "b".repeat(40);
  assert.deepEqual(
    planPackageTag({
      tag: "@astermesh/pglite-socket@0.0.23",
      remoteCommit: undefined,
      currentCommit,
      packageName: "@astermesh/pglite-socket",
      packageVersion: "0.0.23",
      manifest: undefined,
    }),
    { action: "create", commit: currentCommit },
  );
});

test("existing package tag targets must declare the tagged identity", () => {
  const common = {
    tag: "@astermesh/pglite@0.3.17",
    remoteCommit: "a".repeat(40),
    currentCommit: "b".repeat(40),
    packageName: "@astermesh/pglite",
    packageVersion: "0.3.17",
  };

  assert.throws(
    () =>
      planPackageTag({
        ...common,
        manifest: {
          name: "@astermesh/pglite",
          version: "0.3.16",
        },
      }),
    /does not declare @astermesh\/pglite@0\.3\.17/,
  );
  assert.throws(
    () =>
      planPackageTag({
        ...common,
        manifest: {
          name: "@astermesh/pglite-react",
          version: "0.3.17",
        },
      }),
    /does not declare @astermesh\/pglite@0\.3\.17/,
  );
  assert.throws(
    () => planPackageTag({ ...common, manifest: undefined }),
    /does not declare @astermesh\/pglite@0\.3\.17/,
  );
});

test("package Git tags are preflighted before registry tags mutate", () => {
  const finalizer = readFileSync(
    new URL("./finalize-release.mjs", import.meta.url),
    "utf8",
  );
  const gitTagPreflight = finalizer.indexOf("const gitTagPlans");
  const registryFinalization = finalizer.indexOf("finalizeDistTags({");

  assert.notEqual(gitTagPreflight, -1);
  assert.notEqual(registryFinalization, -1);
  assert.ok(gitTagPreflight < registryFinalization);
});

test("automatic publication reacts only to package version changes", () => {
  const packages = validConfig.packages;
  const current = new Map([
    [
      "packages/pglite/package.json",
      { name: "@astermesh/pglite", version: "0.3.17", description: "new" },
    ],
    [
      "packages/pglite-react/package.json",
      { name: "@astermesh/pglite-react", version: "0.2.34" },
    ],
  ]);
  const unchangedVersions = new Map([
    [
      "packages/pglite/package.json",
      { name: "@astermesh/pglite", version: "0.3.17", description: "old" },
    ],
    [
      "packages/pglite-react/package.json",
      { name: "@astermesh/pglite-react", version: "0.2.34" },
    ],
  ]);
  assert.deepEqual(
    changedPackageVersions(
      packages,
      (path) => unchangedVersions.get(path),
      (path) => current.get(path),
    ),
    [],
  );

  unchangedVersions.get("packages/pglite/package.json").version = "0.3.16";
  assert.deepEqual(
    changedPackageVersions(
      packages,
      (path) => unchangedVersions.get(path),
      (path) => current.get(path),
    ),
    [
      {
        name: "@astermesh/pglite",
        before: "0.3.16",
        after: "0.3.17",
      },
    ],
  );
});

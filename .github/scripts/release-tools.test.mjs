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
import {
  loadReleaseConfig,
  parseReleaseLine,
  releaseConfigPath,
  releaseLineDistTag,
  validateReleaseConfig,
} from "./release-config.mjs";
import { validateReleaseSource } from "./release-source.mjs";
import {
  resolveSubmoduleRepository,
  runContextRepository,
} from "./repository-identity.mjs";
import { planPackageTag, remoteTagCommit } from "./remote-tag.mjs";

// Every organization this fork has answered to. The release machinery derives
// the owner from the run rather than naming it, and this pattern is what holds
// it to that: the name has already changed twice, and each change found a
// hard-coded copy that nothing else reported. Fixtures below use `@acme` and
// `@example` precisely because neither is a name anyone could mistake for ours.
const ownerNamePattern = /astermesh|simthat|simthis/i;

const validConfig = {
  schemaVersion: 1,
  releaseLine: "simbox/v0.3",
  distTag: "line-0-3",
  upstreamWrapperCommit: "4555814e2b0beac8af5d5d760907040b7b8f61df",
  packages: [
    {
      directory: "packages/pglite",
      name: "@acme/pglite",
      upstreamName: "@electric-sql/pglite",
      postgresLicense: true,
    },
    {
      directory: "packages/pglite-react",
      name: "@acme/pglite-react",
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

test("verification runs never share the release concurrency group", () => {
  const workflow = readFileSync(
    new URL("../workflows/build.yml", import.meta.url),
    "utf8",
  );
  const concurrency = section(workflow, "\nconcurrency:\n", "\nenv:\n");

  assert.match(concurrency, /\$\{\{ inputs\.publish/);
  assert.match(
    concurrency,
    /&& format\('pglite-release-\{0\}', inputs\.line \|\| inputs\.ref\)/,
  );
  assert.match(
    concurrency,
    /\|\| format\('pglite-verify-\{0\}', github\.run_id\)/,
  );
  assert.equal(
    concurrency.match(/pglite-release-/g).length,
    1,
    "the serialized release group must exist only on the publish branch",
  );
  assert.match(concurrency, /cancel-in-progress: false/);
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
  assert.match(workflow, /scope: "@\$\{\{ github\.repository_owner \}\}"/);
  assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.GITHUB_TOKEN \}\}/);
  // The probe names no owner of its own. On GitHub Packages the scope is the
  // repository owner, and the run token can read only what its own owner holds,
  // so a written-down scope breaks the moment the repository moves.
  assert.match(
    workflow,
    /PUBLISHED_PACKAGE: "@\$\{\{ github\.repository_owner \}\}\/pglite"/,
  );
  assert.doesNotMatch(workflow, /PUBLISHED_PACKAGE: "@[a-z0-9][a-z0-9-]*\//);
  assert.match(
    workflow,
    /npm view "\$PUBLISHED_PACKAGE@>=0\.0\.0" version --json/,
  );
  assert.match(workflow, /--registry=https:\/\/npm\.pkg\.github\.com/);
  assert.match(
    workflow,
    /parsePublishedVersions\(process\.argv\[1\], process\.argv\[2\]\)/,
  );
  assert.doesNotMatch(workflow, /packages: write/);
});

test("the live package query judges a 404 against a declared state", () => {
  const workflow = readFileSync(
    new URL("../workflows/test-release-tooling.yml", import.meta.url),
    "utf8",
  );

  // GitHub Packages returns the same 404, worded the same way, for a record
  // that does not exist and for one this token may not read. The probe must
  // therefore never conclude anything from a 404 alone.
  assert.match(workflow, /PUBLISHED_STATE: present/);
  assert.match(
    workflow,
    /\[ "\$PUBLISHED_STATE" = "absent" \] && grep -q 'E404'/,
  );
  // A positive control runs first, so a 404 cannot stand in for a broken
  // connection, a missing token or a rejected one.
  assert.match(workflow, /npm whoami --registry=https:\/\/npm\.pkg\.github\.com/);
  // Both disagreements with the declared state fail.
  assert.match(workflow, /is declared absent, but the registry returned a record/);
  assert.match(workflow, /cat "\$RUNNER_TEMP\/npm-view\.err" >&2\n\s*exit 1/);
});

test("release source overrides are verification-only line descendants", () => {
  const base = {
    sourceCommit: "a".repeat(40),
    releaseLine: "simbox/v0.3",
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
    scope: "acme",
    rootPackage: "@acme/pglite",
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
    "@acme/pglite",
  );

  assert.deepEqual(calls, [
    [
      "view",
      "@acme/pglite@>=0.0.0",
      "version",
      "--json",
    ],
  ]);
  assert.deepEqual(versions, ["0.3.16", "0.3.17"]);
  assert.deepEqual(
    parsePublishedVersions('"0.3.17"\n', "@acme/pglite"),
    ["0.3.17"],
  );
  assert.deepEqual(
    readPublishedVersions(() => undefined, "@acme/pglite"),
    [],
  );
  assert.throws(
    () => parsePublishedVersions("", "@acme/pglite"),
    /empty published versions response/,
  );
  assert.throws(
    () => parsePublishedVersions("{", "@acme/pglite"),
    /invalid published versions response/,
  );
  assert.throws(
    () => parsePublishedVersions('{"version":"0.3.17"}', "@acme/pglite"),
    /invalid published version/,
  );
  assert.throws(
    () =>
      parsePublishedVersions(
        '["0.3.17","0.3.17"]',
        "@acme/pglite",
      ),
    /duplicate published version/,
  );
});

test("registry classification rejects reused and regressed versions", () => {
  const pkg = {
    name: "@acme/pglite",
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
    "@acme/pglite",
  );
  assert.deepEqual(calls, [["dist-tag", "ls", "@acme/pglite"]]);
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
      "@acme/pglite",
    ),
    new Map([
      ["line-0-3", "0.3.17"],
      ["staging-30300319510", "0.3.17"],
    ]),
  );
  assert.deepEqual(
    parseDistTagListing("", "@acme/pglite"),
    new Map(),
  );
  assert.throws(
    () => parseDistTagListing("not a tag record", "@acme/pglite"),
    /invalid dist-tag record/,
  );
  assert.throws(
    () =>
      parseDistTagListing(
        "line-0-3: 0.3.17\nline-0-3: 0.3.18\n",
        "@acme/pglite",
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
    "@acme/pglite",
  );
  const stagedOnly = parseDistTagListing(
    "staging-30300319510: 0.3.17\n",
    "@acme/pglite-react",
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
      packageName: "@acme/pglite",
      tags: finalized,
    }),
  );
  assert.throws(
    () =>
      validateFinalDistTags({
        ...common,
        packageName: "@acme/pglite",
        tags: partiallyFinalized,
      }),
    /still has staging dist-tags/,
  );
});

test("package-family tag finalization is ordered and idempotent", () => {
  const packages = [
    { name: "@acme/pglite", version: "0.3.17" },
    { name: "@acme/pglite-react", version: "0.2.34" },
    { name: "@acme/pglite-vue", version: "0.2.34" },
  ];
  const registry = fakeDistTagRegistry({
    "@acme/pglite": {
      "line-0-3": "0.3.17",
      "staging-30300319510": "0.3.17",
      "staging-future": "0.3.18",
    },
    "@acme/pglite-react": {
      "staging-30300319510": "0.2.34",
    },
    "@acme/pglite-vue": {},
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
      "@acme/pglite-react@0.2.34",
      "line-0-3",
    ],
    [
      "dist-tag",
      "add",
      "@acme/pglite-vue@0.2.34",
      "line-0-3",
    ],
    [
      "dist-tag",
      "rm",
      "@acme/pglite",
      "staging-30300319510",
    ],
    [
      "dist-tag",
      "rm",
      "@acme/pglite-react",
      "staging-30300319510",
    ],
  ]);
  assert.deepEqual(
    Object.fromEntries(registry.tagsByPackage.get("@acme/pglite")),
    {
      "line-0-3": "0.3.17",
      "staging-future": "0.3.18",
    },
  );
  assert.deepEqual(
    Object.fromEntries(registry.tagsByPackage.get("@acme/pglite-react")),
    { "line-0-3": "0.2.34" },
  );
  assert.deepEqual(
    Object.fromEntries(registry.tagsByPackage.get("@acme/pglite-vue")),
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
    "@acme/pglite": {
      latest: "0.3.16",
      "line-0-3": "0.3.17",
      "staging-30300319510": "0.3.17",
    },
  });

  finalizeDistTags({
    packages: [{ name: "@acme/pglite", version: "0.3.17" }],
    distTag: "line-0-3",
    promoteLatest: true,
    runNpm: registry.runNpm,
  });

  assert.deepEqual(
    Object.fromEntries(registry.tagsByPackage.get("@acme/pglite")),
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
    if (packageName === "@acme/pglite") {
      return "staging-30300319510: 0.3.17\n";
    }
    return "not a dist-tag record\n";
  };

  assert.throws(
    () =>
      finalizeDistTags({
        packages: [
          { name: "@acme/pglite", version: "0.3.17" },
          { name: "@acme/pglite-react", version: "0.2.34" },
        ],
        distTag: "line-0-3",
        promoteLatest: false,
        runNpm,
      }),
    /invalid dist-tag record for @acme\/pglite-react/,
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
        packages: [{ name: "@acme/pglite", version: "0.3.17" }],
        distTag: "line-0-3",
        promoteLatest: false,
        runNpm,
      }),
    /dist-tag line-0-3 does not point to 0.3.17/,
  );
  assert.deepEqual(mutations, [
    ["dist-tag", "add", "@acme/pglite@0.3.17", "line-0-3"],
    [
      "dist-tag",
      "rm",
      "@acme/pglite",
      "staging-30300319510",
    ],
  ]);
});

test("remote package tags resolve to their commit targets", () => {
  const tag = "@acme/pglite@0.3.17";
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
      tag: "@acme/pglite@0.3.17",
      remoteCommit: originalCommit,
      currentCommit: "b".repeat(40),
      packageName: "@acme/pglite",
      packageVersion: "0.3.17",
      manifest: {
        name: "@acme/pglite",
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
      tag: "@acme/pglite-socket@0.0.23",
      remoteCommit: undefined,
      currentCommit,
      packageName: "@acme/pglite-socket",
      packageVersion: "0.0.23",
      manifest: undefined,
    }),
    { action: "create", commit: currentCommit },
  );
});

test("existing package tag targets must declare the tagged identity", () => {
  const common = {
    tag: "@acme/pglite@0.3.17",
    remoteCommit: "a".repeat(40),
    currentCommit: "b".repeat(40),
    packageName: "@acme/pglite",
    packageVersion: "0.3.17",
  };

  assert.throws(
    () =>
      planPackageTag({
        ...common,
        manifest: {
          name: "@acme/pglite",
          version: "0.3.16",
        },
      }),
    /does not declare @acme\/pglite@0\.3\.17/,
  );
  assert.throws(
    () =>
      planPackageTag({
        ...common,
        manifest: {
          name: "@acme/pglite-react",
          version: "0.3.17",
        },
      }),
    /does not declare @acme\/pglite@0\.3\.17/,
  );
  assert.throws(
    () => planPackageTag({ ...common, manifest: undefined }),
    /does not declare @acme\/pglite@0\.3\.17/,
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
      { name: "@acme/pglite", version: "0.3.17", description: "new" },
    ],
    [
      "packages/pglite-react/package.json",
      { name: "@acme/pglite-react", version: "0.2.34" },
    ],
  ]);
  const unchangedVersions = new Map([
    [
      "packages/pglite/package.json",
      { name: "@acme/pglite", version: "0.3.17", description: "old" },
    ],
    [
      "packages/pglite-react/package.json",
      { name: "@acme/pglite-react", version: "0.2.34" },
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
        name: "@acme/pglite",
        before: "0.3.16",
        after: "0.3.17",
      },
    ],
  );
});

test("release lines name a platform, a version, and an optional variant", () => {
  assert.deepEqual(parseReleaseLine("simbox/v0.3"), {
    platform: "simbox",
    major: 0,
    minor: 3,
    variant: undefined,
  });
  assert.deepEqual(parseReleaseLine("simbox/v0.3-postgis"), {
    platform: "simbox",
    major: 0,
    minor: 3,
    variant: "postgis",
  });
  assert.equal(releaseLineDistTag(parseReleaseLine("simbox/v0.5")), "line-0-5");
  assert.equal(
    releaseLineDistTag(parseReleaseLine("simbox/v0.3-postgis")),
    "line-0-3-postgis",
  );
  assert.equal(
    validateReleaseConfig({
      ...validConfig,
      releaseLine: "simbox/v0.3-postgis",
      distTag: "line-0-3-postgis",
    }).distTag,
    "line-0-3-postgis",
  );

  for (const line of [
    "v0.3",
    "simbox/0.3",
    "SimBox/v0.3",
    "simbox/v0",
    "simbox/v0.3-",
    "simbox/v0.3-PostGIS",
  ]) {
    assert.throws(() => parseReleaseLine(line), /invalid release line/);
  }
});

test("the package scope follows the manifest, not the tooling", () => {
  const elsewhere = {
    ...validConfig,
    packages: validConfig.packages.map((entry) => ({
      ...entry,
      name: entry.name.replace("@acme/", "@example/"),
    })),
  };
  const resolved = validateReleaseConfig(elsewhere);
  assert.equal(resolved.scope, "example");
  assert.equal(resolved.rootPackage, "@example/pglite");

  assert.throws(
    () =>
      validateReleaseConfig({
        ...validConfig,
        packages: [
          validConfig.packages[0],
          { ...validConfig.packages[1], name: "@example/pglite-react" },
        ],
      }),
    /mixes package scopes/,
  );
  assert.throws(
    () =>
      validateReleaseConfig({
        ...validConfig,
        packages: [
          { ...validConfig.packages[0], name: "@acme/pglite-tools" },
        ],
      }),
    /must include @acme\/pglite/,
  );
});

test("fork repositories resolve from the run context and the submodule link", () => {
  assert.equal(
    runContextRepository({
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_REPOSITORY: "acme/pglite",
    }),
    "https://github.com/acme/pglite",
  );
  assert.throws(
    () => runContextRepository({ GITHUB_SERVER_URL: "https://github.com" }),
    /invalid GITHUB_REPOSITORY/,
  );
  assert.throws(
    () =>
      runContextRepository({
        GITHUB_SERVER_URL: "github.com",
        GITHUB_REPOSITORY: "acme/pglite",
      }),
    /invalid GITHUB_SERVER_URL/,
  );

  assert.equal(
    resolveSubmoduleRepository(
      "https://github.com/acme/pglite",
      "../postgres-pglite.git",
    ),
    "https://github.com/acme/postgres-pglite",
  );
  assert.equal(
    resolveSubmoduleRepository(
      "https://example.test/elsewhere/pglite",
      "../postgres-pglite.git",
    ),
    "https://example.test/elsewhere/postgres-pglite",
  );
  assert.equal(
    resolveSubmoduleRepository(
      "https://github.com/acme/pglite",
      "https://github.com/another/postgres-pglite.git",
    ),
    "https://github.com/another/postgres-pglite",
  );
  assert.throws(
    () =>
      resolveSubmoduleRepository(
        "https://github.com/acme/pglite",
        "git@github.com:acme/postgres-pglite.git",
      ),
    /unsupported submodule url/,
  );
});

test("the release workflow reads its identity from the run context", () => {
  const workflow = readFileSync(
    new URL("../workflows/build.yml", import.meta.url),
    "utf8",
  );
  const schema = JSON.parse(
    readFileSync(
      new URL("../attestations/fork-lineage-v2.schema.json", import.meta.url),
      "utf8",
    ),
  );

  assert.match(
    workflow,
    /predicate-type: \$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/attestations\/fork-lineage\/v2/,
  );
  assert.match(
    workflow,
    /SIGNER_WORKFLOW: \$\{\{ job\.workflow_repository \}\}\/\.github\/workflows\/build\.yml/,
  );
  assert.match(workflow, /scope: "@\$\{\{ github\.repository_owner \}\}"/);
  assert.doesNotMatch(workflow, /--signer-workflow [a-z]/);
  assert.equal(
    ownerNamePattern.test(workflow),
    false,
    "the release workflow must name no owner",
  );

  assert.equal(schema.properties.schemaVersion.const, 2);
  assert.equal(schema.$id, undefined);
  assert.deepEqual(schema.properties.wrapper.required, ["upstream", "fork"]);
  assert.deepEqual(schema.properties.engine.required, ["upstream", "fork"]);
  assert.equal(schema.$defs.forkWrapper.properties.repository.const, undefined);
  assert.equal(schema.$defs.forkEngine.properties.repository.const, undefined);
  assert.equal(
    ownerNamePattern.test(JSON.stringify(schema)),
    false,
    "the lineage schema must name no owner",
  );
});

test("the tooling gate runs on the shared CI branch, and names no other", () => {
  const workflow = readFileSync(
    new URL("../workflows/test-release-tooling.yml", import.meta.url),
    "utf8",
  );

  assert.equal(
    workflow.split("      - simbox/ci\n").length - 1,
    2,
    "simbox/ci must be filtered on for both pull_request and push",
  );
  // The rename listed both names for exactly as long as it took to merge the
  // pull request that renamed the filter. Nothing should carry the old one now.
  assert.equal(
    ownerNamePattern.test(workflow),
    false,
    "the tooling gate must name no owner",
  );
});

test("the line manifest is read from its declared path", () => {
  assert.equal(releaseConfigPath, ".release/line.json");

  const workspace = mkdtempSync(resolve(tmpdir(), "release-line-"));
  try {
    assert.throws(() => loadReleaseConfig(workspace), /ENOENT/);
    mkdirSync(resolve(workspace, ".release"));
    writeFileSync(
      resolve(workspace, releaseConfigPath),
      `${JSON.stringify(validConfig, null, 2)}\n`,
    );
    assert.equal(
      loadReleaseConfig(workspace).releaseLine,
      validConfig.releaseLine,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

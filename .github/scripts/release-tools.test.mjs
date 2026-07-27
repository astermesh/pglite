import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

import {
  fingerprintDirectory,
  fingerprintTarball,
} from "./artifact-fingerprint.mjs";
import { classifyPackage } from "./classify-packages.mjs";
import { changedPackageVersions } from "./detect-version-change.mjs";
import { validateReleaseConfig } from "./release-config.mjs";
import { remoteTagCommit } from "./remote-tag.mjs";

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
  const verify = section(workflow, "\n  verify:\n", "\n  publish:\n");
  const beforePublish = workflow.slice(0, workflow.indexOf("\n  publish:\n"));
  const publish = section(workflow, "\n  publish:\n", "\n  finalize:\n");
  const finalize = workflow.slice(workflow.indexOf("\n  finalize:\n"));

  assert.equal(
    permissions,
    "permissions:\n  contents: read\n  packages: read\n",
  );
  assert.match(
    dispatch,
    /publish:[\s\S]*default: false[\s\S]*type: boolean/,
  );
  assert.match(call, /publish:[\s\S]*required: true[\s\S]*type: boolean/);

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

  assert.match(publish, /inputs\.publish/);
  assert.match(publish, /- verify/);
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

  assert.match(finalize, /inputs\.publish/);
  assert.match(finalize, /- verify/);
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
    /different contents/,
  );
  assert.throws(() => classifyPackage(pkg, ["0.3.18"], undefined), /not newer/);
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

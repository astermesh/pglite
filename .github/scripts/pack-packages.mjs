import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";

import { fingerprintTarball } from "./artifact-fingerprint.mjs";
import { tarballFilename } from "./release-config.mjs";

const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const tarballDirectory = resolve(process.env.TARBALL_DIRECTORY);
const context = JSON.parse(readFileSync(process.env.RELEASE_CONTEXT, "utf8"));
const packedPackagesPath = process.env.PACKED_PACKAGES;

if (!packedPackagesPath) throw new Error("PACKED_PACKAGES is required");

function collectPackagePaths(manifest) {
  const paths = new Set(["LICENSE", "NOTICE"]);
  const addPath = (value) => {
    if (typeof value !== "string") return;
    paths.add(value.startsWith("./") ? value.slice(2) : value);
  };
  const collectExports = (value) => {
    if (typeof value === "string") {
      if (value.startsWith("./")) addPath(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) collectExports(entry);
      return;
    }
    if (value && typeof value === "object") {
      for (const entry of Object.values(value)) collectExports(entry);
    }
  };

  addPath(manifest.main);
  addPath(manifest.module);
  addPath(manifest.types);
  if (typeof manifest.bin === "string") {
    addPath(manifest.bin);
  } else {
    for (const value of Object.values(manifest.bin || {})) addPath(value);
  }
  collectExports(manifest.exports);
  return paths;
}

function assertRequiredPath(packageRoot, path, packageName) {
  if (!path.includes("*")) {
    const file = resolve(packageRoot, path);
    if (statSync(file).size <= 0) {
      throw new Error(`${packageName} has an empty required file: ${path}`);
    }
    return;
  }

  const directory = resolve(packageRoot, dirname(path));
  const pattern = new RegExp(
    `^${basename(path)
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replaceAll("*", ".*")}$`,
  );
  const matches = readdirSync(directory).filter((name) => pattern.test(name));
  if (
    matches.length === 0 ||
    matches.some((name) => statSync(resolve(directory, name)).size <= 0)
  ) {
    throw new Error(`${packageName} has no non-empty files matching ${path}`);
  }
}

function dependencyValues(manifest) {
  return [
    ...Object.entries(manifest.dependencies || {}),
    ...Object.entries(manifest.devDependencies || {}),
    ...Object.entries(manifest.optionalDependencies || {}),
    ...Object.entries(manifest.peerDependencies || {}),
  ];
}

const packedPackages = [];
for (const pkg of context.packages) {
  const filename = tarballFilename(pkg.name, pkg.version);
  execFileSync(
    "pnpm",
    ["--dir", pkg.directory, "pack", "--pack-destination", tarballDirectory],
    { cwd: workspace, stdio: "inherit" },
  );
  const tarball = realpathSync(resolve(tarballDirectory, filename));

  if (basename(tarball) !== filename) {
    throw new Error(`unexpected tarball filename: ${basename(tarball)}`);
  }
  if (statSync(tarball).size <= 0) {
    throw new Error(`empty tarball: ${filename}`);
  }

  const extraction = mkdtempSync(resolve(tmpdir(), "pglite-package-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", extraction]);
    const packageRoot = resolve(extraction, "package");
    const manifest = JSON.parse(
      readFileSync(resolve(packageRoot, "package.json"), "utf8"),
    );

    if (manifest.name !== pkg.name || manifest.version !== pkg.version) {
      throw new Error(
        `unexpected packed identity: ${manifest.name}@${manifest.version}`,
      );
    }
    if (
      manifest.repository?.url !==
        "git+https://github.com/astermesh/pglite.git" &&
      manifest.repository?.url !== "https://github.com/astermesh/pglite" &&
      manifest.repository?.url !== "git+https://github.com/astermesh/pglite"
    ) {
      throw new Error(`unexpected repository for ${pkg.name}`);
    }

    const requiredPaths = collectPackagePaths(manifest);
    if (pkg.postgresLicense) requiredPaths.add("POSTGRES-LICENSE");
    if (pkg.name === "@astermesh/pglite") {
      requiredPaths.add("dist/pglite.data");
      requiredPaths.add("dist/pglite.js");
      requiredPaths.add("dist/pglite.wasm");
    }
    if (pkg.name === "@astermesh/pglite-tools") {
      requiredPaths.add("dist/pg_dump.wasm");
    }
    for (const path of requiredPaths) {
      assertRequiredPath(packageRoot, path, pkg.name);
    }

    for (const [name, version] of dependencyValues(manifest)) {
      if (
        name === "@electric-sql/pglite" ||
        name.startsWith("@electric-sql/pglite-")
      ) {
        throw new Error(
          `${pkg.name} retains upstream package dependency ${name}`,
        );
      }
      if (version.startsWith("workspace:")) {
        throw new Error(`${pkg.name} retains workspace protocol for ${name}`);
      }
    }

    packedPackages.push({
      ...pkg,
      filename,
      fingerprint: fingerprintTarball(tarball),
    });
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
}

writeFileSync(
  packedPackagesPath,
  `${JSON.stringify(packedPackages, null, 2)}\n`,
);

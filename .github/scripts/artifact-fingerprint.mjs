import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";

const nestedTarballPattern = /\.(?:tar\.gz|tgz)$/;

function normalizedEntries(root) {
  const entries = [];

  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = resolve(directory, name);
      const stat = lstatSync(path);
      const relativePath = relative(root, path).split("\\").join("/");
      if (stat.isDirectory()) {
        entries.push({ path: `${relativePath}/`, type: "directory" });
        visit(path);
      } else if (stat.isSymbolicLink()) {
        entries.push({
          path: relativePath,
          type: "symlink",
          target: readlinkSync(path),
        });
      } else if (stat.isFile()) {
        entries.push({
          path: relativePath,
          type: "file",
          executable: (stat.mode & 0o111) !== 0,
          source: path,
          content: nestedTarballPattern.test(relativePath)
            ? undefined
            : readFileSync(path),
        });
      } else {
        throw new Error(`unsupported tarball entry: ${relativePath}`);
      }
    }
  }

  visit(root);
  return entries;
}

function tarballListing(tarball, requiredRoot) {
  const listing = execFileSync("tar", ["-tzf", tarball], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .filter(Boolean);

  for (const entry of listing) {
    const normalized = entry.replace(/^\.\//, "");
    if (
      normalized.startsWith("/") ||
      normalized.split("/").includes("..") ||
      (requiredRoot &&
        !(
          normalized === requiredRoot ||
          normalized.startsWith(`${requiredRoot}/`)
        ))
    ) {
      throw new Error(`unsafe tarball entry: ${entry}`);
    }
  }
  return listing;
}

function fingerprintArchiveContents(tarball, requiredRoot) {
  tarballListing(tarball, requiredRoot);
  const extraction = mkdtempSync(resolve(tmpdir(), "pglite-fingerprint-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", extraction]);
    return fingerprintDirectory(
      requiredRoot ? resolve(extraction, requiredRoot) : extraction,
    );
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
}

export function fingerprintDirectory(root) {
  const hash = createHash("sha256");
  for (const entry of normalizedEntries(root)) {
    hash.update(
      `${entry.type}\0${entry.path}\0${entry.executable ? "x" : "-"}\0`,
    );
    if (entry.target !== undefined) hash.update(entry.target);
    if (entry.content !== undefined) hash.update(entry.content);
    if (entry.source !== undefined && entry.content === undefined) {
      hash.update("normalized-tarball\0");
      hash.update(fingerprintArchiveContents(entry.source));
    }
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function fingerprintTarball(tarball) {
  return fingerprintArchiveContents(tarball, "package");
}

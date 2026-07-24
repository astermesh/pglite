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
          content: readFileSync(path),
        });
      } else {
        throw new Error(`unsupported tarball entry: ${relativePath}`);
      }
    }
  }

  visit(root);
  return entries;
}

export function fingerprintDirectory(root) {
  const hash = createHash("sha256");
  for (const entry of normalizedEntries(root)) {
    hash.update(
      `${entry.type}\0${entry.path}\0${entry.executable ? "x" : "-"}\0`,
    );
    if (entry.target !== undefined) hash.update(entry.target);
    if (entry.content !== undefined) hash.update(entry.content);
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function fingerprintTarball(tarball) {
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
      !(normalized === "package" || normalized.startsWith("package/"))
    ) {
      throw new Error(`unsafe tarball entry: ${entry}`);
    }
  }

  const extraction = mkdtempSync(resolve(tmpdir(), "pglite-fingerprint-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", extraction]);
    return fingerprintDirectory(resolve(extraction, "package"));
  } finally {
    rmSync(extraction, { recursive: true, force: true });
  }
}

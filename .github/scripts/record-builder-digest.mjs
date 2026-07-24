import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const contextPath = process.env.RELEASE_CONTEXT;
const context = JSON.parse(readFileSync(contextPath, "utf8"));
const reference = context.build?.builderImage?.reference;
if (!reference) throw new Error("builder image reference is missing");

const digest = execFileSync(
  "docker",
  ["image", "inspect", reference, "--format", "{{index .RepoDigests 0}}"],
  { encoding: "utf8" },
).trim();

if (!/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(digest)) {
  throw new Error(`invalid builder image digest: ${digest}`);
}

context.build.builderImage.digest = digest;
writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);

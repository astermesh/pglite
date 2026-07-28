import { commitPattern } from "./release-config.mjs";

export function remoteTagCommit(output, tag) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  let direct;
  let peeled;

  for (const line of output.split("\n").filter(Boolean)) {
    const [commit, ref, ...extra] = line.trim().split(/\s+/);
    if (extra.length > 0 || !commitPattern.test(commit)) {
      throw new Error(`invalid remote tag record: ${line}`);
    }
    if (ref === directRef) direct = commit;
    if (ref === peeledRef) peeled = commit;
  }

  return peeled || direct;
}

export function planPackageTag({
  tag,
  remoteCommit,
  currentCommit,
  packageName,
  packageVersion,
  manifest,
}) {
  if (!remoteCommit) {
    return { action: "create", commit: currentCommit };
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    manifest.name !== packageName ||
    manifest.version !== packageVersion
  ) {
    throw new Error(
      `${tag} target does not declare ${packageName}@${packageVersion}`,
    );
  }
  return { action: "keep", commit: remoteCommit };
}

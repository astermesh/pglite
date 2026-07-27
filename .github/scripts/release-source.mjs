export function validateReleaseSource({
  publish,
  sourceOverride,
  sourceCommit,
  releaseLine,
  sourceIsOnLine,
  sourceExtendsLine,
}) {
  if (publish && sourceOverride) {
    throw new Error("source_ref is allowed only when publish is false");
  }
  if (sourceIsOnLine) return "landed";
  if (!publish && sourceOverride && sourceExtendsLine) return "candidate";
  throw new Error(
    `${sourceCommit} is not an allowed source for ${releaseLine}`,
  );
}

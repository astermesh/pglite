import { readFileSync, writeFileSync } from "node:fs";

const context = JSON.parse(readFileSync(process.env.RELEASE_CONTEXT, "utf8"));
const packageName = process.env.PACKAGE_NAME;
const pkg = context.packages.find(
  (candidate) => candidate.name === packageName,
);

if (!pkg)
  throw new Error(`package is absent from release context: ${packageName}`);
if (!context.build?.builderImage?.digest) {
  throw new Error("builder image digest is absent from release context");
}

const predicate = {
  schemaVersion: 1,
  releaseLine: context.releaseLine,
  package: {
    name: pkg.name,
    version: pkg.version,
    sourceDirectory: pkg.directory,
  },
  wrapper: {
    upstream: {
      ...context.wrapper.upstream,
      packageName: pkg.upstreamName,
      packageVersion: pkg.upstreamVersion,
    },
    astermesh: context.wrapper.astermesh,
  },
  engine: context.engine,
  build: context.build,
};

writeFileSync(
  process.env.LINEAGE_PATH,
  `${JSON.stringify(predicate, null, 2)}\n`,
);

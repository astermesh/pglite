import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { loadReleaseConfig } from "./release-config.mjs";

const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
const { packages } = loadReleaseConfig(workspace);
const apache = readFileSync(resolve(workspace, "LICENSE"));
const postgres = readFileSync(resolve(workspace, "postgres-pglite/COPYRIGHT"));

for (const pkg of packages) {
  const license = readFileSync(resolve(workspace, pkg.directory, "LICENSE"));
  const notice = readFileSync(
    resolve(workspace, pkg.directory, "NOTICE"),
    "utf8",
  );

  if (!apache.equals(license)) {
    throw new Error(
      `${pkg.directory}/LICENSE differs from the wrapper license`,
    );
  }
  if (!notice.includes(pkg.name)) {
    throw new Error(`${pkg.directory}/NOTICE does not identify ${pkg.name}`);
  }
  if (!notice.includes("https://github.com/electric-sql/pglite")) {
    throw new Error(
      `${pkg.directory}/NOTICE does not identify upstream PGlite`,
    );
  }

  if (pkg.postgresLicense) {
    const packagePostgres = readFileSync(
      resolve(workspace, pkg.directory, "POSTGRES-LICENSE"),
    );
    if (!postgres.equals(packagePostgres)) {
      throw new Error(
        `${pkg.directory}/POSTGRES-LICENSE differs from the engine license`,
      );
    }
  }
}

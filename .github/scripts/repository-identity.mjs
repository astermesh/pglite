const absoluteUrlPattern = /^[a-z][a-z0-9+.-]*:\/\//i;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/;
const serverUrlPattern = /^https:\/\/[A-Za-z0-9.-]+(?::[0-9]+)?$/;

export function normalizeRepositoryUrl(url) {
  if (typeof url !== "string" || !absoluteUrlPattern.test(url)) {
    throw new Error(`invalid repository url: ${String(url)}`);
  }
  return url.replace(/\/+$/, "").replace(/\.git$/, "");
}

// Git resolves a relative submodule url against the superproject's own remote,
// treating that remote as a directory. `new URL` needs the trailing slash to
// agree with it.
export function resolveSubmoduleRepository(superprojectUrl, submoduleUrl) {
  const superproject = normalizeRepositoryUrl(superprojectUrl);
  if (typeof submoduleUrl !== "string" || submoduleUrl.length === 0) {
    throw new Error(`invalid submodule url: ${String(submoduleUrl)}`);
  }
  if (absoluteUrlPattern.test(submoduleUrl)) {
    return normalizeRepositoryUrl(submoduleUrl);
  }
  if (!submoduleUrl.startsWith("./") && !submoduleUrl.startsWith("../")) {
    throw new Error(`unsupported submodule url: ${submoduleUrl}`);
  }
  return normalizeRepositoryUrl(
    new URL(submoduleUrl, `${superproject}/`).toString(),
  );
}

// The fork owns no hard-coded owner: the wrapper repository is whatever
// repository the workflow is running in.
export function runContextRepository(env = process.env) {
  const serverUrl = env.GITHUB_SERVER_URL;
  const repository = env.GITHUB_REPOSITORY;
  if (typeof serverUrl !== "string" || !serverUrlPattern.test(serverUrl)) {
    throw new Error(`invalid GITHUB_SERVER_URL: ${String(serverUrl)}`);
  }
  if (typeof repository !== "string" || !repositoryPattern.test(repository)) {
    throw new Error(`invalid GITHUB_REPOSITORY: ${String(repository)}`);
  }
  return `${serverUrl}/${repository}`;
}

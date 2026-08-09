import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { satisfies } from 'semver';
import { TitwError } from './errors.js';
import { ensureDir, pathExists, walkFiles } from './fsx.js';
import { hashFile, hashTree } from './hash.js';
import { PACKAGE_MANIFEST_FILENAME, loadPackageManifest, type PackageManifest } from './manifest.js';
import type { PackageSource } from './source.js';

const run = promisify(execFile);

/** A published version and the ref it was read from. */
export interface Release {
  readonly version: string;
  readonly ref: string;
}

export interface FetchedPackage {
  readonly source: PackageSource;
  /** Working tree holding the whole package at the resolved version. */
  readonly dir: string;
  readonly manifest: PackageManifest;
  readonly version: string;
  /** Exact commit; `null` for `path:` sources, which resolve to the working tree. */
  readonly commit: string | null;
  readonly ref: string | null;
  /** Every file in the package, package-relative — the whole package, not the selection. */
  readonly files: string[];
  readonly manifestHash: string;
  readonly treeHash: string;
}

/**
 * Run `git` with prompts disabled.
 *
 * TITW never handles credentials itself: whatever the user's ssh agent,
 * credential helper, or gh session provides is what git sees, and a missing
 * credential must fail fast rather than block on a terminal prompt.
 */
async function git(args: readonly string[], cwd?: string): Promise<string> {
  try {
    const { stdout } = await run('git', [...args], {
      ...(cwd === undefined ? {} : { cwd }),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr ?? (error as Error).message).trim();
    throw new TitwError('E_GIT', `git ${args[0] ?? ''} failed`, stderr === '' ? [] : [stderr]);
  }
}

/**
 * Clone or refresh the cache checkout for a git source.
 *
 * @returns the cache directory holding the repository.
 */
export async function ensureRepo(source: PackageSource, cacheDir: string): Promise<string> {
  if (source.cloneUrl === null) {
    throw new TitwError('E_SOURCE_INVALID', `source is not a git source: ${source.canonical}`);
  }
  await ensureDir(cacheDir);
  const repoDir = path.join(cacheDir, source.cacheKey);
  if (await pathExists(path.join(repoDir, '.git'))) {
    await git(['fetch', '--prune', '--force', '--quiet', 'origin'], repoDir);
  } else {
    await git(['clone', '--quiet', '--', source.cloneUrl, repoDir]);
  }
  // A warm cache may predate the remote renaming its default branch.
  await git(['remote', 'set-head', 'origin', '--auto'], repoDir);
  return repoDir;
}

/** Ref of the remote default branch, e.g. `origin/main`. */
async function defaultBranchRef(repoDir: string): Promise<string> {
  return (await git(['rev-parse', '--abbrev-ref', 'origin/HEAD'], repoDir)).trim();
}

/**
 * The single published version of a git source: the manifest's `version:` at
 * the default-branch HEAD (D19 — git tags are not the release mechanism).
 * `null` when the repo has no package manifest.
 */
export async function publishedVersion(repoDir: string): Promise<Release | null> {
  const ref = await defaultBranchRef(repoDir);
  await checkoutClean(repoDir, ref);
  const manifestPath = path.join(repoDir, PACKAGE_MANIFEST_FILENAME);
  if (!(await pathExists(manifestPath))) return null;
  const manifest = await loadPackageManifest(manifestPath);
  return { version: manifest.version, ref };
}

/**
 * Check out a ref and scrub the working tree.
 *
 * `git clean -xdff` removes untracked and ignored leftovers a previous
 * checkout left behind — without it a warm cache and a fresh clone disagree
 * on `treeHash` for the same commit.
 */
async function checkoutClean(repoDir: string, ref: string): Promise<void> {
  await git(['checkout', '--quiet', '--detach', '--force', ref], repoDir);
  await git(['clean', '-xdff', '--quiet'], repoDir);
}

/**
 * Fetch a whole package at the version resolved from `range`.
 *
 * The whole package is fetched and locked even when the consumer selects one
 * file (handoff invariant 3) — selection happens after this, over the tree
 * this returns.
 */
export async function fetchPackage(options: {
  source: PackageSource;
  range: string;
  cacheDir: string;
  /** Exact commit to check out, bypassing version resolution (frozen installs). */
  commit?: string | undefined;
}): Promise<FetchedPackage> {
  const { source, range, cacheDir } = options;

  if (source.kind === 'path') {
    const dir = source.dir ?? '';
    if (!(await pathExists(path.join(dir, PACKAGE_MANIFEST_FILENAME)))) {
      throw new TitwError(
        'E_NOT_FOUND',
        `no ${PACKAGE_MANIFEST_FILENAME} in ${dir}`,
        ['a path: source points at a package working tree, not a directory of packages'],
      );
    }
    const manifest = await loadPackageManifest(path.join(dir, PACKAGE_MANIFEST_FILENAME));
    if (range !== '*' && !satisfies(manifest.version, range)) {
      throw new TitwError(
        'E_VERSION_UNRESOLVED',
        `${source.canonical} is version ${manifest.version}, which does not satisfy ${range}`,
      );
    }
    return describe(source, dir, manifest, null, null);
  }

  const repoDir = await ensureRepo(source, cacheDir);

  if (options.commit !== undefined) {
    if (!/^[0-9a-f]{40}$/.test(options.commit)) {
      // A lock commit is always a full sha; anything else (including a value
      // starting with "-") must never reach git's argument parser.
      throw new TitwError('E_LOCK_INVALID', `not a commit sha: ${options.commit}`);
    }
    await checkoutClean(repoDir, options.commit);
    const pinnedManifestPath = path.join(repoDir, PACKAGE_MANIFEST_FILENAME);
    if (!(await pathExists(pinnedManifestPath))) {
      throw new TitwError(
        'E_NOT_FOUND',
        `${source.canonical}@${options.commit.slice(0, 7)} has no ${PACKAGE_MANIFEST_FILENAME}`,
      );
    }
    const pinnedManifest = await loadPackageManifest(pinnedManifestPath);
    return describe(source, repoDir, pinnedManifest, pinnedManifest.version, options.commit);
  }

  const release = await publishedVersion(repoDir);
  if (release === null) {
    throw new TitwError(
      'E_NOT_FOUND',
      `${source.canonical} has no ${PACKAGE_MANIFEST_FILENAME}`,
      ['a titw package declares its version in the manifest on its default branch (D19)'],
    );
  }
  if (range !== '*' && !satisfies(release.version, range)) {
    throw new TitwError(
      'E_VERSION_UNRESOLVED',
      `${source.canonical} is version ${release.version}, which does not satisfy ${range}`,
      ['only the version published on the default branch is installable from source (D19)'],
    );
  }
  const commit = (await git(['rev-parse', 'HEAD'], repoDir)).trim();
  const manifest = await loadPackageManifest(path.join(repoDir, PACKAGE_MANIFEST_FILENAME));
  return describe(source, repoDir, manifest, release.version, commit, release.ref);
}

async function describe(
  source: PackageSource,
  dir: string,
  manifest: PackageManifest,
  version: string | null,
  commit: string | null,
  ref: string | null = null,
): Promise<FetchedPackage> {
  const files = await walkFiles(dir);
  const inventory = await Promise.all(
    files.map(async (file) => [file, await hashFile(path.join(dir, ...file.split('/')))] as const),
  );
  return {
    source,
    dir,
    manifest,
    version: version ?? manifest.version,
    commit,
    ref,
    files,
    manifestHash: await hashFile(path.join(dir, PACKAGE_MANIFEST_FILENAME)),
    treeHash: hashTree(inventory),
  };
}

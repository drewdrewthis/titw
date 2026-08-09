import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { maxSatisfying, rsort, satisfies, valid as validSemver } from 'semver';
import { TitwError } from './errors.js';
import { ensureDir, pathExists, walkFiles } from './fsx.js';
import { hashFile, hashTree } from './hash.js';
import { PACKAGE_MANIFEST_FILENAME, loadPackageManifest, type PackageManifest } from './manifest.js';
import type { PackageSource } from './source.js';

const run = promisify(execFile);

/** A release tag and the semver version it denotes. */
export interface ReleaseTag {
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
    await git(['fetch', '--tags', '--prune', '--force', '--quiet', 'origin'], repoDir);
  } else {
    await git(['clone', '--quiet', source.cloneUrl, repoDir]);
  }
  return repoDir;
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

/** List the release tags of a repository, newest version first. */
export async function listVersions(repoDir: string): Promise<ReleaseTag[]> {
  const stdout = await git(['tag', '--list'], repoDir);
  const tags: ReleaseTag[] = [];
  for (const line of stdout.split('\n')) {
    const ref = line.trim();
    if (ref === '') continue;
    const version = versionFromTag(ref);
    if (version !== null) tags.push({ version, ref });
  }
  return sortDescending(tags);
}

/** Read the semver version a tag denotes; `v1.2.3` and `1.2.3` both count. */
export function versionFromTag(ref: string): string | null {
  const candidate = ref.startsWith('v') ? ref.slice(1) : ref;
  return validSemver(candidate);
}

/** Sort release tags newest-version-first. */
export function sortDescending(tags: readonly ReleaseTag[]): ReleaseTag[] {
  const order = rsort(tags.map((tag) => tag.version));
  const byVersion = new Map(tags.map((tag) => [tag.version, tag]));
  return order.flatMap((version) => {
    const tag = byVersion.get(version);
    return tag === undefined ? [] : [tag];
  });
}

/** Newest tag satisfying `range`, or `null` when nothing does. */
export function pickVersion(tags: readonly ReleaseTag[], range: string): ReleaseTag | null {
  const best = maxSatisfying(
    tags.map((tag) => tag.version),
    range,
  );
  if (best === null) return null;
  return tags.find((tag) => tag.version === best) ?? null;
}

/** Newest tag overall, ignoring any range. */
export function latestVersion(tags: readonly ReleaseTag[]): ReleaseTag | null {
  return sortDescending(tags)[0] ?? null;
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

  const tags = await listVersions(repoDir);
  if (tags.length === 0) {
    throw new TitwError(
      'E_VERSION_UNRESOLVED',
      `${source.canonical} has no release tags`,
      ['tag a release as "v1.2.3" or "1.2.3" before installing it'],
    );
  }
  const picked = pickVersion(tags, range);
  if (picked === null) {
    throw new TitwError(
      'E_VERSION_UNRESOLVED',
      `${source.canonical} has no release satisfying ${range}`,
      [`available: ${tags.map((tag) => tag.version).join(', ')}`],
    );
  }
  await checkoutClean(repoDir, picked.ref);
  const commit = (await git(['rev-parse', 'HEAD'], repoDir)).trim();

  const manifestPath = path.join(repoDir, PACKAGE_MANIFEST_FILENAME);
  if (!(await pathExists(manifestPath))) {
    throw new TitwError(
      'E_NOT_FOUND',
      `${source.canonical}@${picked.version} has no ${PACKAGE_MANIFEST_FILENAME}`,
    );
  }
  const manifest = await loadPackageManifest(manifestPath);
  if (manifest.version !== picked.version) {
    throw new TitwError(
      'E_VERSION_MISMATCH',
      `tag ${picked.ref} declares version ${picked.version} but the manifest says ${manifest.version}`,
    );
  }
  return describe(source, repoDir, manifest, picked.version, commit, picked.ref);
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

import path from 'node:path';
import { createHash } from 'node:crypto';
import { TitwError } from './errors.js';

/** How a package is reached. `github` is sugar over `git`; both clone over https. */
export type SourceKind = 'github' | 'git' | 'path';

export interface PackageSource {
  readonly kind: SourceKind;
  /** Exactly what the user typed — preserved for messages and round-tripping. */
  readonly raw: string;
  /** Normalized user-facing form (`github:owner/repo`, `git+ssh://…`, `path:…`). */
  readonly canonical: string;
  /** URL handed to `git clone`; `null` for `path:` sources. */
  readonly cloneUrl: string | null;
  /** Absolute working-tree directory; `null` for git sources. */
  readonly dir: string | null;
  /** Stable directory name for this source inside `$TITW_HOME/cache`. */
  readonly cacheKey: string;
}

const GITHUB_SUGAR = /^github:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;
const BARE_SLUG = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?$/;
const GIT_URL = /^git\+(ssh|https|http|file):\/\/(.*)$/;
const PATH_SOURCE = /^path:(.+)$/;

/**
 * Parse a v1 source specifier (handoff §11) into its normalized form.
 *
 * Accepted: `github:owner/repo`, bare `owner/repo` (github sugar),
 * `git+ssh://…`, `git+https://…`, `git+file://…`, `path:…`.
 *
 * @param spec source specifier as typed by the user.
 * @param options.baseDir directory that `path:` sources resolve against (default `process.cwd()`).
 * @throws TitwError when the form is unsupported or embeds credentials.
 */
export function parseSource(spec: string, options: { baseDir?: string } = {}): PackageSource {
  const raw = spec.trim();
  if (raw === '') throw new TitwError('E_SOURCE_INVALID', 'source is empty');

  const pathMatch = PATH_SOURCE.exec(raw);
  if (pathMatch !== null) {
    const given = pathMatch[1] ?? '';
    const base = options.baseDir ?? process.cwd();
    const dir = path.resolve(base, given);
    return {
      kind: 'path',
      raw,
      canonical: `path:${given}`,
      cloneUrl: null,
      dir,
      cacheKey: cacheKeyFor('path', dir),
    };
  }

  const github = GITHUB_SUGAR.exec(raw) ?? BARE_SLUG.exec(raw);
  if (github !== null) {
    const owner = github[1] ?? '';
    const repo = github[2] ?? '';
    const canonical = `github:${owner}/${repo}`;
    return {
      kind: 'github',
      raw,
      canonical,
      cloneUrl: `https://github.com/${owner}/${repo}.git`,
      dir: null,
      cacheKey: cacheKeyFor('github', canonical),
    };
  }

  const git = GIT_URL.exec(raw);
  if (git !== null) {
    const scheme = git[1] ?? '';
    const rest = git[2] ?? '';
    const cloneUrl = `${scheme}://${rest}`;
    assertNoCredentials(cloneUrl, raw);
    return {
      kind: 'git',
      raw,
      canonical: `git+${cloneUrl}`,
      cloneUrl,
      dir: null,
      cacheKey: cacheKeyFor('git', cloneUrl),
    };
  }

  throw new TitwError(
    'E_SOURCE_INVALID',
    `unsupported source: ${raw}`,
    [
      'expected one of: github:owner/repo, owner/repo, git+ssh://…, git+https://…, git+file://…, path:…',
    ],
  );
}

/**
 * Reject a URL carrying an inline password.
 *
 * Credentials must never enter a manifest, lock, receipt, or log (handoff §11),
 * and the source string is written to all four.
 */
function assertNoCredentials(cloneUrl: string, raw: string): void {
  let parsed: URL;
  try {
    parsed = new URL(cloneUrl);
  } catch {
    throw new TitwError('E_SOURCE_INVALID', `not a valid URL: ${raw}`);
  }
  if (parsed.password !== '') {
    throw new TitwError(
      'E_SOURCE_CREDENTIALS',
      'source must not embed credentials',
      ['use an ssh key, a credential helper, or the gh CLI session instead'],
    );
  }
}

/** Filesystem-safe, collision-resistant cache directory name for a source. */
function cacheKeyFor(kind: SourceKind, identity: string): string {
  const slug = identity
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const digest = createHash('sha256').update(`${kind}:${identity}`).digest('hex').slice(0, 12);
  return `${slug === '' ? kind : slug}-${digest}`;
}

import picomatch from 'picomatch';
import { TitwError } from './errors.js';
import { comparePaths } from './fsx.js';

export interface SelectionRequest {
  /** Every file in the package tree, package-relative and `/`-separated. */
  readonly files: readonly string[];
  /** The publisher's export patterns from `titw.package.yaml`. */
  readonly exports: readonly string[];
  /** Consumer include patterns; absent selects every export. */
  readonly include?: readonly string[] | undefined;
  /** Consumer exclude patterns; always subtracts. */
  readonly exclude?: readonly string[] | undefined;
}

export interface Selection {
  /** Files the publisher exported, sorted. */
  readonly exported: string[];
  /** Files surviving include/exclude, sorted — the materialization set. */
  readonly selected: string[];
  /** Include patterns that matched no exported file (likely typos). */
  readonly unmatchedInclude: string[];
  /** Exclude patterns that subtracted nothing. */
  readonly unmatchedExclude: string[];
}

/**
 * Validate one selector against the v1 selector rules (handoff §10).
 *
 * Selectors are package-relative and `/`-separated; absolute paths, `..`, and
 * `!` negation are rejected. `exclude` already provides explicit subtraction,
 * so negation would only introduce an ordering-dependent second mechanism.
 *
 * @param selector the pattern as written.
 * @param field which manifest field it came from, for the diagnostic.
 */
export function validateSelector(selector: string, field: string): void {
  const fail = (reason: string): never => {
    throw new TitwError('E_SELECTOR_INVALID', `${field}: invalid selector "${selector}": ${reason}`);
  };

  if (selector.trim() === '') fail('selector is empty');
  if (selector.startsWith('!')) {
    fail('negation is not supported — use "exclude", which always subtracts');
  }
  if (selector.startsWith('/') || /^[A-Za-z]:[\\/]/.test(selector)) {
    fail('selectors are package-relative; absolute paths are not allowed');
  }
  if (selector.includes('\\')) fail('selectors use "/" as the separator');
  if (selector.split('/').some((segment) => segment === '..')) {
    fail('".." is not allowed — selectors cannot escape the package');
  }
}

/** Validate a list of selectors, reporting the first offender per field. */
export function validateSelectors(selectors: readonly string[] | undefined, field: string): void {
  for (const selector of selectors ?? []) validateSelector(selector, field);
}

/**
 * Run the §10 selection algorithm over a package tree.
 *
 * Steps 1-4 and 9 (expand exports, include, exclude, deterministic sort) are
 * implemented here. Steps 5-8 (component atomicity, declared requirements,
 * target-conflict and approval checks) attach to the returned {@link Selection}
 * once components ship; they only ever add to or reject `selected`, never
 * reorder it.
 */
export function selectFiles(request: SelectionRequest): Selection {
  validateSelectors(request.exports, 'exports');
  validateSelectors(request.include, 'include');
  validateSelectors(request.exclude, 'exclude');

  const files = [...request.files].sort(comparePaths);
  const exported = files.filter((file) => matchesAny(file, request.exports));

  const include = request.include;
  const included =
    include === undefined ? exported : exported.filter((file) => matchesAny(file, include));

  const exclude = request.exclude ?? [];
  const selected = included.filter((file) => !matchesAny(file, exclude));

  return {
    exported,
    selected,
    unmatchedInclude: (request.include ?? []).filter(
      (pattern) => !exported.some((file) => matches(file, pattern)),
    ),
    unmatchedExclude: exclude.filter((pattern) => !included.some((file) => matches(file, pattern))),
  };
}

/** True when `file` matches any of `patterns`. */
export function matchesAny(file: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matches(file, pattern));
}

const matcherCache = new Map<string, (file: string) => boolean>();

/**
 * Match one file against one selector.
 *
 * A selector naming a directory (`knowledge`, `knowledge/procedures`) matches
 * everything beneath it, so consumers are not forced to append `/**` to every
 * path they mean as a subtree.
 */
export function matches(file: string, pattern: string): boolean {
  let matcher = matcherCache.get(pattern);
  if (matcher === undefined) {
    const exact = picomatch(pattern, { dot: true });
    const subtree = picomatch(`${pattern.replace(/\/+$/, '')}/**`, { dot: true });
    matcher = (candidate: string): boolean => exact(candidate) || subtree(candidate);
    matcherCache.set(pattern, matcher);
  }
  return matcher(file);
}

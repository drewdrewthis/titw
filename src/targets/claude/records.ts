import {
  asString,
  asStringList,
  parseFrontmatter,
  readPath,
} from '../../core/frontmatter.js';

/**
 * The seven record stores the `procedures` plugin scans, in its own order
 * (DECISIONS D5, measured against plugin v0.2.3).
 */
export const RECORD_STORES = {
  'failure-mode': 'references/failure-modes',
  decision: 'references/decisions',
  solution: 'references/solutions',
  procedure: 'references/procedures',
  research: 'references/research',
  plan: 'plans',
  principle: 'references/principles',
} as const;

/** A record kind TITW can project. */
export type RecordKind = keyof typeof RECORD_STORES;

const STORE_BASENAMES = new Set(
  Object.values(RECORD_STORES).map((store) => store.slice(store.lastIndexOf('/') + 1)),
);

/** Normalize an OKF `type:` or six-key `kind:` value to a {@link RecordKind}. */
export function normalizeKind(value: string | null): RecordKind | null {
  if (value === null) return null;
  const slug = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return slug in RECORD_STORES ? (slug as RecordKind) : null;
}

/** Store directory for a kind, or `null` when the kind is not a record kind. */
export function storeForKind(value: string | null): string | null {
  const kind = normalizeKind(value);
  return kind === null ? null : RECORD_STORES[kind];
}

/** What the projection needs to know about one Markdown file. */
export interface RecordInfo {
  /** Resolved record kind, or `null` when the file is not a projectable record. */
  readonly kind: RecordKind | null;
  /** Stable record identity: `titw.id`, else the six-key `id`. */
  readonly id: string | null;
  /** Frontmatter lines to insert into the projected copy; empty when none are needed. */
  readonly compat: string[];
}

/**
 * Classify a Markdown document and decide what compat frontmatter its
 * projected copy needs.
 *
 * The plugin's scanner reads top-level `id:`/`kind:` and an inline
 * `keywords: [a, b]` list; an OKF-native record spells those `titw.id`,
 * `type:`, and `tags:`. Compat keys are computed here and inserted into the
 * generated copy only — package bytes never change (DECISIONS D5).
 *
 * Only records are decorated: a document with no projectable kind is copied
 * verbatim.
 */
export function classifyRecord(text: string): RecordInfo {
  const { data } = parseFrontmatter(text);
  const declaredKind = asString(data['kind']);
  const declaredType = asString(data['type']);
  const kind = normalizeKind(declaredKind) ?? normalizeKind(declaredType);

  const declaredId = asString(data['id']);
  const namespacedId = asString(readPath(data, 'titw.id'));
  const id = namespacedId ?? declaredId;

  const compat: string[] = [];
  if (kind !== null) {
    if (declaredId === null && namespacedId !== null) compat.push(`id: ${namespacedId}`);
    if (normalizeKind(declaredKind) === null) compat.push(`kind: ${kind}`);
    if (data['keywords'] === undefined) {
      const tags = asStringList(data['tags']);
      if (tags.length > 0) compat.push(`keywords: [${tags.join(', ')}]`);
    }
  }

  return { kind, id, compat };
}

/**
 * Place a source path inside its store, preserving the subpath that follows
 * the store's own directory.
 *
 * `knowledge/procedures/deploy/PROCEDURE.md` (kind `procedure`) projects to
 * `references/procedures/deploy/PROCEDURE.md`. A record filed outside a
 * conventionally-named directory keeps its basename only, since there is no
 * subpath to preserve.
 */
export function projectionPath(store: string, sourcePath: string): string {
  const segments = sourcePath.split('/');
  const filename = segments[segments.length - 1] ?? sourcePath;
  const storeName = store.slice(store.lastIndexOf('/') + 1);

  for (let i = segments.length - 2; i >= 0; i -= 1) {
    if (segments[i] === storeName) return [store, ...segments.slice(i + 1)].join('/');
  }
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment !== undefined && STORE_BASENAMES.has(segment)) {
      return [store, ...segments.slice(i + 1)].join('/');
    }
  }
  return `${store}/${filename}`;
}

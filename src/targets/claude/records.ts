import {
  asString,
  asStringList,
  parseFrontmatter,
  readPath,
  renderInlineList,
} from '../../core/frontmatter.js';

/**
 * Record kinds the plugin's own stores use (DECISIONS D5, plugin v0.2.3).
 * Under D23 the projection is verbatim per package — kind never decides
 * placement — but a known kind still gates compat decoration.
 */
export const RECORD_KINDS = [
  'failure-mode',
  'decision',
  'solution',
  'procedure',
  'research',
  'plan',
  'principle',
] as const;

/** A record kind TITW recognizes. */
export type RecordKind = (typeof RECORD_KINDS)[number];

const KIND_SET: ReadonlySet<string> = new Set(RECORD_KINDS);

/** Normalize an OKF `type:` or six-key `kind:` value to a {@link RecordKind}. */
export function normalizeKind(value: string | null): RecordKind | null {
  if (value === null) return null;
  const slug = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return KIND_SET.has(slug) ? (slug as RecordKind) : null;
}

/** What the projection needs to know about one Markdown file. */
export interface RecordInfo {
  /** Resolved record kind, or `null` when the file is not a recognized record. */
  readonly kind: RecordKind | null;
  /** Declared kind value that resolved to no known kind; `null` when absent or known. */
  readonly unknownKind: string | null;
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
 */
export function classifyRecord(text: string): RecordInfo {
  const { data } = parseFrontmatter(text);
  const declaredKind = asString(data['kind']);
  const declaredType = asString(data['type']);
  const kind = normalizeKind(declaredKind) ?? normalizeKind(declaredType);
  const unknownKind = kind !== null ? null : (declaredKind ?? declaredType);

  const declaredId = asString(data['id']);
  const namespacedId = asString(readPath(data, 'titw.id'));
  const id = namespacedId ?? declaredId;

  const compat: string[] = [];
  if (kind !== null) {
    if (declaredId === null && namespacedId !== null) compat.push(`id: ${namespacedId}`);
    if (normalizeKind(declaredKind) === null) compat.push(`kind: ${kind}`);
    if (data['keywords'] === undefined) {
      const tags = asStringList(data['tags']);
      if (tags.length > 0) compat.push(`keywords: ${renderInlineList(tags)}`);
    }
  }

  return { kind, unknownKind, id, compat };
}

/**
 * Normalize a Markdown document so the plugin's scanner can read it:
 * strip a BOM, fold CRLF to LF, and rewrite a block-style `keywords:` list
 * to the inline form (the only syntax the corpus matcher tokenizes).
 *
 * Applies to the projected copy only — package bytes never change.
 */
export function normalizeRecordText(text: string): string {
  let out = text;
  if (out.charCodeAt(0) === 0xfeff) out = out.slice(1);
  out = out.replace(/\r\n/g, '\n');

  const fm = parseFrontmatter(out);
  if (!fm.present) return out;
  const keywords = asStringList(fm.data['keywords']);
  const blockList = /^(\s*)keywords:[ \t]*\n(?:\1[ \t]+-[ \t].*\n?)+/m;
  if (keywords.length > 0 && blockList.test(fm.block)) {
    const header = out.slice(0, fm.bodyOffset);
    const body = out.slice(fm.bodyOffset);
    out =
      header.replace(
        blockList,
        (_m, indent: string) => `${indent}keywords: ${renderInlineList(keywords)}\n`,
      ) + body;
  }
  return out;
}

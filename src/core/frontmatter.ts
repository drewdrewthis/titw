import { parse as parseYaml } from 'yaml';

const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/;

export interface Frontmatter {
  readonly present: boolean;
  /** Parsed mapping; `{}` when absent or not a mapping. */
  readonly data: Record<string, unknown>;
  /** Raw text between the fences, unparsed. */
  readonly block: string;
  /** Offset just past the closing fence — where the body starts. */
  readonly bodyOffset: number;
}

/**
 * Read a Markdown file's YAML frontmatter without disturbing its bytes.
 *
 * Malformed YAML is reported as `present` with empty `data` rather than
 * throwing: a package may legitimately ship a document TITW does not
 * understand, and refusing to materialize it would be worse than not
 * classifying it.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const match = FRONTMATTER.exec(text);
  if (match === null) return { present: false, data: {}, block: '', bodyOffset: 0 };
  const block = match[1] ?? '';
  let data: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(block);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      data = parsed as Record<string, unknown>;
    }
  } catch {
    data = {};
  }
  return { present: true, data, block, bodyOffset: match[0].length };
}

/**
 * Return `text` with `lines` inserted at the top of its frontmatter block,
 * creating the block when the document has none.
 *
 * Insertion is textual so every other byte — including keys TITW does not
 * model — survives verbatim.
 *
 * @param lines already-rendered YAML lines, e.g. `kind: procedure`.
 */
export function insertFrontmatterKeys(text: string, lines: readonly string[]): string {
  if (lines.length === 0) return text;
  const block = lines.join('\n');
  const match = FRONTMATTER.exec(text);
  if (match === null) return `---\n${block}\n---\n\n${text}`;
  const opening = text.slice(0, text.indexOf('\n') + 1);
  return `${opening}${block}\n${text.slice(opening.length)}`;
}

/** Render a YAML inline list — the only `keywords:` syntax the corpus matcher tokenizes. */
export function renderInlineList(values: readonly string[]): string {
  return `[${values.join(', ')}]`;
}

/** Read a nested value such as `titw.id`, returning `undefined` when any hop is missing. */
export function readPath(data: Record<string, unknown>, dotted: string): unknown {
  let current: unknown = data;
  for (const key of dotted.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** Coerce a frontmatter value to a trimmed string, or `null` when it is not scalar text. */
export function asString(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() === '' ? null : value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/** Coerce a frontmatter value to a list of strings; a scalar becomes a one-item list. */
export function asStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const s = asString(item);
      return s === null ? [] : [s];
    });
  }
  const single = asString(value);
  return single === null ? [] : [single];
}

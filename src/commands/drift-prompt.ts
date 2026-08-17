import { createInterface } from 'node:readline/promises';

/** A user's resolution for one locally-modified path. */
export type DriftChoice = 'replace' | 'keep' | 'propose';

/** Streams `promptDriftChoices` reads from and writes to — a test seam so no test touches the real TTY. */
export interface DriftPromptIO {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

const SINGLE: Record<string, DriftChoice> = { r: 'replace', k: 'keep', p: 'propose' };
const APPLY_ALL: Record<string, DriftChoice> = { R: 'replace', K: 'keep', P: 'propose' };

/**
 * Ask, one path at a time, how to resolve each locally-modified path:
 * (r)eplace with the newly-built version, (k)eep the local edit, or (p)ropose
 * it for upstream contribution. An uppercase answer applies that choice to
 * every remaining path without asking again, so a large drift set isn't one
 * keystroke per file.
 *
 * Reads lines via the Interface's async iterator rather than `question()`.
 * `question()` resolves from the next 'line' event after it is called; a
 * fully-buffered input — exactly what a piped/scripted stdin (or a test
 * fixture) looks like — delivers every line before a second `question()`
 * call re-attaches a listener, so lines after the first fire with nobody
 * listening, are lost, and then input hits 'end' and auto-closes the
 * interface, so the next `question()` throws "readline was closed". The
 * async iterator queues lines that arrive before anyone is waiting instead
 * of dropping them, so it is safe for both buffered and truly-interactive
 * input.
 */
export async function promptDriftChoices(
  paths: readonly string[],
  io: DriftPromptIO,
): Promise<Map<string, DriftChoice>> {
  const choices = new Map<string, DriftChoice>();
  const rl = createInterface({ input: io.input, output: io.output });
  const lines = rl[Symbol.asyncIterator]();
  try {
    let applyToAll: DriftChoice | null = null;
    for (const rel of paths) {
      if (applyToAll !== null) {
        choices.set(rel, applyToAll);
        continue;
      }
      const answer = await askOne(lines, io.output, rel);
      if (answer === null) break; // input exhausted; leave the rest unresolved (caller defaults to replace)
      choices.set(rel, answer.value);
      if (answer.applyToAll) applyToAll = answer.value;
    }
  } finally {
    rl.close();
  }
  return choices;
}

async function askOne(
  lines: AsyncIterator<string>,
  output: NodeJS.WritableStream,
  rel: string,
): Promise<{ value: DriftChoice; applyToAll: boolean } | null> {
  const query =
    `${rel} was locally edited: (r)eplace with the new version, (k)eep the local edit, ` +
    `(p)ropose it for upstream (uppercase = apply to all remaining files) > `;
  for (;;) {
    output.write(query);
    const next = await lines.next();
    if (next.done === true) return null;
    const answer = next.value.trim();
    if (answer.length === 1) {
      const all = APPLY_ALL[answer];
      if (all !== undefined) return { value: all, applyToAll: true };
      const one = SINGLE[answer];
      if (one !== undefined) return { value: one, applyToAll: false };
    }
    output.write(`unrecognized answer "${answer}" — enter r, k, p (or R, K, P to apply to all).\n`);
  }
}

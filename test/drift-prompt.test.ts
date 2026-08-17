import { Readable, Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { promptDriftChoices } from '../src/commands/drift-prompt.js';

/** Deliver `lines` as one chunk (a bare string would iterate character-by-character). */
function input(lines: readonly string[]): NodeJS.ReadableStream {
  return Readable.from([`${lines.join('\n')}\n`]);
}

function sink(): { stream: NodeJS.WritableStream; written: string[] } {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, written };
}

describe('promptDriftChoices', () => {
  it('asks once per path and maps each answer to its choice', async () => {
    const { stream: output } = sink();
    const choices = await promptDriftChoices(['a.md', 'b.md', 'c.md'], {
      input: input(['r', 'k', 'p']),
      output,
    });
    expect(choices.get('a.md')).toBe('replace');
    expect(choices.get('b.md')).toBe('keep');
    expect(choices.get('c.md')).toBe('propose');
  });

  it('applies an uppercase answer to every remaining path without asking again', async () => {
    const { stream: output } = sink();
    // Only two answers for three paths: "K" for b.md must also resolve c.md.
    const choices = await promptDriftChoices(['a.md', 'b.md', 'c.md'], {
      input: input(['r', 'K']),
      output,
    });
    expect(choices.get('a.md')).toBe('replace');
    expect(choices.get('b.md')).toBe('keep');
    expect(choices.get('c.md')).toBe('keep');
  });

  it('reprompts on an unrecognized answer instead of guessing', async () => {
    const { stream: output, written } = sink();
    const choices = await promptDriftChoices(['a.md'], {
      input: input(['x', 'q', 'k']),
      output,
    });
    expect(choices.get('a.md')).toBe('keep');
    expect(written.some((line) => line.includes('unrecognized answer "x"'))).toBe(true);
    expect(written.some((line) => line.includes('unrecognized answer "q"'))).toBe(true);
  });

  it('returns an empty map and asks nothing for an empty path list', async () => {
    const { stream: output, written } = sink();
    const choices = await promptDriftChoices([], { input: input([]), output });
    expect(choices.size).toBe(0);
    expect(written).toEqual([]);
  });

  it('stops and leaves remaining paths unresolved when input ends before every path is answered', async () => {
    const { stream: output } = sink();
    const choices = await promptDriftChoices(['a.md', 'b.md'], {
      input: input(['r']),
      output,
    });
    expect(choices.get('a.md')).toBe('replace');
    expect(choices.has('b.md')).toBe(false);
  });
});

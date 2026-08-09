import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install } from '../src/commands/install.js';
import { sync } from '../src/commands/sync.js';
import { CORPUS_DIR } from '../src/targets/claude/index.js';
import { FIXTURE_KEYWORD, buildFixtureRepo, makeTmpDir, removeTree } from './helpers/fixture.js';

const run = promisify(execFile);

/**
 * The procedures plugin's query machinery, vendored at a pinned version
 * (test/fixtures/plugin/VERSION) with the D23 `titw` store added to its
 * store list. Vendoring makes this spike run on every machine and in CI —
 * it can never silently skip.
 */
const QUERY_RECORDS = fileURLToPath(
  new URL('./fixtures/plugin/scripts/query-records.sh', import.meta.url),
);

describe('spike: the procedures plugin queries the projected titw store (D23)', () => {
  let root: string;
  /** Directory standing in for `~/.claude`: holds `titw/` = the projected corpus. */
  let claudeRoot: string;

  beforeAll(async () => {
    root = await makeTmpDir('spike');
    const repo = await buildFixtureRepo(path.join(root, 'fixture-way'));
    const home = path.join(root, 'home');

    await install({ home, source: repo.source });
    const result = await sync({ home });
    const corpus = path.join(result.targets[0]?.root ?? '', CORPUS_DIR);

    claudeRoot = path.join(root, 'claude-root');
    await fs.mkdir(claudeRoot, { recursive: true });
    await fs.cp(corpus, path.join(claudeRoot, 'titw'), { recursive: true });
  }, 60_000);

  afterAll(async () => {
    await removeTree(root);
  });

  async function query(args: readonly string[]): Promise<string> {
    const { stdout } = await run('bash', [QUERY_RECORDS, ...args], {
      env: { ...process.env, QUERY_RECORDS_ROOT: claudeRoot },
    });
    return stdout;
  }

  it('finds a six-key fixture record by keyword at its verbatim path', async () => {
    const stdout = await query(['--keyword', FIXTURE_KEYWORD]);
    expect(stdout).toContain('titw/@titw+fixture-way/knowledge/procedures/deploy/PROCEDURE.md');
    expect(stdout).toContain('Deploy the fixture');
  });

  it('finds the OKF-native record, proving the compat keys are what it matches on', async () => {
    const stdout = await query(['--keyword', 'okf frontmatter']);
    expect(stdout).toContain('titw/@titw+fixture-way/knowledge/research/okf-adoption.md');
  });

  it('finds every projected record kind through the single titw store', async () => {
    const stdout = await query(['--keyword', FIXTURE_KEYWORD]);
    for (const expected of [
      'knowledge/procedures/deploy/PROCEDURE.md',
      'knowledge/principles/simple-first.md',
      'knowledge/decisions/2026-08-08-use-yaml.md',
      'knowledge/solutions/2026-08-08-tag-resolution.md',
      'knowledge/failure-modes/stale-projection.md',
      'knowledge/research/okf-adoption.md',
      'plans/ship-v1.md',
    ]) {
      expect(stdout).toContain(expected);
    }
  });

  it('answers a structural --kind query from frontmatter, not directory placement', async () => {
    const stdout = await query(['--kind', 'procedure']);
    expect(stdout).toContain('knowledge/procedures/deploy/PROCEDURE.md');
    expect(stdout).not.toContain('simple-first.md');
  });

  it('finds a record by its stable id', async () => {
    const stdout = await query(['--id', 'res.okf-adoption']);
    expect(stdout).toContain('okf-adoption.md');
  });
});

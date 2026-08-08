import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { install } from '../src/commands/install.js';
import { sync } from '../src/commands/sync.js';
import { FIXTURE_KEYWORD, buildFixtureRepo, makeTmpDir, removeTree } from './helpers/fixture.js';

const run = promisify(execFile);

/**
 * The real, separately-installed plugin script — not a copy. The spike proves
 * TITW's projection is queryable by the machinery as shipped (handoff §21 step
 * 5), so a vendored copy would prove nothing.
 */
const QUERY_RECORDS = path.join(
  os.homedir(),
  '.claude/plugins/marketplaces/drewdrewthis/plugins/procedures/scripts/query-records.sh',
);

const installed = existsSync(QUERY_RECORDS);

describe.skipIf(!installed)('spike: the procedures plugin queries the active TITW corpus', () => {
  let root: string;
  let corpus: string;

  beforeAll(async () => {
    root = await makeTmpDir('spike');
    const repo = await buildFixtureRepo(path.join(root, 'fixture-way'));
    const home = path.join(root, 'home');

    await install({ home, source: repo.source });
    const result = await sync({ home });
    corpus = path.join(result.targets[0]?.root ?? '', 'corpus');
  }, 60_000);

  afterAll(async () => {
    await removeTree(root);
  });

  async function query(args: readonly string[]): Promise<string> {
    const { stdout } = await run(QUERY_RECORDS, [...args], {
      env: { ...process.env, QUERY_RECORDS_ROOT: corpus },
    });
    return stdout;
  }

  it('finds a six-key fixture record by keyword', async () => {
    const stdout = await query(['--keyword', FIXTURE_KEYWORD]);
    expect(stdout).toContain('references/procedures/deploy/PROCEDURE.md');
    expect(stdout).toContain('Deploy the fixture');
  });

  it('finds the OKF-native record, proving the compat keys are what it matches on', async () => {
    const stdout = await query(['--keyword', 'okf frontmatter']);
    expect(stdout).toContain('references/research/okf-adoption.md');
  });

  it('reaches every projected store', async () => {
    const stdout = await query(['--keyword', FIXTURE_KEYWORD]);
    for (const expected of [
      'references/procedures/',
      'references/principles/',
      'references/decisions/',
      'references/solutions/',
      'references/failure-modes/',
      'references/research/',
      'plans/',
    ]) {
      expect(stdout).toContain(expected);
    }
  });

  it('answers a structural --kind query against the projection', async () => {
    const stdout = await query(['--kind', 'procedure']);
    expect(stdout).toContain('references/procedures/deploy/PROCEDURE.md');
    expect(stdout).not.toContain('references/principles/');
  });

  it('finds a record by its stable id', async () => {
    const stdout = await query(['--id', 'res.okf-adoption']);
    expect(stdout).toContain('references/research/okf-adoption.md');
  });
});

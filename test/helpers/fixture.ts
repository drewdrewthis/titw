import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

/**
 * A keyword unique enough that the procedures plugin cannot match it against
 * the real corpus, so the spike test proves TITW's projection was searched.
 */
export const FIXTURE_KEYWORD = 'titwfixture';

/** Package name of the fixture. */
export const FIXTURE_PACKAGE = '@titw/fixture-way';

export interface FixtureRepo {
  /** Working tree of the fixture git repository. */
  readonly dir: string;
  /** Source specifier that clones it without touching the network. */
  readonly source: string;
  /** Tags created, oldest first. */
  readonly versions: string[];
}

/** Create a realpath-resolved temporary directory. */
export async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `titw-${prefix}-`));
  return fs.realpath(dir);
}

async function write(root: string, rel: string, contents: string): Promise<void> {
  const file = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

function record(options: {
  id: string;
  kind: string;
  keywords: string[];
  heading: string;
  body?: string;
}): string {
  return [
    '---',
    `id: ${options.id}`,
    `kind: ${options.kind}`,
    'date: 2026-08-08',
    `keywords: [${options.keywords.join(', ')}]`,
    'links: {}',
    'status: active',
    '---',
    '',
    `# ${options.heading}`,
    '',
    options.body ?? 'Fixture body.',
    '',
  ].join('\n');
}

/** An OKF-native concept: `type`/`tags` instead of `kind`/`keywords`. */
function okfRecord(options: {
  id: string;
  type: string;
  tags: string[];
  heading: string;
}): string {
  return [
    '---',
    `type: ${options.type}`,
    `title: ${options.heading}`,
    `tags: [${options.tags.join(', ')}]`,
    'status: stable',
    'titw:',
    `  id: ${options.id}`,
    '---',
    '',
    `# ${options.heading}`,
    '',
    'Fixture body.',
    '',
  ].join('\n');
}

function packageManifest(version: string): string {
  return [
    'schema: 1',
    `name: "${FIXTURE_PACKAGE}"`,
    `version: ${version}`,
    'description: Fixture package for the TITW v1 slice',
    'repository: https://github.com/drewdrewthis/titw-fixture',
    'license: MIT',
    'knowledge:',
    '  format: okf',
    '  version: "0.2"',
    'exports:',
    '  - README.md',
    '  - knowledge/**',
    '  - plans/**',
    '  - scripts/**',
    '',
  ].join('\n');
}

/** Write the fixture package's files into `root` at the given version. */
export async function writeFixturePackage(root: string, version: string): Promise<void> {
  await write(root, 'titw.package.yaml', packageManifest(version));
  await write(root, 'README.md', '# Fixture way\n\nNot a record — no frontmatter.\n');
  await write(root, 'CHANGELOG.md', '# Changelog\n\nUnexported: not in the export list.\n');

  await write(
    root,
    'knowledge/procedures/deploy/PROCEDURE.md',
    record({
      id: 'proc.deploy.fixture',
      kind: 'procedure',
      keywords: ['deployment', 'release', FIXTURE_KEYWORD],
      heading: 'Deploy the fixture',
    }),
  );
  await write(
    root,
    'knowledge/procedures/vm-only/PROCEDURE.md',
    record({
      id: 'proc.vm-only.fixture',
      kind: 'procedure',
      keywords: ['vm', 'machine', FIXTURE_KEYWORD],
      heading: 'VM-only procedure',
    }),
  );
  await write(
    root,
    'knowledge/principles/simple-first.md',
    record({
      id: 'prin.simple-first',
      kind: 'principle',
      keywords: ['simplicity', 'design', FIXTURE_KEYWORD],
      heading: 'Simple first',
    }),
  );
  await write(
    root,
    'knowledge/decisions/2026-08-08-use-yaml.md',
    record({
      id: 'dec.2026-08-08-use-yaml',
      kind: 'decision',
      keywords: ['yaml', 'manifest', FIXTURE_KEYWORD],
      heading: 'Use YAML for manifests',
    }),
  );
  await write(
    root,
    'knowledge/solutions/2026-08-08-tag-resolution.md',
    record({
      id: 'sol.2026-08-08-tag-resolution',
      kind: 'solution',
      keywords: ['semver', 'tags', FIXTURE_KEYWORD],
      heading: 'Resolve tags with semver',
    }),
  );
  await write(
    root,
    'knowledge/failure-modes/stale-projection.md',
    record({
      id: 'fm.stale-projection',
      kind: 'failure-mode',
      keywords: ['projection', 'stale', FIXTURE_KEYWORD],
      heading: 'Stale projection',
    }),
  );
  await write(
    root,
    'knowledge/research/okf-adoption.md',
    okfRecord({
      id: 'res.okf-adoption',
      type: 'Research',
      tags: ['okf', 'frontmatter', FIXTURE_KEYWORD],
      heading: 'OKF adoption notes',
    }),
  );
  await write(
    root,
    'plans/ship-v1.md',
    record({
      id: 'plan.ship-v1',
      kind: 'plan',
      keywords: ['slice', 'shipping', FIXTURE_KEYWORD],
      heading: 'Ship the v1 slice',
    }),
  );
  await write(root, 'scripts/verify.sh', '#!/usr/bin/env bash\necho fixture\n');
  await fs.chmod(path.join(root, 'scripts', 'verify.sh'), 0o755);

  if (version !== '1.0.0') {
    await write(
      root,
      'knowledge/principles/added-in-1-1.md',
      record({
        id: 'prin.added-in-1-1',
        kind: 'principle',
        keywords: ['addition', FIXTURE_KEYWORD],
        heading: 'Added in 1.1.0',
      }),
    );
  }
}

async function git(dir: string, args: readonly string[]): Promise<void> {
  await run(
    'git',
    [
      '-c',
      'user.name=TITW Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    { cwd: dir },
  );
}

/**
 * Build a local git repository holding the fixture package, tagged `v1.0.0`
 * and `v1.1.0`.
 *
 * Cloning it over `git+file://` exercises the real fetch path — clone, tag
 * listing, semver resolution, commit pinning — with no network.
 */
export async function buildFixtureRepo(dir: string): Promise<FixtureRepo> {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, ['init', '--quiet', '-b', 'main']);

  await writeFixturePackage(dir, '1.0.0');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'fixture 1.0.0']);
  await git(dir, ['tag', 'v1.0.0']);

  await writeFixturePackage(dir, '1.1.0');
  await git(dir, ['add', '-A']);
  await git(dir, ['commit', '--quiet', '-m', 'fixture 1.1.0']);
  await git(dir, ['tag', 'v1.1.0']);

  return { dir, source: `git+file://${dir}`, versions: ['1.0.0', '1.1.0'] };
}

/** Recursively delete a tree that may hold read-only files. */
export async function removeTree(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true, maxRetries: 3 }).catch(async () => {
    await run('chmod', ['-R', 'u+w', target]);
    await fs.rm(target, { recursive: true, force: true });
  });
}

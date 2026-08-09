#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { Command } from 'commander';
import { isTitwError } from './core/errors.js';
import { files } from './commands/files.js';
import { gc } from './commands/gc.js';
import { install, installFrozen } from './commands/install.js';
import { outdated } from './commands/outdated.js';
import { status } from './commands/status.js';
import { rollback, sync } from './commands/sync.js';
import { uninstall } from './commands/uninstall.js';

interface GlobalFlags {
  env?: string;
  json?: boolean;
  dryRun?: boolean;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function emit(json: boolean | undefined, payload: unknown, lines: () => string[]): void {
  if (json === true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  for (const line of lines()) process.stdout.write(`${line}\n`);
}

/** Build the `titw` command tree. Exported so tests can drive it without a subprocess. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('titw')
    .description('a package manager for agent knowledge and behavior files')
    .showHelpAfterError();

  program
    .command('install')
    .argument('[source]', 'github:owner/repo, owner/repo, git+ssh://…, git+https://…, or path:…')
    .description('fetch, lock, and select a package into an environment')
    .option('--version <range>', 'semver range (default: newest release)')
    .option('--include <glob>', 'select only matching exports (repeatable)', collect, [])
    .option('--exclude <glob>', 'subtract matching paths (repeatable)', collect, [])
    .option('--frozen', 'reproduce every locked package exactly; never resolves or rewrites state')
    .option('--env <name>', 'environment name', 'default')
    .option('--dry-run', 'resolve and report without writing state')
    .option('--json', 'machine-readable output')
    .action(async (source: string | undefined, options: GlobalFlags & {
      version?: string;
      include: string[];
      exclude: string[];
      frozen?: boolean;
    }) => {
      if (options.frozen === true) {
        if (source !== undefined) {
          throw new Error('install --frozen takes no source: it installs what titw.lock pins');
        }
        if (options.version !== undefined || options.include.length > 0 || options.exclude.length > 0) {
          throw new Error('install --frozen ignores nothing: --version/--include/--exclude are not allowed');
        }
        const frozen = await installFrozen({
          ...(options.env === undefined ? {} : { environment: options.env }),
          ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
        });
        emit(options.json, frozen, () => [
          `${frozen.dryRun ? 'would install' : 'installed'} ${frozen.packages.length} locked package(s)`,
          ...frozen.packages.map(
            (pkg) =>
              `  ${pkg.name}@${pkg.version}${pkg.commit === null ? '' : ` (${pkg.commit.slice(0, 7)})`}`,
          ),
        ]);
        return;
      }
      if (source === undefined) {
        throw new Error('install requires a <source> (or --frozen to install from titw.lock)');
      }
      const result = await install({
        source,
        ...(options.version === undefined ? {} : { version: options.version }),
        ...(options.include.length === 0 ? {} : { include: options.include }),
        ...(options.exclude.length === 0 ? {} : { exclude: options.exclude }),
        ...(options.env === undefined ? {} : { environment: options.env }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      });
      emit(options.json, result, () => [
        `${result.dryRun ? 'would install' : 'installed'} ${result.package}@${result.version}` +
          `${result.commit === null ? '' : ` (${result.commit.slice(0, 7)})`}`,
        `  source    ${result.source}  range ${result.range}`,
        `  selected  ${result.selected.length} of ${result.exported.length} exported file(s)`,
        ...(result.dryRun ? [] : [`  installed ${result.installedDir}`]),
        ...result.warnings.map((warning) => `  warning: ${warning}`),
        ...(result.dryRun ? [] : ['run "titw sync" to materialize the projection']),
      ]);
    });

  program
    .command('sync')
    .description('stage, validate, and atomically activate the target projections')
    .option('--env <name>', 'environment name', 'default')
    .option('--locked', 'fail instead of writing if titw.lock would change')
    .option('--dry-run', 'stage and validate without activating')
    .option('--json', 'machine-readable output')
    .action(async (options: GlobalFlags & { locked?: boolean }) => {
      const result = await sync({
        ...(options.env === undefined ? {} : { environment: options.env }),
        ...(options.locked === undefined ? {} : { locked: options.locked }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      });
      emit(options.json, result, () => [
        `${result.dryRun ? 'would sync' : 'synced'} environment "${result.environment}"` +
          ` (generation ${result.generation})`,
        ...result.packages.map((pkg) => `  ${pkg.name}@${pkg.version}  ${pkg.selected} file(s)`),
        ...result.targets.flatMap((target) => [
          `  target ${target.id}: ${target.paths} path(s) -> ${target.root}`,
          ...target.warnings.map((warning) => `    warning: ${warning}`),
          ...driftLines(target.drift),
        ]),
      ]);
    });

  program
    .command('uninstall')
    .argument('<package>', 'installed package name')
    .description('remove a package: manifest + lock entries, installed tree, and its projected files')
    .option('--env <name>', 'environment name', 'default')
    .option('--dry-run', 'report what would be removed without writing')
    .option('--json', 'machine-readable output')
    .action(async (pkg: string, options: GlobalFlags) => {
      const result = await uninstall({
        package: pkg,
        ...(options.env === undefined ? {} : { environment: options.env }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      });
      emit(options.json, result, () => [
        `${result.dryRun ? 'would uninstall' : 'uninstalled'} ${result.package}@${result.version}`,
        ...(result.removedInstalledDir === null ? [] : [`  removed  ${result.removedInstalledDir}`]),
        ...(result.sync === null
          ? []
          : result.sync.targets.map((t) => `  target ${t.id}: ${t.paths} path(s) remain`)),
        ...(result.dryRun ? [] : ['cache clone retained; run "titw gc" to reclaim it']),
      ]);
    });

  program
    .command('gc')
    .description('delete installed trees and cache clones nothing in titw.lock references')
    .option('--env <name>', 'environment name', 'default')
    .option('--dry-run', 'report what would be deleted without deleting')
    .option('--json', 'machine-readable output')
    .action(async (options: GlobalFlags) => {
      const result = await gc({
        ...(options.env === undefined ? {} : { environment: options.env }),
        ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      });
      emit(options.json, result, () => [
        `${result.dryRun ? 'would delete' : 'deleted'} ${result.installed.length} installed tree(s), ${result.cache.length} cache clone(s)`,
        ...[...result.installed, ...result.cache].map((p) => `  ${p}`),
      ]);
    });

  program
    .command('status')
    .description('report the environment, its packages, and the active projections')
    .option('--env <name>', 'environment name', 'default')
    .option('--json', 'machine-readable output')
    .action(async (options: GlobalFlags) => {
      const result = await status({
        ...(options.env === undefined ? {} : { environment: options.env }),
      });
      emit(options.json, result, () => [
        `home        ${result.home}`,
        `environment ${result.environment}${result.initialized ? '' : ' (not initialized)'}`,
        `packages    ${result.packages.length}`,
        ...result.packages.map(
          (pkg) =>
            `  ${pkg.name}@${pkg.version}  ${pkg.selected} selected  ${pkg.source}` +
            `${pkg.installed ? '' : '  (not installed)'}`,
        ),
        ...result.targets.map(
          (target) =>
            `  target ${target.id}: ${target.active ? target.generation ?? 'active' : 'never synced'}` +
            ` (${target.paths} path(s))\n    corpus ${target.corpusRoot}`,
        ),
      ]);
    });

  program
    .command('files')
    .argument('<package>', 'installed package name')
    .description('list a package’s selected files and where they are projected')
    .option('--env <name>', 'environment name', 'default')
    .option('--json', 'machine-readable output')
    .action(async (pkg: string, options: GlobalFlags) => {
      const result = await files({
        package: pkg,
        ...(options.env === undefined ? {} : { environment: options.env }),
      });
      emit(options.json, result, () => [
        `${result.package}@${result.version}  ${result.files.length} selected file(s)`,
        ...result.files.map(
          (file) => `  ${file.path}${file.targetPath === null ? '' : ` -> ${file.targetPath}`}`,
        ),
      ]);
    });

  program
    .command('outdated')
    .description('report current, wanted, and latest versions')
    .option('--env <name>', 'environment name', 'default')
    .option('--json', 'machine-readable output')
    .action(async (options: GlobalFlags) => {
      const result = await outdated({
        ...(options.env === undefined ? {} : { environment: options.env }),
      });
      emit(options.json, result, () => [
        'package  current  wanted  latest',
        ...result.packages.map(
          (row) =>
            `${row.name}  ${row.current}  ${row.wanted ?? '?'}  ${row.latest ?? '?'}` +
            `${row.upToDate ? '' : '  (update available)'}` +
            `${row.error === undefined ? '' : `  [${row.error}]`}`,
        ),
      ]);
    });

  program
    .command('rollback')
    .description('re-activate the previous projection of a target')
    .option('--env <name>', 'environment name', 'default')
    .option('--target <id>', 'target id (default: the first enabled target)')
    .option('--json', 'machine-readable output')
    .action(async (options: GlobalFlags & { target?: string }) => {
      const result = await rollback({
        ...(options.env === undefined ? {} : { environment: options.env }),
        ...(options.target === undefined ? {} : { target: options.target }),
      });
      emit(options.json, result, () => [
        `rolled back target ${result.id} to generation ${result.generation}`,
        `  ${result.paths} path(s) at ${result.root}`,
      ]);
    });

  return program;
}

function driftLines(drift: { missing: string[]; modified: string[]; unowned: string[] } | null): string[] {
  if (drift === null) return [];
  const total = drift.missing.length + drift.modified.length + drift.unowned.length;
  if (total === 0) return [];
  return [
    `    drift in the replaced projection (preserved, not deleted):` +
      ` ${drift.missing.length} missing, ${drift.modified.length} modified,` +
      ` ${drift.unowned.length} unowned`,
  ];
}

/** Parse argv and run. Returns the process exit code. */
export async function main(argv: readonly string[]): Promise<number> {
  try {
    await buildProgram().parseAsync([...argv]);
    return 0;
  } catch (error) {
    if (isTitwError(error)) {
      process.stderr.write(`titw: ${error.message}\n`);
      return 1;
    }
    process.stderr.write(`titw: ${(error as Error).message}\n`);
    return 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  process.exitCode = await main(process.argv);
}

# TITW — This Is The Way

A GitHub-backed package manager for agent knowledge and behavior files.

TITW installs versioned packages of procedures, principles, decisions, skills, hooks, and
scripts; lets consumers select or omit individual files; records exact provenance in a
lockfile; and materializes an atomic local projection for an agent runtime. GitHub is the
review/permissions/release layer; agent turns read local files — no server, registry, or
network call in the hot path.

Companion to the [procedures Claude plugin](https://github.com/drewdrewthis/claude-plugins/tree/main/plugins/procedures),
which supplies the runtime lookup machinery (`/how-do-i`, procedure-scout, gates). TITW
packages and versions the corpus that machinery reads.

- Design: [docs/HANDOFF.md](docs/HANDOFF.md)
- Resolved design calls: [DECISIONS.md](DECISIONS.md)

## Status

Pre-v1. The vertical slice works: `install → select → sync → the procedures plugin queries
the projection`, proven end to end against a fixture corpus (`test/spike.procedures-plugin.test.ts`
runs the real installed `query-records.sh` against a synced projection).

Authoring commands (`init`, `check`, `lint`, `build`, `publish`), dependency resolution, and
active components (skills/hooks) are not implemented yet.

## Working today

```bash
titw install github:owner/repo --version "^1.2.0" --exclude "knowledge/procedures/vm-only/**"
titw install path:../local-package --include knowledge/principles/simple-first.md
titw sync                 # stage → validate → atomically activate → receipt
titw status               # environment, packages, active projection
titw files @scope/package # selected files and where each one projects
titw outdated             # current / wanted / latest, from the published manifest version
titw update [package]     # re-resolve locked package(s) against their recorded range
titw rollback             # re-activate the previous projection
```

`install`/`sync` take `--dry-run`; every inspection command takes `--json`. All state lives
under `$TITW_HOME` (default `$XDG_DATA_HOME/titw`, else `~/.local/share/titw`).

## Pointing the procedures plugin at the corpus

`sync` writes the seven-store corpus to `$TITW_HOME/targets/claude/active/corpus`
(`titw status` prints the path). The plugin reads it through its own corpus-root override —
no plugin changes, no network:

```bash
QUERY_RECORDS_ROOT="$(titw status --json | jq -r '.targets[0].corpusRoot')" \
  ~/.claude/plugins/marketplaces/drewdrewthis/plugins/procedures/scripts/query-records.sh \
  --keyword deployment
```

## Target CLI (design)

```bash
# author
titw init && titw check && titw build && titw publish --to github:owner/repo

# consume
titw update && titw remove @scope/package
```

## Development

```bash
npm install
npm test
npm run typecheck
```

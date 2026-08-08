# TITW Design Handoff

Status: current design handoff; v1 scope is substantially defined but the
manifest schemas and exact Claude activation mechanism still need to be frozen

Date: 2026-08-08

Working name and CLI: **TITW** / `titw` ("This Is The Way")

Primary initial target: Claude Code

## 1. Executive summary

TITW is a GitHub-backed package manager for agent knowledge and behavior files.
It installs versioned packages locally, lets consumers select or omit individual
files, validates what authors publish, records exact provenance in a lockfile,
and materializes a local projection for an agent runtime.

The original use case is concrete: one machine has roughly 200 evolving
procedures, principles, decisions, solutions, failure modes, research records,
skills, scripts, and hooks. Two other machines should be able to adopt some or
all of that system. Some material should be public, some belongs in private Git
repositories, and some must remain local-only because it contains personal data
or machine-specific procedures.

TITW does not serve knowledge at agent runtime. GitHub is the collaboration,
review, permissions, and release layer; TITW installs a reviewed and locked
snapshot; agent turns read local files. There is no TITW server, registry, MCP,
or network call in the hot path.

The concise model is:

```text
local editable package
        |
        | titw build / publish
        v
clean GitHub package + version tag
        |
        | titw install / update
        v
locked read-only local package
        |
        | include / exclude + target adapter
        v
atomic local agent projection
```

TITW is the distribution and dependency layer. Agent plugins, skills, hooks,
and scouts remain the runtime behavior layer.

## 2. What changed from the previous handoff

The previous Library artifact was titled `frankie-v1-spec.md`. The following
changes are material and supersede it:

1. **The project is now TITW, not Frankie.** The CLI is `titw`; proposed files
   are `titw.package.yaml`, `titw.yaml`, and `titw.lock`.
2. **OKF v0.2 is now the base knowledge format.** TITW knowledge Markdown must
   be valid Open Knowledge Format documents. TITW-specific metadata belongs
   under a `titw:` namespace. The old statement that ordinary knowledge files
   require no frontmatter is no longer correct; OKF concept documents require
   `type`.
3. **The existing procedures plugin is a separate runtime engine.** TITW does
   not replace `/how-do-i`, the procedure scout, gates, `/log`, or
   `/am-i-done`. It supplies and versions the corpus those mechanisms read.
4. **Publication metadata is simpler.** For Markdown, published versus
   local-only may be declared in visible frontmatter (`titw.publish`). Package
   defaults or sidecars handle non-Markdown files. The older heavyweight
   `visibility.public` / `visibility.private` workspace model is not the
   canonical design.
5. **Public versus private is primarily a repository permission boundary.** A
   private GitHub package behaves like a public one from TITW's perspective.
   File-level metadata answers "ship this file or keep it local," not "which
   audience may read it."
6. **Context is runtime applicability, not an install profile.** Optional
   `titw.applies` and `titw.excludes` metadata can help a scout distinguish a
   LangWatch deployment from a personal deployment. Context does not install
   different package sets and does not reintroduce profiles.
7. **Package provenance is derived, not copied into documents.** Package name,
   version, commit, and repository come from the package boundary and lockfile
   and are exposed through a generated catalog.
8. **No symlinks in v1.** Materialization uses staged copies and atomic
   activation.
9. **Package freshness is explicit.** `titw outdated` reports current, wanted,
   and latest versions; updates never occur silently.
10. **Scorecards and OpenTelemetry are deferred.** They may later record
    self-reported procedure outcomes, but they are not required for packaging,
    installing, selecting, or using knowledge.

Still valid from the old design: whole-package versioning, GitHub sources,
exact lockfile commits and hashes, publisher exports, consumer include/exclude,
single-file installation, clean public builds, reference validation,
byte-preserving materialization, no install-time lifecycle scripts, local
runtime reads, and ordinary Git pull requests for contribution.

## 3. Product boundary

### TITW owns

- package manifests and whole-package versions;
- GitHub/path source resolution and private-repository authentication through
  existing Git tooling;
- the publisher's export surface;
- local-only versus publishable filtering;
- consumer `include` and `exclude` selection;
- dependency resolution and an exact lockfile;
- package caching and read-only installed copies;
- deterministic checks, linting, packing, and clean output;
- target-specific local materialization;
- provenance catalogs, receipts, update previews, removal, and rollback;
- optional wiring for explicitly enabled skills, hooks, and scripts.

### TITW does not own

- the semantic truth of Markdown;
- a universal optimal procedure for every situation;
- runtime procedure selection or procedure synthesis;
- agent memory, RAG, or remote context serving;
- user accounts, a registry, or package discovery in v1;
- Git hosting, review, forks, pull requests, or repository permissions;
- an MCP protocol implementation;
- automatic execution of package code during install, update, build, or pack;
- procedure outcome scoring in v1.

### Relationship to other layers

```text
GitHub                  review, permissions, releases, contributions
TITW                    package, lock, filter, validate, materialize
Claude target adapter   local corpus and optional plugin components
procedures plugin       lookup, gates, synthesis, logging, completion review
MCP                     live external data and actions, when separately needed
```

MCP and TITW are complementary. TITW packages reviewed static or executable
assets. MCP provides live resources and capabilities. A future package may
declare an MCP component, but enabling live executable authority must be an
explicit action and is not required for v1.

## 4. Existing procedures system that TITW must support

Repository: <https://github.com/drewdrewthis/claude-plugins>

The `procedures` Claude plugin deliberately ships machinery only. Its knowledge
corpus currently lives outside the plugin under `~/.claude/references/**`.

The runtime flow is:

```text
main agent asks /how-do-i for an operation
        v
procedure-scout searches procedures plus relevant principles, mistakes,
decisions, solutions, failure modes, research, and plans
        v
scout returns a natural-language, fully compiled recommendation
        v
main agent acts however it decides
        v
main agent submits an am-I-done report
        v
/am-i-done performs a cold-read review
```

The scout's response is advice returned to the main agent, not an executable
TITW plan. TITW should not require plan adoption tracking.

The existing query implementation is local Bash/awk and accepts corpus-root
overrides such as `QUERY_RECORDS_ROOT` / `CODEX_ROOT`. This is the intended v1
integration seam: TITW materializes the selected corpus locally and the plugin
queries that projection. No MCP or remote retrieval is necessary.

The procedures plugin and TITW can evolve independently:

- the plugin defines how knowledge is found, enforced, created, and reviewed;
- TITW defines how that knowledge is packaged, shared, selected, updated, and
  attributed.

## 5. Core concepts and invariants

V1 has seven important concepts:

1. **Local package:** editable source owned by the user.
2. **Published package:** a clean, versioned GitHub repository distribution.
3. **Installed package:** a locked, read-only local copy of a published package.
4. **Exported file:** a path the publisher permits consumers to install.
5. **Selection:** consumer `include` and `exclude` patterns over exports.
6. **Component:** metadata for an asset requiring target wiring, such as a
   skill, hook, or executable.
7. **Target projection:** an atomically generated local view for an agent.

Invariants:

1. The package is the unit of authorship, trust, release, and versioning.
2. One published GitHub repository represents one TITW package in v1.
3. Git fetches and locks the package as a whole even when one file is selected.
4. A file does not receive an independent package version.
5. The publisher controls exports; the consumer controls selection from them.
6. Omitting `include` selects every exported file.
7. When `include` exists, only matching exports form the initial selection.
8. `exclude` always subtracts and therefore wins.
9. Consumer exclusion is not a privacy boundary: anyone able to clone the
   package can read its complete published contents.
10. Installed package files are read-only. Contributions modify a normal Git
    checkout and arrive through an ordinary PR and release.
11. Package code never runs automatically during install, resolution, update,
    check, pack, or removal.
12. Selected content is copied unchanged; only catalogs, wrappers, and target
    manifests are generated.
13. Agent turns read the active local projection and perform no TITW network
    request.
14. Updates are explicit and atomically activated.
15. No profiles, collections, presets, or hidden overlays exist in v1.

## 6. Package layout and manifest

A package can contain knowledge and optional behavior components:

```text
engineering-way/
├── titw.package.yaml
├── README.md
├── knowledge/
│   ├── procedures/
│   ├── principles/
│   ├── decisions/
│   ├── solutions/
│   ├── failure-modes/
│   └── research/
├── skills/
├── hooks/
├── scripts/
├── assets/
└── tests/
```

Directory names are conventions. The package manifest and exported paths are
authoritative.

The exact schema still needs to be frozen. Current candidate:

```yaml
schema: 1
name: "@dru/engineering-way"
version: 1.2.0
description: Shared engineering knowledge and Claude process machinery
repository: https://github.com/drewdrewthis/engineering-way
license: MIT

knowledge:
  format: okf
  version: "0.2"

exports:
  - README.md
  - knowledge/**
  - skills/**
  - hooks/**
  - scripts/**
  - assets/**

publish:
  default: false

dependencies:
  "@example/common":
    source: github:example/common
    version: "^1.1.0"

components:
  - id: lookup-skill
    type: agent-skill
    path: skills/lookup
    requires:
      - knowledge/procedures/lookup/**

  - id: procedure-query
    type: executable
    path: scripts/query-records.sh
    runtime: shell

targets:
  claude:
    knowledge: knowledge/**
    skills: skills/**
    hooks: hooks/**
```

Questions to freeze during implementation:

- whether `exports` should be named `files`;
- whether target mappings belong in the package manifest or are inferred from
  component types;
- exact active-component approval UX;
- whether `version` is mandatory in the manifest or derived from the Git tag
  and merely checked when present.

Do not broaden these questions into profiles, registries, or policy languages.

## 7. OKF v0.2 knowledge profile

TITW should treat OKF v0.2 as the interoperable base rather than inventing a
competing Markdown schema.

An OKF concept is a Markdown file with YAML frontmatter. `type` is the only
always-required OKF key. Recommended keys include `title`, `description`,
`resource`, and `tags`. OKF v0.2 also defines:

- `sources` and source credibility signals;
- `generated` and `verified` actors/timestamps;
- `status: draft | stable | deprecated`;
- `stale_after`;
- attested computation fields for the specialized computation concept.

TITW-specific extensions should be nested under `titw:`:

```yaml
---
type: Procedure
title: Deploy LangWatch to production
description: Deploy and verify a normal LangWatch production release.
tags: [deployment, langwatch, production]

status: stable
generated:
  by: human:dru
  at: 2026-08-08T10:00:00Z
verified:
  - by: claude-code/claude-opus
    at: 2026-08-08T10:30:00Z
stale_after: 2026-11-08

sources:
  - id: deployment-config
    resource: https://github.com/langwatch/langwatch
    title: LangWatch deployment configuration

titw:
  id: procedure.deploy.langwatch
  publish: true
  applies:
    organization: langwatch
    environment: production
    situation: normal-release
  excludes:
    situation: rollback
  requires:
    - ../../scripts/verify-deployment.sh
---
```

Rules:

1. TITW preserves unknown OKF and extension keys when round-tripping.
2. `type` is canonical; do not permanently duplicate it as `kind`.
3. Existing `status: active` migrates to OKF `status: stable`.
4. Existing `date` maps to `generated.at` when its meaning is a meaningful
   content change.
5. Existing `keywords` map to `tags`.
6. Stable record identity, when required by the procedures system, is
   `titw.id`; OKF's default concept identity remains the bundle-relative path.
7. Generic relationships remain ordinary Markdown links. A `titw.links`
   extension may preserve the current exact-ID graph where needed; do not
   misuse OKF `sources` for arbitrary relationships.
8. `verified` describes document verification, not the success of every
   procedure run.
9. A generic OKF bundle may tolerate broken links as the OKF spec requires.
   A package opting into TITW's stricter publication profile may fail its own
   build on broken exported references.
10. Non-knowledge files such as scripts and images do not need OKF frontmatter.

The current six-key procedure-record schema can be migrated mechanically. A
TITW migration command is desirable because there are roughly 200 existing
files, but dual canonical schemas should not become permanent.

Authoritative OKF source:
<https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>

## 8. Publication and local-only material

A local editable package may contain material that must never enter a published
distribution. Markdown can carry visible publication metadata:

```yaml
titw:
  publish: false
```

or:

```yaml
titw:
  publish: true
```

The package manifest provides the default. Sidecar/manifest metadata covers
scripts, assets, and other files without frontmatter. Recommended precedence:

1. explicit local-only/private exclusion always wins;
2. per-file metadata overrides the package default;
3. the package export allowlist is applied after publication filtering;
4. a public build is default-deny unless the author explicitly chooses a less
   restrictive policy and accepts the review risk.

Build behavior:

1. enumerate the local package;
2. remove local-only files;
3. expand the published export surface;
4. construct the reference/dependency graph;
5. fail if a published file or component requires a local-only, missing, or
   unexported path;
6. run safe structure, secret, and lint checks;
7. copy selected bytes to a fresh staging directory;
8. generate the distribution manifest and hash inventory;
9. atomically publish the clean output directory.

The public Git repository receives only this clean output and no private source
history. The mixed authoring repository must itself remain private.

A private GitHub package uses the same mechanism and existing Git credentials.
It may publish everything needed to be standalone while retaining a few
strictly local-only files. GitHub repository access—not TITW metadata—is the
reader authorization boundary.

Presidio or heavyweight PII/NLP scanning is deferred. V1 should use explicit
publication metadata, clean-build review, high-confidence secret detection,
lightweight PII warnings, and human review. An optional external privacy audit
provider can be added later.

## 9. References and build validation

TITW can determine dependencies from:

- relative Markdown links and images;
- `titw.requires` on OKF documents;
- package/component `requires` declarations;
- supported skill, hook, and target metadata.

It cannot reliably infer dynamic paths inside scripts or prose. Authors must
declare those dependencies.

Hard checks should include:

- package and manifest schema;
- version/tag consistency;
- exported path expansion;
- path traversal, absolute paths, special files, and case collisions;
- symlinks (rejected in v1 package outputs);
- missing/local-only/unexported declared requirements;
- broken relative links in strict TITW packages;
- component atomicity and skill/hook structure;
- duplicate target names and duplicate stable record IDs;
- undeclared executable files;
- deterministic packing and file hashes;
- obvious credentials, tokens, private keys, and high-confidence secrets.

Lint may warn about stale dates, malformed optional metadata, anchors, duplicate
headings, possible PII, unreachable records, or suspicious path-like prose. It
must not pretend to determine whether a procedure or principle is true.

Author repositories run their native tests in CI. Consumer installation never
runs package tests or lifecycle scripts.

## 10. Consumer manifest and selection

One environment has a small `titw.yaml`:

```yaml
schema: 1
name: local-agents

packages:
  "@dru/engineering-way":
    source: github:drewdrewthis/engineering-way
    version: "^1.2.0"
    exclude:
      - knowledge/procedures/production-only/**

  "@example/common":
    source: github:example/common
    version: "^1.1.0"
    include:
      - knowledge/principles/simple-first.md

targets:
  claude:
    enabled: true
```

Selection algorithm:

1. Expand the publisher's exported files.
2. If `include` is absent, start with every export.
3. If `include` exists, start only with matching exports.
4. Subtract every `exclude` match.
5. Detect atomic components intersected by the selection.
6. Add declared requirements of selected components.
7. Fail if an explicit exclusion blocks a requirement.
8. Validate target conflicts and active-component approval.
9. sort paths deterministically and materialize them.

Selectors are package-relative, use `/`, support exact paths and ordinary glob
syntax, and reject absolute paths, `..`, and negation. `exclude` already
provides explicit subtraction, so glob negation is unnecessary.

Single-file installation is a first-class use case. TITW still fetches and
locks the whole package, but materializes only the selected file and its
explicitly required dependencies.

Agent Skills compatibility:

```bash
titw install vercel-labs/agent-skills \
  --skill web-design-guidelines
```

TITW should understand valid `skills/<name>/SKILL.md` directories without
shelling out to `npx skills`. Conversely, TITW packages may expose ordinary
Agent Skills so non-TITW users can still install them with existing skill
tools.

Installed files are not automatically exposed as hundreds of Claude skills.
Only selected explicit skill entrypoints are activated; passive procedures and
knowledge remain in the local catalog for the existing lookup machinery.

## 11. Sources, versions, lockfile, and freshness

V1 sources:

```text
github:owner/repository
git+ssh://git@github.com/owner/repository.git
git+https://github.com/owner/repository.git
path:../local-package
```

GitHub is the default user-facing form. Existing SSH agents, credential
helpers, GitHub CLI sessions, or deploy keys handle private access. Credentials
must never appear in TITW manifests, locks, receipts, or logs.

The whole package is semantically versioned. A release tag resolves to one
commit; `titw.lock` records the exact version, commit, manifest hash, and
distribution hash. The manifest version should match the Git tag if both are
present.

Suggested semver guidance:

- patch: wording fixes and compatible corrections;
- minor: added exported knowledge or backward-compatible components;
- major: removed/renamed paths, incompatible component behavior, or materially
  changed meaning that consumers must consciously adopt.

Freshness commands:

```bash
titw outdated
titw update
titw update @dru/engineering-way
titw install @dru/engineering-way@2
```

`outdated` reports:

- **current:** exact locked version;
- **wanted:** newest release satisfying the declared range;
- **latest:** newest published release.

Branch packages may report that their locked commit is behind. Exact commit
pins do not update implicitly. `titw update` stays within the declared range;
changing a major constraint is explicit.

Network checks never run on every agent turn. A later optional background or
SessionStart refresh may cache update metadata, but the procedure lookup hot
path remains offline.

Package version freshness is not procedure correctness. OKF `status`,
`stale_after`, and verification metadata address document lifecycle separately.

## 12. CLI surface

The exact option spelling can evolve, but the conceptual CLI is:

### Authoring

```bash
titw init
titw check
titw lint
titw pack --dry-run
titw build
titw publish --to github:owner/repository
```

### Installing and selecting

```bash
titw install github:owner/repository
titw install github:owner/repository --version "^1.2.0"
titw install github:owner/repository \
  --include knowledge/principles/simple-first.md
titw install vercel-labs/agent-skills --skill web-design-guidelines

titw remove @scope/package
titw update [@scope/package]
titw outdated
titw sync
```

`install` is the correct user verb; do not call package adoption `import`.

### Inspecting

```bash
titw status
titw files @scope/package
titw why @scope/package:knowledge/procedures/review.md
titw diff
titw doctor
titw target inspect claude
titw rollback [generation]
```

All mutating commands should support `--dry-run`; inspection should support
machine-readable JSON. Exact subcommand grouping (`titw claude sync` versus
`titw sync --target claude`) remains a small CLI decision, not an architectural
one.

## 13. Local storage and materialization

One TITW data root should visibly separate editable and installed state:

```text
~/.local/share/titw/
├── packages/
│   ├── local/                     # editable packages or registrations
│   └── installed/                 # immutable package versions
├── cache/                         # fetched package objects
├── environments/<environment>/
│   ├── titw.yaml
│   ├── titw.lock
│   ├── receipts/
│   └── generations/
└── targets/claude/
    ├── active/
    └── previous/
```

Use platform-appropriate XDG equivalents; the exact physical layout is an
implementation detail, but local versus installed and source versus generated
must remain obvious.

No symlinks in v1. `titw sync`:

1. validates manifest and lock;
2. verifies cached package hashes;
3. expands exports and selections;
4. validates requirements and active components;
5. copies selected bytes into a temporary generation;
6. generates catalogs, provenance, and target glue;
7. validates the staged target;
8. atomically activates it;
9. records a receipt and retains the previous valid generation.

TITW removes only paths proven to be owned by its receipt. Unexpected drift is
reported and preserved rather than blindly deleted.

## 14. Package provenance and context

Do not write package name or version into source Markdown. A file may be moved,
forked, or republished, and the package version changes independently of its
contents.

The resolver generates a provenance catalog keyed by stable record ID and/or
materialized path:

```json
{
  "procedure.deploy.langwatch": {
    "package": "@dru/engineering-way",
    "version": "1.2.0",
    "commit": "a91c2f0",
    "repository": "github:drewdrewthis/engineering-way",
    "sourcePath": "knowledge/procedures/deploy-langwatch.md",
    "editable": false
  }
}
```

The existing scout or query layer may return this attribution alongside a
record. Installed third-party files remain read-only. To change one, the user
checks out or forks the normal source repository, creates a branch, opens a PR,
and waits for a new release. TITW should not invent a proprietary contribution
or hidden patch format.

Context is separate from provenance. Optional document metadata may say when a
procedure applies:

```yaml
titw:
  applies:
    organization: langwatch
    system: slack
    situation: incident-update
  excludes:
    environment: personal
```

Stable context facts may be declared in project-local configuration and
temporary situation inferred from the request. The runtime scout—not the TITW
dependency resolver—uses context to rank available knowledge. Unknown or equal
specific matches should be surfaced rather than silently guessed.

This does not create profiles. Installed availability is controlled by package
selection; applicability is decided when knowledge is used.

## 15. Claude target

V1 targets Claude Code, but target-specific behavior must remain behind an
adapter so later Codex/OpenCode support does not change the package format.

The Claude target has two related outputs:

1. **Corpus projection:** selected OKF records in a local directory that the
   existing `procedures` plugin can query through its corpus-root override.
2. **Optional plugin projection:** selected Agent Skills, Claude hooks, and
   approved scripts copied into a self-contained generated Claude plugin.

Passive knowledge does not become always-on prompt context merely because it
is installed. The procedure scout discovers and reads it locally on demand.
Only a small number of explicit skills/gateways should be activated; exposing
hundreds of discovered skills causes duplication and model degradation.

Claude plugins are self-contained and should not depend on paths outside their
plugin root. This reinforces copy-based materialization. The exact method used
to point the separately installed `procedures` plugin at the active TITW corpus
must be frozen during the adapter spike; likely options are a generated
environment wrapper or a documented corpus-root environment setting. Do not
duplicate or silently rewrite the existing plugin unless the spike proves it
necessary.

## 16. Executables, hooks, and other components

Packages may contain scripts and hooks because procedures often reference
them. The important trust boundary is passive versus active:

- passive Markdown/assets can be selected and copied;
- scripts can be present without being run;
- hooks, executable wrappers, and future MCP components require explicit local
  activation;
- changing active executable bytes invalidates prior approval or at minimum
  requires a conspicuous update review;
- package lifecycle commands never execute during install or update.

The exact hash-bound approval design from the old specification is reasonable
but has not been explicitly re-ratified as mandatory v1 UX. Preserve the
security property while keeping the interaction simple.

Same-name skill or hook conflicts must fail visibly. Exact duplicate content
may be deduplicated or warned about, but semantic duplicate detection is later
work.

## 17. Contribution and evolution workflow

Contribution is ordinary Git:

```text
installed record reveals its package/repository
        v
clone or fork repository
        v
edit local package + run titw check
        v
branch / pull request / review
        v
merge + package release
        v
titw outdated / explicit update
```

There is no custom TITW patch exchange. An installed package is never edited in
place because the next sync would overwrite it.

The existing procedures plugin may create or evolve local records. Writes must
eventually target a declared editable local package, not the derived active
projection. The minimal configuration needed to choose that writable package
is still to be specified. This is a write destination, not a profile.

If a referenced record is installed/read-only, evolution should identify its
source and direct the user to the repository workflow rather than mutating the
projection.

## 18. Three-machine scenario

The immediate success case:

### VM1: source machine

- registers the existing corpus as an editable local package;
- migrates knowledge frontmatter to the OKF/TITW profile;
- marks personal/local-only files with `titw.publish: false`;
- builds a clean private or public distribution;
- publishes and tags the GitHub repository.

### VM2: process first

Initially installs only the machinery and minimum lookup knowledge:

```yaml
packages:
  "@dru/engineering-way":
    source: github:drewdrewthis/engineering-way
    version: "^1.0.0"
    include:
      - skills/**
      - hooks/**
      - scripts/**
      - knowledge/procedures/lookup/**
```

It can later broaden selection to shared procedures and principles.

### Local machine

Installs the package but excludes machine- or production-specific paths:

```yaml
packages:
  "@dru/engineering-way":
    source: github:drewdrewthis/engineering-way
    version: "^1.0.0"
    exclude:
      - knowledge/procedures/vm-only/**
      - knowledge/procedures/production-only/**
```

Copying `titw.yaml` and `titw.lock` to another compatible machine and running a
frozen install should reproduce the same package bytes and selection.

## 19. V1 acceptance criteria

### Packaging and publication

- [ ] A local package may contain OKF knowledge, skills, hooks, scripts, and
      assets.
- [ ] One GitHub repository represents one published package.
- [ ] The package has one whole-package version and exact commit/hash lock.
- [ ] Markdown can visibly declare publishable or local-only status.
- [ ] Non-Markdown publication metadata is expressible in the manifest or a
      sidecar.
- [ ] A clean public build contains no local-only files or source Git history.
- [ ] A published file requiring a filtered or missing file fails the strict
      build with the complete dependency chain.
- [ ] Build, check, lint, and pack never execute package code.

### OKF and knowledge

- [ ] Knowledge documents are valid OKF v0.2 concepts.
- [ ] TITW extensions are namespaced under `titw:`.
- [ ] Unknown OKF keys are preserved.
- [ ] Existing six-key records can be migrated mechanically.
- [ ] Package provenance is available without modifying document bytes.
- [ ] Duplicate stable record IDs fail projection validation.

### Installation and selection

- [ ] `titw install github:owner/repo` works for public and credentialed private
      repositories.
- [ ] Omitting selection installs all exports.
- [ ] `include` can select one file, directory, or glob.
- [ ] `exclude` subtracts and wins.
- [ ] Atomic components cannot be partially installed.
- [ ] Whole packages are locked even when one file is materialized.
- [ ] Agent Skills can be selectively installed without calling `npx skills`.
- [ ] Updates are explicit and `titw outdated` reports available versions.

### Local target and safety

- [ ] Installed packages are read-only and separate from editable local
      packages.
- [ ] Materialization uses copies, staging, and atomic activation—no symlinks.
- [ ] Passive files do not become hundreds of active Claude skills.
- [ ] The existing procedures plugin can query the active local corpus.
- [ ] Optional hooks/scripts require explicit activation and are conspicuous on
      update.
- [ ] Agent turns perform no TITW network request.
- [ ] Receipts make sync, rollback, repair, and removal ownership-safe.
- [ ] Credentials never enter TITW state.

### Concrete adoption

- [ ] VM1 can publish the existing procedural system while retaining
      local-only material.
- [ ] VM2 can initially install only process machinery and later add knowledge.
- [ ] The local machine can omit situational paths.
- [ ] A normal Git PR can improve an installed procedure and a later release is
      detected as outdated.

## 20. Explicitly deferred

- package registry or discovery service;
- TITW accounts or hosting;
- runtime server or remote corpus API;
- profiles, collections, presets, or organization policy layers;
- symlink mode;
- repository monorepo/subpath packages;
- Codex and OpenCode target adapters;
- automatic semantic duplicate detection;
- universal truth or procedure quality scoring;
- OpenTelemetry scorecards and am-I-done outcome aggregation;
- Presidio or other heavyweight privacy scanning;
- automatic MCP server activation;
- install-time lifecycle scripts;
- semantic testing language for Markdown;
- hidden local overlays of installed packages.

## 21. Recommended implementation sequence

1. **Freeze schemas.** Finalize `titw.package.yaml`, `titw.yaml`, `titw.lock`,
   OKF/TITW frontmatter, selector syntax, and diagnostics.
2. **Build the package core.** GitHub/path resolution, whole-package cache,
   semver/tag resolution, exports, include/exclude, lockfile, deterministic
   hashes, and `outdated`.
3. **Build author checks.** Publication filtering, reference graph, clean
   staging, `check`, `lint`, `pack --dry-run`, and public-output inspection.
4. **Build copy materialization.** Generations, provenance catalog, receipts,
   atomic activation, rollback, repair, and removal.
5. **Spike the existing Claude procedures integration.** Materialize a small
   fixture corpus, point `query-records.sh` at it, and prove `/how-do-i` and the
   gates work without modifying the source plugin.
6. **Add Agent Skills and active Claude components.** Selective skills first;
   explicit hook/script activation second.
7. **Migrate the real corpus.** Mechanically convert frontmatter, classify
   publication, find broken references, and test the three-machine scenario.

## 22. Implementation language

TITW v1 will be implemented in strict TypeScript on a current supported Node.js
LTS.

This is a deliberate product decision, not an open comparison:

- the implementation is primarily CLI orchestration, YAML/JSON Schema,
  semver, Git subprocesses, hashing, globs, and filesystem staging;
- TypeScript is the fastest language for the coding-assistant-heavy build;
- the maintainer prefers TypeScript and does not want to maintain Python;
- Node provides straightforward macOS/Linux/Windows behavior and an immediate
  `npx` / npm distribution path;
- Python would add unwanted interpreter, virtual-environment, and packaging
  friction;
- Go or Rust could produce attractive single binaries but would slow initial
  iteration without solving a demonstrated v1 problem.

The core must not require Python. Packages may still contain Python scripts if
their authors explicitly declare and activate that runtime. A standalone
compiled binary can be explored later without changing TITW's package format.

## 23. Design statement

TITW v1 is a local-first package manager for agent knowledge and behavior
files, with OKF as its interoperable knowledge format and GitHub as its release
and collaboration layer.

It solves a package lifecycle problem: what can be published, which package
version is installed, which files a consumer opted into, where every record
came from, how selected files become locally usable, and how updates and
removal remain reviewable and reversible.

It deliberately does not solve runtime reasoning. The existing Claude
procedures plugin continues to consult records and compile situational guidance
for the main agent. TITW makes that corpus portable, attributable, selective,
versioned, safe to publish, and fast to read locally.

That is enough for the immediate three-machine and team-sharing use case
without inventing a cloud service, a new context protocol, or a policy language.

## 24. Primary references

- TITW's existing Claude runtime machinery:
  <https://github.com/drewdrewthis/claude-plugins>
- Open Knowledge Format v0.2:
  <https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md>
- Agent Skills installer and ecosystem:
  <https://github.com/vercel-labs/skills>
- Claude Code plugins:
  <https://code.claude.com/docs/en/plugins>
- Claude Code plugin reference:
  <https://code.claude.com/docs/en/plugins-reference>
- Claude Code hooks:
  <https://code.claude.com/docs/en/hooks>
- Model Context Protocol architecture:
  <https://modelcontextprotocol.io/docs/learn/architecture>

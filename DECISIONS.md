# TITW Decisions

Small design calls left open by `docs/HANDOFF.md`, resolved here so implementation can
proceed. All are reversible pre-1.0; override by editing this file and the code together.

## D1 — Export field is named `exports`

`exports` (not `files`) in `titw.package.yaml`. It names the publisher-controlled surface
consumers may select from — the same semantic as npm/Node `exports` — while `files` would
collide with the npm meaning "what goes in the tarball" (TITW's equivalent is the
publication filter, not the export list).

## D2 — `version` is mandatory in the manifest; tag consistency is checked

The manifest carries the version; when a Git tag is present it must agree (`titw check`
fails on mismatch). Deriving from the tag alone would make a bare checkout (path: source,
un-tagged branch) versionless and make `check` depend on Git state.

## D3 — Target mappings live in the manifest under `targets:`

Explicit mapping beats inference from component types. Inference can be layered on later
as a default when `targets:` is absent; the manifest key stays authoritative.

## D4 — Active-component approval is hash-bound, via an explicit command

`titw enable <package>:<component-id>` records the component's content hash in `titw.yaml`.
On sync, a hash mismatch deactivates the component and reports conspicuously; re-approval
is the same `enable` command. No interactive prompt machinery in v1 — the command IS the
approval act. (Deferred past the v1 slice; the slice ships passive knowledge only.)

## D5 — Claude corpus projection uses the seven-store layout with compat frontmatter

Measured 2026-08-08 against the installed `procedures` plugin (v0.2.3):
`query-records.sh` resolves its root as `${QUERY_RECORDS_ROOT:-${CODEX_ROOT:-~/.claude}}`
and greps `kind:`/`keywords:` frontmatter across exactly these stores:

```
references/failure-modes  references/decisions  references/solutions
references/procedures     references/research   references/principles  plans
```

Therefore the v1 Claude target projects knowledge into that layout and preserves
`kind`/`keywords` keys. OKF-native records (`type`/`tags`) get compat keys emitted into
the projection copy (`kind`, `keywords`) — projection is generated output, so this does
not violate "copied unchanged" for the package store, only decorates the target view.
Revisit when the plugin learns OKF keys natively.

Correction (2026-08-08, spike): compat keys are INSERTED into the projected copy's
frontmatter (derived from `type`/`tags`/`titw.id`), not merely preserved — the awk matcher
tokenizes `keywords: [a, b]` inline-list syntax only.

## D6 — Toolchain

Node ≥20, strict TypeScript (NodeNext ESM), `vitest`, `commander`, `zod` (schema
validation), `yaml`, `picomatch` (selectors), `semver`. Git operations shell out to the
system `git` — no libgit2 binding; that keeps private-repo auth on the user's existing
credential helpers, per the handoff.

## D7 — Data root

`$TITW_HOME`, defaulting to `$XDG_DATA_HOME/titw` or `~/.local/share/titw`, laid out as
in handoff §13. Every command takes the root from the environment so tests run hermetic.

## D8 — v1 slice repo layout

Single package, `src/` layered as `core/` (manifest, sources, cache, lock, selection),
`materialize/` (staging, generations, receipts, activation), `targets/claude/`, `cli.ts`.
No monorepo until a second distributable exists.

---

Resolved while building the v1 slice (2026-08-08). Same standing as D1–D8.

## D9 — `titw.lock` is JSON; the two authored manifests stay YAML

`titw.package.yaml` and `titw.yaml` are hand-edited, so YAML earns its cost. `titw.lock` is
generated and diffed, never authored; JSON removes every quoting question (npm's split).

## D10 — Source forms also accept `git+file://` and a bare `owner/repo` slug

`git+file://<abs path>` completes the `git+<scheme>://` family and is what makes the fetch
path — clone, tag listing, semver resolution, commit pinning — testable with no network.
Bare `owner/repo` is github sugar, as handoff §12 already writes it
(`titw install vercel-labs/agent-skills`); it normalizes to `github:owner/repo`.

## D11 — Omitting `--version` records `^<resolved version>`

Resolution uses `*` (newest release), but the range written to `titw.yaml`/`titw.lock` is
`^<resolved>`. Recording `*` would make `outdated`'s "wanted" column meaningless and every
package permanently up to date.

## D12 — A directory selector implies its subtree

`knowledge` selects exactly what `knowledge/**` selects. Consumers should not have to
remember `/**`, and no other reading of a directory-shaped selector is useful.

## D13 — Compat frontmatter also carries `id`, derived from `titw.id` (extends D5)

Measured by the spike: the plugin's `record-scan.awk` matches `^id:` at frontmatter top
level, so an OKF record whose identity lives at `titw.id` is invisible to `--id` and
`--links-to` without it. The projected copy therefore gets `id`, `kind`, and `keywords`.
Only records are decorated — a document with no projectable kind is copied verbatim.

## D14 — Selected non-record files project under `<target>/files/<package>/<path>`

The corpus holds records. Scripts, assets, and un-frontmattered Markdown still land in the
projection so that "everything selected is materialized" stays literally true and every byte
is receipted. Active components (D4) will supersede this for skills and hooks.

## D15 — `targets/<id>/{active,previous}` is `$TITW_HOME`-global, per handoff §13

Not per-environment. This is a genuine collision the moment a second environment syncs the
same target; the slice ships one environment (`default`) and the receipt records which
environment produced the projection. Revisit before multi-environment support.

## D16 — Generated projection files are read-only too

Handoff invariant 10 only demands it of installed packages, but the projection is derived
state that the next sync replaces wholesale (§17: an installed package is never edited in
place). `0444` makes that visible at the moment of the mistake rather than at the next sync.

A side effect worth keeping: a packaged script projects without its execute bit, so a
selected executable is present but not runnable until activation (D4) grants it — which is
exactly the passive/active boundary of handoff §16.

## D17 — `sync` recomputes selection from `titw.yaml` and relocks it

`titw.yaml` is authoritative for *what* is selected; `titw.lock` is authoritative for *which
bytes* those selectors resolve against. So sync re-runs the §10 algorithm, verifies the
installed tree against the locked tree hash, and rewrites only the lock's `selection` and
file inventory — never its version, commit, or refs. Editing selection then syncing works;
changing versions still requires an explicit `install`.

## D18 — Receipts come in a `current`/`previous` pair mirroring the directory pair

`receipts/<target>/{current,previous}.json` swap exactly when `active`/`previous` swap, plus
one `<generation>.json` per sync for history. Rollback then restores a receipt that was
actually written for that tree instead of re-deriving one from the tree it just demoted.

---

Resolved in the 2026-08-09 design review conversation. Same standing as D1–D8.

## D19 — A release is the declared version on the default branch; git tags are not the mechanism

Version validity and verification are v2 (issue #3). Trust is accepted the way the Claude
plugin marketplace accepts it: the manifest's `version:` at the fetched commit IS the
release. A new version must be strictly greater than the one it replaces — publish enforces
the bump, consumers refuse downgrades against their lock. Accepted consequence: only the
current version is installable from source; history lives in locks, caches, and generations,
not in the repo's refs. The tag machinery in fetch (tag listing, semver-over-tags
resolution, tag/manifest mismatch check) is superseded — the mismatch check moves to
publish, where the bump happens.

## D20 — `titw publish` is a conformity check plus a monotonic version bump

`titw publish major|minor|patch`: refuse a dirty tree, verify frontmatter conformity of
every exported record (the producer-side twin of the projection's checks — unique ids,
inline keywords, no CRLF/BOM, no symlinks), bump `titw.package.yaml`, commit, push. No tag,
no release object, no registry. Distribution is the push itself — anyone with the URL can
install the moment it lands.

## D21 — Repository trust is deferred to v2

TOFU at first install; `titw.lock`'s commit + treeHash pin what was actually fetched.
Signing, hash publication, namespaces, and mutation tripwires wait until packages come from
people the consumer doesn't trust. Preserved as issue #3.

## D22 — Materialized files keep their source modes; read-only stamping is dropped (amends D16, relaxes handoff invariant 10)

The npm precedent: edit at your own risk. Drift detection is the real guard — receipts hash
every file and `titw status` reports modified/unowned paths without deleting them; `0444`
was a tripwire on top of that, and it broke packaged scripts by stripping the execute bit.
Installed trees and projections now preserve each file's source mode. An edit to derived
state is still clobbered by the next sync — reported as drift beforehand, not prevented.

## D23 — The Claude projection root is `~/.claude/titw/`, added to the plugin's store list

A single top-level vendor root, not per-store `vendor/` subdirs and not a hidden dotdir
(ripgrep skips dotdirs by default, blinding fallback sweeps). Packages project verbatim
(`titw/<pkg>/...`) — the plugin's `--kind` filter is frontmatter-based, so no kind-routing
map is needed and the unknown-kind-drop class disappears. Activation stays a single atomic
rename; one ownership boundary for receipts, drift, uninstall, and gitignore. Cost: the
plugin's `STORES` list gains one entry (touching `stores.sh`, `lint-frontmatter.sh`
scope, and the store-list drift test) — a policy call on whether codex lint applies to
vendored records ships with that change.

## D24 — Proposing is file-granular, and the diff base is the upstream commit the package was installed from

Proposing a file upstream isn't a separate command — it's one of the three choices
(`replace` / `keep` / `propose`) sync offers per file when it finds local drift (D25).
Choosing `propose` keeps the local edit and records that file's path for later upstream
contribution. The base for what counts as "the user's change" is the commit the package
was installed from — `titw.lock`'s per-package `commit` (nullable only for `path:` sources)
— never upstream tip; tip would catch files upstream itself changed and the user never
touched, which aren't the user's to propose. Files, not commits, are the unit: a local tree
with forty commits still proposes exactly the files marked, and cherry-picking never enters
the picture because records already live one-per-file. Turning a marked file into a
contribution means committing it onto a fresh branch off upstream main, pushing, opening a
PR, and deleting the branch — plumbing that never becomes durable local topology. Auto-
opening a PR the instant a file is marked was rejected: most local edits are personal, never
meant to travel upstream, and immediate auto-PR erases the mine/for-everyone distinction
while spamming upstream with noise.

## D25 — Sync detects drift via receipt hashes and prompts on the modified bucket

Before rebuilding a projection, sync compares the live tree against the last receipt
(`detectDrift`): a receipt-owned path that's absent is `missing`, present but hash-mismatched
is `modified`, present but receipt-unowned is `unowned`. For every file in `modified` — a
receipt-owned file the user edited since the last sync — sync prompts: `replace` with the
newly built version, `keep` the local edit, or `propose` it (keep it and record the path for
later upstream contribution, D24). A non-TTY session or an explicit non-interactive flag
skips the prompt and replaces, so scripted and CI use never hangs. Built on
`node:readline/promises` — no TUI framework, no new dependency.

## D26 — Reconciliation is not a separate surface; it's the same three choices sync offers per file

There's no dedicated command that answers "how do I differ from upstream, and what do I want
to do about it" — that question is `replace` / `keep` / `propose`, asked inline by sync
(D25) the moment it finds a file in the `modified` drift bucket. `propose` is one of the
three answers to that prompt, not a command of its own (D24). Folding reconciliation into
sync means the decision is made at the moment the conflict is detected, against the tree
that's actually about to be rebuilt, by the one command a corpus consumer already runs —
not against a stale snapshot from a separate surface run earlier or later.

## D27 — Retracted: sync commits dirty files itself, lazily, right before it rebases

Void. There is no rebase and no git merge machinery anywhere in titw's source (`grep -rnE
"rebase|merge|stash|cherry-pick" src/` finds nothing) — sync re-materializes a projection:
verify the cached tree hash against the lock, recompute selection, build into a staging dir,
validate, write a content-hashed receipt, activate atomically, rewrite the lock. It never
fetches, merges, rebases, or diffs a working tree against a remote ref. This entry answered
a question the architecture doesn't pose: there is no rebase for a lazy commit to prepare a
tree for, and no stash-pop conflict for a commit to give git something to resolve toward.
Conflict handling and undo are covered instead by D25 (drift detection plus a per-file
prompt) and by rollback/generations (a prior generation survives until `gc`) — neither needs
the corpus tree to be a git repo with commits at all.

## D28 — Sync prompts on drift it would otherwise overwrite, reversing D4's no-prompt stance for that one case

D4 declared the command IS the approval act — no interactive prompt machinery in v1. That
still holds everywhere except one case: a file sync is about to rebuild that the user edited
since the last sync (the `modified` drift bucket, D25). Silently replacing it discards the
edit from view without asking; silently keeping it means the user stops receiving upstream
updates to that file without being told either. Both are titw choosing for the user, on
their behalf, invisibly — the one case D4 didn't have in view when it ruled prompting out.
The prompt (`replace` / `keep` / `propose`, D25/D26) is v1's one interactive surface, gated
to exactly that moment, with a non-interactive fallback that replaces so scripted and non-TTY
use is unaffected by the reversal.

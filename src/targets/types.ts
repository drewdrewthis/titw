/** One installed package contributing to a projection. */
export interface TargetPackageInput {
  readonly name: string;
  readonly version: string;
  readonly commit: string | null;
  /** Canonical source form, e.g. `github:owner/repo`. */
  readonly source: string;
  /** `repository` from the package manifest, when it declares one. */
  readonly repository?: string | undefined;
  /** Read-only installed package root the bytes are copied from. */
  readonly rootDir: string;
  /** Selected package-relative paths, sorted. */
  readonly files: readonly string[];
}

export interface TargetBuildInput {
  /** Staging directory the target writes its whole projection into. */
  readonly outDir: string;
  readonly packages: readonly TargetPackageInput[];
}

export interface TargetBuildResult {
  /** Every path written, relative to `outDir` and sorted. */
  readonly paths: string[];
  readonly warnings: string[];
}

/**
 * A target adapter turns a selection into a local projection.
 *
 * Target-specific behavior lives behind this interface so a later Codex or
 * OpenCode adapter cannot change the package format (handoff §15).
 */
export interface Target {
  readonly id: string;
  build(input: TargetBuildInput): Promise<TargetBuildResult>;
}

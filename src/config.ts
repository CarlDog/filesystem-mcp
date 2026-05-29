import { promises as fsp } from "node:fs";
import * as path from "node:path";

/** Split a comma-separated FS_ROOTS string into trimmed, non-empty entries. */
export function parseRoots(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Derive root paths from docker bind specs (`source:target[:flags]`) by
 * taking the container-side `target` of each. Used as the default for
 * FS_ROOTS when it's unset, so the operator declares each mount exactly
 * once (in FS_VOLUME*) and the roots follow automatically — no second,
 * drift-prone declaration. Empty/undefined specs and the `/dev/null`
 * no-op sentinel mount are skipped.
 */
export function deriveRootsFromVolumes(
  specs: Array<string | undefined>,
): string[] {
  const roots: string[] = [];
  for (const spec of specs) {
    if (!spec) continue;
    const parts = spec.split(":");
    const target = parts[1]?.trim();
    if (!target || target === "/dev/null") continue;
    roots.push(target);
  }
  return roots;
}

export interface ResolvedRoots {
  /** realpath-resolved, validated, de-duplicated directory roots. */
  resolved: string[];
  /** entries that failed validation, with a human-readable reason. */
  skipped: Array<{ root: string; reason: string }>;
}

/**
 * Resolve each declared root through realpath() and validate it is an
 * existing directory. Invalid entries are collected in `skipped` rather
 * than aborting — the caller decides whether an empty `resolved` set is
 * fatal. This keeps a single stale FS_ROOTS entry (e.g. a mount target
 * that didn't get mounted) from crash-looping the whole server: the
 * valid roots still come up, the bad one is logged and dropped.
 */
export async function resolveRoots(
  declaredRoots: string[],
): Promise<ResolvedRoots> {
  const resolved: string[] = [];
  const skipped: Array<{ root: string; reason: string }> = [];
  for (const r of declaredRoots) {
    if (!path.isAbsolute(r)) {
      skipped.push({ root: r, reason: "not an absolute path" });
      continue;
    }
    let real: string;
    try {
      real = await fsp.realpath(r);
    } catch {
      skipped.push({ root: r, reason: "does not exist" });
      continue;
    }
    try {
      const st = await fsp.stat(real);
      if (!st.isDirectory()) {
        skipped.push({ root: r, reason: `not a directory (real: ${real})` });
        continue;
      }
    } catch {
      skipped.push({ root: r, reason: "does not exist" });
      continue;
    }
    if (!resolved.includes(real)) resolved.push(real);
  }
  return { resolved, skipped };
}

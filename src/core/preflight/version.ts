/** Minimal semver handling — enough to gate on a CLI version, no dependency. */

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

export function parseVersion(input: string): Semver | undefined {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(input.trim());
  if (!m) return undefined;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

/** Returns <0, 0, or >0 in the manner of a comparator. */
export function compareVersions(a: Semver, b: Semver): number {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  return a.patch - b.patch;
}

export function satisfiesMinimum(found: string, minimum: string): boolean {
  const f = parseVersion(found);
  const m = parseVersion(minimum);
  if (!f || !m) return false;
  return compareVersions(f, m) >= 0;
}

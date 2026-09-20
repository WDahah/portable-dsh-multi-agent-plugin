import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** Create a fixture directory under the *resolved* system temporary root.
 *
 * `os.tmpdir()` is a symlink on some platforms — notably macOS, where it sits under
 * `/var` -> `/private/var`. The journal deliberately refuses any path whose components
 * include a link, so fixtures built on the unresolved value fail with UNSAFE_JOURNAL_PATH
 * for a reason that has nothing to do with the behavior under test. Resolving here keeps
 * that protection intact in production while letting the suite run anywhere. */
export async function makeTempRoot(prefix) {
  const base = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(base, prefix));
}
/** Resolved system temporary root, for fixtures asserting their own cleanup location. */
export const resolvedTmpdir = () => fs.realpath(os.tmpdir());

import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** System temporary root with links and Windows 8.3 short names expanded.
 *
 * CI runners set TEMP to a short name such as `C:\Users\RUNNER~1\...`. `fs.realpath`
 * keeps that alias, and the governance path guards then refuse fixtures as aliased
 * (`M4_SETUP_PATH_ALIAS`, `PATH_MISSING`). The native resolver returns the long form. */
export const nativeTmpdir = () => realpathSync.native(os.tmpdir());

/** Create a fixture directory under the *resolved* system temporary root.
 *
 * `os.tmpdir()` is a symlink on some platforms — notably macOS, where it sits under
 * `/var` -> `/private/var`. The journal deliberately refuses any path whose components
 * include a link, so fixtures built on the unresolved value fail with UNSAFE_JOURNAL_PATH
 * for a reason that has nothing to do with the behavior under test. Resolving here keeps
 * that protection intact in production while letting the suite run anywhere. */
export async function makeTempRoot(prefix) {
  return fs.mkdtemp(path.join(nativeTmpdir(), prefix));
}
/** Resolved system temporary root, for fixtures asserting their own cleanup location. */
export const resolvedTmpdir = async () => nativeTmpdir();

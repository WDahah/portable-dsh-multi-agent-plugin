import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DEFAULT_BUNDLE_ROOT, assertNode} from './setup.mjs';

export const MANIFEST_FILENAME = 'portable-manifest.json';
export const MANIFEST_HELP = `Usage: node scripts/manifest.mjs [--check]
Regenerate ${MANIFEST_FILENAME} from the files actually present in this package.
With --check, report whether the committed manifest already matches and change nothing.
Integrity is not authenticity: regenerating after an unreviewed edit hides nothing from
a reader who trusts the source, but it does not make an unreviewed change trustworthy.`;

// Never list generated, machine-local, or transportable-state directories.
const EXCLUDED_ROOTS = new Set(['.local', '.git', 'node_modules', 'coverage', 'state']);
const EXCLUDED_NAMES = new Set([MANIFEST_FILENAME, '.DS_Store', 'Thumbs.db']);

/** Enumerate package-relative POSIX paths of every regular file, excluding generated trees. */
export async function listPackageFiles(root, current = root, found = []) {
  const entries = await fs.readdir(current, {withFileTypes: true});
  for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const absolute = path.join(current, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join('/');
    if (relative.split('/').some(part => EXCLUDED_ROOTS.has(part))) continue;
    if (EXCLUDED_NAMES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) throw new Error(`Refusing to list a symbolic link: ${relative}`);
    if (entry.isDirectory()) {await listPackageFiles(root, absolute, found); continue;}
    if (!entry.isFile()) throw new Error(`Refusing to list a non-regular file: ${relative}`);
    found.push(relative);
  }
  return found;
}
export async function buildManifest(bundleRoot = DEFAULT_BUNDLE_ROOT) {
  assertNode();
  const root = await fs.realpath(bundleRoot);
  const paths = (await listPackageFiles(root)).sort();
  if (!paths.length) throw new Error('Refusing to write an empty manifest.');
  const files = [];
  for (const relative of paths) {
    const sha256 = createHash('sha256').update(await fs.readFile(path.join(root, ...relative.split('/')))).digest('hex');
    files.push({path: relative, sha256});
  }
  return {schemaVersion: 1, files};
}
/** Compare byte-for-byte with the committed document so --check never rewrites it. */
export async function checkManifest(bundleRoot = DEFAULT_BUNDLE_ROOT) {
  const root = await fs.realpath(bundleRoot);
  const generated = serialize(await buildManifest(root));
  let committed;
  try {committed = await fs.readFile(path.join(root, MANIFEST_FILENAME), 'utf8');}
  catch (error) {if (error.code !== 'ENOENT') throw error; return {ok: false, reason: 'MISSING_MANIFEST'};}
  return committed === generated ? {ok: true} : {ok: false, reason: 'STALE_MANIFEST'};
}
const serialize = manifest => JSON.stringify(manifest, null, 2) + '\n';
export async function writeManifest(bundleRoot = DEFAULT_BUNDLE_ROOT) {
  const root = await fs.realpath(bundleRoot);
  const manifest = await buildManifest(root);
  await fs.writeFile(path.join(root, MANIFEST_FILENAME), serialize(manifest), 'utf8');
  return {written: MANIFEST_FILENAME, count: manifest.files.length};
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.some(a => a === '--help' || a === '-h')) {console.log(MANIFEST_HELP); return;}
  const check = argv.includes('--check');
  if (argv.some(a => a !== '--check')) throw new Error('Unknown manifest option.');
  if (check) {
    const result = await checkManifest();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) console.error('The committed manifest does not match these files. Run: node scripts/manifest.mjs');
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  console.log(JSON.stringify(await writeManifest(), null, 2));
  console.log('Regenerated. Review the diff and run node scripts/verify.mjs before committing.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {console.error(`Manifest failed: ${error.message}`); process.exitCode = 1;});

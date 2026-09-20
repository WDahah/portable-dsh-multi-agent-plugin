import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DEFAULT_BUNDLE_ROOT, assertNode} from './setup.mjs';

/** Integrity only, not authenticity: distribute the manifest over a trusted channel. */
export async function verify(bundleRoot = DEFAULT_BUNDLE_ROOT) {
  assertNode();
  if (typeof bundleRoot !== 'string' || !path.isAbsolute(bundleRoot)) throw new Error('Absolute bundleRoot required.');
  const root = await fs.realpath(bundleRoot), manifestPath = path.join(root, 'portable-manifest.json');
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid integrity manifest file.');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 10000) throw new Error('Invalid integrity manifest schema.');
  const seen = new Set(), failures = [];
  for (const entry of manifest.files) {
    const relative = entry?.path;
    if (typeof relative !== 'string' || !relative || relative.includes('\\') || relative.includes(':') || path.posix.isAbsolute(relative) || relative.split('/').some(p => !p || p === '.' || p === '..') || /^(?:\.local|state|node_modules)(?:\/|$)/.test(relative) || relative === 'portable-manifest.json' || seen.has(relative) || !/^[a-f0-9]{64}$/.test(entry?.sha256)) throw new Error('Unsafe, duplicate, excluded or invalid manifest entry.');
    seen.add(relative);
    let filename = root;
    for (const part of relative.split('/')) {
      filename = path.join(filename, part);
      const item = await fs.lstat(filename);
      if (item.isSymbolicLink()) throw new Error(`Manifest path contains a link: ${relative}`);
    }
    if (!(await fs.stat(filename)).isFile()) throw new Error(`Manifest path is not a regular file: ${relative}`);
    const actual = createHash('sha256').update(await fs.readFile(filename)).digest('hex');
    if (actual !== entry.sha256) failures.push(relative);
  }
  return {ok: failures.length === 0, checked: seen.size, failures, authenticityVerified: false, unlistedFilesChecked: false};
}
export async function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {console.log('Usage: node scripts/verify.mjs\nVerify listed portable-manifest.json SHA-256 hashes. Integrity is not authenticity; unlisted files are not checked.'); return;}
  if (argv.length) throw new Error('Unknown verify option.');
  const result = await verify(); console.log(JSON.stringify(result, null, 2)); process.exitCode = result.ok ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {console.error(`Verification failed: ${error.message}`); process.exitCode = 1;});

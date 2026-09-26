import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DEFAULT_BUNDLE_ROOT, assertNode} from './setup.mjs';

export const I18N_RECORD_SUFFIX = '.i18n.yaml';
export const I18N_HELP = `Usage: node scripts/i18n.mjs [--check]
Regenerate the ${I18N_RECORD_SUFFIX} bilingual-pair records from the files actually present.
With --check, report whether every committed record still matches and change nothing.
Both languages carry equal authority: edit one side, bring the other along, then re-record.`;

/**
 * Every bilingual pair this package ships, each pairing a canonical English document with its
 * Chinese counterpart. The English side stays canonical for tooling: the tests that read shipped
 * prose read the English files, so a translation can never silently change what they assert.
 */
export const PAIRS = Object.freeze([
  {english: 'README.md', chinese: 'README.zh.md'},
  {english: 'START-HERE.md', chinese: 'START-HERE.zh.md'},
  {english: 'INSTALL-WITH-AI.md', chinese: 'INSTALL-WITH-AI.zh.md'},
  {english: 'docs/SECURITY-AND-LIMITS.md', chinese: 'docs/SECURITY-AND-LIMITS.zh.md'},
  {english: 'docs/USAGE.md', chinese: 'docs/USAGE.zh.md'}
]);

/** The record that sits beside one pair's English document. */
export function recordPathFor(english) {
  return english.replace(/\.md$/, I18N_RECORD_SUFFIX);
}

/**
 * Git's own blob hash for one file's bytes. Using git's algorithm rather than a fresh one keeps
 * the record meaningful to anyone reading the repository, and hashing bytes rather than decoded
 * text keeps a checkout's line-ending policy visible instead of silently normalized away.
 * @param contents - the file's exact bytes.
 * @returns the 40-character hex SHA-1 git records for that blob.
 */
export function blobHash(contents) {
  return createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${contents.length}\0`, 'utf8'), contents])).digest('hex');
}

const header = pair => `# Bilingual-pair consistency record: the git blob hash of each side as of the last
# confirmed-consistent state. Both languages carry equal authority; after editing either
# side, bring the other along and re-record with:
#   node scripts/i18n.mjs
`;

/**
 * Read both sides of one pair and render its record.
 * @param root - the resolved package root.
 * @param pair - the English and Chinese paths of one pair.
 * @returns the record path and its exact text.
 * @throws when either side is missing, because a pair with one side is not a pair.
 */
export async function buildRecord(root, pair) {
  const read = async relative => {
    try {return await fs.readFile(path.join(root, ...relative.split('/')));}
    catch (error) {
      if (error.code === 'ENOENT') throw new Error(`Bilingual pair is incomplete: ${relative} is missing.`);
      throw error;
    }
  };
  const [english, chinese] = [await read(pair.english), await read(pair.chinese)];
  return {path: recordPathFor(pair.english), text: `${header(pair)}${pair.english}: ${blobHash(english)}\n${pair.chinese}: ${blobHash(chinese)}\n`};
}

/** Every pair's record, in PAIRS order. */
export async function buildRecords(bundleRoot = DEFAULT_BUNDLE_ROOT) {
  assertNode();
  const root = await fs.realpath(bundleRoot);
  const records = [];
  for (const pair of PAIRS) records.push(await buildRecord(root, pair));
  return records;
}

/**
 * Compare every committed record with a freshly built one, so --check never rewrites a file.
 * @param bundleRoot - the package root; defaults to the resolved bundle.
 * @returns the per-pair verdict and whether every pair is recorded and fresh.
 */
export async function checkRecords(bundleRoot = DEFAULT_BUNDLE_ROOT) {
  assertNode();
  const root = await fs.realpath(bundleRoot);
  const pairs = [];
  for (const pair of PAIRS) {
    const recordPath = recordPathFor(pair.english);
    let expected;
    try {expected = await buildRecord(root, pair);}
    catch (error) {pairs.push({pair: pair.english, ok: false, reason: 'MISSING_SIDE', detail: error.message}); continue;}
    let committed;
    try {committed = await fs.readFile(path.join(root, ...recordPath.split('/')), 'utf8');}
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      pairs.push({pair: pair.english, ok: false, reason: 'MISSING_RECORD'});
      continue;
    }
    pairs.push(committed === expected.text ? {pair: pair.english, ok: true} : {pair: pair.english, ok: false, reason: 'STALE_RECORD'});
  }
  return {ok: pairs.every(entry => entry.ok), pairs};
}

/** Rewrite every record from what is on disk. */
export async function writeRecords(bundleRoot = DEFAULT_BUNDLE_ROOT) {
  const records = await buildRecords(bundleRoot);
  const root = await fs.realpath(bundleRoot);
  for (const record of records) await fs.writeFile(path.join(root, ...record.path.split('/')), record.text, 'utf8');
  return {written: records.map(record => record.path), count: records.length};
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.some(a => a === '--help' || a === '-h')) {console.log(I18N_HELP); return;}
  const check = argv.includes('--check');
  if (argv.some(a => a !== '--check')) throw new Error('Unknown i18n option.');
  if (check) {
    const result = await checkRecords();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) console.error('A bilingual pair is unrecorded, incomplete or stale. Run: node scripts/i18n.mjs');
    process.exitCode = result.ok ? 0 : 1;
    return;
  }
  console.log(JSON.stringify(await writeRecords(), null, 2));
  console.log('Re-recorded. Review the diff before committing.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {console.error(`i18n failed: ${error.message}`); process.exitCode = 1;});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {PAIRS, checkRecords, recordPathFor} from '../scripts/i18n.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFile(path.join(root, ...relative.split('/')), 'utf8');
const basename = relative => path.posix.basename(relative);
// Command blocks are instruction a reader executes, so they travel whole and untranslated, info
// string included — a translated shell command is broken instruction. A `text` block is prose to
// read instead: it is a prompt or a sample, and translating it is the point of the pair. The
// demo test treats sh/bash/console/shell blocks as executable for the same reason.
const COMMAND_INFO = /^(sh|bash|console|shell|pwsh|zsh)\b/;
const commandBlocks = text => [...text.matchAll(/```([^\n]*)\n[\s\S]*?```/g)]
  .filter(match => COMMAND_INFO.test(match[1].trim()))
  .map(match => match[0]);
const toolNames = text => [...new Set([...text.matchAll(/orchestrator_[a-z0-9_]+/g)].map(match => match[0]))].sort();

test('every bilingual pair ships both sides and a fresh record', async () => {
  const result = await checkRecords(root);
  assert.deepEqual(result.pairs.filter(entry => !entry.ok), [], 'a pair is unrecorded, incomplete or stale — run node scripts/i18n.mjs');
  assert.ok(result.ok);
});

test('each side links to its counterpart in the first lines', async () => {
  for (const pair of PAIRS) {
    const [english, chinese] = [await read(pair.english), await read(pair.chinese)];
    assert.ok(english.split('\n').slice(0, 5).some(line => line.includes(`](${basename(pair.chinese)})`)),
      `${pair.english} does not link to ${basename(pair.chinese)} near its heading`);
    assert.ok(chinese.split('\n').slice(0, 5).some(line => line.includes(`](${basename(pair.english)})`)),
      `${pair.chinese} does not link back to ${basename(pair.english)} near its heading`);
  }
});

test('a translation carries every command block through unchanged', async () => {
  for (const pair of PAIRS) {
    const [english, chinese] = [commandBlocks(await read(pair.english)), commandBlocks(await read(pair.chinese))];
    assert.deepEqual(chinese, english, `${pair.chinese} changed a command block; commands, paths and flags stay in English`);
  }
});

test('tool names are identifiers a translation may not rename', async () => {
  // A renamed tool is a broken instruction: the reader would call something that does not exist.
  for (const pair of PAIRS) {
    const [english, chinese] = [toolNames(await read(pair.english)), toolNames(await read(pair.chinese))];
    assert.deepEqual(chinese, english, `${pair.chinese} does not carry exactly the same orchestrator_* names as ${pair.english}`);
  }
});

test('the pairing records are enumerable and named for their documents', () => {
  for (const pair of PAIRS) {
    assert.ok(pair.english.endsWith('.md') && pair.chinese.endsWith('.zh.md'), `${pair.english} is not an English/Chinese md pair`);
    assert.equal(recordPathFor(pair.english), pair.english.replace(/\.md$/, '.i18n.yaml'));
  }
});

test('a Chinese document links to the Chinese side of every pair it references', async () => {
  // A reader who chose Chinese should not be sent back to English for a document that has a
  // Chinese side. Documents without one — GOVERNANCE, BENCHMARK, ARCHITECTURE, DESIGN-NOTES —
  // stay reachable through their English path, which is the point of pairing only some of them.
  for (const pair of PAIRS) {
    const directory = path.posix.dirname(pair.chinese);
    // Line 3 is the switcher, whose whole job is to link back to the English side.
    const body = (await read(pair.chinese)).split('\n').filter((_, index) => index !== 2).join('\n');
    for (const other of PAIRS) {
      const englishTarget = path.posix.relative(directory, other.english);
      assert.equal(body.includes(`](${englishTarget})`), false,
        `${pair.chinese} links to the English ${other.english}; point at ${other.chinese} instead`);
      assert.equal(body.includes(`](${englishTarget}#`), false,
        `${pair.chinese} links into an anchor on the English ${other.english}`);
    }
  }
});

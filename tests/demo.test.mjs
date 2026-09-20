// The demo is the first thing a stranger runs, so CI has to keep it honest. These cases
// check that it executes, stays truthful about being synthetic, and keeps demonstrating
// the refusals it claims to demonstrate.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const run = promisify(execFile);
const demo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'demo.mjs');
// NO_COLOR keeps assertions about text from tripping over escape codes.
const exec = async (...args) => (await run(process.execPath, [demo, ...args], {env: {...process.env, NO_COLOR: '1'}})).stdout;

test('the demo runs to completion with no host, network or dependencies', async () => {
  const output = await exec();
  assert.match(output, /routing and verdict logic, no host required/);
  // Every scene is reached, so a throw halfway through fails the test rather than
  // producing a shorter demo nobody notices.
  for (const heading of ['A role names routing', 'A refusal tells you what to run next',
    'Evidence expires', 'A review avoids the model it is judging', 'A verdict is declared',
    'The objective travels as data', 'Old identifiers keep working']) {
    assert.ok(output.includes(heading), `missing scene: ${heading}`);
  }
});
test('the demo says its evidence is synthetic rather than implying real probes ran', async () => {
  const output = await exec();
  assert.match(output, /Only the qualification evidence is synthetic/);
  // The closing lines must keep the limits visible, since the demo is where most readers
  // form their impression of what this does.
  assert.match(output, /Whether the work is any good stays a judgement/);
  assert.match(output, /needs a DSH\/Cordis host/);
});
test('the demo actually demonstrates refusals, not only successes', async () => {
  const output = await exec();
  for (const refusal of ['MISSING_EXACT_QUALIFICATION', 'EXPIRED_QUALIFICATION',
    'UNAVAILABLE_AT_PROBE', 'AMBIGUOUS_LATEST_QUALIFICATION', 'INVALID_INPUT',
    'VERDICT_UNREADABLE', 'UNCONVERGED']) {
    assert.ok(output.includes(refusal), `demo no longer shows ${refusal}`);
  }
  // A refusal without its remedy would be exactly the vagueness the plugin avoids.
  assert.match(output, /orchestrator_qualify \{"route_id"/);
});
test('the demo shows an independent review and an honest non-independent one', async () => {
  const output = await exec('diversity');
  assert.match(output, /avoiding codex\s+-> claude\//);
  assert.match(output, /independent=yes/);
  // The unavoidable case has to stay visible: it is the honest half of the feature.
  assert.match(output, /independent=no/);
  assert.match(output, /NO_QUALIFIED_ALTERNATIVE_PROVIDER/);
  assert.match(output, /REVIEW_SHARES_PROVIDER_WITH_SUBJECT/);
});
test('the demo refuses prose and invented verdict states', async () => {
  const output = await exec('verdicts');
  const lines = output.split('\n');
  for (const label of ['prose', 'invented state', 'missing onObjective', 'empty summary']) {
    const line = lines.find(l => l.trim().startsWith(label));
    assert.ok(line, `missing case: ${label}`);
    assert.match(line, /refused/, `${label} was accepted`);
  }
});
test('a named scene runs alone and an unknown one fails loudly', async () => {
  const output = await exec('routing');
  assert.ok(output.includes('A role names routing'));
  assert.equal(output.includes('A verdict is declared'), false);
  await assert.rejects(exec('not-a-scene'), error => {
    assert.equal(error.code, 1);
    assert.match(error.stderr, /Unknown scene/);
    return true;
  });
});
test('the quickstart commands parse in every common shell', async () => {
  // `&&` is a parse error in Windows PowerShell, still the default shell on Windows, and
  // the quickstart is the first command a stranger runs. A shipped one-liner failed there
  // because it had only ever been tried in pwsh 7, so the shell-agnostic form is enforced.
  const fs = await import('node:fs/promises');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  for (const file of ['README.md', path.join('docs', 'DESIGN-NOTES.md')]) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    for (const block of text.matchAll(/```(?:sh|bash|console|shell)\n([\s\S]*?)```/g)) {
      assert.equal(block[1].includes('&&'), false,
        `${file} has a shell block using && — it will not parse in Windows PowerShell`);
    }
  }
});
test('the demo is tidy enough to paste into a bug report or a post', async () => {
  // This output is the first thing most readers see, and ragged formatting undercuts a
  // project whose argument is that it is careful about detail.
  const output = await exec();
  const lines = output.split('\n');
  assert.deepEqual(lines.filter(line => /\s$/.test(line)), [], 'trailing whitespace');
  assert.equal(/\n\n\n/.test(output), false, 'stacked blank lines');
  // Columns that pad to a fixed width silently misalign when a longer case is added.
  const columns = lines.filter(line => line.includes(' -> ')).map(line => line.indexOf(' -> '));
  for (const group of [columns.slice(0, 5)]) {
    assert.equal(new Set(group).size, 1, 'the role table lost its column alignment');
  }
  const overrides = lines.filter(line => line.trim().startsWith('standard + '));
  assert.equal(overrides.length, 3);
  assert.equal(new Set(overrides.map(line => line.indexOf(' -> '))).size, 1,
    'the override table lost its column alignment');
});
test('output is clean when piped, so it can be pasted or logged', async () => {
  // execFile gives a non-TTY stdout, which is the condition colour must switch off under.
  const output = (await run(process.execPath, [demo], {env: {...process.env, NO_COLOR: ''}})).stdout;
  assert.equal(/\u001b\[/.test(output), false, 'ANSI escapes leaked into piped output');
});

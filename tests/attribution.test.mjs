// Route attribution fixtures: which exact model produced which round, and what a record
// written before per-round routes existed reports. No provider calls.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeTempRoot} from './helpers/tmp.mjs';
import {createAgentDispatcher, routeLabel} from '../src/agent-dispatch.mjs';
import {createTaskEngine} from '../src/engine.mjs';
import {createJournal, diskId} from '../src/journal.mjs';

const root = await makeTempRoot('portable-attribution-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'attribution-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const route = {provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', maxTokens: 256, costRates: null};
const streaming = text => ({async prepareCall(config) {return {config, stream: async function* () {
  yield {type: 'text-delta', text};
  yield {type: 'usage', usage: {inputTokens: 5, outputTokens: 2, totalTokens: 7}};
  yield {type: 'finish', reason: {kind: 'stop'}};
}};}});

test('child labels name the exact route so two models are distinguishable', async () => {
  const labels = [];
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start(_name, request) {
    labels.push(request.label);
    return {id: 'child-' + labels.length, result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'ok'}]}), async dispose() {}};
  }})});
  await dispatcher.delegate({run_id: 'labelled', prompt: 'x', role: 'R04'}, {provider: 'codex', model: 'gpt-5.6-terra'}, 'medium', exec());
  assert.equal(labels[0], 'R04 · codex/gpt-5.6-terra · medium · round 1');
  // The label must separate two children that differ only by model.
  assert.notEqual(routeLabel('R04', {provider: 'claude', model: 'claude-opus-5'}, 'high', 1), labels[0]);
  assert.match(routeLabel(undefined, {provider: 'codex', model: 'gpt-5.6-luna'}, 'medium', 2), /^task · codex\/gpt-5\.6-luna · medium · round 2$/);
  dispatcher.dispose();
});
test('every delegated round reports the exact model that produced it', async () => {
  let calls = 0;
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    calls++;
    return {id: 'child-' + calls, result: Promise.resolve({stopReason: calls === 1 ? 'max-tokens' : 'completed', output: [{type: 'text', text: 'part' + calls}]}), async dispose() {}};
  }})});
  const result = await dispatcher.delegate({run_id: 'rounds', prompt: 'x', role: 'R04', max_rounds: 2}, {provider: 'claude', model: 'claude-opus-5'}, 'high', exec());
  assert.equal(result.rounds.length, 2);
  for (const round of result.rounds) {
    assert.equal(round.model, 'claude-opus-5');
    assert.equal(round.provider, 'claude');
    assert.equal(round.effort, 'high');
    assert.equal(round.route_recorded_per_round, true);
    assert.ok(round.child_id, 'each round still names its child');
  }
  // Reading back a saved assignment keeps the same attribution.
  const reread = await dispatcher.read('rounds');
  assert.deepEqual(reread.rounds.map(r => r.model), ['claude-opus-5', 'claude-opus-5']);
  dispatcher.dispose();
});
test('direct task view exposes its route at the task and the round', async () => {
  const engine = createTaskEngine({root: fresh(), owner, getLlm: () => streaming('answer')});
  await engine.plan({task_id: 'direct', prompt: 'x', route});
  const result = await engine.run('direct', exec());
  assert.equal(result.status, 'COMPLETED');
  assert.deepEqual(result.route, {provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', maxTokens: 256});
  assert.equal(result.rounds[0].model, 'gpt-5.6-terra');
  assert.equal(result.rounds[0].effort, 'medium');
  assert.equal(result.rounds[0].routeRecordedPerRound, true);
});
test('a round written before per-round routes still loads and says so', async () => {
  const directory = fresh();
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('legacy output')});
  await engine.plan({task_id: 'legacy', prompt: 'x', route});
  await engine.run('legacy', exec());
  // Rewrite the stored round without its route, exactly as an older build wrote it.
  const journal = createJournal(directory, diskId(owner));
  const stored = await journal.load(diskId('legacy'));
  const file = path.join(directory, diskId(owner), diskId('legacy'), String(stored.revision).padStart(8, '0') + '.json');
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const round of document.record.rounds) delete round.route;
  const {createHash} = await import('node:crypto');
  document.sha256 = createHash('sha256').update(JSON.stringify(document.record), 'utf8').digest('hex');
  await fs.writeFile(file, JSON.stringify(document), 'utf8');
  const reopened = createTaskEngine({root: directory, owner, getLlm: () => null});
  const view = await reopened.read('legacy');
  assert.equal(view.status, 'COMPLETED');
  assert.equal(view.text, 'legacy output');
  // Falls back to the task route and reports that the round itself carried none.
  assert.equal(view.rounds[0].model, 'gpt-5.6-terra');
  assert.equal(view.rounds[0].routeRecordedPerRound, false);
});
test('a round route disagreeing with the task route is refused', async () => {
  const directory = fresh();
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('text')});
  await engine.plan({task_id: 'forged', prompt: 'x', route});
  await engine.run('forged', exec());
  const journal = createJournal(directory, diskId(owner));
  const stored = await journal.load(diskId('forged'));
  const file = path.join(directory, diskId(owner), diskId('forged'), String(stored.revision).padStart(8, '0') + '.json');
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.record.rounds[0].route.model = 'claude-opus-5';
  const {createHash} = await import('node:crypto');
  document.sha256 = createHash('sha256').update(JSON.stringify(document.record), 'utf8').digest('hex');
  await fs.writeFile(file, JSON.stringify(document), 'utf8');
  // Even with a recomputed checksum, the route must match the planned request.
  const reopened = createTaskEngine({root: directory, owner, getLlm: () => null});
  await assert.rejects(reopened.read('forged'), error => error.code === 'CORRUPT');
});
test('an unknown key on a round is still refused', async () => {
  const directory = fresh();
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('text')});
  await engine.plan({task_id: 'extra', prompt: 'x', route});
  await engine.run('extra', exec());
  const journal = createJournal(directory, diskId(owner));
  const stored = await journal.load(diskId('extra'));
  const file = path.join(directory, diskId(owner), diskId('extra'), String(stored.revision).padStart(8, '0') + '.json');
  const document = JSON.parse(await fs.readFile(file, 'utf8'));
  document.record.rounds[0].smuggled = 'value';
  const {createHash} = await import('node:crypto');
  document.sha256 = createHash('sha256').update(JSON.stringify(document.record), 'utf8').digest('hex');
  await fs.writeFile(file, JSON.stringify(document), 'utf8');
  const reopened = createTaskEngine({root: directory, owner, getLlm: () => null});
  await assert.rejects(reopened.read('extra'), error => error.code === 'CORRUPT');
});

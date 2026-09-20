// Listing and deletion fixtures. Records are created through the ordinary code paths, so
// a passing case reflects real stored state rather than hand-written files.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeTempRoot} from './helpers/tmp.mjs';
import {createPlugin} from '../src/plugin.mjs';
import {createAgentDispatcher} from '../src/agent-dispatch.mjs';
import {createTaskEngine} from '../src/engine.mjs';
import {createQualificationManager, BUILD_ID, keyOf, createRecordStore} from '../src/qualification.mjs';
import {createHash} from 'node:crypto';

const root = await makeTempRoot('portable-state-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'state-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const route = {provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', maxTokens: 256, costRates: null};
const child = text => ({async start() {return {id: 'child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text}]}), async dispose() {}};}});
const streaming = text => ({async prepareCall(config) {return {config, stream: async function* () {
  yield {type: 'text-delta', text};
  yield {type: 'usage', usage: {inputTokens: 5, outputTokens: 2, totalTokens: 7}};
  yield {type: 'finish', reason: {kind: 'stop'}};
}};}});

test('assignments list newest first and carry their route and prompt', async () => {
  const directory = fresh();
  const dispatcher = createAgentDispatcher({root: directory, owner, getSubagents: () => child('done')});
  await dispatcher.delegate({run_id: 'older', prompt: 'first request', role: 'R04'}, {provider: 'codex', model: 'gpt-5.6-terra'}, 'medium', exec());
  await dispatcher.delegate({run_id: 'newer', prompt: 'second request', role: 'R07'}, {provider: 'claude', model: 'claude-opus-5'}, 'high', exec());
  const listed = await dispatcher.list();
  assert.deepEqual(listed.map(entry => entry.run_id), ['newer', 'older']);
  assert.equal(listed[0].model, 'claude-opus-5');
  assert.equal(listed[0].state, 'COMPLETED');
  // The listing is a summary: saved output text is not replayed into it.
  assert.equal(Object.hasOwn(listed[0], 'text'), false);
  // The original request is recoverable from the read view.
  assert.equal((await dispatcher.read('older')).prompt, 'first request');
  dispatcher.dispose();
});
test('forgetting an assignment removes only that record', async () => {
  const directory = fresh();
  const dispatcher = createAgentDispatcher({root: directory, owner, getSubagents: () => child('done')});
  await dispatcher.delegate({run_id: 'keep', prompt: 'x'}, route, 'medium', exec());
  await dispatcher.delegate({run_id: 'drop', prompt: 'y'}, route, 'medium', exec());
  assert.deepEqual((await dispatcher.forget('drop')), {run_id: 'drop', removed: true, forced: false});
  assert.deepEqual((await dispatcher.list()).map(e => e.run_id), ['keep']);
  await assert.rejects(dispatcher.read('drop'), error => error.code === 'UNKNOWN_ASSIGNMENT');
  await assert.rejects(dispatcher.forget('drop'), error => error.code === 'UNKNOWN_ASSIGNMENT');
  // A forgotten id is free again, so deletion is not a tombstone.
  const reused = await dispatcher.delegate({run_id: 'drop', prompt: 'z'}, route, 'medium', exec());
  assert.equal(reused.state, 'COMPLETED');
  dispatcher.dispose();
});
test('a delegation in flight cannot be deleted beneath itself', async () => {
  const directory = fresh();
  let release;
  const held = new Promise(resolve => {release = resolve;});
  const dispatcher = createAgentDispatcher({root: directory, owner, getSubagents: () => ({async start() {
    return {id: 'slow', result: held.then(() => ({stopReason: 'completed', output: [{type: 'text', text: 'late'}]})), async dispose() {}};
  }})});
  const running = dispatcher.delegate({run_id: 'busy', prompt: 'x'}, route, 'medium', exec());
  await assert.rejects(dispatcher.forget('busy'), error => error.code === 'DELEGATION_BUSY');
  release();
  assert.equal((await running).state, 'COMPLETED');
  assert.deepEqual(await dispatcher.forget('busy'), {run_id: 'busy', removed: true, forced: false});
  dispatcher.dispose();
});
test('direct tasks list with their readable id, route and resumability', async () => {
  const directory = fresh();
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('answer')});
  await engine.plan({task_id: 'listed-task', prompt: 'the original question', route});
  await engine.run('listed-task', exec());
  const listed = await engine.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].task_id, 'listed-task');
  assert.equal(listed[0].status, 'COMPLETED');
  assert.equal(listed[0].model, 'gpt-5.6-terra');
  assert.equal(listed[0].resumable, false);
  // The prompt is recoverable from the saved task, not only the answer.
  assert.equal((await engine.read('listed-task')).prompt, 'the original question');
  // A fresh engine over the same directory still resolves the readable id.
  assert.equal((await createTaskEngine({root: directory, owner, getLlm: () => null}).list())[0].task_id, 'listed-task');
});
test('forgetting a task removes it and frees its id', async () => {
  const directory = fresh();
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('answer')});
  await engine.plan({task_id: 'temporary', prompt: 'x', route});
  await engine.run('temporary', exec());
  assert.deepEqual(await engine.forget('temporary'), {task_id: 'temporary', removed: true});
  assert.deepEqual(await engine.list(), []);
  await assert.rejects(engine.read('temporary'), error => error.code === 'UNKNOWN_TASK');
  await assert.rejects(engine.forget('temporary'), error => error.code === 'UNKNOWN_TASK');
  // Planning the same id again must succeed, proving no stale in-memory copy survived.
  await engine.plan({task_id: 'temporary', prompt: 'second life', route});
  assert.equal((await engine.read('temporary')).status, 'PLANNED');
});
test('a task listed without a known id is reported, never hidden', async () => {
  const directory = fresh();
  const engine = createTaskEngine({root: directory, owner, getLlm: () => streaming('answer')});
  await engine.plan({task_id: 'orphan', prompt: 'x', route});
  // Remove the lookup hint only; the record itself stays.
  const {diskId} = await import('../src/journal.mjs');
  await fs.rm(path.join(directory, diskId(owner), 'task-index.json'), {force: true});
  const listed = await createTaskEngine({root: directory, owner, getLlm: () => null}).list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].task_id, null);
  assert.match(listed[0].digest, /^x[a-f0-9]{63}$/);
  assert.equal(listed[0].status, 'PLANNED');
});
test('expired qualifications are pruned while live evidence is kept', async () => {
  const directory = fresh();
  const store = createRecordStore(directory, owner, 'qualifications');
  const now = 5_000_000;
  const record = (model, expiresAt) => ({schemaVersion: 1, qualificationType: 'smoke',
    issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'r'}, runtimeBuildId: BUILD_ID,
    adapterFingerprint: createHash('sha256').update('codex\0' + model + '\0' + BUILD_ID).digest('hex'),
    provider: 'codex', model, effort: 'medium', issuedAt: now - 1000, expiresAt,
    durationMs: 5, available: true, transportPassed: true, textPassed: true, toolPassed: true, imagePassed: false,
    caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}],
    allowedDataClasses: ['public', 'internal'], domainEvidence: false, attestation: null});
  await store.save(keyOf('codex\0stale\0medium'), record('stale', now - 1), 0);
  await store.save(keyOf('codex\0live\0medium'), record('live', now + 86400000), 0);
  const manager = createQualificationManager({root: directory, owner, clock: () => now, getLlm: () => null, getSubagents: () => null});
  assert.equal((await manager.list()).length, 2);
  const pruned = await manager.forget();
  assert.equal(pruned.count, 1);
  assert.equal(pruned.removed[0].model, 'stale');
  assert.equal(pruned.removed[0].expired, true);
  assert.deepEqual((await manager.list()).map(r => r.model), ['live']);
  // An exact route removes live evidence too, when that is what the caller asked for.
  assert.equal((await manager.forget({route: {provider: 'codex', model: 'live'}})).count, 1);
  assert.deepEqual(await manager.list(), []);
  manager.dispose();
});
test('forget refuses an ambiguous or empty target before touching storage', async t => {
  const definitions = new Map();
  const ctx = {tools: {register(d) {definitions.set(d.name, d); return () => definitions.delete(d.name);}},
    get: () => undefined, effect(fn) {const release = fn(); t.after(() => release?.()); return release;}};
  createPlugin(d => d).apply(ctx, {stateRoot: fresh(), enabled: true});
  const forget = definitions.get('orchestrator_forget');
  for (const args of [{}, {run_id: 'a', task_id: 'b'}]) {
    const result = await forget.execute(args, exec());
    assert.equal(result.reason, 'SPECIFY_EXACTLY_ONE_TARGET');
  }
  assert.equal((await forget.execute({qualifications: 'everything'}, exec())).reason, 'QUALIFICATIONS_EXPIRED_OR_ALL');
  assert.equal((await definitions.get('orchestrator_list').execute({kind: 'invented'}, exec())).reason, 'UNKNOWN_LIST_KIND');
});
test('list reports each kind and stays empty for a fresh owner', async t => {
  const definitions = new Map();
  const ctx = {tools: {register(d) {definitions.set(d.name, d); return () => definitions.delete(d.name);}},
    get: () => undefined, effect(fn) {const release = fn(); t.after(() => release?.()); return release;}};
  createPlugin(d => d).apply(ctx, {stateRoot: fresh(), enabled: true});
  const listed = await definitions.get('orchestrator_list').execute({}, exec());
  assert.equal(listed.kind, 'all');
  assert.deepEqual(listed.assignments, []);
  assert.deepEqual(listed.tasks, []);
  assert.deepEqual(listed.qualifications, []);
  const only = await definitions.get('orchestrator_list').execute({kind: 'tasks'}, exec());
  assert.equal(Object.hasOwn(only, 'assignments'), false);
});

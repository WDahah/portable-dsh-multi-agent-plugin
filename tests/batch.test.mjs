import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {makeTempRoot} from './helpers/tmp.mjs';
import {createBatchRunner} from '../src/batch.mjs';
import {createAgentDispatcher} from '../src/agent-dispatch.mjs';
import {BUILD_ID, createRecordStore, keyOf} from '../src/qualification.mjs';
import {createPlugin} from '../src/plugin.mjs';
import {ROUTES, expectedEffort} from '../src/routes.mjs';
import {parseWorkerResult, WORKER_RESULT_SCHEMA} from '../src/worker-result.mjs';

const owner = 'batch-owner';
const exec = signal => ({agent: {id: owner}, signal: signal ?? new AbortController().signal});
const deferred = () => {let resolve; const promise = new Promise(r => {resolve = r;}); return {promise, resolve};};
const metadata = {role: 'standard', category: 'code-inspection', risk: 'low', complexity: 'routine', escalate: false, dataClass: 'public'};
const request = (batch_id = 'inspect', n = 3) => ({batch_id, brief: 'Inspect only. Return evidence, not edits.', tasks: Array.from({length: n}, (_, i) => ({
  id: `task${i}`, scope: `src/module${i}.mjs`, prompt: `Inspect module ${i} only.`, task: {...metadata},
}))});
const findings = overrides => ({status: 'complete', summary: 'Inspected the assigned scope.', findings: [{detail: 'Evidence found.', evidence: 'src/example.mjs:1'}], uncertainties: [], ...overrides});
function evidence() {
  const route = ROUTES.find(r => r.id === 'codex-terra');
  return [{schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'SYNTHETIC'},
    runtimeBuildId: 'fixture', adapterFingerprint: 'fixture', provider: route.provider, model: route.model,
    effort: expectedEffort(route, 'balanced'), issuedAt: Date.now() - 1000, expiresAt: Date.now() + 3600000,
    durationMs: 1, available: true, transportPassed: true, textPassed: true, toolPassed: true, imagePassed: false,
    domainEvidence: false, allowedDataClasses: ['public'], caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}]}];
}
async function fixture(t, start, release = () => {}) {
  const root = await makeTempRoot('portable-batch-test-');
  const agents = createAgentDispatcher({root, owner, getSubagents: () => ({start})});
  const batches = createBatchRunner({root, owner, agents, qualifications: {list: async () => evidence()}});
  t.after(async () => {const drained = batches.dispose(); release(); await agents.dispose(); await drained; await fs.rm(root, {recursive: true, force: true});});
  return {root, agents, batches};
}

test('batch findings reject oversized, contradictory and unstructured output without truncation', () => {
  assert.deepEqual(parseWorkerResult({structured: findings()}), findings());
  assert.deepEqual(parseWorkerResult({output: JSON.stringify(findings())}), findings());
  for (const candidate of [findings({summary: 'x'.repeat(301)}), findings({findings: Array(6).fill({detail: 'd', evidence: 'e'})}),
    findings({uncertainties: ['Unresolved']}), findings({status: 'needs-clarification'}), {...findings(), extra: true}]) {
    assert.equal(parseWorkerResult({structured: candidate}), null);
  }
  assert.equal(parseWorkerResult({output: 'Looks good.'}), null);
});

test('two workers overlap, a third waits for disposal, and results remain in request order', async t => {
  const firstTwo = deferred(), third = deferred(), disposal = deferred(), disposing = deferred();
  const gates = [deferred(), deferred(), deferred()];
  const seen = []; let active = 0, peak = 0;
  const {root, agents, batches} = await fixture(t, async (_name, input) => {
    const i = seen.length; seen.push(input); active++; peak = Math.max(peak, active);
    assert.deepEqual(input.toolFilter.allow, ['read', 'glob', 'grep']);
    assert.deepEqual(input.outputSchema, WORKER_RESULT_SCHEMA);
    const intent = await createRecordStore(root, owner, 'batches').read(keyOf('inspect'));
    assert.equal(intent.data.state, 'RUNNING');
    if (i === 1) firstTwo.resolve();
    if (i === 2) third.resolve();
    return {id: `child${i}`, result: gates[i].promise,
      async dispose() {if (i === 0) {disposing.resolve(); await disposal.promise;} active--;}};
  }, () => {gates.forEach(g => g.resolve({stopReason: 'aborted', output: []})); disposal.resolve();});
  const running = batches.run(request(), exec());
  await firstTwo.promise;
  assert.equal(seen.length, 2);
  await assert.rejects(batches.run(request('other'), exec()), {code: 'BATCH_BUSY'});
  await assert.rejects(batches.forget('inspect'), {code: 'BATCH_BUSY'});
  gates[0].resolve({stopReason: 'completed', structured: findings(), output: []});
  await disposing.promise;
  await agents.read('b7-inspect-task0');
  assert.equal(seen.length, 2);
  disposal.resolve();
  await third.promise;
  gates[2].resolve({stopReason: 'completed', structured: findings(), output: []});
  gates[1].resolve({stopReason: 'completed', structured: findings(), output: []});
  const result = await running;
  assert.equal(peak, 2); assert.equal(active, 0);
  assert.equal(result.state, 'COMPLETED');
  assert.deepEqual(result.tasks.map(r => r.id), ['task0', 'task1', 'task2']);
  assert.ok(result.tasks.every(r => r.round_commitments === 1 && r.summary));
  assert.equal(result.accounting.recorded_round_commitments, 3);
  assert.equal(result.accounting.model_calls, null); assert.equal(result.accounting.usage, null);
  assert.equal(result.accounting.usage_complete, false); assert.equal(result.accounting.scheduling_model_calls, 0);
  const summary = await batches.read('inspect');
  assert.ok(summary.tasks.every(r => !Object.hasOwn(r, 'result')));
  assert.ok(!Object.hasOwn(summary, 'brief'));
  assert.equal((await batches.read('inspect', true)).tasks[0].result.status, 'complete');
  await assert.rejects(batches.run(request(), exec()), {code: 'BATCH_ALREADY_EXISTS'});
  assert.equal(seen.length, 3);
});

test('invalid batches refuse before dispatch; independent partial failures do not retry', async t => {
  let calls = 0;
  const {batches} = await fixture(t, async () => {
    const index = calls++;
    return {id: `c${index}`, result: Promise.resolve(index === 0
      ? {stopReason: 'completed', output: [{type: 'text', text: 'prose'}]}
      : {stopReason: 'completed', structured: findings({status: 'needs-clarification', uncertainties: ['Which version?']}), output: []}), async dispose() {}};
  });
  for (const change of [r => {r.tasks[0].allowed_tools = ['write'];}, r => {r.tasks[0].depends_on = ['task1'];},
    r => {r.tasks[0].task.role = 'review';}, r => {r.batch_id = undefined;}, r => {r.tasks[0].task.capabilities = {};},
    r => {r.tasks[0].task.capabilities = ['text', 'text'];}]) {
    const input = request(); change(input); await assert.rejects(batches.run(input, exec()), {code: 'INVALID_BATCH'});
  }
  for (const field of ['id', 'scope', 'prompt']) {
    const input = request(); input.tasks[1][field] = input.tasks[0][field];
    await assert.rejects(batches.run(input, exec()), {code: 'DUPLICATE_BATCH_TASK'});
  }
  assert.equal(calls, 0);
  const result = await batches.run(request('partial', 2), exec());
  assert.equal(result.state, 'INCOMPLETE'); assert.equal(calls, 2);
  assert.deepEqual(result.tasks.map(t => t.state), ['RESULT_UNREADABLE', 'NEEDS_CLARIFICATION']);
});

test('parent cancellation drains active children and never starts remaining tasks', async t => {
  const ready = deferred(); let starts = 0, disposals = 0;
  const {batches} = await fixture(t, async (_name, input) => {
    starts++; if (starts === 2) ready.resolve();
    const done = deferred();
    const abort = () => done.resolve({stopReason: 'aborted', output: []});
    input.signal.addEventListener('abort', abort, {once: true});
    if (input.signal.aborted) abort();
    return {id: `cancel${starts}`, result: done.promise, async dispose() {disposals++; input.signal.removeEventListener('abort', abort);}};
  });
  const controller = new AbortController();
  const running = batches.run(request('cancel', 4), exec(controller.signal));
  t.after(async () => {controller.abort(); await running.catch(() => {});});
  await ready.promise; controller.abort();
  const result = await running;
  assert.equal(starts, 2); assert.equal(disposals, 2);
  assert.equal(result.state, 'INTERRUPTED_UNKNOWN');
  assert.deepEqual(result.tasks.slice(2).map(t => t.state), ['NOT_STARTED', 'NOT_STARTED']);
  assert.equal(result.replay_enabled, false);
});

test('valid partial findings survive an unfinished child without becoming a pass', async t => {
  const {batches} = await fixture(t, async () => ({id: 'partial-child', result: Promise.resolve({
    stopReason: 'max-tokens', structured: findings({status: 'partial'}), output: []}), async dispose() {}}));
  const result = await batches.run(request('partial-findings', 2), exec());
  assert.equal(result.state, 'INCOMPLETE');
  assert.ok(result.tasks.every(t => t.state === 'INCOMPLETE' && t.result.status === 'partial'));
});

test('batch cancellation removes queued workers without waiting for unrelated children', async t => {
  const gates = [deferred(), deferred()], ready = deferred(), queued = deferred();
  let starts = 0, submissions = 0;
  const {root, agents} = await fixture(t, async () => {
    const i = starts++; if (starts === 2) ready.resolve();
    return {id: `unrelated${i}`, result: gates[i].promise, async dispose() {}};
  }, () => gates.forEach(g => g.resolve({stopReason: 'aborted', output: []})));
  const occupied = ['one', 'two'].map(run_id => agents.delegate({run_id, prompt: 'Hold this slot.'},
    {provider: 'codex', model: 'fixture'}, 'medium', exec()));
  await ready.promise;
  const batches = createBatchRunner({root, owner, qualifications: {list: async () => evidence()}, agents: {
    delegate(...args) {const result = agents.delegate(...args); if (++submissions === 2) queued.resolve(); return result;},
  }});
  const controller = new AbortController();
  const running = batches.run(request('queued', 3), exec(controller.signal));
  t.after(async () => {controller.abort(); await batches.dispose(); await running.catch(() => {}); await Promise.allSettled(occupied);});
  await queued.promise; controller.abort();
  const result = await running;
  assert.equal(starts, 2);
  assert.equal(result.state, 'INTERRUPTED_UNKNOWN');
  assert.equal(result.tasks[2].state, 'NOT_STARTED');
  assert.deepEqual(await batches.referencedBy(result.tasks[0].run_id), []);
  assert.equal((await agents.read('one')).state, 'RUNNING');
  gates.forEach(g => g.resolve({stopReason: 'completed', output: [{type: 'text', text: 'done'}]}));
  await Promise.all(occupied);
});

test('batch journal failure cancels siblings and drains disposal before returning', async t => {
  const gates = [deferred(), deferred()], ready = deferred(), abortSeen = deferred(), disposal = deferred();
  let starts = 0, disposed = 0;
  const {root, batches} = await fixture(t, async (_name, input) => {
    const i = starts++;
    const abort = () => {abortSeen.resolve(); gates[i].resolve({stopReason: 'aborted', output: []});};
    input.signal.addEventListener('abort', abort, {once: true});
    if (i === 1) ready.resolve();
    return {id: `persist${i}`, result: gates[i].promise, async dispose() {
      if (i === 1) await disposal.promise;
      input.signal.removeEventListener('abort', abort); disposed++;
    }};
  }, () => {gates.forEach(g => g.resolve({stopReason: 'aborted', output: []})); disposal.resolve();});
  const running = batches.run(request('storage', 3), exec());
  await ready.promise;
  // Both task RUNNING commitments are saved before native start. Occupy the next revision
  // exclusively so the next commit fails without replacing a global filesystem method.
  const directory = path.join(root, 'bridge', keyOf(owner), 'batches', keyOf('storage'));
  await fs.mkdir(path.join(directory, '00000005.json'));
  gates[0].resolve({stopReason: 'completed', structured: findings(), output: []});
  await abortSeen.promise;
  let settled = false; running.then(() => {settled = true;});
  assert.equal(settled, false); assert.equal(starts, 2);
  disposal.resolve();
  const result = await running;
  assert.equal(disposed, 2); assert.equal(result.state, 'PERSISTENCE_FAILED'); assert.equal(starts, 2);
  await fs.rmdir(path.join(directory, '00000005.json'));
  assert.ok((await batches.referencedBy(result.tasks[1].run_id)).includes('storage'));
});

test('batch journal failure during task admission preserves the persistence cause', async t => {
  for (const qualified of [true, false]) {
    await t.test(qualified ? 'selected task' : 'unavailable task', async t => {
      const {root} = await fixture(t, async () => {throw new Error('must not start');});
      const directory = path.join(root, 'bridge', keyOf(owner), 'batches', keyOf('admission-storage'));
      let injection, starts = 0;
      const batches = createBatchRunner({root, owner, agents: {async delegate() {starts++; throw new Error('must not dispatch');}},
        qualifications: {async list() {
          await (injection ??= fs.mkdir(path.join(directory, '00000003.json')));
          return qualified ? evidence() : [];
        }}});
      t.after(() => batches.dispose());
      const answer = await batches.run(request('admission-storage', 3), exec());
      assert.equal(starts, 0); assert.equal(answer.state, 'PERSISTENCE_FAILED');
      assert.ok(answer.tasks.slice(0, 2).every(task => task.reason === 'PERSISTENCE_FAILED'));
      assert.equal(answer.tasks[2].state, 'NOT_STARTED');
    });
  }
});

test('assignment failure stays isolated and preserves known worker failure codes', async t => {
  const {root} = await fixture(t, async () => {throw new Error('stub dispatcher only');});
  let calls = 0;
  const batches = createBatchRunner({root, owner, qualifications: {list: async () => evidence()}, agents: {async delegate() {
    const index = calls++;
    return {state: index === 0 ? 'PERSISTENCE_FAILED' : index === 1 ? 'INTERRUPTED_UNKNOWN' : 'COMPLETED',
      failure_code: index === 1 ? 'EVIDENCE_EXPIRED' : null, rounds: [], returned_children: 0,
      worker_result: index === 2 ? findings() : null};
  }}});
  t.after(() => batches.dispose());
  const answer = await batches.run(request('isolated-failure', 3), exec());
  assert.equal(calls, 3); assert.equal(answer.state, 'INCOMPLETE'); assert.equal(answer.persistence_failed, false);
  assert.deepEqual(answer.tasks.map(task => task.reason), ['PERSISTENCE_FAILED', 'EVIDENCE_EXPIRED', null]);
  assert.equal(answer.tasks[2].state, 'COMPLETED');
  assert.deepEqual((await batches.read('isolated-failure')).tasks.map(task => task.reason), answer.tasks.map(task => task.reason));
});

test('recovery reads do not replay an unfinished batch', async t => {
  const {root, batches} = await fixture(t, async () => {throw new Error('must not start');});
  const req = request('recovered', 2);
  await createRecordStore(root, owner, 'batches').save(keyOf('recovered'), {
    schemaVersion: 1, owner, batch_id: 'recovered', request: {...req, max_tokens: 16384},
    state: 'RUNNING', created_at: 1, deadline_at: 900001, tasks: [{id: 'a', run_id: 'recovered-a', state: 'RUNNING', round_commitments: null}],
  }, 0);
  const result = await batches.read('recovered');
  assert.equal(result.state, 'INTERRUPTED_UNKNOWN');
  assert.equal(result.tasks[0].state, 'INTERRUPTED_UNKNOWN');
  assert.equal(result.accounting.round_counts_complete, false);
  await assert.rejects(batches.run(req, exec()), {code: 'BATCH_ALREADY_EXISTS'});
});

test('batch-task ID pairs are injective and standalone collisions never become owned references', async t => {
  let calls = 0;
  const {agents, batches} = await fixture(t, async () => ({id: `identity${++calls}`,
    result: Promise.resolve({stopReason: 'completed', structured: findings(), output: []}), async dispose() {}}));
  const left = request('alpha-beta', 2), right = request('alpha', 2);
  left.tasks[0].id = 'gamma'; right.tasks[0].id = 'beta-gamma';
  const a = await batches.run(left, exec()), b = await batches.run(right, exec());
  assert.notEqual(a.tasks[0].run_id, b.tasks[0].run_id);
  assert.equal(a.state, 'COMPLETED'); assert.equal(b.state, 'COMPLETED');
  const collision = 'b8-existing-task0';
  await agents.delegate({run_id: collision, prompt: 'Standalone', max_rounds: 1},
    {provider: 'codex', model: 'fixture'}, 'medium', exec());
  const before = calls;
  const c = await batches.run(request('existing', 2), exec());
  assert.equal(c.tasks[0].reason, 'ASSIGNMENT_ALREADY_EXISTS');
  assert.equal(calls, before + 1);
  assert.deepEqual(await batches.referencedBy(collision), []);
  const largest = request('x'.repeat(39), 2); largest.tasks[0].id = 'y'.repeat(20);
  assert.equal((await batches.run(largest, exec())).tasks[0].run_id.length, 64);
});

test('plugin exposes batch read/list/forget and protects assignment references', async t => {
  const root = await makeTempRoot('portable-batch-plugin-'), definitions = new Map(), cleanups = [];
  t.after(async () => {for (const cleanup of cleanups.reverse()) await cleanup?.(); await fs.rm(root, {recursive: true, force: true});});
  const services = {subagents: {async start() {
    return {id: 'fixture', result: Promise.resolve({stopReason: 'completed', structured: findings(), output: []}), async dispose() {}};
  }}};
  createPlugin(d => d).apply({tools: {register(d) {definitions.set(d.name, d); return () => definitions.delete(d.name);}},
    get: name => services[name], effect(fn) {const cleanup = fn(); cleanups.push(cleanup); return cleanup;}}, {stateRoot: root, enabled: true});
  // Synthetic evidence is private to this fixture; no live qualification is performed.
  const qualified = evidence()[0];
  qualified.runtimeBuildId = BUILD_ID;
  qualified.adapterFingerprint = createHash('sha256').update(qualified.provider + '\0' + qualified.model + '\0' + BUILD_ID).digest('hex');
  await createRecordStore(root, owner, 'qualifications').save(keyOf('fixture'), qualified, 0);
  const invoke = (name, args) => definitions.get(name).execute(args, exec());
  const result = await invoke('orchestrator_batch', request('api', 2));
  assert.equal(result.state, 'COMPLETED');
  assert.equal((await invoke('orchestrator_batch_read', {batch_id: 'api'})).tasks[0].result, undefined);
  assert.equal((await invoke('orchestrator_list', {kind: 'batches'})).batches.length, 1);
  assert.equal((await invoke('orchestrator_forget', {run_id: 'b3-api-task0'})).reason, 'ASSIGNMENT_REFERENCED_BY_BATCH');
  assert.equal((await invoke('orchestrator_forget', {batch_id: 'api'})).batch.removed, true);
  assert.equal((await invoke('orchestrator_forget', {run_id: 'b3-api-task0'})).assignment.removed, true);
});

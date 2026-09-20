// Portable regression fixtures only: no real Cordis registry, model or provider calls.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createPlugin} from '../src/plugin.mjs';
import {createRecordStore, createQualificationManager, keyOf} from '../src/qualification.mjs';
import {createAgentDispatcher} from '../src/agent-dispatch.mjs';
import {ROUTES, selectRoute} from '../src/routes.mjs';
import {makeTempRoot} from './helpers/tmp.mjs';

const root = await makeTempRoot('portable-bridge-test-');
// Delete only the unique directory created by this test file.
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const route = ROUTES.find(r => r.id === 'deepseek-v41-flash'), owner = 'synthetic-parent';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const llm = {async prepareCall(config) {return {config};}, listProviders() {return [{id: route.provider}];}};
const metadata = {role: 'R04', category: 'implementation', risk: 'low', complexity: 'routine', escalate: false, capabilities: ['text', 'tools'], dataClass: 'public'};

// Minimal declared host boundary; identity defineTool intentionally does NOT implement
// or certify the external host's schema DSL, middleware, tool filter or real registry.
function syntheticHost(services = {}) {
  const definitions = new Map(), cleanups = [];
  const tools = {register(definition) {
    assert.equal(typeof definition.execute, 'function');
    assert.equal(typeof definition.output.render, 'function');
    assert.equal(definitions.has(definition.name), false);
    definitions.set(definition.name, definition);
    return () => definitions.delete(definition.name);
  }};
  const ctx = {tools, get: name => services[name], effect(callback) {
    const cleanup = callback(); let released = false;
    const release = () => {if (!released) {released = true; return cleanup?.();}};
    cleanups.push(release); return release;
  }};
  return {ctx, definitions, dispose() {for (const cleanup of cleanups.reverse()) cleanup();}};
}
function passingService(getManager, childId = 'synthetic-child') {
  return {async start(name, request) {
    assert.equal(name, 'spawn'); assert.equal(request.parent.id, owner); assert.equal(request.maxDepth, 1);
    assert.deepEqual(request.toolFilter, {allow: ['orchestrator_qualification_echo']});
    const token = /with token ([a-f0-9-]+)/.exec(request.prompt[0].text)[1];
    const response = getManager().echo({token}, {agent: {id: childId}});
    return {id: childId, result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: `QUALIFIED:${response.marker}:42`}]}), async dispose() {}};
  }};
}
test('synthetic qualification binds child/tool/text and persists selectable fixture evidence', async () => {
  let manager; manager = createQualificationManager({root: fresh(), owner, getLlm: () => llm, getSubagents: () => passingService(() => manager)});
  const result = await manager.qualify(route, 'high', exec());
  assert.equal(result.qualification.available, true); assert.equal(result.qualification.imagePassed, false); assert.equal(result.cost_unknown, true);
  const selected = selectRoute({task: metadata, qualifications: await manager.list()});
  assert.equal(selected.status, 'SELECTED'); assert.equal(selected.route.id, route.id);
  assert.throws(() => manager.echo({token: 'unknown'}, exec())); manager.dispose();
});
test('forged child identity and absent tool call never qualify', async () => {
  for (const mode of ['wrong-child', 'no-tool']) {
    let manager;
    const service = {async start(_name, request) {
      const token = /with token ([a-f0-9-]+)/.exec(request.prompt[0].text)[1];
      const marker = mode === 'wrong-child' ? manager.echo({token}, {agent: {id: 'forger'}}).marker : 'invented-fixture';
      return {id: 'actual-fixture-child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: `QUALIFIED:${marker}:42`}]}), async dispose() {}};
    }};
    manager = createQualificationManager({root: fresh(), owner, getLlm: () => llm, getSubagents: () => service});
    assert.equal((await manager.qualify(route, 'high', exec())).qualification.available, false); manager.dispose();
  }
});
test('latest failed qualification supersedes a pass; config mismatch starts no child', async () => {
  let manager, fail = false, starts = 0, now = Date.now();
  const service = passingService(() => manager);
  manager = createQualificationManager({root: fresh(), owner, clock: () => now, getLlm: () => ({async prepareCall(config) {return {config: fail ? {...config, model: 'wrong-fixture'} : config};}}), getSubagents: () => ({async start(...args) {starts++; return service.start(...args);}})});
  await manager.qualify(route, 'high', exec()); fail = true; now++;
  assert.equal((await manager.qualify(route, 'high', exec())).qualification.available, false); assert.equal(starts, 1);
  assert.equal(selectRoute({task: metadata, qualifications: await manager.list(), now}).status, 'UNAVAILABLE'); manager.dispose();
});
test('qualification deadline cancels its synthetic child and never reports zero cost', async () => {
  let disposed = 0;
  const manager = createQualificationManager({root: fresh(), owner, getLlm: () => llm, deadlineMs: 100, getSubagents: () => ({async start(_name, request) {
    const result = new Promise(resolve => {
      const abort = () => resolve({stopReason: 'aborted', output: []});
      if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, {once: true});
    });
    return {id: 'synthetic-child', result, async dispose() {disposed++;}};
  }})});
  const result = await manager.qualify(route, 'high', exec());
  assert.equal(result.qualification.available, false); assert.equal(result.cost_unknown, true); assert.equal(disposed, 1); manager.dispose();
});
test('immutable journal refuses traversal, conflicting writes and corrupt latest', async () => {
  const directory = fresh(), store = createRecordStore(directory, owner, 'assignments'), key = keyOf('task');
  await store.save(key, {state: 'one'}, 0); await assert.rejects(store.save(key, {state: 'reset'}, 0)); await assert.rejects(store.read('../bad'));
  const file = path.join(directory, 'bridge', keyOf(owner), 'assignments', key, '00000002.json');
  await fs.writeFile(file, '{torn', {flag: 'wx'}); await assert.rejects(store.read(key));
});
test('assignment commits before start; exact route and readonly continuation use new children', async () => {
  const directory = fresh(); let count = 0, disposals = 0;
  const dispatcher = createAgentDispatcher({root: directory, owner, getSubagents: () => ({async start(_name, request) {
    count++; assert.equal(request.agentOptions.provider, route.provider); assert.equal(request.agentOptions.reasoningEffort, 'high');
    const saved = await createRecordStore(directory, owner, 'assignments').read(keyOf('run'));
    assert.equal(saved.data.state, 'RUNNING'); assert.equal(saved.data.rounds.length, count);
    if (count === 2) assert.match(request.prompt[0].text, /part-one/);
    return {id: 'synthetic-child-' + count, result: Promise.resolve({stopReason: count === 1 ? 'max-tokens' : 'completed', output: [{type: 'text', text: count === 1 ? 'part-one' : 'part-two'}]}), async dispose() {disposals++;}};
  }})});
  const result = await dispatcher.delegate({run_id: 'run', prompt: 'Synthetic read-only analysis'}, route, 'high', exec());
  assert.equal(result.state, 'COMPLETED'); assert.equal(result.text, 'part-onepart-two'); assert.equal(result.rounds.length, 2); assert.equal(disposals, 2); assert.equal(result.cost_unknown, true);
  await assert.rejects(dispatcher.delegate({run_id: 'run', prompt: 'retry'}, route, 'high', exec())); assert.equal(count, 2);
  const reopened = createAgentDispatcher({root: directory, owner, getSubagents: () => null}); assert.equal((await reopened.read('run')).replay_enabled, false);
  dispatcher.dispose(); reopened.dispose();
});
test('side-effecting agent work never automatically continues token-limited results', async () => {
  let calls = 0; const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {calls++; return {id: 'synthetic-child', result: Promise.resolve({stopReason: 'max-tokens', output: [{type: 'text', text: 'partial edit fixture'}]}), async dispose() {}};}})});
  const result = await dispatcher.delegate({run_id: 'write', prompt: 'Synthetic edit fixture; no filesystem effects', allowed_tools: ['read', 'edit'], max_rounds: 3}, route, 'high', exec());
  assert.equal(result.state, 'PARTIAL_NEEDS_RECONCILIATION'); assert.equal(calls, 1); dispatcher.dispose();
});
test('agent error never retries and foreign owner fails before dispatch', async () => {
  let calls = 0; const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {calls++; return {id: 'synthetic-child', result: Promise.resolve({stopReason: 'error', output: [{type: 'text', text: 'partial'}]}), async dispose() {}};}})});
  await assert.rejects(dispatcher.delegate({run_id: 'foreign', prompt: 'x'}, route, 'high', {agent: {id: 'foreign'}, signal: new AbortController().signal}));
  const result = await dispatcher.delegate({run_id: 'error', prompt: 'x'}, route, 'high', exec()); assert.equal(result.state, 'INTERRUPTED_UNKNOWN'); assert.equal(result.text, 'partial'); assert.equal(calls, 1); dispatcher.dispose();
});
test('agent abort preserves visible prefix and duplicate continuation stops', async () => {
  const controller = new AbortController();
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    controller.abort(); return {id: 'synthetic-abort', result: Promise.resolve({stopReason: 'aborted', output: [{type: 'text', text: 'saved abort prefix'}]}), async dispose() {}};
  }})});
  const aborted = await dispatcher.delegate({run_id: 'abort', prompt: 'x'}, route, 'high', {agent: {id: owner}, signal: controller.signal});
  assert.equal(aborted.text, 'saved abort prefix'); assert.equal(aborted.state, 'INTERRUPTED_UNKNOWN');
  let calls = 0;
  const repeated = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    calls++; return {id: 'synthetic-repeat-' + calls, result: Promise.resolve({stopReason: 'max-tokens', output: [{type: 'text', text: 'same answer'}]}), async dispose() {}};
  }})});
  const result = await repeated.delegate({run_id: 'repeat', prompt: 'x', max_rounds: 8}, route, 'high', exec());
  assert.equal(result.state, 'PARTIAL_NO_PROGRESS'); assert.equal(calls, 2); assert.equal(result.text, 'same answer'); dispatcher.dispose(); repeated.dispose();
});
test('agent context limit is explicit and prevents a new child', async () => {
  let calls = 0; const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {calls++; return {id: 'synthetic-context', result: Promise.resolve({stopReason: 'max-tokens', output: [{type: 'text', text: 'x'.repeat(160000)}]}), async dispose() {}};}})});
  const result = await dispatcher.delegate({run_id: 'context', prompt: 'x'}, route, 'high', exec());
  assert.equal(result.state, 'PARTIAL_CONTEXT_LIMIT'); assert.equal(calls, 1); assert.equal(result.total_chars, 160000); dispatcher.dispose();
});
test('SYNTHETIC injected host registers tools, qualifies fixture, plans and disposes', async t => {
  const services = {llm}; const host = syntheticHost(services); t.after(() => host.dispose());
  services.subagents = {async start(_name, request) {
    const token = /with token ([a-f0-9-]+)/.exec(request.prompt[0].text)[1];
    const response = await host.definitions.get('orchestrator_qualification_echo').execute({token}, {agent: {id: 'synthetic-injected-child'}, signal: request.signal});
    return {id: 'synthetic-injected-child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: `QUALIFIED:${response.marker}:42`}]}), async dispose() {}};
  }};
  createPlugin(definition => definition).apply(host.ctx, {stateRoot: fresh(), enabled: true});
  assert.deepEqual([...host.definitions.keys()].sort(), ['orchestrator_capacity', 'orchestrator_delegate', 'orchestrator_iterate', 'orchestrator_delegate_read', 'orchestrator_forget', 'orchestrator_inventory', 'orchestrator_list', 'orchestrator_plan', 'orchestrator_qualification_echo', 'orchestrator_qualify', 'orchestrator_read', 'orchestrator_resume', 'orchestrator_run'].sort());
  assert.equal(host.definitions.get('orchestrator_plan').timeoutMs, 60000); assert.equal(host.definitions.get('orchestrator_run').timeoutMs, 910000);
  const e = exec(), result = await host.definitions.get('orchestrator_qualify').execute({route_id: route.id, effort: 'high'}, e);
  assert.equal(result.qualification.available, true);
  const planned = await host.definitions.get('orchestrator_plan').execute({task_id: 'planned', prompt: 'Synthetic short answer', task: metadata, max_tokens: 256}, e);
  assert.equal(planned.selection.status, 'SELECTED'); assert.equal(planned.task.status, 'PLANNED');
  assert.equal((await host.definitions.get('orchestrator_inventory').execute({}, e)).qualifications.length, 1);
  const retained = host.definitions.get('orchestrator_inventory'); host.dispose(); assert.equal(host.definitions.size, 0);
  await assert.rejects(retained.execute({}, e)); assert.equal(e.signal.aborted, false);
});
test('SYNTHETIC disabled factory refuses dispatch without service calls', async t => {
  let calls = 0; const host = syntheticHost({llm: {prepareCall() {calls++; throw new Error('must not call');}}, subagents: {start() {calls++; throw new Error('must not call');}}});
  t.after(() => host.dispose()); assert.throws(() => createPlugin(undefined), TypeError);
  createPlugin(definition => definition).apply(host.ctx, {stateRoot: fresh()});
  assert.equal((await host.definitions.get('orchestrator_qualify').execute({route_id: route.id, effort: 'high'}, exec())).status, 'BRIDGE_REFUSED_OR_FAILED');
  assert.equal((await host.definitions.get('orchestrator_run').execute({task_id: 'absent'}, exec())).status, 'BRIDGE_REFUSED_OR_FAILED');
  assert.equal(calls, 0); host.dispose(); assert.equal(host.definitions.size, 0);
});

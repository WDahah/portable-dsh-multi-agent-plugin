// Synthetic LLM fixtures only. No host install, provider, credentials or network required.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createTaskEngine} from '../src/engine.mjs';
import {createPlugin} from '../src/plugin.mjs';
import {makeTempRoot} from './helpers/tmp.mjs';

const fixtures = await makeTempRoot('portable-diagnostic-test-');
// Cleanup is restricted to this file's uniquely created temporary root.
after(() => fs.rm(fixtures, {recursive: true, force: true}));
const root = () => fs.mkdtemp(path.join(fixtures, 'case-'));
const owner = 'synthetic-diagnostic-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const route = {provider: 'synthetic-provider', model: 'synthetic-model', effort: 'low', maxTokens: 256, costRates: {inputMicrosPerMillion: 300000, outputMicrosPerMillion: 1200000}};
const usage = {type: 'usage', usage: {inputTokens: 10, cacheReadTokens: 0, outputTokens: 20, totalTokens: 30, reasoningTokens: 0}};
const plan = {task_id: 'task', prompt: 'Synthetic continuation task', route, maxRounds: 2, contextChars: 50000};
async function contents(directory) {
  let out = '';
  for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
    const file = path.join(directory, entry.name);
    out += entry.isDirectory() ? await contents(file) : await fs.readFile(file, 'utf8');
  }
  return out;
}
function provider(secondError = false) {
  let calls = 0; const signals = [];
  return {signals, get calls() {return calls;}, async prepareCall(config, signal) {
    const round = ++calls; signals.push(signal);
    return {config, async *stream(options) {
      assert.equal(options.signal, signal);
      if (round === 2) {assert.equal(options.messages.length, 3); assert.equal(options.messages[1].content[0].text, 'first-prefix ');}
      if (round === 2 && secondError) {
        yield {type: 'finish', reason: {kind: 'error', failure: {code: 'INVALID_REQUEST', status: 400, message: 'secret-key-123 missing thinking signature', requestId: 'secret-request'}}};
        return;
      }
      yield {type: 'reasoning-delta', text: 'secret-reasoning'};
      yield {type: 'text-delta', text: round === 1 ? 'first-prefix ' : 'second-complete'};
      yield usage;
      yield {type: 'finish', reason: {kind: round === 1 ? 'max-tokens' : 'stop'}};
    }};
  }};
}
test('synthetic round-two failure preserves accounting and exposes only redacted diagnostics', async t => {
  const directory = await root(), llm = provider(true), engine = createTaskEngine({root: directory, owner, getLlm: () => llm});
  t.after(() => engine.dispose()); await engine.plan(plan);
  const result = await engine.run('task', exec());
  assert.equal(result.status, 'INTERRUPTED_UNCERTAIN'); assert.equal(result.text, 'first-prefix ');
  assert.equal(result.roundCount, 2); assert.equal(result.spentMicros, 27); assert.ok(result.heldMicros > 0); assert.equal(result.diagnosticPersisted, false);
  assert.deepEqual(result.diagnostics[1], {phase: 'stream', code: 'INVALID_REQUEST', httpStatus: 400, failureCategory: 'THINKING_PROTOCOL', finishKind: 'error', usageCount: 0, finishCount: 1, round: 2, visibleChars: 0, aborted: false});
  assert.equal(result.diagnostics[0].finishKind, 'max-tokens'); assert.equal(result.diagnostics[0].usageCount, 1);
  assert.equal(JSON.stringify(result).includes('secret-'), false);
  const disk = await contents(directory); assert.equal(disk.includes('THINKING_PROTOCOL'), false); assert.equal(disk.includes('secret-'), false);
  const reopened = createTaskEngine({root: directory, owner, getLlm: () => {throw new Error('must not replay');}});
  t.after(() => reopened.dispose()); assert.deepEqual((await reopened.read('task')).diagnostics, []);
  await engine.run('task', exec()); assert.equal(llm.calls, 2);
});
test('synthetic prepare errors allowlist code/status and redact uppercase secret-like codes', async t => {
  for (const code of ['AUTH', 'secret credential string', 'SECRET_API_KEY_123']) {
    const directory = await root();
    const engine = createTaskEngine({root: directory, owner, getLlm: () => ({async prepareCall() {
      throw Object.assign(new Error('secret-token'), {code, status: 401, requestId: 'secret-id'});
    }})});
    t.after(() => engine.dispose()); await engine.plan(plan);
    const result = await engine.run('task', exec()), d = result.diagnostics[0];
    assert.equal(d.phase, 'prepare'); assert.equal(d.code, code === 'AUTH' ? 'AUTH' : 'UNKNOWN'); assert.equal(d.httpStatus, 401);
    assert.equal(d.usageCount, 0); assert.equal(d.finishCount, 0); assert.equal(d.visibleChars, 0);
    assert.equal(result.roundCount, 1); assert.equal(result.status, 'INTERRUPTED_UNCERTAIN');
    for (const secret of ['secret-token', 'secret-id', 'secret credential string', 'SECRET_API_KEY_123']) {
      assert.equal(JSON.stringify(result).includes(secret), false); assert.equal((await contents(directory)).includes(secret), false);
    }
  }
});
test('synthetic two-round success has exact known accounting and portable factory timeouts', async t => {
  const llm = provider(), engine = createTaskEngine({root: await root(), owner, getLlm: () => llm}), e = exec();
  t.after(() => engine.dispose()); await engine.plan(plan);
  const result = await engine.run('task', e);
  assert.equal(result.status, 'COMPLETED'); assert.equal(result.text, 'first-prefix second-complete');
  assert.equal(result.roundCount, 2); assert.equal(result.spentMicros, 54); assert.equal(result.heldMicros, 0);
  assert.equal(result.costUnknown, false); assert.equal(result.resumable, false); assert.equal(result.diagnostics.length, 2);
  assert.ok(result.diagnostics.every(d => d.code === null)); assert.deepEqual(result.rounds.map(r => r.finish), ['max-tokens', 'stop']);
  // Settled round controllers must no longer be owned by the engine; disposal
  // cannot abort completed requests or the parent signal. Node also exits normally
  // with no outstanding 15-minute deadline timer after this test.
  assert.ok(llm.signals.every(signal => !signal.aborted)); engine.dispose();
  assert.ok(llm.signals.every(signal => !signal.aborted)); assert.equal(e.signal.aborted, false);
  const definitions = new Map(), disposers = [];
  const ctx = {tools: {register(definition) {definitions.set(definition.name, definition); return () => definitions.delete(definition.name);}},
    get() {throw new Error('synthetic mount must not access a service');},
    effect(callback) {const dispose = callback(); disposers.push(dispose); return dispose;}};
  // This is explicitly a synthetic context, not native host-registry qualification.
  createPlugin(definition => definition).apply(ctx, {stateRoot: await root()});
  t.after(() => {for (const dispose of disposers.reverse()) dispose();});
  for (const name of ['orchestrator_inventory', 'orchestrator_plan', 'orchestrator_read']) assert.equal(definitions.get(name).timeoutMs, 60000);
  for (const name of ['orchestrator_run', 'orchestrator_resume']) assert.equal(definitions.get(name).timeoutMs, 910000);
  assert.equal(definitions.get('orchestrator_delegate').timeoutMs, 2510000);
  assert.equal(definitions.get('orchestrator_qualify').timeoutMs, 190000);
});

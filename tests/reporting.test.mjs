// Honest-reporting fixtures: what a refusal tells the caller to do next, what usage is
// reported when a route has no published pricing, and how reserve routes are labelled.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeTempRoot} from './helpers/tmp.mjs';
import {ROUTES, POOL_PRIORITY, selectRoute, expectedEffort} from '../src/routes.mjs';
import {createTaskEngine} from '../src/engine.mjs';
import {createAgentDispatcher} from '../src/agent-dispatch.mjs';

const root = await makeTempRoot('portable-reporting-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'reporting-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const NOW = 1_000_000;
const task = overrides => ({role: 'R04', category: 'implementation', risk: 'low', complexity: 'routine', escalate: false, ...overrides});
function qualification(id, pool = 'balanced', overrides = {}) {
  const r = ROUTES.find(x => x.id === id);
  return {schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'SYNTHETIC'},
    runtimeBuildId: 'synthetic-build', adapterFingerprint: 'synthetic-key', provider: r.provider, model: r.model,
    effort: expectedEffort(r, pool), issuedAt: NOW - 100, expiresAt: NOW + 100, durationMs: 5, available: true,
    transportPassed: true, textPassed: true, toolPassed: true, imagePassed: false,
    caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}],
    allowedDataClasses: ['public'], domainEvidence: false, ...overrides};
}
const select = (t, qualifications) => selectRoute({task: task(t), qualifications, now: NOW});

test('a missing qualification names the exact probe that would fix it', () => {
  const result = select({}, []);
  assert.equal(result.status, 'UNAVAILABLE');
  for (const entry of result.reasons) {
    assert.equal(entry.reason, 'MISSING_EXACT_QUALIFICATION');
    // The hint is directly usable as orchestrator_qualify arguments.
    assert.deepEqual(entry.requalify, {route_id: entry.id, effort: entry.effort});
    assert.ok(POOL_PRIORITY.balanced.includes(entry.requalify.route_id));
  }
});
test('a hint from zero evidence covers everything the task will need', () => {
  // Following the hint must produce evidence that actually satisfies the task, so a
  // capability or policy requirement cannot be omitted just because nothing is stored yet.
  const image = select({role: 'R05'}, []).reasons[0].requalify;
  assert.deepEqual(image.capabilities, ['image']);
  const structured = select({capabilities: ['structured-output']}, []).reasons[0].requalify;
  assert.deepEqual(structured.capabilities, ['structured-output']);
  // text and tools are covered by the base smoke, so they are not requested again.
  const plain = select({capabilities: ['text', 'tools']}, []).reasons[0].requalify;
  assert.equal(Object.hasOwn(plain, 'capabilities'), false);
  assert.equal(select({role: 'R08'}, []).reasons[0].requalify.attestation.domainEvidence, true);
  assert.ok(select({dataClass: 'restricted'}, []).reasons[0].requalify.attestation.dataClasses.includes('restricted'));
});
test('an expired qualification reports when it lapsed and how to renew it', () => {
  // issuedAt must precede expiresAt or the record is malformed rather than merely lapsed.
  const expired = qualification('codex-terra', 'balanced', {issuedAt: NOW - 90000, expiresAt: NOW - 3600});
  const entry = select({}, [expired]).reasons[0];
  assert.equal(entry.reason, 'EXPIRED_QUALIFICATION');
  assert.equal(entry.expiredAt, NOW - 3600);
  assert.equal(entry.expiredForMs, 3600);
  assert.deepEqual(entry.requalify, {route_id: 'codex-terra', effort: 'medium'});
});
test('capability and policy refusals ask for the right kind of evidence', () => {
  const base = qualification('codex-terra');
  const image = select({role: 'R05'}, [base]).reasons[0];
  assert.equal(image.reason, 'IMAGE_PROBE_REQUIRED');
  assert.deepEqual(image.requalify.capabilities, ['image']);
  const structured = select({capabilities: ['structured-output']}, [base]).reasons[0];
  assert.deepEqual(structured.requalify.capabilities, ['structured-output']);
  // Domain and data class are attested, never probed, so the hint asks for an attestation.
  const domain = select({role: 'R08'}, [qualification('codex-sol', 'advanced')]).reasons[0];
  assert.equal(domain.reason, 'DOMAIN_EVIDENCE_REQUIRED');
  assert.equal(domain.requalify.attestation.domainEvidence, true);
  assert.equal(Object.hasOwn(domain.requalify, 'capabilities'), false);
  const dataClass = select({dataClass: 'confidential'}, [base]).reasons[0];
  assert.equal(dataClass.reason, 'DATA_CLASS_NOT_QUALIFIED');
  assert.ok(dataClass.requalify.attestation.dataClasses.includes('confidential'));
});
test('reserve routes are labelled as held back, not as failures', () => {
  const reserved = ROUTES.filter(r => r.reserve);
  assert.ok(reserved.length > 0);
  // reserve is exactly "in no pool", so the flag can never disagree with routing.
  for (const route of ROUTES) assert.equal(route.reserve, route.pools.length === 0);
  const pooled = new Set(Object.values(POOL_PRIORITY).flat());
  for (const route of reserved) assert.equal(pooled.has(route.id), false);
});
test('an unpriced route still reports token usage instead of implying free work', async () => {
  const engine = createTaskEngine({root: fresh(), owner, getLlm: () => ({async prepareCall(config) {return {config, stream: async function* () {
    yield {type: 'text-delta', text: 'answer'};
    yield {type: 'usage', usage: {inputTokens: 120, outputTokens: 45, totalTokens: 165, reasoningTokens: 12}};
    yield {type: 'finish', reason: {kind: 'stop'}};
  }};}})});
  // A subscription route has no published pricing, so costMicros is legitimately null.
  await engine.plan({task_id: 'unpriced', prompt: 'x', route: {provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', maxTokens: 256, costRates: null}});
  const result = await engine.run('unpriced', exec());
  assert.equal(result.costUnknown, true);
  assert.equal(result.rounds[0].costMicros, null);
  // Unknown cost, but usage is still reported.
  assert.equal(result.rounds[0].usage.inputTokens, 120);
  assert.equal(result.rounds[0].usage.outputTokens, 45);
  assert.equal(result.rounds[0].usage.reasoningTokens, 12);
  assert.equal(result.usage.totalTokens, 165);
  assert.equal(result.usageRoundsMissing, 0);
  // The same totals survive a read from storage.
  assert.equal((await engine.read('unpriced')).usage.outputTokens, 45);
});
test('an unsettled round reports missing usage rather than a zero total', async () => {
  const engine = createTaskEngine({root: fresh(), owner, getLlm: () => ({async prepareCall() {throw Object.assign(new Error('x'), {code: 'NETWORK_ERROR'});}})});
  await engine.plan({task_id: 'failed', prompt: 'x', route: {provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', maxTokens: 256, costRates: null}});
  const result = await engine.run('failed', exec());
  assert.equal(result.status, 'INTERRUPTED_UNCERTAIN');
  assert.equal(result.usage, null);
  assert.equal(result.usageRoundsMissing, 1);
  assert.equal(result.rounds[0].usage, null);
});
test('a delegation states why no token count exists', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'done'}]}), async dispose() {}};
  }})});
  const result = await dispatcher.delegate({run_id: 'usage', prompt: 'x'}, {provider: 'codex', model: 'gpt-5.6-terra'}, 'medium', exec());
  assert.equal(result.cost_unknown, true);
  assert.equal(result.usage, null);
  // The child result contract carries no usage, so the reason is named rather than implied.
  assert.equal(result.usage_reason, 'CHILD_RESULT_CARRIES_NO_USAGE');
  dispatcher.dispose();
});

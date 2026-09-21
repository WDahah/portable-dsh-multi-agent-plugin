// Escalation fixtures. Any single signal used to be enough to reach the most expensive
// tier, which sent 82% of ordinary task shapes there. These cases pin down what now counts
// as grounds, what stays on balanced, and what a record says about why.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeTempRoot} from './helpers/tmp.mjs';
import {selectRoute, expectedEffort, ROUTES, POOL_PRIORITY} from '../src/routes.mjs';
import {createAgentDispatcher} from '../src/agent-dispatch.mjs';

const root = await makeTempRoot('portable-escalation-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'escalation-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const NOW = 1_000_000;
function qualification(id, pool, overrides = {}) {
  const route = ROUTES.find(r => r.id === id);
  return {schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'SYNTHETIC'},
    runtimeBuildId: 'b', adapterFingerprint: 'f', provider: route.provider, model: route.model, effort: expectedEffort(route, pool),
    issuedAt: NOW - 10, expiresAt: NOW + 90000, durationMs: 1, available: true,
    transportPassed: true, textPassed: true, toolPassed: true, imagePassed: true,
    caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}, {name: 'image', passed: true}],
    allowedDataClasses: ['public', 'internal', 'confidential'], domainEvidence: true,
    attestation: {kind: 'operator-attestation', attestedBy: 'SYNTHETIC', basis: 'fixture', dataClasses: ['public', 'internal', 'confidential'], domainEvidence: true}, ...overrides};
}
function everything() {
  const seen = new Set(), records = [];
  for (const [pool, ids] of Object.entries(POOL_PRIORITY)) for (const id of ids) {
    const key = id + '|' + expectedEffort(ROUTES.find(r => r.id === id), pool);
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(qualification(id, pool));
  }
  return records;
}
const pick = (overrides, qualifications = everything()) => selectRoute({
  task: {role: 'standard', category: 'c', risk: 'low', complexity: 'routine', escalate: false, ...overrides},
  qualifications, now: NOW});

test('one description of a task is not grounds for the most expensive tier', () => {
  // Each of these used to reach advanced on its own.
  assert.equal(pick({risk: 'high'}).pool, 'balanced');
  assert.equal(pick({complexity: 'complex'}).pool, 'balanced');
  assert.equal(pick({dataClass: 'restricted'}).pool, 'balanced');
  // And the result says what was considered and why it was not enough.
  assert.deepEqual(pick({risk: 'high'}).grounds, ['HIGH_RISK', 'INSUFFICIENT_FOR_ADVANCED']);
  assert.deepEqual(pick({complexity: 'complex'}).grounds, ['COMPLEX', 'INSUFFICIENT_FOR_ADVANCED']);
});
test('grounds that corroborate each other do escalate', () => {
  assert.equal(pick({risk: 'high', complexity: 'complex'}).pool, 'advanced');
  assert.deepEqual(pick({risk: 'high', complexity: 'complex'}).grounds, ['HIGH_RISK', 'COMPLEX']);
  assert.equal(pick({risk: 'high', dataClass: 'restricted'}).pool, 'advanced');
  assert.equal(pick({complexity: 'complex', dataClass: 'restricted'}).pool, 'advanced');
});
test('critical risk and an advanced role each escalate alone', () => {
  // Both are statements about the work rather than descriptions of it.
  assert.equal(pick({risk: 'critical'}).pool, 'advanced');
  assert.deepEqual(pick({risk: 'critical'}).grounds, ['CRITICAL_RISK']);
  for (const role of ['deep', 'review', 'domain']) {
    const result = pick({role});
    assert.equal(result.pool, 'advanced', role);
    assert.ok(result.grounds.includes('ROLE_REQUIRES_ADVANCED'));
  }
});
test('an ordinary task reports no grounds at all', () => {
  const result = pick({});
  assert.equal(result.pool, 'balanced');
  assert.deepEqual(result.grounds, []);
});
test('economy is never reached by inference, only by asking', () => {
  // The cheap tier is the least likely to be qualified, so falling into it automatically
  // would turn ordinary work into a refusal and quietly lower quality where it succeeded.
  for (const shape of [{}, {risk: 'low', complexity: 'routine'}, {dataClass: 'public'}]) {
    assert.notEqual(pick(shape).pool, 'economy');
  }
  assert.equal(pick({pool: 'economy'}).pool, 'economy');
  // A task that only qualifies economy is refused rather than served from it.
  assert.equal(pick({}, [qualification('codex-luna', 'economy')]).status, 'UNAVAILABLE');
});
test('an explicit pool and escalate still win outright', () => {
  assert.equal(pick({escalate: true}).pool, 'long-horizon');
  assert.deepEqual(pick({escalate: true}).grounds, ['CALLER_REQUESTED_ESCALATION']);
  // Explicit pool beats grounds in both directions.
  assert.equal(pick({risk: 'critical', pool: 'balanced'}).pool, 'balanced');
  assert.equal(pick({pool: 'advanced'}).pool, 'advanced');
});
test('fewer task shapes reach advanced than before, and none reach a stronger tier', () => {
  const roles = ['standard', 'deep', 'review', 'vision', 'domain'];
  const rank = {economy: 0, balanced: 1, advanced: 2, 'long-horizon': 3, vision: 1};
  let advanced = 0, total = 0;
  for (const role of roles) for (const risk of ['low', 'medium', 'high', 'critical']) {
    for (const complexity of ['routine', 'moderate', 'complex']) {
      const result = pick({role, risk, complexity});
      total += 1;
      if (result.pool === 'advanced') advanced += 1;
      // An advanced pool must always be explainable by the grounds that reached it.
      if (result.pool === 'advanced') assert.ok(result.grounds.length > 0);
      // Nothing may quietly land somewhere cheaper than balanced.
      assert.ok(rank[result.pool] >= 1, `${role}/${risk}/${complexity} reached ${result.pool}`);
    }
  }
  // Roles that demand advanced are three of five, so a majority is expected; the point is
  // that it is no longer nearly everything.
  assert.ok(advanced / total < 0.75, `${Math.round(advanced / total * 100)}% still reach advanced`);
});
test('a review with no named subject still avoids the provider it would review', () => {
  const leader = ROUTES.find(r => r.id === POOL_PRIORITY.advanced[0]);
  const result = selectRoute({task: {role: 'review', category: 'c', risk: 'low', complexity: 'routine', escalate: false},
    qualifications: everything(), now: NOW, avoidProvider: leader.provider});
  assert.notEqual(result.route.provider, leader.provider);
  assert.equal(result.independence.independent, true);
});
test('a record says who chose the route and on what grounds', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'ok'}]}), async dispose() {}};
  }})});
  const chosen = await dispatcher.delegate({run_id: 'auto', prompt: 'x', role: 'deep',
    grounds: ['ROLE_REQUIRES_ADVANCED'], routing_provenance: 'SELECTOR'},
  {provider: 'codex', model: 'gpt-5.6-sol'}, 'high', exec());
  assert.equal(chosen.routed_by, 'SELECTOR');
  assert.deepEqual(chosen.selection_grounds, ['ROLE_REQUIRES_ADVANCED']);
  // A caller that picked the route itself is distinguishable from one the selector chose,
  // because only the second is reproducible from the task and its evidence.
  const manual = await dispatcher.delegate({run_id: 'manual', prompt: 'x', role: 'deep',
    routing_provenance: 'CALLER_SUPPLIED'}, {provider: 'claude', model: 'claude-opus-5'}, 'high', exec());
  assert.equal(manual.routed_by, 'CALLER_SUPPLIED');
  assert.equal(manual.selection_grounds, null);
  dispatcher.dispose();
});
test('a record written before provenance existed reads as selector-chosen', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'ok'}]}), async dispose() {}};
  }})});
  // No provenance supplied: the selector is the only thing that could have chosen it.
  const result = await dispatcher.delegate({run_id: 'legacy', prompt: 'x', role: 'standard'},
    {provider: 'codex', model: 'gpt-5.6-terra'}, 'medium', exec());
  assert.equal(result.routed_by, 'SELECTOR');
  assert.equal(result.selection_grounds, null);
  dispatcher.dispose();
});

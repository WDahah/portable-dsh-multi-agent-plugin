// Role naming fixtures: names that describe real routing, deprecated codes that still
// behave exactly as before, and an intent that is recorded without ever routing.
import test, {after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {makeTempRoot} from './helpers/tmp.mjs';
import {ROLES, ROLE_NAMES, ROLE_ALIASES, resolveRole, selectRoute, expectedEffort, ROUTES, POOL_PRIORITY} from '../src/routes.mjs';
import {createAgentDispatcher, routeLabel} from '../src/agent-dispatch.mjs';

const root = await makeTempRoot('portable-roles-test-');
after(() => fs.rm(root, {recursive: true, force: true}));
let sequence = 0;
const fresh = () => path.join(root, 'case-' + ++sequence);
const owner = 'roles-owner';
const exec = () => ({agent: {id: owner}, signal: new AbortController().signal});
const NOW = 1_000_000;
const base = {category: 'c', risk: 'low', complexity: 'routine', escalate: false};
const select = (overrides, qualifications = []) => selectRoute({task: {...base, ...overrides}, qualifications, now: NOW});
// One record per provider+model+effort: duplicates would tie and refuse as ambiguous.
function fullEvidence() {
  const seen = new Set(), records = [];
  for (const route of ROUTES) for (const effort of new Set(Object.values(route.effortsExpected))) {
    const key = route.provider + '|' + route.model + '|' + effort;
    if (seen.has(key)) continue;
    seen.add(key);
    records.push({schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'SYNTHETIC'},
      runtimeBuildId: 'b', adapterFingerprint: 'f', provider: route.provider, model: route.model, effort,
      issuedAt: NOW - 10, expiresAt: NOW + 90000, durationMs: 1, available: true,
      transportPassed: true, textPassed: true, toolPassed: true, imagePassed: true,
      caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}, {name: 'image', passed: true}, {name: 'structured-output', passed: true}],
      allowedDataClasses: ['public', 'internal', 'confidential'], domainEvidence: true,
      attestation: {kind: 'operator-attestation', attestedBy: 'SYNTHETIC-OPERATOR', basis: 'Synthetic fixture.', dataClasses: ['public', 'internal', 'confidential'], domainEvidence: true}});
  }
  return records;
}

test('every role name describes routing the selector actually performs', () => {
  const evidence = fullEvidence();
  for (const name of ROLE_NAMES) {
    const definition = ROLES[name];
    const result = select({role: name}, evidence);
    // The declared pool is what a plain task on that role reaches.
    assert.equal(result.pool, definition.pool, name);
    assert.equal(result.role, name);
    assert.equal(result.roleDeprecated, false);
    assert.ok(definition.describes.length > 20, name + ' has a description');
  }
  // vision demands an image probe; domain demands an attestation. Both are observable.
  assert.equal(ROLES.vision.image, true);
  assert.equal(ROLES.domain.domain, true);
});
test('a role that requires evidence refuses without it, naming the remedy', () => {
  const visionRefusal = select({role: 'vision'}, []).reasons[0];
  assert.deepEqual(visionRefusal.requalify.capabilities, ['image']);
  const domainRefusal = select({role: 'domain'}, []).reasons[0];
  assert.equal(domainRefusal.requalify.attestation.domainEvidence, true);
  // standard needs neither, so its hint asks for neither.
  const plain = select({role: 'standard'}, []).reasons[0];
  assert.equal(Object.hasOwn(plain.requalify, 'capabilities'), false);
  assert.equal(Object.hasOwn(plain.requalify, 'attestation'), false);
});
test('every shipped code still resolves and reports its canonical name', () => {
  for (const [code, canonical] of Object.entries(ROLE_ALIASES)) {
    const resolved = resolveRole(code);
    assert.equal(resolved.role, canonical, code);
    assert.equal(resolved.deprecated, true, code);
    assert.equal(resolved.supplied, code);
    // The selection reports both, so a caller can migrate without guessing.
    const result = select({role: code}, fullEvidence());
    assert.equal(result.role, canonical);
    assert.equal(result.roleSupplied, code);
    assert.equal(result.roleDeprecated, true);
    assert.ok(result.warnings.includes('DEPRECATED_ROLE_CODE'));
  }
  // All twelve codes shipped since 1.0.0 remain accepted.
  assert.equal(Object.keys(ROLE_ALIASES).length, 12);
});
test('an alias routes exactly where its code always did', () => {
  const evidence = fullEvidence();
  const variants = [{}, {risk: 'high'}, {complexity: 'complex'}, {escalate: true}, {pool: 'economy'}, {dataClass: 'confidential'}];
  for (const [code, canonical] of Object.entries(ROLE_ALIASES)) {
    for (const variant of variants) {
      const viaCode = select({role: code, ...variant}, evidence);
      const viaName = select({role: canonical, ...variant}, evidence);
      assert.equal(viaCode.status, viaName.status, code + ' ' + JSON.stringify(variant));
      assert.equal(viaCode.pool, viaName.pool);
      assert.equal(viaCode.effort, viaName.effort);
      assert.equal(viaCode.route?.id, viaName.route?.id);
    }
  }
});
test('the five previously undocumented codes keep their observed behaviour', () => {
  const evidence = fullEvidence();
  // R03 and R12 silently reached advanced; that is preserved and now named.
  for (const code of ['R03', 'R12']) assert.equal(select({role: code}, evidence).pool, 'advanced');
  // R02, R06 and R10 were balanced; also preserved.
  for (const code of ['R02', 'R06', 'R10']) assert.equal(select({role: code}, evidence).pool, 'balanced');
});
test('intent is recorded and never influences routing', () => {
  const evidence = fullEvidence();
  const a = select({role: 'standard', intent: 'write the migration'}, evidence);
  const b = select({role: 'standard', intent: 'delete production'}, evidence);
  assert.equal(a.intent, 'write the migration');
  assert.equal(b.intent, 'delete production');
  // Wildly different intents must not change pool, effort or route.
  assert.equal(a.pool, b.pool);
  assert.equal(a.effort, b.effort);
  assert.equal(a.route.id, b.route.id);
  // Absent intent reports null rather than being omitted.
  assert.equal(select({role: 'standard'}, evidence).intent, null);
  // An unusable intent refuses the task rather than being silently dropped.
  assert.equal(select({role: 'standard', intent: ''}, evidence).reason, 'INVALID_INPUT');
  assert.equal(select({role: 'standard', intent: 'x'.repeat(201)}, evidence).reason, 'INVALID_INPUT');
  assert.equal(select({role: 'standard', intent: 42}, evidence).reason, 'INVALID_INPUT');
});
test('unknown roles are refused, including plausible invented ones', () => {
  for (const role of ['architect', 'security', 'planner', 'R00', 'R13', 'r04', 'Standard', '', 42, null]) {
    assert.equal(select({role}).reason, 'INVALID_INPUT', String(role));
  }
  assert.equal(resolveRole('architect'), null);
  assert.equal(resolveRole(undefined), null);
});
test('risk, complexity and explicit pool still override the role', () => {
  const evidence = fullEvidence();
  // A balanced role reaches advanced through risk or complexity.
  assert.equal(select({role: 'standard', risk: 'high'}, evidence).pool, 'advanced');
  assert.equal(select({role: 'standard', complexity: 'complex'}, evidence).pool, 'advanced');
  assert.equal(select({role: 'standard', escalate: true}, evidence).pool, 'long-horizon');
  // An explicit pool beats even an advanced role.
  assert.equal(select({role: 'review', pool: 'economy'}, evidence).pool, 'economy');
});
test('the child label names the role and carries the intent', async () => {
  const route = {provider: 'claude', model: 'claude-opus-5'};
  assert.equal(routeLabel('review', route, 'high', 1), 'review · claude/claude-opus-5 · high · round 1');
  assert.equal(routeLabel('review', route, 'high', 1, 'check the plan'), 'review: check the plan · claude/claude-opus-5 · high · round 1');
  // A blank intent must not produce a dangling separator.
  assert.equal(routeLabel('standard', route, 'medium', 2, '   '), 'standard · claude/claude-opus-5 · medium · round 2');
  // A long intent is bounded so one label cannot flood a session tree.
  assert.ok(routeLabel('standard', route, 'medium', 1, 'y'.repeat(500)).length < 200);
});
test('role and intent are stored on the assignment and its listing', async () => {
  const dispatcher = createAgentDispatcher({root: fresh(), owner, getSubagents: () => ({async start() {
    return {id: 'child', result: Promise.resolve({stopReason: 'completed', output: [{type: 'text', text: 'ok'}]}), async dispose() {}};
  }})});
  await dispatcher.delegate({run_id: 'labelled', prompt: 'p', role: 'review', intent: 'check the migration plan'}, {provider: 'claude', model: 'claude-opus-5'}, 'high', exec());
  const saved = await dispatcher.read('labelled');
  assert.equal(saved.role, 'review');
  assert.equal(saved.intent, 'check the migration plan');
  assert.equal((await dispatcher.list())[0].intent, 'check the migration plan');
  // A run without intent reports null rather than omitting the field.
  await dispatcher.delegate({run_id: 'plain', prompt: 'p', role: 'standard'}, {provider: 'codex', model: 'gpt-5.6-terra'}, 'medium', exec());
  assert.equal((await dispatcher.read('plain')).intent, null);
  dispatcher.dispose();
});
test('pools named by roles exist in the routing table', () => {
  for (const name of ROLE_NAMES) assert.ok(Object.hasOwn(POOL_PRIORITY, ROLES[name].pool), name);
  // expectedEffort agrees with the pool each role declares.
  const terra = ROUTES.find(r => r.id === 'codex-terra');
  assert.equal(expectedEffort(terra, ROLES.standard.pool), 'medium');
  assert.equal(expectedEffort(terra, ROLES.deep.pool), 'high');
});

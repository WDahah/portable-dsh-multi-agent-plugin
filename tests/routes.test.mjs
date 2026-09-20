import test from 'node:test';
import assert from 'node:assert/strict';
import {ROUTES, UNAVAILABLE_CANDIDATES, POOL_PRIORITY, expectedEffort, selectRoute} from '../src/routes.mjs';
const NOW = 1_000_000;
const task = overrides => ({role: 'R04', category: 'implementation', risk: 'low', complexity: 'routine', escalate: false, ...overrides});
// Explicitly synthetic machine-record fixtures; no provider calls or real qualification claims.
function qualification(id, pool = 'balanced', overrides = {}) {
  const r = ROUTES.find(r => r.id === id);
  return {schemaVersion: 1, qualificationType: 'smoke', issuer: {kind: 'plugin-service', service: 'orchestration-v3', runtimeId: 'SYNTHETIC-TEST'}, runtimeBuildId: 'synthetic-build', adapterFingerprint: 'synthetic-route-key-not-artifact-proof', provider: r.provider, model: r.model, effort: expectedEffort(r, pool), issuedAt: NOW - 100, expiresAt: NOW + 100, durationMs: 5, available: true, transportPassed: true, textPassed: true, toolPassed: true, imagePassed: false, caseResults: [{name: 'text', passed: true}, {name: 'native-tool-roundtrip', passed: true}], allowedDataClasses: ['public'], domainEvidence: false, ...overrides};
}
const select = (t, qualifications) => selectRoute({task: task(t), qualifications, now: NOW});

test('15 actual runtime strings, immutable nested metadata, no invented V41 vision mapping', () => {
  assert.equal(ROUTES.length, 15); assert.equal(new Set(ROUTES.map(r => r.id)).size, 15);
  assert.equal(new Set(ROUTES.map(r => r.provider + '/' + r.model)).size, 15);
  assert.equal(ROUTES.find(r => r.id === 'deepseek-v4-vision').candidateId, null);
  assert.equal(ROUTES.some(r => r.candidateId === 'deepseek-v41-vision-label'), false);
  assert.equal(UNAVAILABLE_CANDIDATES[0].candidateId, 'deepseek-v41-vision-label');
  assert.throws(() => ROUTES[0].pools.push('advanced'), TypeError);
  assert.throws(() => {ROUTES[0].effortsExpected.standard = 'max';}, TypeError);
  assert.ok(ROUTES.every(r => !r.immutableModelVersion && !r.historicalQualificationTransferred));
});
test('inventory alone never selects a route', () => {
  const r = select({}, []); assert.equal(r.status, 'UNAVAILABLE'); assert.equal(r.reasons.length, 3);
});
test('balanced priorities are deterministic and exact medium, then qualified alternatives', () => {
  const terra = qualification('codex-terra'), sonnet = qualification('claude-sonnet');
  assert.equal(select({}, [sonnet, terra]).route.id, 'codex-terra');
  assert.equal(select({}, [terra, sonnet]).effort, 'medium');
  const r = select({}, [{...terra, available: false}, sonnet]);
  assert.equal(r.route.id, 'claude-sonnet'); assert.equal(r.reasons[0].reason, 'UNAVAILABLE_AT_PROBE');
});
test('advanced roles, high risk and complexity; escalation selects long pool', () => {
  for (const role of ['R03', 'R07', 'R12']) assert.equal(select({role}, [qualification('codex-sol', 'advanced')]).pool, 'advanced');
  for (const change of [{risk: 'high'}, {risk: 'critical'}, {complexity: 'complex'}]) assert.equal(select(change, [qualification('codex-sol', 'advanced')]).effort, 'high');
  const r = select({escalate: true}, [qualification('claude-fable', 'long-horizon')]);
  assert.equal(r.pool, 'long-horizon'); assert.equal(r.effort, 'xhigh');
  assert.equal(expectedEffort('kimi-k3', 'long-horizon'), 'max');
});
test('economy only explicit, no cross-pool fallback, reserve routes not silently activated', () => {
  const luna = qualification('codex-luna', 'economy');
  assert.equal(select({}, [luna]).status, 'UNAVAILABLE');
  assert.equal(select({pool: 'economy'}, [luna]).route.id, 'codex-luna');
  assert.equal(select({risk: 'high'}, [qualification('codex-terra')]).status, 'UNAVAILABLE');
  assert.equal(ROUTES.filter(r => r.pools.length === 0).length, 5);
  assert.equal(ROUTES.find(r => r.id === 'deepseek-v4-pro').pricing, null);
  assert.equal(ROUTES.find(r => r.id === 'deepseek-v4-vision').pricing, null);
  assert.equal(POOL_PRIORITY['long-horizon'][0], 'claude-fable');
});
test('wrong effort, subscription surface, missing native tool roundtrip do not qualify', () => {
  for (const change of [{effort: 'high'}, {provider: 'openai'}, {toolPassed: false}, {caseResults: [{name: 'text', passed: true}]}]) {
    assert.equal(select({}, [qualification('codex-terra', 'balanced', change)]).status, 'UNAVAILABLE');
  }
});
test('expired, future, malformed, non-machine and non-smoke records fail closed', () => {
  for (const change of [{expiresAt: NOW}, {issuedAt: NOW + 1}, {durationMs: -1}, {adapterFingerprint: ''}, {issuer: {kind: 'user'}}, {qualificationType: 'inventory'}, {transportPassed: false}]) {
    assert.equal(select({}, [qualification('codex-terra', 'balanced', change)]).status, 'UNAVAILABLE');
  }
});
test('latest failure supersedes historical success and duplicate timestamps refuse', () => {
  const good = qualification('codex-terra'), bad = {...good, issuedAt: NOW - 10, textPassed: false};
  assert.equal(select({}, [good, bad]).reasons[0].reason, 'TEXT_OR_TRANSPORT_FAILED');
  assert.equal(select({}, [good, {...good}]).reasons[0].reason, 'AMBIGUOUS_LATEST_QUALIFICATION');
});
test('R05 requires actual image test, not inventory capability or role label', () => {
  const q = qualification('codex-terra');
  assert.equal(select({role: 'R05'}, [q]).reasons[0].reason, 'IMAGE_PROBE_REQUIRED');
  assert.equal(select({role: 'R05'}, [{...q, imagePassed: true}]).status, 'UNAVAILABLE');
  assert.equal(select({role: 'R05'}, [{...q, imagePassed: true, caseResults: [...q.caseResults, {name: 'image', passed: true}]}]).status, 'SELECTED');
});
test('domain roles require explicit domain evidence; smoke never claims role certification', () => {
  for (const role of ['R08', 'R09']) {
    assert.equal(select({role}, [qualification('codex-sol', 'advanced')]).reasons[0].reason, 'DOMAIN_EVIDENCE_REQUIRED');
    const r = select({role}, [qualification('codex-sol', 'advanced', {domainEvidence: true})]);
    assert.equal(r.status, 'SELECTED'); assert.equal(r.qualificationLevel, 'smoke');
    assert.ok(r.warnings.includes('SMOKE_IS_NOT_ROLE_COMPETENCE_CERTIFICATION'));
  }
});
test('data class and extra capabilities need explicit evidence; no financial gate', () => {
  const q = qualification('codex-terra');
  assert.equal(select({dataClass: 'confidential'}, [q]).reasons[0].reason, 'DATA_CLASS_NOT_QUALIFIED');
  assert.equal(select({capabilities: ['structured-output']}, [q]).status, 'UNAVAILABLE');
  const r = select({}, [{...q, costUsd: 200}]);
  assert.equal(r.status, 'SELECTED'); assert.equal(r.financialFilter, false); assert.equal(r.softTargetUsd, 1);
});
test('invalid tasks refuse and do not silently select a default', () => {
  for (const change of [{role: 'R99'}, {pool: 'auto'}, {risk: 'unknown'}, {complexity: 'easy'}, {escalate: 'false'}, {dataClass: 'secret'}, {capabilities: ['magic']}]) assert.equal(select(change, []).reason, 'INVALID_INPUT');
});
test('ordinary application implementation routes without project-specific metadata', () => {
  const result=select({category:'implementation',dataClass:'public'},[qualification('codex-terra')]);
  assert.equal(result.status,'SELECTED');assert.equal(result.pool,'balanced');assert.equal(result.effort,'medium');
  assert.equal(Object.hasOwn(result,'workspace'),false);assert.equal(Object.hasOwn(result,'project'),false);
});

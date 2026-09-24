import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {digest, ownedJson, validatePlanV2} from '../src/governance/contracts.mjs';
import {openGovernanceStoreV2} from '../src/governance/store.mjs';
import {createGovernanceControllerM4B} from '../src/governance/controller.mjs';
import {createStagePolicyV2} from '../src/governance/policy.mjs';
import {inspectBaseline, createWorkspaceV2, workspaceFile, captureDeliveryDestinationM4B} from '../src/governance/workspace.mjs';
import {m2GitFixture} from './helpers/governance.mjs';

const raw = value => createHash('sha256').update(value).digest('hex');
const route = provider => ({provider, model: 'scripted-test-fixture', effort: 'none'});

function errorLeaves(error) {
  if (error instanceof AggregateError) return error.errors.flatMap(errorLeaves);
  return [error];
}

// Real store, controller, workspace and custody are used. Only model execution and
// the test-command producer are scripted; this is not a live-host qualification.
async function fixture(t, options = {}) {
  const f = await m2GitFixture(t, {files: {'a.txt': 'before\r\n', 'test.mjs': '// trusted fixture\n'}});
  const baseline = await inspectBaseline({
    sourceRoot: f.sourceRoot,
    scratchRoot: f.scratchRoot,
    protectedRoots: [f.governanceRoot, f.legacyRoot, f.configRoot, ...f.protectedRoots],
    git: f.git,
  });
  if (options.freshWorkspaces) await fs.mkdir(f.workspaceRoot);
  const store = await openGovernanceStoreV2({
    root: f.governanceRoot,
    projectRoot: f.sourceRoot,
    protectedRoots: [f.workspaceRoot, f.scratchRoot, f.legacyRoot, f.configRoot, ...f.protectedRoots],
  });
  let controller, observedWorkspacePoison = false;
  f.own(async () => {
    try {
      if (controller) await controller.close();
      else await store.close();
    } catch (error) {
      if (!observedWorkspacePoison) throw error;
      const leaves = errorLeaves(error), workspaceFailures = leaves.filter(item => item?.code === 'WORKSPACE_POISONED');
      assert.ok(workspaceFailures.length > 0, 'cleanup must retain the already-observed workspace poison');
      assert.ok(leaves.every(item => item?.code === 'WORKSPACE_POISONED' || item?.code === 'STORE_REVOKED'),
        'cleanup may tolerate only consequences of the already-observed poison');
    }
  });
  const executionPolicy = {
    schemaVersion: 1,
    routes: {'plan-review': route('plan-review-provider'), author: route('author-provider'), validator: route('validator-provider'), reviewer: route('reviewer-provider')},
    node: {executable: process.execPath, sha256: raw(await fs.readFile(process.execPath)), version: process.versions.node, systemRoot: f.git.systemRoot},
    enforcement: 'guarded-native-trusted-code',
    settlementGraceMs: 1000,
    testFiles: [{path: 'test.mjs', sha256: raw('// trusted fixture\n')}],
    environmentRecipe: 'systemroot-owned-temp-v1',
  };
  const plan = validatePlanV2({
    schemaVersion: 2,
    jobId: 'six-stage-fixture',
    projectId: store.status().projectId,
    baseline: baseline.baselineDigest,
    objective: 'Exercise the six-stage diagnostic governance sequence',
    nonGoals: ['No production activation'],
    files: [{path: 'a.txt', operation: 'replace', expectedHash: raw('before\r\n')}],
    protectedTests: ['test.mjs'],
    criteria: [{id: 'C', description: 'Exact candidate passes the protected test', method: 'test'}],
    commands: [{id: 'test', executable: process.execPath, argv: ['--test', '--test-isolation=none', '--test-reporter=tap', 'test.mjs'], cwd: 'frozen', environment: f.git.systemRoot === null ? {} : {SYSTEMROOT: f.git.systemRoot}, timeoutMs: 10000, expectedExit: 0, inventory: ['T']}],
    policy: {planner: {id: 'planner', provider: 'planner-provider'}, implementerProvider: 'author-provider', correctionLimit: 2},
    testInventory: ['T'],
    environmentDigest: digest({node: executionPolicy.node, enforcement: executionPolicy.enforcement, environmentRecipe: executionPolicy.environmentRecipe}),
    executionPolicy,
  });
  const tickets = new WeakMap();
  const runs = new WeakMap();
  const handlers = {};
  const actors = {};
  const host = {
    prepareStage(spec) { const ticket = {}; tickets.set(ticket, spec); return ticket; },
    async start(ticket, {onActor}) {
      const spec = tickets.get(ticket);
      assert.ok(spec);
      const reservedActor = Object.freeze({id: spec.id, ...spec.route});
      const actor = options.actorReuse === spec.role ? actors.author : reservedActor;
      assert.ok(actor);
      actors[spec.role] = actor;
      const stage = await onActor({actor, execution: Promise.resolve(spec.role === 'author' ? (options.authorStop ?? 'completed') : 'completed'), disposed: Promise.resolve()});
      handlers[spec.role] = stage;
      assert.equal(Object.hasOwn(stage, 'file'), spec.role === 'author');
      assert.equal(Object.hasOwn(stage, 'run'), spec.role === 'validator');
      if (spec.role === 'author' && options.authorStop !== 'error') await stage.file({operation: 'replace', path: 'a.txt', expectedHash: raw('before\r\n'), text: 'after\r\n'});
      if (spec.role === 'validator' && options.foreignEvidence) await stage.evidence({evidenceId: 'foreign-evidence'});
      if (spec.role === 'validator' && !options.skipRun) await stage.run('test');
      const listed = (spec.role === 'validator' || spec.role === 'reviewer') ? await stage.evidence({operation: 'list'}) : {evidence: []};
      let submission = null;
      if (spec.role === 'plan-review') submission = {criteria: [{id: 'C', outcome: 'pass'}], findings: [], evidenceIds: []};
      if ((spec.role === 'validator' || spec.role === 'reviewer') && !options.incomplete) submission = {
        criteria: [{id: 'C', outcome: options.failedJudgments ? 'fail' : 'pass'}],
        findings: [],
        evidenceIds: listed.evidence.map(row => row.id),
      };
      const run = {};
      runs.set(run, {actor, stopReason: spec.role === 'author' ? (options.authorStop ?? 'completed') : 'completed', submission});
      return run;
    },
    async observe(run) { return runs.get(run); },
    cancel() {},
    async close() {},
  };
  let decide;
  const workspaceFactory = ({authority}) => {
    const state = authority.readCurrent();
    const workspaceRoot = options.freshWorkspaces
      ? path.join(f.workspaceRoot, `attempt-${state.attempts.at(-1).index}`)
      : f.workspaceRoot;
    const workspace = createWorkspaceV2({
      sourceRoot: f.sourceRoot, workspaceRoot, scratchRoot: f.scratchRoot,
      governanceRoot: f.governanceRoot, legacyRoot: f.legacyRoot, configRoot: f.configRoot,
      protectedRoots: f.protectedRoots, protectedFiles: ['test.mjs'], git: f.git, baseline, authority,
    });
    if (!options.corruptSeal) return Object.freeze({...workspace, file: workspaceFile});
    return Object.freeze({...workspace, file: workspaceFile, async seal() {
      const sealed = await workspace.seal();
      return {...sealed, descriptor: {...sealed.descriptor, candidateDigest: 'f'.repeat(64)}};
    }});
  };
  const runnerFactory = ({assignment, authorize, custody}) => {
    const receipts = new WeakMap();
    return {
      async run(commandId) {
        assert.equal(authorize(), true); custody.verify();
        const failed = options.failedRunner === true;
        const stdout = failed ? 'not ok scripted test producer\n' : 'ok scripted test producer\n';
        const facts = {
          commandId,
          commandDigest: digest(plan.commands[0]),
          binding: options.runnerFactMismatch === 'binding'
            ? {...assignment.binding, candidateDigest: raw('stale-candidate')}
            : assignment.binding,
          assignmentId: options.runnerFactMismatch === 'assignment' ? 'foreign-assignment' : assignment.id,
          actualExit: failed ? 1 : 0,
          signal: null,
          timedOut: false,
          aborted: false,
          captureComplete: true,
          managedSettled: true,
          enforcement: 'partial',
          settlementGraceMs: 1000,
          inventory: [{id: 'T', outcome: failed ? 'fail' : 'pass'}],
          stdoutDigest: raw(stdout),
          stderrDigest: raw(''),
          stdoutChunks: [stdout],
          stderrChunks: [],
          status: failed ? 'failed' : 'completed',
          reason: failed ? 'fixture-exit-1' : null,
          limitations: ['Scripted producer; not live-host qualification'],
        };
        const receipt = {}; receipts.set(receipt, ownedJson(facts)); return receipt;
      },
      consume(receipt) { const value = receipts.get(receipt); assert.ok(value); receipts.delete(receipt); return value; },
      stop() {}, async close() {},
    };
  };
  const delivery = captureDeliveryDestinationM4B({destinationId: 'unused-fixture-output', outputRoot: path.join(f.root, 'delivery'), protectedRoots: [f.sourceRoot, f.workspaceRoot, f.scratchRoot, f.governanceRoot, f.legacyRoot, f.configRoot, ...f.protectedRoots]});
  controller = await createGovernanceControllerM4B({store, host, humanPort: {bind(fn) { decide = fn; return () => { decide = null; }; }}, workspaceFactory, runnerFactory, authorizeOwner: () => true, delivery});
  return {
    ...f, controller, store, plan, handlers, actors,
    decide: input => decide(input),
    observeWorkspacePoison(error) {
      assert.equal(error?.code, 'WORKSPACE_POISONED');
      observedWorkspacePoison = true;
      return true;
    },
  };
}

async function authorize(f) {
  await f.controller.propose(f.plan);
  await assert.rejects(f.controller.propose({...f.plan}), {code: 'PLAN_ALREADY_EXISTS'});
  assert.deepEqual((await f.store.load()).latest.payload.plan.criteria, f.plan.criteria);
  await assert.rejects(f.controller.requestAuthor(), {code: 'PLAN_NOT_AUTHORIZED'});
  const review = await f.controller.reviewPlan();
  assert.deepEqual(Object.keys(f.handlers['plan-review']), []);
  await assert.rejects(f.controller.requestAuthor(), {code: 'PLAN_NOT_AUTHORIZED'});
  await assert.rejects(f.decide({planDigest: digest('wrong plan'), reviewResultId: review.resultId, decision: 'authorize'}), {code: 'STALE_HUMAN_DECISION'});
  await assert.rejects(f.decide({planDigest: digest(f.plan), reviewResultId: 'wrong-result', decision: 'authorize'}), {code: 'STALE_HUMAN_DECISION'});
  await f.decide({planDigest: digest(f.plan), reviewResultId: review.resultId, decision: 'authorize'});
}

async function authorAndSeal(f) {
  const result = await f.controller.requestAuthor();
  assert.equal(result.outcome, 'completed-fail');
  return f.controller.seal();
}

test('real V2/M4B sequence binds plan, candidate, evidence and independent stages without activating a gate', async t => {
  const f = await fixture(t);
  await authorize(f);
  await f.controller.requestAuthor();
  const sealed = await f.controller.seal();
  assert.equal(sealed.candidateDigest, (await f.store.load()).latest.payload.candidate);
  await f.controller.validate();
  await f.controller.review();
  assert.equal(Object.hasOwn(f.handlers.validator, 'file'), false);
  assert.equal(Object.hasOwn(f.handlers.reviewer, 'file'), false);
  assert.notEqual(f.actors.author.id, f.actors.validator.id);
  assert.notEqual(f.actors.author.id, f.actors.reviewer.id);
  assert.notEqual(f.actors.validator.id, f.actors.reviewer.id);
  const readiness = await f.controller.diagnosticReadiness();
  assert.equal(readiness.diagnosticallyReady, true);
  assert.equal(readiness.accepted, false);
  assert.equal(readiness.gateActive, false);
  assert.equal(readiness.candidateDigest, sealed.candidateDigest);
});

test('wrong seal binding, foreign evidence, and incomplete judgments are refused', async t => {
  await t.test('seal descriptor is structurally validated before controller binding', async t => {
    const f = await fixture(t, {corruptSeal: true}); await authorize(f); await f.controller.requestAuthor();
    await assert.rejects(f.controller.seal(), {code: 'CANDIDATE_DIGEST_MISMATCH'});
  });
  await t.test('validator cannot cite foreign evidence', async t => {
    const f = await fixture(t, {foreignEvidence: true}); await authorize(f); await f.controller.requestAuthor(); await f.controller.seal();
    await assert.rejects(f.controller.validate(), {code: 'FOREIGN_EVIDENCE'});
  });
  await t.test('incomplete validation and review never become ready', async t => {
    const f = await fixture(t, {incomplete: true}); await authorize(f); await f.controller.requestAuthor(); await f.controller.seal(); await f.controller.validate(); await f.controller.review();
    const readiness = await f.controller.diagnosticReadiness();
    assert.equal(readiness.diagnosticallyReady, false); assert.equal(readiness.accepted, false); assert.equal(readiness.gateActive, false);
  });
});

test('a noncompleted author poisons its real workspace and cannot consume a fictitious second attempt', async t => {
  const f = await fixture(t, {authorStop: 'error'}); await authorize(f);
  const first = await f.controller.requestAuthor();
  assert.equal(first.outcome, 'error');
  assert.equal((await f.store.load()).latest.payload.attempts.length, 1);
  await assert.rejects(f.controller.requestAuthor(), error => {
    const workspacePoison = errorLeaves(error).find(item => item?.code === 'WORKSPACE_POISONED');
    assert.ok(workspacePoison, 'the prior real workspace close must report its poison');
    return f.observeWorkspacePoison(workspacePoison);
  });
  const state = (await f.store.load()).latest.payload;
  assert.equal(state.attempts.length, 1);
  assert.equal(state.phase, 'CORRECTION_REQUIRED');
});

test('three completed correction cycles use real fresh workspaces and the fourth author is phase-refused', async t => {
  const f = await fixture(t, {freshWorkspaces: true, failedRunner: true, failedJudgments: true}); await authorize(f);
  const expected = {plan: digest(f.plan), criteria: digest(f.plan.criteria), commands: digest(f.plan.commands)};
  const identities = [];
  for (let index = 0; index < 3; index++) {
    await authorAndSeal(f);
    const validation = await f.controller.validate();
    const review = await f.controller.review();
    assert.equal(validation.outcome, 'completed-fail');
    assert.equal(review.outcome, 'completed-fail');
    const state = (await f.store.load()).latest.payload;
    assert.equal(state.attempts.length, index + 1);
    assert.equal(state.attempts[index].index, index);
    assert.equal(state.attempts[index].planDigest, expected.plan);
    assert.equal(state.phase, index === 2 ? 'REASSESS_REQUIRED' : 'CORRECTION_REQUIRED');
    const testEvidence = state.evidence.find(row => row.kind === 'test' && row.generation === state.generation);
    assert.equal(testEvidence.status, 'failed');
    assert.equal(testEvidence.details.actualExit, 1);
    assert.deepEqual(testEvidence.details.inventory, [{id: 'T', outcome: 'fail'}]);
    identities.push({plan: digest(state.plan), criteria: digest(state.plan.criteria), commands: digest(state.plan.commands)});
  }
  assert.deepEqual(identities, [expected, expected, expected]);
  const final = (await f.store.load()).latest.payload;
  assert.deepEqual(final.attempts.map(row => row.index), [0, 1, 2]);
  assert.equal(final.authors.length, 3);
  await assert.rejects(f.controller.requestAuthor(), {code: 'AUTHOR_NOT_ALLOWED'});
  await assert.rejects(f.controller.propose({...f.plan, criteria: [{id: 'CHANGED', description: 'weakened', method: 'test'}]}), {code: 'PLAN_ALREADY_EXISTS'});
  const unchanged = (await f.store.load()).latest.payload;
  assert.equal(unchanged.attempts.length, 3);
  assert.equal(digest(unchanged.plan), expected.plan);
  assert.equal(digest(unchanged.plan.criteria), expected.criteria);
  assert.equal(digest(unchanged.plan.commands), expected.commands);
});

test('foreign or stale runner facts stop the fixture before test evidence is accepted', async t => {
  for (const mismatch of ['binding', 'assignment']) await t.test(mismatch, async t => {
    const f = await fixture(t, {runnerFactMismatch: mismatch}); await authorize(f); await authorAndSeal(f);
    await assert.rejects(f.controller.validate(), {code: 'RUNNER_FACT_MISMATCH'});
    const state = (await f.store.load()).latest.payload;
    assert.equal(state.phase, 'STOPPED');
    assert.equal(state.evidence.filter(row => row.kind === 'test').length, 0);
    await assert.rejects(f.controller.review(), {code: 'CANDIDATE_REQUIRED'});
  });
});

test('an observed actor reused from the author stops validator or reviewer admission', async t => {
  await t.test('validator', async t => {
    const f = await fixture(t, {actorReuse: 'validator'}); await authorize(f); await authorAndSeal(f);
    await assert.rejects(f.controller.validate(), {code: 'ACTUAL_ACTOR_CHANGED'});
    assert.equal((await f.store.load()).latest.payload.phase, 'STOPPED');
    assert.equal(f.actors.validator, f.actors.author);
  });
  await t.test('reviewer', async t => {
    const f = await fixture(t, {actorReuse: 'reviewer'}); await authorize(f); await authorAndSeal(f); await f.controller.validate();
    await assert.rejects(f.controller.review(), {code: 'ACTUAL_ACTOR_CHANGED'});
    assert.equal((await f.store.load()).latest.payload.phase, 'STOPPED');
    assert.equal(f.actors.reviewer, f.actors.author);
  });
});

test('real stage policy guards exact role tools, definitions, routes and actor identity', () => {
  const names = ['m3_plan', 'm3_read', 'm3_evidence', 'm3_run', 'm3_submit', 'm3_file', 'write', 'edit', 'pwsh'];
  const sentinels = Object.fromEntries(names.map(name => [name, 0]));
  const definitions = Object.fromEntries(names.map(name => [name, {name, body(exec) {
    policy.assert(exec, definitions[name], leases.get(exec.agent));
    sentinels[name]++;
  }}]));
  const globalRegistry = new Map(names.map(name => [name, definitions[name]]));
  const scopedRegistry = new WeakMap(), live = new WeakSet(), authorized = new WeakSet(), leases = new WeakMap();
  const policy = createStagePolicyV2({
    resolveDefinition(name, actor) { return scopedRegistry.get(actor)?.get(name) ?? globalRegistry.get(name); },
    isLive: actor => live.has(actor),
    authorize: actor => authorized.has(actor),
  });
  try {
    const roles = {
      'plan-review': ['m3_plan', 'm3_submit'],
      validator: ['m3_plan', 'm3_read', 'm3_evidence', 'm3_run', 'm3_submit'],
      reviewer: ['m3_plan', 'm3_read', 'm3_evidence', 'm3_submit'],
    };
    const actors = {};
    for (const [role, allowed] of Object.entries(roles)) {
      const assignedRoute = route(`${role}-policy-provider`);
      const actor = {id: `${role}-actor`, options: {provider: assignedRoute.provider, model: assignedRoute.model, reasoningEffort: assignedRoute.effort}};
      actors[role] = actor; live.add(actor); authorized.add(actor);
      const scoped = new Map(allowed.map(name => [name, definitions[name]]));
      scopedRegistry.set(actor, scoped);
      const lease = policy.enroll(actor, {role, definitions: allowed.map(name => definitions[name]), route: assignedRoute});
      leases.set(actor, lease);
      for (const name of allowed) assert.equal(scoped.get(name), definitions[name], 'registry preserves exact definition identity');
    }
    const execute = (actor, name) => {
      const exec = {agent: actor, name, signal: new AbortController().signal};
      const refusal = policy.guard(exec);
      if (refusal) throw Object.assign(new Error(refusal), {code: refusal});
      const definition = scopedRegistry.get(actor)?.get(name) ?? globalRegistry.get(name);
      return definition.body(exec);
    };
    for (const role of Object.keys(roles)) {
      for (const denied of ['m3_file', 'write', 'edit', 'pwsh']) {
        assert.throws(() => execute(actors[role], denied), {code: 'PROBE_UNKNOWN_TOOL'});
      }
      execute(actors[role], 'm3_plan');
      execute(actors[role], 'm3_submit');
    }
    execute(actors.validator, 'm3_read');
    execute(actors.reviewer, 'm3_read');
    execute(actors.validator, 'm3_run');
    assert.throws(() => execute(actors.reviewer, 'm3_run'), {code: 'PROBE_UNKNOWN_TOOL'});
    assert.throws(() => execute(actors['plan-review'], 'm3_read'), {code: 'PROBE_UNKNOWN_TOOL'});
    const foreign = {...actors.validator, options: {...actors.validator.options}};
    assert.throws(() => execute(foreign, 'm3_run'), {code: 'V2_UNKNOWN_ACTOR'});
    assert.equal(sentinels.m3_run, 1);
    assert.equal(sentinels.m3_read, 2);
    assert.equal(sentinels.m3_submit, 3);
    assert.equal(sentinels.m3_file + sentinels.write + sentinels.edit + sentinels.pwsh, 0);
  } finally {
    policy.dispose();
  }
});

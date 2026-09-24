// Offline policy fixtures, not evidence of real-host dispatch or OS confinement.
// Sentinels are actual body-side counters; no disk, timers, processes or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createProbePolicy} from '../src/governance/policy.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(yes => {resolve = yes;});
  return {promise, resolve};
};
const refusal = code => ({code});

function fixture(t) {
  const agent = {id: 'actor', scope: {id: 'not-the-agent'}}, registry = new Map();
  const scopes = new WeakMap(), lookups = [], sentinel = {permitted: 0, forbidden: 0};
  const resolveDefinition = (name, actor) => {
    lookups.push({name, actor});
    return scopes.get(actor)?.get(name) ?? registry.get(name);
  };
  const policy = createProbePolicy({resolveDefinition});
  t.after(() => policy.dispose());
  let lease;
  const permitted = {name: 'probe_read', body(exec) {
    policy.assert(exec, permitted, lease);
    sentinel.permitted++;
  }};
  const forbidden = {name: 'raw_write', body() {sentinel.forbidden++;}};
  registry.set(permitted.name, permitted); registry.set(forbidden.name, forbidden);
  lease = policy.enroll(agent, {role: 'reviewer', definitions: [permitted]});
  const execution = (overrides = {}) => ({agent, name: permitted.name, arguments: {},
    signal: new AbortController().signal, token: {}, ...overrides});
  const dispatch = (exec, {guard = true} = {}) => {
    const denied = guard && policy.guard(exec);
    if (denied) throw Object.assign(new Error(denied), {code: denied});
    return resolveDefinition(exec.name, exec.agent).body(exec);
  };
  return {agent, registry, scopes, lookups, sentinel, policy, permitted, forbidden,
    lease, execution, dispatch};
}

test('exact enrolled actor, definition and lease permit a real body side effect', t => {
  const f = fixture(t), exec = f.execution();
  assert.equal(f.policy.guard(exec), undefined, 'allow is synchronous undefined');
  const metadata = f.policy.assert(exec, f.permitted, f.lease);
  assert.deepEqual(metadata, {role: 'reviewer', generation: 1});
  assert.equal(Object.isFrozen(metadata), true);
  assert.equal(Object.isFrozen(f.lease), true);
  assert.equal(Object.getPrototypeOf(f.lease), null);
  assert.deepEqual(Object.keys(f.lease), [], 'lease exposes no model authority fields');
  f.dispatch(exec);
  assert.deepEqual(f.sentinel, {permitted: 1, forbidden: 0});
  assert.ok(f.lookups.every(({actor}) => actor === f.agent), 'scope lookup receives exact Agent');
});

test('negative control executes forbidden counter without guard; guarded entry blocks it', t => {
  const f = fixture(t), exec = f.execution({name: f.forbidden.name});
  f.dispatch(exec, {guard: false});
  assert.equal(f.sentinel.forbidden, 1, 'fixture really can execute the forbidden body');
  assert.throws(() => f.dispatch(exec), refusal('PROBE_UNKNOWN_TOOL'));
  assert.equal(f.sentinel.forbidden, 1, 'denial leaves the sentinel unchanged');
  f.dispatch(f.execution());
  assert.equal(f.sentinel.permitted, 1);
});

test('identity strings and same-ID foreign actor objects do not impersonate enrollment', t => {
  const f = fixture(t);
  for (const actor of [f.agent.id, {id: f.agent.id}, {...f.agent}, null]) {
    const code = typeof actor === 'object' && actor ? 'PROBE_UNKNOWN_ACTOR' : 'PROBE_INVALID_EXECUTION';
    const exec = f.execution({agent: actor, arguments: {actor: f.agent.id, role: 'reviewer'}});
    assert.throws(() => f.dispatch(exec), refusal(code));
    assert.throws(() => f.policy.assert(exec, f.permitted, f.lease), refusal(code));
  }
  assert.deepEqual(f.sentinel, {permitted: 0, forbidden: 0});
  f.dispatch(f.execution());
  assert.equal(f.sentinel.permitted, 1);
});

test('model argument name, identity, role and lease fields cannot grant authority', t => {
  const f = fixture(t);
  const spoof = {name: f.permitted.name, agent: f.agent.id, actor: f.agent.id,
    role: 'reviewer', generation: 1, lease: {}, phase: 'ACTIVE'};
  assert.throws(() => f.dispatch(f.execution({name: f.forbidden.name, arguments: spoof})),
    refusal('PROBE_UNKNOWN_TOOL'));
  assert.throws(() => f.dispatch(f.execution({name: 'unknown', arguments: spoof})),
    refusal('PROBE_UNKNOWN_TOOL'));
  // Even hostile-looking arguments cannot rename an otherwise permitted execution.
  f.dispatch(f.execution({arguments: {name: 'raw_write', role: 'implementer'}}));
  assert.deepEqual(f.sentinel, {permitted: 1, forbidden: 0});
});

test('same-name foreign definition object is not its trusted registration', t => {
  const f = fixture(t), foreign = {name: f.permitted.name, body: f.forbidden.body};
  f.registry.set(foreign.name, foreign);
  assert.throws(() => f.dispatch(f.execution()), refusal('PROBE_DEFINITION_CHANGED'));
  assert.equal(f.sentinel.forbidden, 0);
  f.registry.set(f.permitted.name, f.permitted);
  assert.equal(f.policy.guard(f.execution()), 'PROBE_ACTOR_REVOKED', 'restoration cannot renew authority');
});

test('effective Agent-scoped shadow denies even when global registration is trusted', t => {
  const f = fixture(t), foreign = {name: f.permitted.name, body: f.forbidden.body};
  f.dispatch(f.execution());
  f.scopes.set(f.agent, new Map([[foreign.name, foreign]]));
  assert.throws(() => f.dispatch(f.execution()), refusal('PROBE_DEFINITION_CHANGED'));
  assert.equal(f.registry.get(f.permitted.name), f.permitted);
  assert.deepEqual(f.sentinel, {permitted: 1, forbidden: 0});
});

test('definition removal or renamed registration permanently loses readiness', async t => {
  for (const changed of ['removed', 'renamed']) {
    await t.test(changed, t => {
      const f = fixture(t), exec = f.execution();
      assert.equal(f.policy.guard(exec), undefined);
      if (changed === 'removed') f.registry.delete(f.permitted.name);
      else f.permitted.name = 'different-name';
      assert.throws(() => f.policy.assert(exec, f.permitted, f.lease), refusal('PROBE_DEFINITION_CHANGED'));
      assert.equal(f.policy.guard(exec), 'PROBE_ACTOR_REVOKED');
      assert.equal(f.sentinel.permitted, 0);
    });
  }
});

test('resolver errors and asynchronous lookup results fail closed', async t => {
  for (const resolveDefinition of [() => {throw new Error('not ready');}, () => Promise.resolve({})]) {
    await t.test('unavailable exact definition', t => {
      const policy = createProbePolicy({resolveDefinition}), agent = {}, definition = {name: 'read'};
      t.after(() => policy.dispose());
      const lease = policy.enroll(agent, {role: 'reviewer', definitions: [definition]});
      const exec = {agent, name: 'read'};
      assert.match(policy.guard(exec), /^PROBE_DEFINITION_(UNAVAILABLE|CHANGED)$/);
      assert.throws(() => policy.assert(exec, definition, lease), refusal('PROBE_ACTOR_REVOKED'));
    });
  }
});

test('body assertions require own exact definition and own opaque lease', t => {
  const f = fixture(t), exec = f.execution(), other = {};
  const otherLease = f.policy.enroll(other, {role: 'implementer', definitions: [f.forbidden]});
  for (const lease of [undefined, {}, {...f.lease}, otherLease, f.agent.id]) {
    assert.throws(() => f.policy.assert(exec, f.permitted, lease), refusal('PROBE_LEASE_MISMATCH'));
  }
  assert.throws(() => f.policy.assert(exec, {...f.permitted}, f.lease), refusal('PROBE_DEFINITION_MISMATCH'));
  assert.throws(() => f.policy.assert(exec, f.forbidden, f.lease), refusal('PROBE_DEFINITION_MISMATCH'));
  assert.equal(f.policy.guard(f.execution({agent: other})), 'PROBE_UNKNOWN_TOOL');
  assert.equal(f.policy.guard(f.execution({agent: other, name: f.forbidden.name})), undefined);
  f.dispatch(exec);
  assert.equal(f.sentinel.permitted, 1);
});

test('trusted enrollment copies permission list and cannot overwrite an existing actor', t => {
  const f = fixture(t), agent = {}, definitions = [f.permitted];
  const lease = f.policy.enroll(agent, {role: 'assessor', definitions});
  definitions.push(f.forbidden); definitions[0] = f.forbidden;
  assert.equal(f.policy.guard(f.execution({agent, name: f.forbidden.name})), 'PROBE_UNKNOWN_TOOL');
  assert.deepEqual(f.policy.assert(f.execution({agent}), f.permitted, lease), {role: 'assessor', generation: 1});
  assert.throws(() => f.policy.enroll(agent, {role: 'implementer', definitions: [f.forbidden]}),
    refusal('PROBE_ALREADY_ENROLLED'));
});

test('malformed trusted enrollments and malformed executions do not open authority', t => {
  assert.throws(() => createProbePolicy(), TypeError);
  const f = fixture(t);
  for (const agent of ['actor', null, [], 1]) {
    assert.throws(() => f.policy.enroll(agent, {role: 'reviewer', definitions: [f.permitted]}), TypeError);
  }
  for (const options of [{}, {role: '', definitions: [f.permitted]}, {role: 'reviewer', definitions: []},
    {role: 'reviewer', definitions: ['probe_read']},
    {role: 'reviewer', definitions: [f.permitted, {...f.permitted}]}]) {
    assert.throws(() => f.policy.enroll({}, options), TypeError);
  }
  for (const exec of [undefined, null, [], {}, {agent: 'actor'}]) {
    assert.equal(f.policy.guard(exec), 'PROBE_INVALID_EXECUTION');
  }
  f.dispatch(f.execution());
  assert.equal(f.sentinel.permitted, 1);
});

test('disposed identities stay retired, including disposal before enrollment', t => {
  const f = fixture(t), neverEnrolled = {};
  f.dispatch(f.execution());
  assert.equal(f.policy.revokeActor(f.agent), true);
  assert.equal(f.policy.revokeActor(f.agent), false);
  assert.throws(() => f.dispatch(f.execution()), refusal('PROBE_ACTOR_REVOKED'));
  assert.throws(() => f.policy.enroll(f.agent, {role: 'reviewer', definitions: [f.permitted]}),
    refusal('PROBE_ACTOR_REVOKED'));
  f.policy.revokeActor(neverEnrolled);
  assert.throws(() => f.policy.enroll(neverEnrolled, {role: 'reviewer', definitions: [f.permitted]}),
    refusal('PROBE_ACTOR_REVOKED'));
  assert.throws(() => f.policy.revokeActor(f.agent.id), TypeError);
  assert.equal(f.sentinel.permitted, 1);
});

test('global revoke and disposal are terminal with no model-callable reset API', t => {
  const f = fixture(t), exec = f.execution(), admission = f.policy.bind(exec, f.permitted, f.lease);
  assert.equal(f.policy.revoke(), true); assert.equal(f.policy.revoke(), false);
  assert.equal(f.policy.guard(exec), 'PROBE_POLICY_REVOKED');
  assert.throws(() => f.policy.assert(exec, f.permitted, f.lease), refusal('PROBE_POLICY_REVOKED'));
  assert.throws(() => f.policy.check(admission, exec, f.permitted), refusal('PROBE_STALE_ADMISSION'));
  assert.throws(() => f.policy.enroll({}, {role: 'reviewer', definitions: [f.permitted]}),
    refusal('PROBE_POLICY_REVOKED'));
  assert.equal(f.policy.dispose(), true); assert.equal(f.policy.dispose(), false);
  assert.equal(f.policy.revoke(), false);
  assert.equal(f.policy.guard(exec), 'PROBE_POLICY_DISPOSED');
  assert.throws(() => f.policy.assert(exec, f.permitted, f.lease), refusal('PROBE_POLICY_DISPOSED'));
  assert.throws(() => f.policy.enroll({}, {role: 'reviewer', definitions: [f.permitted]}),
    refusal('PROBE_POLICY_DISPOSED'));
  assert.equal(Object.isFrozen(f.policy), true);
  assert.deepEqual(Object.keys(f.policy).sort(),
    ['assert', 'bind', 'check', 'dispose', 'enroll', 'guard', 'revoke', 'revokeActor'].sort());
  assert.deepEqual(f.sentinel, {permitted: 0, forbidden: 0});
});

test('admissions cannot be copied, supplied by another policy or rebound to another execution', t => {
  const f = fixture(t), other = fixture(t), exec = f.execution();
  const admission = f.policy.bind(exec, f.permitted, f.lease);
  for (const forged of [{}, {...admission}, undefined, '1']) {
    assert.throws(() => f.policy.check(forged, exec, f.permitted), refusal('PROBE_UNKNOWN_ADMISSION'));
  }
  assert.throws(() => other.policy.check(admission, exec, f.permitted), refusal('PROBE_UNKNOWN_ADMISSION'));
  assert.deepEqual(f.policy.check(admission, exec, f.permitted), {role: 'reviewer', generation: 1});
  assert.throws(() => f.policy.check(admission, {...exec}, f.permitted), refusal('PROBE_EXECUTION_CHANGED'));
  assert.throws(() => f.policy.check(admission, exec, f.permitted), refusal('PROBE_UNKNOWN_ADMISSION'));
});

test('bound actor, execution name, signal and body definition cannot change after admission', async t => {
  for (const field of ['agent', 'name', 'signal', 'definition']) {
    await t.test(field, t => {
      const f = fixture(t), exec = f.execution(), admission = f.policy.bind(exec, f.permitted, f.lease);
      let definition = f.permitted;
      if (field === 'agent') exec.agent = {id: f.agent.id};
      if (field === 'name') exec.name = f.forbidden.name;
      if (field === 'signal') exec.signal = new AbortController().signal;
      if (field === 'definition') definition = {...definition};
      assert.throws(() => f.policy.check(admission, exec, definition), refusal('PROBE_EXECUTION_CHANGED'));
      assert.equal(f.sentinel.permitted, 0);
    });
  }
});

test('body rechecks revocation after guard succeeds but before body starts', async t => {
  const f = fixture(t), exec = f.execution(), entered = deferred(), release = deferred();
  const pending = (async () => {
    assert.equal(f.policy.guard(exec), undefined);
    entered.resolve(); await release.promise;
    f.permitted.body(exec);
  })();
  t.after(async () => {release.resolve(); await Promise.allSettled([pending]);});
  const rejected = assert.rejects(pending, refusal('PROBE_ACTOR_REVOKED'));
  await entered.promise;
  f.policy.revokeActor(f.agent); release.resolve(); await rejected;
  assert.equal(f.sentinel.permitted, 0);
});

test('barrier-held body checks its captured admission immediately before side effect', async t => {
  const cases = [
    ['valid', () => {}, undefined],
    ['actor revoked', f => f.policy.revokeActor(f.agent), 'PROBE_ACTOR_REVOKED'],
    ['generation revoked', f => f.policy.revoke(), 'PROBE_STALE_ADMISSION'],
    ['disposed', f => f.policy.dispose(), 'PROBE_STALE_ADMISSION'],
    ['definition swapped', f => f.registry.set(f.permitted.name, {name: f.permitted.name}), 'PROBE_DEFINITION_CHANGED'],
    ['aborted', (_f, controller) => controller.abort(), 'PROBE_ABORTED'],
  ];
  for (const [name, change, code] of cases) {
    await t.test(name, async t => {
      const f = fixture(t), controller = new AbortController(), exec = f.execution({signal: controller.signal});
      const entered = deferred(), release = deferred();
      const pending = (async () => {
        assert.equal(f.policy.guard(exec), undefined);
        const admission = f.policy.bind(exec, f.permitted, f.lease);
        entered.resolve(); await release.promise;
        f.policy.check(admission, exec, f.permitted);
        f.sentinel.permitted++;
      })();
      t.after(async () => {release.resolve(); await Promise.allSettled([pending]);});
      const settled = code ? assert.rejects(pending, refusal(code)) : pending;
      await entered.promise;
      assert.equal(f.sentinel.permitted, 0, 'body is held before the side effect');
      change(f, controller); release.resolve(); await settled;
      assert.equal(f.sentinel.permitted, code ? 0 : 1);
    });
  }
});

test('revocation from synchronous resolver is rechecked before allow', async t => {
  for (const action of ['revoke', 'dispose', 'revokeActor']) {
    await t.test(action, t => {
      const agent = {}, definition = {name: 'read'};
      const policy = createProbePolicy({resolveDefinition() {policy[action](agent); return definition;}});
      t.after(() => policy.dispose());
      const lease = policy.enroll(agent, {role: 'reviewer', definitions: [definition]});
      const exec = {agent, name: definition.name};
      assert.notEqual(policy.guard(exec), undefined);
      const code = action === 'revokeActor' ? 'PROBE_ACTOR_REVOKED' :
        action === 'revoke' ? 'PROBE_POLICY_REVOKED' : 'PROBE_POLICY_DISPOSED';
      assert.throws(() => policy.assert(exec, definition, lease), refusal(code));
    });
  }
});


import {createStagePolicyV2} from '../src/governance/policy.mjs';
function stagePolicyFixture(){
  const route={provider:'author-provider',model:'fixture',effort:'none'},agent={id:'observed',options:{provider:route.provider,model:route.model,reasoningEffort:route.effort}};
  let live=true,authorized=true;const definition={name:'m3_file'},defs=new Map([[definition.name,definition]]);
  const policy=createStagePolicyV2({resolveDefinition:n=>defs.get(n),isLive:a=>live&&a===agent,authorize:()=>authorized});
  const lease=policy.enroll(agent,{role:'author',definitions:[definition],route}),exec={agent,name:definition.name,signal:new AbortController().signal};
  return{route,agent,definition,defs,policy,lease,exec,setLive:v=>live=v,setAuthorized:v=>authorized=v};
}
test('M3 required policy binds observed actor route and exact definition with no raw fallback',()=>{
  const f=stagePolicyFixture();assert.equal(f.policy.guard(f.exec),undefined);f.policy.assert(f.exec,f.definition,f.lease);
  assert.throws(()=>f.policy.assert({...f.exec,name:'pwsh'},f.definition,f.lease),{code:'PROBE_UNKNOWN_TOOL'});
  assert.throws(()=>f.policy.assert({...f.exec,agent:{...f.agent}},f.definition,f.lease),{code:'V2_UNKNOWN_ACTOR'});
  f.agent.options.model='changed';assert.throws(()=>f.policy.assert(f.exec,f.definition,f.lease),{code:'V2_ROUTE_CHANGED'});
  f.agent.options.model=f.route.model;f.defs.set(f.definition.name,{name:f.definition.name});assert.throws(()=>f.policy.assert(f.exec,f.definition,f.lease),{code:'PROBE_DEFINITION_CHANGED'});
  f.defs.set(f.definition.name,f.definition);assert.throws(()=>f.policy.assert(f.exec,f.definition,f.lease),{code:'PROBE_ACTOR_REVOKED'});
  f.policy.dispose();
});
test('M3 required policy rechecks authority and live registry at body boundary',()=>{
  for(const setter of ['setLive','setAuthorized']){const f=stagePolicyFixture();assert.equal(f.policy.guard(f.exec),undefined);f[setter](false);
    assert.throws(()=>f.policy.assert(f.exec,f.definition,f.lease),{code:setter==='setLive'?'V2_ACTOR_NOT_LIVE':'V2_AUTHORITY_REFUSED'});f.policy.dispose();}
  const f=stagePolicyFixture();f.policy.revoke();assert.throws(()=>f.policy.assert(f.exec,f.definition,f.lease),{code:'PROBE_POLICY_REVOKED'});f.policy.dispose();
});
test('M3 required policy refuses async authority instead of treating Promise as permission',()=>{
  const agent={options:{provider:'a',model:'b',reasoningEffort:'c'}},definition={name:'m3_read'};
  const p=createStagePolicyV2({resolveDefinition:()=>definition,isLive:()=>true,authorize:()=>Promise.resolve(true)}),lease=p.enroll(agent,{role:'reviewer',route:{provider:'a',model:'b',effort:'c'},definitions:[definition]});
  assert.throws(()=>p.assert({agent,name:'m3_read'},definition,lease),{code:'V2_AUTHORITY_REFUSED'});p.dispose();
});

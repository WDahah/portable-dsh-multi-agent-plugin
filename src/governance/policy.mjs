// M0 probe only: trusted host code owns enrollment, leases and lifecycle. Never expose
// this object or its leases as model tools/arguments. Roles label trusted enrollments;
// each enrollment's exact definitions, not its role string, determine its permissions.
//
// resolveDefinition(name, agent) must synchronously return the effective scoped tool
// definition (for example tools.get(name, agent)). guard(exec) returns string|undefined.
// Bodies capture their own definition and enrollment lease, then use:
//   assert(exec, definition, lease) immediately before a synchronous side effect; or
//   const admission = bind(exec, definition, lease);
//   await ownedWork;
//   check(admission, exec, definition); // immediately before each side effect
// There must be no await between the final check and the protected side effect.
//
// ACTIVE -> REVOKED -> DISPOSED is terminal and monotonic. No renewal/reset is offered.
// The adapter must call revokeActor on Agent disposal and dispose on policy teardown.
// This helper neither drains work nor confines processes/files. A guard cannot protect
// a foreign unguarded body swapped in by trusted host code after lookup; the host probe
// must establish dispatch identity behavior separately. Hostile plugins are out of scope.

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
const opaque = () => Object.freeze(Object.create(null));
const fail = code => {throw Object.assign(new Error(code), {code});};

export function createProbePolicy({resolveDefinition} = {}) {
  if (typeof resolveDefinition !== 'function') throw new TypeError('resolveDefinition must be synchronous');
  const actors = new WeakMap(), retired = new WeakSet(), admissions = new WeakMap();
  let phase = 'ACTIVE', generation = 1;

  const phaseDenial = () => phase === 'ACTIVE' ? undefined : `PROBE_POLICY_${phase}`;
  const retire = (agent, code) => {retired.add(agent); return code;};

  function denial(exec, definition, lease, body = false) {
    const closed = phaseDenial();
    if (closed) return closed;
    if (!object(exec) || !object(exec.agent)) return 'PROBE_INVALID_EXECUTION';
    const agent = exec.agent, record = actors.get(agent);
    if (retired.has(agent)) return 'PROBE_ACTOR_REVOKED';
    if (!record) return 'PROBE_UNKNOWN_ACTOR';
    if (exec.signal?.aborted) return 'PROBE_ABORTED';
    const name = exec.name, expected = record.definitions.get(name);
    if (!expected) return 'PROBE_UNKNOWN_TOOL';
    if (body && lease !== record.lease) return 'PROBE_LEASE_MISMATCH';
    if (body && definition !== expected) return 'PROBE_DEFINITION_MISMATCH';
    if (expected.name !== name) return retire(agent, 'PROBE_DEFINITION_CHANGED');
    let effective;
    try {effective = resolveDefinition(name, agent);}
    catch {return retire(agent, 'PROBE_DEFINITION_UNAVAILABLE');}
    if (effective !== expected) return retire(agent, 'PROBE_DEFINITION_CHANGED');
    // A synchronous resolver may call host lifecycle hooks; do not admit a lease it
    // revoked while looking up the definition.
    return phaseDenial() || (retired.has(agent) ? 'PROBE_ACTOR_REVOKED' : undefined);
  }

  function enroll(agent, {role, definitions} = {}) {
    const closed = phaseDenial();
    if (closed) fail(closed);
    if (!object(agent)) throw new TypeError('enroll requires an exact Agent object');
    if (retired.has(agent)) fail('PROBE_ACTOR_REVOKED');
    if (actors.has(agent)) fail('PROBE_ALREADY_ENROLLED');
    if (!text(role)) throw new TypeError('enroll requires a trusted role');
    if (!Array.isArray(definitions) || definitions.length === 0) {
      throw new TypeError('enroll requires exact definition objects');
    }
    const allowed = new Map();
    for (const definition of definitions) {
      if (!object(definition) || !text(definition.name)) throw new TypeError('Invalid definition');
      if (allowed.has(definition.name)) throw new TypeError('Duplicate definition name');
      allowed.set(definition.name, definition);
    }
    const lease = opaque();
    actors.set(agent, {lease, definitions: allowed, metadata: Object.freeze({role, generation})});
    return lease;
  }

  function guard(exec) {
    return denial(exec);
  }

  function assert(exec, definition, lease) {
    const refused = denial(exec, definition, lease, true);
    if (refused) fail(refused);
    return actors.get(exec.agent).metadata;
  }

  function bind(exec, definition, lease) {
    assert(exec, definition, lease);
    const admission = opaque();
    admissions.set(admission, {exec, agent: exec.agent, name: exec.name,
      signal: exec.signal, definition, lease, generation});
    return admission;
  }

  function check(admission, exec, definition) {
    const saved = object(admission) && admissions.get(admission);
    if (!saved) fail('PROBE_UNKNOWN_ADMISSION');
    if (saved.generation !== generation) fail('PROBE_STALE_ADMISSION');
    if (exec !== saved.exec || exec.agent !== saved.agent || exec.name !== saved.name ||
        exec.signal !== saved.signal || definition !== saved.definition) {
      admissions.delete(admission);
      fail('PROBE_EXECUTION_CHANGED');
    }
    return assert(exec, definition, saved.lease);
  }

  function revokeActor(agent) {
    if (!object(agent)) throw new TypeError('revokeActor requires an exact Agent object');
    const changed = !retired.has(agent);
    retired.add(agent);
    return changed;
  }

  function revoke() {
    if (phase !== 'ACTIVE') return false;
    phase = 'REVOKED'; generation++;
    return true;
  }

  function dispose() {
    if (phase === 'DISPOSED') return false;
    phase = 'DISPOSED'; generation++;
    return true;
  }

  return Object.freeze({enroll, guard, assert, bind, check, revokeActor, revoke, dispose});
}

/** Required-stage policy; trusted host setup owns the exact actor and definitions. */
export function createStagePolicyV2({resolveDefinition,isLive,authorize}) {
  if(typeof isLive!=='function'||typeof authorize!=='function')throw new TypeError('V2 policy requires synchronous authority and liveness');
  const base=createProbePolicy({resolveDefinition}), records=new WeakMap();
  function extra(exec){
    const r=records.get(exec?.agent);if(!r)return 'V2_UNKNOWN_ACTOR';
    try{
      const authority=authorize(exec.agent);
      if(authority&&typeof authority.then==='function'){Promise.resolve(authority).catch(()=>{});return 'V2_AUTHORITY_REFUSED';}
      if(authority!==true)return 'V2_AUTHORITY_REFUSED';
      const refusal=base.guard(exec);if(refusal)return refusal;
      if(isLive(exec.agent)!==true)return 'V2_ACTOR_NOT_LIVE';
      const options=exec.agent.options;
      if(options.provider!==r.provider||options.model!==r.model||options.reasoningEffort!==r.effort)return 'V2_ROUTE_CHANGED';
    }catch{return 'V2_AUTHORITY_REFUSED';}
    return undefined;
  }
  return Object.freeze({
    enroll(agent,{role,definitions,route}){
      if(!route||agent.options.provider!==route.provider||agent.options.model!==route.model||agent.options.reasoningEffort!==route.effort)fail('V2_ROUTE_CHANGED');
      const lease=base.enroll(agent,{role,definitions});records.set(agent,{provider:route.provider,model:route.model,effort:route.effort});return lease;
    },
    guard:extra,
    assert(exec,definition,lease){const refusal=extra(exec);if(refusal)fail(refusal);const metadata=base.assert(exec,definition,lease);const final=extra(exec);if(final)fail(final);return metadata;},
    revokeActor:base.revokeActor,revoke:base.revoke,dispose:base.dispose,
  });
}

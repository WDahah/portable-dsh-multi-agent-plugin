// Runtime overlay, not an amendment to the historical API catalog.
import {evidenceIdOf} from './qualification.mjs';

export const POLICY_VERSION = 'orchestration-v3-routes-1';
const freeze = value => {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const standard = {standard: 'medium', deep: 'high', long: 'xhigh'};
const thinking = {standard: 'high', deep: 'high', long: 'max'};
const price = {currency: 'USD', inputPerMillion: 0.30, outputPerMillion: 1.20, kind: 'conservative-estimate', currentPriceVerified: false};
function route(id, candidateId, provider, model, pools, note, image = false) {
  // A route in no pool is a declared reserve, not a broken entry: it can never be selected
  // automatically, and only an explicit pool choice or a policy change would activate it.
  return {id, candidateId, provider, model, pools, reserve: pools.length === 0,
    effortsExpected: provider === 'codex' || provider === 'claude' ? {...standard} : {...thinking},
    capabilitiesRequired: image ? ['text', 'tools', 'image'] : ['text', 'tools'],
    pricing: provider === 'deepseek-official' && ['deepseek-flash', 'deepseek-v4-flash'].includes(model) ? {...price} : null,
    immutableModelVersion: false, historicalQualificationTransferred: false,
    surface: provider === 'deepseek-official' ? 'official-api' : 'subscription', mappingNote: note};
}
export const ROUTES = freeze([
  route('codex-luna', 'openai-luna', 'codex', 'gpt-5.6-luna', ['economy'], 'API candidate to Codex subscription surface; new qualification required.'),
  route('codex-terra', 'openai-terra', 'codex', 'gpt-5.6-terra', ['balanced'], 'API candidate to Codex subscription surface; new qualification required.'),
  route('codex-sol', 'openai-sol', 'codex', 'gpt-5.6-sol', ['advanced'], 'API candidate to Codex subscription surface; new qualification required.'),
  route('codex-astra', 'openai-astra', 'codex', 'gpt-6-astra', ['long-horizon'], 'API candidate to Codex subscription surface; effort expectations are not measured support.'),
  route('claude-sonnet', 'claude-sonnet', 'claude', 'claude-sonnet-5', ['balanced'], 'Anthropic API candidate to Claude subscription surface.'),
  route('claude-opus', 'claude-opus', 'claude', 'claude-opus-5', ['advanced'], 'Anthropic API candidate to Claude subscription surface.'),
  route('claude-fable', 'claude-fable', 'claude', 'claude-fable-5-1', ['long-horizon'], 'Exact requested model string on Claude subscription; moving backend not pinned.'),
  route('deepseek-v41-flash', 'deepseek-v41-label', 'deepseek-official', 'deepseek-flash', ['balanced'], 'Display label V4.1 Flash; runtime model string only, not immutable backend identity.'),
  route('deepseek-v4-flash', 'deepseek-v4-flash', 'deepseek-official', 'deepseek-v4-flash', ['economy'], 'Exact legacy model string; backend version not inferred.'),
  route('deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-official', 'deepseek-v4-pro', [], 'Declared inventory reserve; no automatic pool assignment.'),
  route('deepseek-v4-vision', null, 'deepseek-official', 'deepseek-v4-flash-vision-exp', ['vision'], 'Actual V4 vision route is NOT the unresolved historical V4.1 vision label; reachable only through an explicit vision pool and a passed image probe.', true),
  route('kimi-k3', 'kimi-k3', 'kimi-coding', 'k3', ['advanced', 'long-horizon'], 'Open Platform kimi-k3 candidate to Kimi Coding subscription k3.'),
  route('kimi-k3-256k', 'kimi-k3-256-label', 'kimi-coding', 'k3-256k', [], 'Explicit nearby spelling resolution for this overlay only; reserve route.'),
  route('kimi-coding', 'kimi-k27', 'kimi-coding', 'kimi-for-coding', [], 'Explicit surface/model replacement, NOT identity equivalence to historical K2.7; reserve route.'),
  route('kimi-highspeed', 'kimi-highspeed', 'kimi-coding', 'kimi-for-coding-highspeed', [], 'Subscription surface change; reserve route, not historical qualification.')
]);
export const UNAVAILABLE_CANDIDATES = freeze([
  {candidateId: 'deepseek-v41-vision-label', reason: 'UNMAPPED_V41_VISION_LABEL', provider: null, model: null}
]);
export const POOL_PRIORITY = freeze({
  economy: ['codex-luna', 'deepseek-v4-flash'],
  balanced: ['codex-terra', 'claude-sonnet', 'deepseek-v41-flash'],
  advanced: ['codex-sol', 'claude-opus', 'kimi-k3'],
  'long-horizon': ['claude-fable', 'codex-astra', 'kimi-k3'],
  // Explicit-only: image work still routes through ordinary pools when those routes pass
  // an image probe. This pool exists for deliberately choosing the dedicated vision model.
  vision: ['deepseek-v4-vision']
});
/** Roles name what the selector actually does, so a reader can predict the routing from
 * the label. Anything a role cannot decide belongs in `intent`, which is recorded and
 * never routed — a name that does not change behavior would only mislead. */
export const ROLES = Object.freeze({
  standard: {pool: 'balanced', domain: false, image: false, describes: 'Ordinary work: the balanced pool at standard effort.'},
  deep: {pool: 'advanced', domain: false, image: false, describes: 'Work worth a stronger model: the advanced pool at deep effort.'},
  review: {pool: 'advanced', domain: false, image: false, describes: 'Judging another run. Routes like deep and prefers a different provider from the run under review.'},
  vision: {pool: 'balanced', domain: false, image: true, describes: 'Work whose input is an image. Requires a passed image probe.'},
  domain: {pool: 'advanced', domain: true, image: false, describes: 'Specialist field. Requires an operator attestation; no probe can grant it.'},
});
export const ROLE_NAMES = Object.freeze(Object.keys(ROLES));
/** The numeric codes shipped since 1.0.0. Five were never documented anywhere, so each
 * maps to the behavior it already produced rather than to an invented meaning. */
export const ROLE_ALIASES = Object.freeze({
  R01: 'standard', R02: 'standard', R04: 'standard', R06: 'standard', R10: 'standard', R11: 'standard',
  R03: 'deep', R07: 'review', R12: 'deep',
  R05: 'vision',
  R08: 'domain', R09: 'domain',
});
/** Resolve a role to its canonical name, reporting whether a deprecated code was used. */
export function resolveRole(role) {
  if (typeof role !== 'string') return null;
  if (Object.hasOwn(ROLES, role)) return {role, deprecated: false, supplied: role};
  if (Object.hasOwn(ROLE_ALIASES, role)) return {role: ROLE_ALIASES[role], deprecated: true, supplied: role};
  return null;
}
const allowedCapabilities = new Set(['text', 'tools', 'image', 'structured-output', 'video']);
const nonempty = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
// Ordinary smoke evidence admits only these; wider classes require an attestation.
export const BASE_DATA_CLASSES = Object.freeze(['public', 'internal']);
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function expectedEffort(routeOrId, pool) {
  const entry = typeof routeOrId === 'string' ? ROUTES.find(r => r.id === routeOrId) : routeOrId;
  if (!entry || !Object.hasOwn(POOL_PRIORITY, pool)) throw new TypeError('Unknown route or pool');
  // vision and the remaining pools use the standard tier; only advanced/long escalate.
  return entry.effortsExpected[pool === 'long-horizon' ? 'long' : pool === 'advanced' ? 'deep' : 'standard'];
}
function taskPolicy(task) {
  const resolved = task ? resolveRole(task.role) : null;
  if (!task || !resolved || !nonempty(task.category) ||
      !['low', 'medium', 'high', 'critical'].includes(task.risk) ||
      !['routine', 'moderate', 'complex'].includes(task.complexity) || typeof task.escalate !== 'boolean') return null;
  // intent records what the caller meant; it never routes, so it is free text.
  if (task.intent !== undefined && !nonempty(task.intent, 200)) return null;
  if (task.pool !== undefined && !Object.hasOwn(POOL_PRIORITY, task.pool)) return null;
  if (task.dataClass !== undefined && !['public', 'internal', 'confidential', 'restricted'].includes(task.dataClass)) return null;
  if (task.capabilities !== undefined && (!Array.isArray(task.capabilities) || task.capabilities.some(c => !allowedCapabilities.has(c)))) return null;
  const advanced = ROLES[resolved.role].pool === 'advanced';
  const normal = task.escalate ? 'long-horizon' : advanced || ['high', 'critical'].includes(task.risk) || task.complexity === 'complex' ? 'advanced' : 'balanced';
  // Explicit pool is a deliberate policy override, never an unavailable-route fallback.
  return {role: resolved, pool: task.pool ?? normal,
    reason: task.pool ? 'EXPLICIT_POOL' : task.escalate ? 'ESCALATED' : normal === 'advanced' ? 'ROLE_OR_RISK_OR_COMPLEXITY' : 'BALANCED_DEFAULT'};
}
function recordReason(q, route, effort, task, now, roleName) {
  if (q.schemaVersion !== 1 || q.qualificationType !== 'smoke' || q.issuer?.kind !== 'plugin-service' ||
      q.issuer.service !== 'orchestration-v3' || !nonempty(q.issuer.runtimeId) || !nonempty(q.runtimeBuildId) || !nonempty(q.adapterFingerprint) ||
      !integer(q.issuedAt) || !integer(q.expiresAt) || !integer(q.durationMs) || q.expiresAt <= q.issuedAt ||
      !Array.isArray(q.caseResults) || !Array.isArray(q.allowedDataClasses) || typeof q.domainEvidence !== 'boolean' ||
      ['available', 'transportPassed', 'textPassed', 'toolPassed', 'imagePassed'].some(k => typeof q[k] !== 'boolean')) return 'INVALID_QUALIFICATION';
  // Policy wider than ordinary smoke is only usable with the attestation that authorized
  // it, so a record claiming more without a named author and basis fails closed.
  const widened = q.domainEvidence || q.allowedDataClasses.some(c => !BASE_DATA_CLASSES.includes(c));
  if (widened && (q.attestation?.kind !== 'operator-attestation' ||
      !nonempty(q.attestation.attestedBy) || !nonempty(q.attestation.basis, 2000))) return 'UNATTESTED_POLICY_WIDENING';
  if (q.provider !== route.provider || q.model !== route.model || q.effort !== effort) return 'EXACT_ROUTE_EFFORT_MISMATCH';
  if (q.issuedAt > now) return 'FUTURE_QUALIFICATION';
  if (q.expiresAt <= now) return 'EXPIRED_QUALIFICATION';
  if (!q.available) return 'UNAVAILABLE_AT_PROBE';
  const passed = name => q.caseResults.filter(c => c?.name === name).length === 1 && q.caseResults.some(c => c?.name === name && c.passed === true);
  if (!q.transportPassed || !q.textPassed || !passed('text')) return 'TEXT_OR_TRANSPORT_FAILED';
  if (!q.toolPassed || !passed('native-tool-roundtrip')) return 'NATIVE_TOOL_ROUNDTRIP_REQUIRED';
  const capabilities = new Set([...route.capabilitiesRequired, ...(task.capabilities ?? [])]);
  if (ROLES[roleName].image) capabilities.add('image');
  if (capabilities.has('image') && (!q.imagePassed || !passed('image'))) return 'IMAGE_PROBE_REQUIRED';
  for (const capability of ['structured-output', 'video']) if (capabilities.has(capability) && !passed(capability)) return 'CAPABILITY_PROBE_REQUIRED:' + capability;
  if (!q.allowedDataClasses.includes(task.dataClass ?? 'public')) return 'DATA_CLASS_NOT_QUALIFIED';
  if (ROLES[roleName].domain && !q.domainEvidence) return 'DOMAIN_EVIDENCE_REQUIRED';
  return null;
}
/** Report the canonical role beside whatever the caller supplied, so a deprecated code can
 * be migrated without guessing, and carry intent through unchanged as a recorded label. */
function roleView(policy, task) {
  return {role: policy.role.role, roleSupplied: policy.role.supplied,
    roleDeprecated: policy.role.deprecated, intent: task.intent ?? null};
}
/** Input records are detached data read by the plugin from its private journal, NEVER tool arguments.
 * Schema/provenance labels are not authentication or cryptographic proof. */
export function selectRoute({task, qualifications, now = Date.now(), avoidProvider} = {}) {
  const policy = taskPolicy(task);
  const base = {policyVersion: POLICY_VERSION, softTargetUsd: 1, financialFilter: false, qualificationLevel: 'smoke'};
  if (!policy || !Array.isArray(qualifications) || !integer(now)) return {...base, status: 'UNAVAILABLE', reason: 'INVALID_INPUT', reasons: []};
  const reasons = [];
  // A review of a run should not land on the model that produced it: same model, same
  // blind spots. Candidates from another provider are tried first, but nothing is removed
  // — an unavoidable same-provider review proceeds and says so rather than refusing.
  const candidates = [...POOL_PRIORITY[policy.pool]];
  if (typeof avoidProvider === 'string' && avoidProvider) {
    candidates.sort((a, b) => {
      const sameA = ROUTES.find(r => r.id === a)?.provider === avoidProvider ? 1 : 0;
      const sameB = ROUTES.find(r => r.id === b)?.provider === avoidProvider ? 1 : 0;
      return sameA - sameB;
    });
  }
  for (const id of candidates) {
    const route = ROUTES.find(r => r.id === id), effort = expectedEffort(route, policy.pool);
    const matching = qualifications.filter(q => q && q.provider === route.provider && q.model === route.model && q.effort === effort);
    if (!matching.length) {
      // With no evidence at all, the hint must still name every capability this task will
      // need, or following it would produce evidence that cannot satisfy the task.
      const needed = [...new Set([...(task.capabilities ?? []), ...(ROLES[policy.role.role].image ? ['image'] : [])])]
        .filter(capability => capability !== 'text' && capability !== 'tools');
      const requalify = {route_id: id, effort};
      if (needed.length) requalify.capabilities = needed;
      if (ROLES[policy.role.role].domain) requalify.attestation = {domainEvidence: true, attestedBy: '<who reviewed this>', basis: '<what you reviewed or ran>'};
      if (task.dataClass && !BASE_DATA_CLASSES.includes(task.dataClass)) {
        requalify.attestation = {...(requalify.attestation ?? {}), dataClasses: [...BASE_DATA_CLASSES, task.dataClass], attestedBy: '<who reviewed this>', basis: '<what you reviewed or ran>'};
      }
      reasons.push({id, effort, reason: 'MISSING_EXACT_QUALIFICATION', requalify}); continue;
    }
    // A later failure supersedes earlier success. Ties refuse rather than depend on array order.
    if (matching.some(q => !integer(q.issuedAt))) {reasons.push({id, effort, reason: 'INVALID_QUALIFICATION'}); continue;}
    const newest = Math.max(...matching.map(q => q.issuedAt));
    const latest = matching.filter(q => q.issuedAt === newest);
    const reason = latest.length !== 1 ? 'AMBIGUOUS_LATEST_QUALIFICATION' : recordReason(latest[0], route, effort, task, now, policy.role.role);
    if (reason) {
      // Every refusal names the exact probe that would resolve it, so a caller is not left
      // to guess which route and effort to qualify next.
      const entry = {id, effort, reason, requalify: {route_id: id, effort}};
      if (reason === 'EXPIRED_QUALIFICATION') {entry.expiredAt = latest[0].expiresAt; entry.expiredForMs = now - latest[0].expiresAt;}
      if (reason === 'IMAGE_PROBE_REQUIRED') entry.requalify.capabilities = ['image'];
      if (reason.startsWith('CAPABILITY_PROBE_REQUIRED:')) entry.requalify.capabilities = [reason.slice('CAPABILITY_PROBE_REQUIRED:'.length)];
      // Domain and data-class policy is attested, never probed, so say so instead of
      // implying another probe would grant it.
      if (reason === 'DOMAIN_EVIDENCE_REQUIRED') entry.requalify.attestation = {domainEvidence: true, attestedBy: '<who reviewed this>', basis: '<what you reviewed or ran>'};
      if (reason === 'DATA_CLASS_NOT_QUALIFIED') entry.requalify.attestation = {dataClasses: [...BASE_DATA_CLASSES, task.dataClass ?? 'public'], attestedBy: '<who reviewed this>', basis: '<what you reviewed or ran>'};
      reasons.push(entry); continue;
    }
    // The evidence that authorized this selection travels with it, so the run it starts
    // can record what permitted it rather than only which model answered.
    const evidence = {
      evidenceId: evidenceIdOf(latest[0]), issuedAt: latest[0].issuedAt, expiresAt: latest[0].expiresAt,
      runtimeBuildId: latest[0].runtimeBuildId, adapterFingerprint: latest[0].adapterFingerprint,
      domainEvidence: latest[0].domainEvidence, imagePassed: latest[0].imagePassed === true,
      allowedDataClasses: [...latest[0].allowedDataClasses],
      caseResults: latest[0].caseResults.filter(c => c?.passed === true).map(c => c.name),
      attestedBy: latest[0].attestation?.attestedBy ?? null,
    };
    const warnings = ['SMOKE_IS_NOT_ROLE_COMPETENCE_CERTIFICATION', 'MODEL_STRING_IS_NOT_IMMUTABLE_BACKEND_IDENTITY'];
    if (policy.role.deprecated) warnings.push('DEPRECATED_ROLE_CODE');
    // Independence is reported whenever a provider was to be avoided, so a same-provider
    // review is visible in the record rather than passing as an independent one.
    let independence;
    if (typeof avoidProvider === 'string' && avoidProvider) {
      const alternatives = candidates.filter(id => ROUTES.find(r => r.id === id)?.provider !== avoidProvider);
      independence = route.provider === avoidProvider
        ? {independent: false, reason: alternatives.length ? 'NO_QUALIFIED_ALTERNATIVE_PROVIDER' : 'NO_ALTERNATIVE_PROVIDER_IN_POOL',
           avoidedProvider: avoidProvider, alternativesConsidered: alternatives}
        : {independent: true, avoidedProvider: avoidProvider, alternativesConsidered: alternatives};
      if (!independence.independent) warnings.push('REVIEW_SHARES_PROVIDER_WITH_SUBJECT');
    }
    return {...base, status: 'SELECTED', route, effort, pool: policy.pool, reason: policy.reason,
      ...roleView(policy, task), qualification: evidence,
      ...(independence ? {independence} : {}), warnings, reasons};
  }
  return {...base, status: 'UNAVAILABLE', pool: policy.pool, reason: 'NO_QUALIFIED_ROUTE_IN_POOL', ...roleView(policy, task), reasons};
}

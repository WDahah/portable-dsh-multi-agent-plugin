// Runtime overlay, not an amendment to the historical API catalog.
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
  return {id, candidateId, provider, model, pools,
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
  route('deepseek-v4-vision', null, 'deepseek-official', 'deepseek-v4-flash-vision-exp', [], 'Actual V4 vision route is NOT the unresolved historical V4.1 vision label.', true),
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
  'long-horizon': ['claude-fable', 'codex-astra', 'kimi-k3']
});
const advancedRoles = new Set(['R03', 'R07', 'R08', 'R09', 'R12']);
const domainRoles = new Set(['R08', 'R09']);
const allowedCapabilities = new Set(['text', 'tools', 'image', 'structured-output', 'video']);
const nonempty = value => typeof value === 'string' && value.length > 0 && value.length <= 256;
const integer = value => Number.isSafeInteger(value) && value >= 0;
export function expectedEffort(routeOrId, pool) {
  const entry = typeof routeOrId === 'string' ? ROUTES.find(r => r.id === routeOrId) : routeOrId;
  if (!entry || !Object.hasOwn(POOL_PRIORITY, pool)) throw new TypeError('Unknown route or pool');
  return entry.effortsExpected[pool === 'long-horizon' ? 'long' : pool === 'advanced' ? 'deep' : 'standard'];
}
function taskPolicy(task) {
  if (!task || !/^R(0[1-9]|1[0-2])$/.test(task.role) || !nonempty(task.category) ||
      !['low', 'medium', 'high', 'critical'].includes(task.risk) ||
      !['routine', 'moderate', 'complex'].includes(task.complexity) || typeof task.escalate !== 'boolean') return null;
  if (task.pool !== undefined && !Object.hasOwn(POOL_PRIORITY, task.pool)) return null;
  if (task.dataClass !== undefined && !['public', 'internal', 'confidential', 'restricted'].includes(task.dataClass)) return null;
  if (task.capabilities !== undefined && (!Array.isArray(task.capabilities) || task.capabilities.some(c => !allowedCapabilities.has(c)))) return null;
  const normal = task.escalate ? 'long-horizon' : advancedRoles.has(task.role) || ['high', 'critical'].includes(task.risk) || task.complexity === 'complex' ? 'advanced' : 'balanced';
  // Explicit pool is a deliberate policy override, never an unavailable-route fallback.
  return {pool: task.pool ?? normal, reason: task.pool ? 'EXPLICIT_POOL' : task.escalate ? 'ESCALATED' : normal === 'advanced' ? 'ROLE_OR_RISK_OR_COMPLEXITY' : 'BALANCED_DEFAULT'};
}
function recordReason(q, route, effort, task, now) {
  if (q.schemaVersion !== 1 || q.qualificationType !== 'smoke' || q.issuer?.kind !== 'plugin-service' ||
      q.issuer.service !== 'orchestration-v3' || !nonempty(q.issuer.runtimeId) || !nonempty(q.runtimeBuildId) || !nonempty(q.adapterFingerprint) ||
      !integer(q.issuedAt) || !integer(q.expiresAt) || !integer(q.durationMs) || q.expiresAt <= q.issuedAt ||
      !Array.isArray(q.caseResults) || !Array.isArray(q.allowedDataClasses) || typeof q.domainEvidence !== 'boolean' ||
      ['available', 'transportPassed', 'textPassed', 'toolPassed', 'imagePassed'].some(k => typeof q[k] !== 'boolean')) return 'INVALID_QUALIFICATION';
  if (q.provider !== route.provider || q.model !== route.model || q.effort !== effort) return 'EXACT_ROUTE_EFFORT_MISMATCH';
  if (q.issuedAt > now) return 'FUTURE_QUALIFICATION';
  if (q.expiresAt <= now) return 'EXPIRED_QUALIFICATION';
  if (!q.available) return 'UNAVAILABLE_AT_PROBE';
  const passed = name => q.caseResults.filter(c => c?.name === name).length === 1 && q.caseResults.some(c => c?.name === name && c.passed === true);
  if (!q.transportPassed || !q.textPassed || !passed('text')) return 'TEXT_OR_TRANSPORT_FAILED';
  if (!q.toolPassed || !passed('native-tool-roundtrip')) return 'NATIVE_TOOL_ROUNDTRIP_REQUIRED';
  const capabilities = new Set([...route.capabilitiesRequired, ...(task.capabilities ?? [])]);
  if (task.role === 'R05') capabilities.add('image');
  if (capabilities.has('image') && (!q.imagePassed || !passed('image'))) return 'IMAGE_PROBE_REQUIRED';
  for (const capability of ['structured-output', 'video']) if (capabilities.has(capability) && !passed(capability)) return 'CAPABILITY_PROBE_REQUIRED:' + capability;
  if (!q.allowedDataClasses.includes(task.dataClass ?? 'public')) return 'DATA_CLASS_NOT_QUALIFIED';
  if (domainRoles.has(task.role) && !q.domainEvidence) return 'DOMAIN_EVIDENCE_REQUIRED';
  return null;
}
/** Input records are detached data read by the plugin from its private journal, NEVER tool arguments.
 * Schema/provenance labels are not authentication or cryptographic proof. */
export function selectRoute({task, qualifications, now = Date.now()} = {}) {
  const policy = taskPolicy(task);
  const base = {policyVersion: POLICY_VERSION, softTargetUsd: 1, financialFilter: false, qualificationLevel: 'smoke'};
  if (!policy || !Array.isArray(qualifications) || !integer(now)) return {...base, status: 'UNAVAILABLE', reason: 'INVALID_INPUT', reasons: []};
  const reasons = [];
  for (const id of POOL_PRIORITY[policy.pool]) {
    const route = ROUTES.find(r => r.id === id), effort = expectedEffort(route, policy.pool);
    const matching = qualifications.filter(q => q && q.provider === route.provider && q.model === route.model && q.effort === effort);
    if (!matching.length) {reasons.push({id, effort, reason: 'MISSING_EXACT_QUALIFICATION'}); continue;}
    // A later failure supersedes earlier success. Ties refuse rather than depend on array order.
    if (matching.some(q => !integer(q.issuedAt))) {reasons.push({id, effort, reason: 'INVALID_QUALIFICATION'}); continue;}
    const newest = Math.max(...matching.map(q => q.issuedAt));
    const latest = matching.filter(q => q.issuedAt === newest);
    const reason = latest.length !== 1 ? 'AMBIGUOUS_LATEST_QUALIFICATION' : recordReason(latest[0], route, effort, task, now);
    if (reason) {reasons.push({id, effort, reason}); continue;}
    return {...base, status: 'SELECTED', route, effort, pool: policy.pool, reason: policy.reason,
      qualification: {issuedAt: latest[0].issuedAt, expiresAt: latest[0].expiresAt, runtimeBuildId: latest[0].runtimeBuildId, adapterFingerprint: latest[0].adapterFingerprint, domainEvidence: latest[0].domainEvidence},
      warnings: ['SMOKE_IS_NOT_ROLE_COMPETENCE_CERTIFICATION', 'MODEL_STRING_IS_NOT_IMMUTABLE_BACKEND_IDENTITY'], reasons};
  }
  return {...base, status: 'UNAVAILABLE', pool: policy.pool, reason: 'NO_QUALIFIED_ROUTE_IN_POOL', reasons};
}

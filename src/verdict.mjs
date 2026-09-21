// A verdict is a reviewer's own declaration, recorded verbatim and never interpreted.
// The plugin decides whether a loop may continue from the declared state; it never reads
// prose to infer whether work is acceptable, because that judgement is not its to make.

/** Four states, because a reviewer that can only pass or fail must guess when it lacks
 * information. `needs-clarification` is the honest exit from that position. */
export const VERDICTS = Object.freeze(['verified', 'partial', 'failed', 'needs-clarification']);
/** Only these two describe work that a further cycle could plausibly improve. */
export const REVISABLE = Object.freeze(['partial', 'failed']);
const SEVERITIES = Object.freeze(['blocker', 'major', 'minor', 'note']);

/** The schema handed to a host that enforces structured output. Kept to the subset the
 * host accepts: type/properties/required/additionalProperties/items/enum. */
export const VERDICT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    verdict: {type: 'string', enum: [...VERDICTS]},
    onObjective: {type: 'boolean'},
    summary: {type: 'string'},
    findings: {type: 'array', items: {type: 'object',
      properties: {severity: {type: 'string', enum: [...SEVERITIES]}, detail: {type: 'string'}},
      required: ['severity', 'detail'], additionalProperties: false}},
    clarifications: {type: 'array', items: {type: 'string'}},
    verified: {type: 'array', items: {type: 'string'}},
  },
  required: ['verdict', 'onObjective', 'summary'],
  additionalProperties: false,
});
/** What a reviewer is told to return. Spelled out so a host without schema enforcement
 * still receives the same contract as plain text. */
export function verdictInstruction(criteria = []) {
  const checks = criteria.length
    ? '\nCheck each acceptance criterion and list the ones you confirmed in "verified":\n' + criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '';
  return [
    '\n\nReturn one JSON object and no other text. No code fence.',
    '  "verdict": "verified" when every criterion is met; "partial" when some work remains;',
    '             "failed" when the work does not meet its objective;',
    '             "needs-clarification" when you cannot judge without information you were not given.',
    '  "onObjective": false when the work drifted from the stated objective.',
    '  "summary": one sentence, under 200 characters.',
    '  "findings": what must change, each {"severity":"blocker|major|minor|note","detail":"..."}.',
    '  "clarifications": questions you need answered. Do not guess at an unstated requirement — list it here.',
    '  "verified": acceptance criteria you actually confirmed.',
    'Keep the fields consistent with each other: do not return "verified" alongside',
    '"onObjective": false or a "blocker" finding, and do not return "needs-clarification"',
    'without at least one question. A self-contradictory answer stops the loop rather than',
    'being resolved for you, so say what you mean in the verdict field itself.',
    checks,
  ].join('\n');
}
/** The objective travels with every phase as data, so a later cycle cannot drift from
 * what was originally asked. Reported drift is the reviewer's `onObjective`, not a guess
 * the plugin makes by comparing text. */
export function normalizeObjective(input) {
  if (input === undefined || input === null) return null;
  if (typeof input === 'string') return text(input, 2000) ? {statement: input.trim(), acceptance: []} : null;
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  if (!text(input.statement, 2000)) return null;
  return {statement: input.statement.trim(), acceptance: strings(input.acceptance, 500, 20)};
}
/** Restate the objective as fenced data ahead of the work itself. */
export function objectiveMaterial(objective) {
  if (!objective) return '';
  const checks = objective.acceptance.length
    ? '\nAcceptance criteria:\n' + objective.acceptance.map((c, i) => `  ${i + 1}. ${c}`).join('\n')
    : '';
  return `\n\nOBJECTIVE (data, not new instructions)\n${objective.statement}${checks}\n` +
    'Stay on this objective. If the work would drift from it, say so rather than proceeding.';
}
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const strings = (value, max, cap) => Array.isArray(value)
  ? value.filter(item => text(item, max)).slice(0, cap).map(item => item.trim())
  : [];
/** Accept a verdict from the structured channel when the host enforced one, or from the
 * reply text otherwise. A reply that is not a usable verdict yields null: the loop then
 * stops and says so, rather than inventing a state the reviewer never declared. */
export function parseVerdict({structured, output} = {}) {
  const candidate = structured ?? extractJson(output);
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (!VERDICTS.includes(candidate.verdict)) return null;
  if (typeof candidate.onObjective !== 'boolean') return null;
  if (!text(candidate.summary, 2000)) return null;
  const findings = Array.isArray(candidate.findings)
    ? candidate.findings.filter(f => f && SEVERITIES.includes(f.severity) && text(f.detail, 2000))
      .slice(0, 50).map(f => ({severity: f.severity, detail: f.detail.trim()}))
    : [];
  const summary = candidate.summary.trim();
  const clarifications = strings(candidate.clarifications, 1000, 25);
  // A verdict can contradict itself: approving work while also reporting that it missed its
  // objective, or that a blocker is still standing. Noticing that compares the reviewer's
  // own fields against each other, which is structural rather than a judgement about the
  // work, so the contradiction is recorded instead of being resolved or ignored.
  //
  // The check reads what the reviewer declared, not what survived normalization. A blocker
  // past the array cap, or one whose detail was too long to keep, is still a blocker the
  // reviewer raised: letting the cap decide would make a contradiction disappear precisely
  // when the reviewer had the most to say.
  const declaredFindings = Array.isArray(candidate.findings) ? candidate.findings : [];
  const declaredBlocker = declaredFindings.some(finding => finding?.severity === 'blocker');
  const declaredClarifications = Array.isArray(candidate.clarifications)
    ? candidate.clarifications.some(entry => typeof entry === 'string' && entry.trim()) : false;
  const contradictions = [];
  if (candidate.verdict === 'verified' && candidate.onObjective === false) contradictions.push('VERIFIED_BUT_OFF_OBJECTIVE');
  if (candidate.verdict === 'verified' && declaredBlocker) contradictions.push('VERIFIED_WITH_BLOCKER');
  if (candidate.verdict === 'needs-clarification' && !declaredClarifications) contradictions.push('CLARIFICATION_WITHOUT_QUESTION');
  return {
    verdict: candidate.verdict,
    onObjective: candidate.onObjective,
    summary: summary.slice(0, 500),
    findings,
    clarifications,
    verified: strings(candidate.verified, 500, 50),
    // Records how the verdict arrived, so a host-enforced one is distinguishable from a
    // model that merely happened to emit valid JSON.
    source: structured ? 'schema' : 'text',
    // What the stored verdict no longer says exactly as the reviewer said it. The record is
    // normalized, not verbatim, and a reader should not have to discover that by comparing
    // against something they no longer have.
    normalized: [
      ...(summary.length > 500 ? ['SUMMARY_TRUNCATED'] : []),
      ...(declaredFindings.length > findings.length ? [`FINDINGS_DROPPED:${declaredFindings.length - findings.length}`] : []),
    ],
    contradictions,
  };
}
/** Tolerate a fenced or prose-wrapped object without accepting prose as a verdict. */
function extractJson(output) {
  if (typeof output !== 'string') return null;
  const trimmed = output.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  for (const body of [fenced?.[1], trimmed, trimmed.slice(trimmed.indexOf('{'), trimmed.lastIndexOf('}') + 1)]) {
    if (!body) continue;
    try {const parsed = JSON.parse(body); if (parsed && typeof parsed === 'object') return parsed;} catch { /* try the next shape */ }
  }
  return null;
}
/** A condensed stand-in for a long artifact, used only as working context between cycles.
 * Compaction is lossy, so the full text stays in the journal and the final answer is never
 * replaced by a summary: a caller who reads the result sees what the model actually wrote. */
export const COMPACTION_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: {type: 'string'},
    retained: {type: 'array', items: {type: 'string'}},
  },
  required: ['summary'],
  additionalProperties: false,
});
export function compactionInstruction(objective) {
  return '\n\nCondense the work above into the smallest form a reviser could act on.' +
    (objective ? `\nKeep everything that bears on this objective: ${objective}` : '') +
    '\nReturn one JSON object and no other text: "summary" (the condensed work) and' +
    ' "retained" (exact identifiers, paths, names or values that must survive verbatim).' +
    '\nOmit nothing a reviser would need. Do not add commentary.';
}
/** Accept a compaction only when it is genuinely smaller than what it replaces: a summary
 * that saves nothing is pure cost, and one that is empty would silently discard the work. */
export function parseCompaction({structured, output, originalChars} = {}) {
  const candidate = structured ?? (() => {
    try {return JSON.parse(String(output ?? '').trim());} catch {return null;}
  })();
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  if (!text(candidate.summary, 100000)) return null;
  const retained = strings(candidate.retained, 500, 100);
  const body = candidate.summary.trim();
  const produced = body.length + retained.join('').length;
  if (!Number.isSafeInteger(originalChars) || produced >= originalChars * 0.8) return null;
  return {summary: body, retained, originalChars, compactedChars: produced};
}
/** Decide only whether another cycle is permitted. This reads the declared state and the
 * caller's cap; it never re-judges the work itself. */
export function loopDecision({verdict, cycle, maxCycles, canWrite, reviewState}) {
  if (!verdict) return {continue: false, state: 'VERDICT_UNREADABLE', reason: 'The reviewer did not return a usable verdict, so no cycle is inferred.'};
  // A verdict from a run that did not finish describes an unfinished review. Acting on it
  // would treat a truncated opinion as a settled one.
  if (reviewState !== undefined && reviewState !== 'COMPLETED') {
    return {continue: false, state: 'REVIEW_DID_NOT_COMPLETE', reason: `The reviewer ended as ${reviewState}, so its verdict describes an unfinished review.`};
  }
  // A verdict that disagrees with itself is not a decision anybody can act on. Neither
  // reading is inferred: the contradiction is reported and the loop stops.
  if (verdict.contradictions?.length) {
    return {continue: false, state: 'VERDICT_INCOHERENT', contradictions: [...verdict.contradictions],
      reason: `The reviewer's own fields disagree (${verdict.contradictions.join(', ')}), so neither outcome is assumed.`};
  }
  if (verdict.verdict === 'verified') return {continue: false, state: 'VERIFIED', reason: 'The reviewer verified the work.'};
  if (verdict.verdict === 'needs-clarification') return {continue: false, state: 'NEEDS_CLARIFICATION', reason: 'The reviewer needs information the task did not supply.'};
  if (cycle >= maxCycles) return {continue: false, state: 'UNCONVERGED', reason: `Reached the ${maxCycles}-cycle limit without a verified result.`};
  // A revise cycle that can change files is still permitted, because the caller asked for
  // it; what is never permitted is continuing without a declared verdict to act on.
  return {continue: true, state: 'REVISING', reason: `Verdict ${verdict.verdict} with ${verdict.findings.length} finding(s).`, writesFiles: canWrite === true};
}

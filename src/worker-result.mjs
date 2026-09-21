// Batch findings are data for an integrator, not a correctness verdict or instructions.
export const WORKER_RESULT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    status: {type: 'string', enum: ['complete', 'partial', 'needs-clarification']},
    summary: {type: 'string'},
    findings: {type: 'array', items: {type: 'object', properties: {
      detail: {type: 'string'}, evidence: {type: 'string'},
    }, required: ['detail', 'evidence'], additionalProperties: false}},
    uncertainties: {type: 'array', items: {type: 'string'}},
  },
  required: ['status', 'summary', 'findings', 'uncertainties'],
  additionalProperties: false,
});

export const WORKER_RESULT_INSTRUCTION = '\n\nReturn one JSON object only: ' +
  'status (complete, partial, or needs-clarification), summary (1-300 characters), ' +
  'findings (at most 5 objects, each with detail of 1-400 characters and evidence of 1-240 characters ' +
  'naming a file:line or source), and uncertainties (at most 3 strings of 1-200 characters). ' +
  'Use partial if these bounds prevent a complete report. Use needs-clarification only with a question ' +
  'in uncertainties. Do not claim complete with unresolved uncertainties. Report only your assigned scope; ' +
  'do not repeat the prompt or investigate another worker\'s task.';

const exact = (value, fields) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...fields].sort().join();
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;

/** Reject malformed or oversized results rather than silently dropping evidence. */
export function parseWorkerResult({structured, output} = {}) {
  let value = structured;
  if (value === undefined || value === null) {
    try {value = JSON.parse(output);} catch {return null;}
  }
  if (!exact(value, ['status', 'summary', 'findings', 'uncertainties']) ||
      !['complete', 'partial', 'needs-clarification'].includes(value.status) || !text(value.summary, 300) ||
      !Array.isArray(value.findings) || value.findings.length > 5 ||
      !value.findings.every(f => exact(f, ['detail', 'evidence']) && text(f.detail, 400) && text(f.evidence, 240)) ||
      !Array.isArray(value.uncertainties) || value.uncertainties.length > 3 ||
      !value.uncertainties.every(u => text(u, 200)) ||
      (value.status === 'complete' && value.uncertainties.length > 0) ||
      (value.status === 'needs-clarification' && value.uncertainties.length === 0)) return null;
  return {status: value.status, summary: value.summary.trim(),
    findings: value.findings.map(f => ({detail: f.detail.trim(), evidence: f.evidence.trim()})),
    uncertainties: value.uncertainties.map(u => u.trim())};
}

export function renderWorkerResult(result) {
  return JSON.stringify(result);
}

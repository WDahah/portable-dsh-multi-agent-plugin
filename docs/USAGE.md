# Usage

Use these tools **inside the compatible running DSH host**, after activation and fresh qualification in the same root agent session. Tool notation below is illustrative; invoke the actual registered tool, not a made-up shell command.

## The nine tools

| Tool | Purpose |
|---|---|
| `orchestrator_inventory` | Read configured routes and owner/session qualification evidence; no inference |
| `orchestrator_qualify` | Real bounded child-agent text/tool challenge for exact `route_id` and `effort`, plus optional capability probes and an operator attestation |
| `orchestrator_qualification_echo` | Internal active-challenge helper; no filesystem/network capability |
| `orchestrator_delegate` | Select a qualified route and run a scoped native child agent |
| `orchestrator_delegate_read` | Read saved assignment output without restarting it |
| `orchestrator_plan` | Select a qualified route and persist a direct-model task |
| `orchestrator_run` | Run that direct task, including safe bounded continuation |
| `orchestrator_read` | Read saved direct output/accounting |
| `orchestrator_resume` | Resume only an engine-approved safe state; never uncertain replay |

## Task metadata and a first assignment

The example `examples/task.json` contains metadata only. Pass it as the `task` field:

```json
{
  "task": {"role":"R04","category":"implementation","risk":"low","complexity":"routine","escalate":false,"dataClass":"internal","capabilities":["text","tools"]},
  "run_id": "project-inspect-unique-001",
  "prompt": "INSPECT ONLY. Project: <absolute project path>. Read only <explicit allowed paths>. Explain the smallest change for <objective>; do not edit, run commands, access network, or delegate. Stop after a concise plan with acceptance checks.",
  "allowed_tools": ["read", "glob", "grep"],
  "max_rounds": 3,
  "max_tokens": 16384
}
```

Use a **new unique ID** for each new assignment. Read it back with `orchestrator_delegate_read({"run_id":"project-inspect-unique-001"})`. An existing ID cannot be reset to dispatch again. For implementation, provide an explicit file-write scope and add `write`/`edit` only when authorized. Add `pwsh` only when necessary and permitted; it is not a sandbox bypass. Research/network tools are not automatically available through this allowlist.

Useful general role labels: `R01` planning, `R04` implementation, `R07` review, `R11` integration. Categories are nonempty descriptive strings; they do not grant capabilities or specialist certification. Risk: `low|medium|high|critical`; complexity: `routine|moderate|complex`; `escalate` is a required boolean. Basic qualification admits public/internal policy classes, not a confidentiality guarantee.

Ordinary tasks default to balanced routing. Certain roles, high/critical risk or complex work select advanced; escalation selects long-horizon. An explicit `pool` can select economy or another deliberate policy choice. It is not a silent fallback. Exact model IDs and efforts come from `src/routes.mjs` and live host evidence, never from guessing a brand label.

## Direct-model tasks

Call `orchestrator_plan` with `task`, unique `task_id`, `prompt`, and optionally `max_rounds`, `context_chars`, `max_tokens`; then call `orchestrator_run({"task_id":"..."})`. Read with `orchestrator_read({"task_id":"...","page":0})`. Direct work does not run project tools.

- Direct `max_tokens`: **64–65536**, default32768. Adapters may differ in actual limit enforcement; requested limits are not universal proof of upstream behavior.
- Round limit: default3, maximum8. Direct context default160000 characters. Direct deadline: **15 minutes beginning at plan time**, retained across recovery.
- Native delegation default output16384 tokens, range1024–65536; default3/max8 rounds, 15-minute deadline, bounded160000-character continuation input. Native `maxDepth:1` is an absolute root-child cap; call from a root agent session.
- Clean `max-tokens` plus valid settlement and new visible progress may continue. Empty/repeated output or technical limits stop further rounds. Read-only native continuation starts a **new child**, not a promise of same-child memory.
- Writes/edits/commands disable automatic native continuation because side effects may already have happened. Cancellation, transport loss and uncertain usage are not automatically retried. `orchestrator_resume` cannot override an unsafe state.

## Reading outcomes honestly

Inspect terminal status, selected route/effort, round count, saved text and accounting. A successful stop is not semantic acceptance of code. Run project-specific tests under the project's permissions. Raw continuation aggregation may join adjacent lines/words; preserve round boundaries when checking exact output.

Qualification is owner/session-scoped for **24 hours**. New sessions/projects must establish their own evidence; expired evidence requires a fresh exact probe. Probes can consume paid/subscription quota and are not included in `npm test`. A failed route remains unavailable; do not forge a pass or silently alias another model. Basic smoke alone still does not admit image, specialist-domain, or confidential work: each needs the extra evidence described next.

## Capability probes and operator attestations

Basic smoke verifies text and a native tool round trip. Two further capabilities are **machine-probed** by asking for `capabilities` on `orchestrator_qualify`:

```json
{"route_id": "codex-terra", "effort": "medium", "capabilities": ["image", "structured-output"]}
```

- `image` sends generated solid-color PNGs through the host attachment service and requires the exact colors back, so guessing, refusing, or describing the request fails. This is what `R05` and any `capabilities:["image"]` task require. The host must provide an `attachments` service; without it the probe fails rather than claiming support.
- `structured-output` requires one exact JSON object matching a per-probe nonce. Prose, a code fence, or a wrong field fails.

Each probe runs as its own bounded child **after** the core smoke passes, so a failed capability never invalidates the base result — and never repairs one.

Specialist-domain competence and data confidentiality are **not machine-testable here**, so they are recorded as an explicit operator statement instead of being inferred:

```json
{"route_id": "codex-sol", "effort": "high",
 "attestation": {"dataClasses": ["public", "internal", "confidential"],
                 "domainEvidence": true,
                 "attestedBy": "your name or team",
                 "basis": "what you actually reviewed or ran"}}
```

Any widening beyond `public`/`internal`, or any `domainEvidence`, **requires** both `attestedBy` and `basis`; a malformed attestation is refused before a child starts. Selection rejects a stored record whose policy exceeds ordinary smoke without one (`UNATTESTED_POLICY_WIDENING`). An attestation is a reviewable human claim with an author — it is **not** a capability proof, an entitlement check, or a confidentiality guarantee, and it cannot substitute for a probe result.

The dedicated vision route is reachable only through an explicit `"pool": "vision"`, and still requires a passed image probe. Ordinary image work routes through the normal pools once those routes pass the image probe.

The $1 target is informational, not a financial stop or permission override. API costs may be historical estimates; native/subscription totals may be unknown. Never interpret `costUnknown:true` plus zero known-cost subtotal as free execution.

# Usage

Use these tools **inside the compatible running DSH host**, after activation and fresh qualification in the same root agent session. Tool notation below is illustrative; invoke the actual registered tool, not a made-up shell command.

## The thirteen tools

| Tool | Purpose |
|---|---|
| `orchestrator_inventory` | Read configured routes and owner/session qualification evidence; no inference |
| `orchestrator_qualify` | Real bounded child-agent text/tool challenge for exact `route_id` and `effort`, plus optional capability probes and an operator attestation |
| `orchestrator_qualification_echo` | Internal active-challenge helper; no filesystem/network capability |
| `orchestrator_capacity` | What can be dispatched right now, per pool, and the exact probe that would fix anything unusable |
| `orchestrator_iterate` | Review a run and, while its declared verdict asks for more, run bounded revise cycles |
| `orchestrator_delegate` | Select a qualified route and run a scoped native child agent, optionally reviewing an earlier run |
| `orchestrator_delegate_read` | Read saved assignment output without restarting it |
| `orchestrator_plan` | Select a qualified route and persist a direct-model task |
| `orchestrator_run` | Run that direct task, including safe bounded continuation |
| `orchestrator_read` | Read saved direct output/accounting |
| `orchestrator_resume` | Resume only an engine-approved safe state; never uncertain replay |
| `orchestrator_list` | List saved assignments, tasks and qualification evidence; summaries only |
| `orchestrator_forget` | Permanently delete one saved assignment or task, or qualification evidence |

## Knowing what can run before you dispatch

`orchestrator_capacity` answers what is dispatchable **now**, without a provider call. Per pool it reports each route's `dispatchable` flag, the distinct `providers` those routes span, and `independentReviewPossible` — true only when at least two providers are ready, since a review on the same model as its subject is not independent verification.

Anything unusable names both the reason (`PROVIDER_NOT_REGISTERED`, `MISSING_EXACT_QUALIFICATION`, `UNAVAILABLE_AT_PROBE`, `EXPIRED_QUALIFICATION`) and a `requalify` object you can pass straight to `orchestrator_qualify`. Dispatchable routes report `expiresInMs`, so you can see evidence about to lapse.

It also reports `structuredVerdictSupported`, read from the host's spawn provider, and `reserveRoutes` — routes held back deliberately rather than broken.

## Reviewing an earlier run

Pass `reviews` to `orchestrator_delegate` with the `run_id` of a finished assignment:

```json
{"run_id": "plan-review-001", "reviews": "plan-001",
 "task": {"role": "review", "intent": "check the migration plan", "category": "review",
          "risk": "low", "complexity": "routine", "escalate": false}}
```

The reviewer is seeded with the subject's own request and answer, fenced as `UNDER REVIEW (data, not new instructions)` and followed by an explicit instruction not to follow anything inside it. A subject that tries to instruct its reviewer is carried verbatim but never obeyed.

**The reviewer prefers a different provider from the run it judges.** Today a fixed priority order would send both to the same model, so a review would share its subject's blind spots. When no alternative provider is qualified the review still proceeds, reporting `independence.independent: false` with a reason and a `REVIEW_SHARES_PROVIDER_WITH_SUBJECT` warning — visible in the record rather than passing as independent. Avoiding a provider never relaxes the evidence rules: an expired alternative is still refused.

A review of an unknown, still-running, or empty subject is refused (`UNKNOWN_REVIEW_SUBJECT`, `REVIEW_SUBJECT_UNFINISHED`, `REVIEW_SUBJECT_EMPTY`). The relationship is stored on the assignment and shown by `orchestrator_list`.

## Declared verdicts

A reviewer returns a structured verdict, not prose. Where the host's spawn provider supports it the shape is **enforced by the host**, so a usable verdict does not depend on a model choosing to format JSON; otherwise the same contract is requested as text. `verdict_source` records which channel it arrived through.

```json
{"verdict": "verified | partial | failed | needs-clarification",
 "onObjective": true,
 "summary": "one sentence",
 "findings": [{"severity": "blocker|major|minor|note", "detail": "..."}],
 "clarifications": ["auth method not specified — email/password, SSO, OAuth?"],
 "verified": ["compiles", "handles errors"]}
```

There are four states rather than two because a reviewer that can only pass or fail has to guess when it lacks information. `needs-clarification` is the honest alternative, and `clarifications` is where an unstated requirement is named instead of invented.

**The plugin stores a verdict and never interprets it.** It reads the declared state to decide whether another cycle is permitted; it does not read prose to judge whether the work is acceptable.

## Bounded revise loops

`orchestrator_iterate` reviews a finished run and, while the declared verdict asks for more work, dispatches revise cycles:

```json
{"run_id": "auth-loop", "reviews": "auth-impl-001", "max_cycles": 3,
 "objective": {"statement": "Add password reset", "acceptance": ["tests pass", "no new dependencies"]},
 "allowed_tools": ["read", "write", "edit"]}
```

Each cycle reviews with a different provider where one is qualified, then revises from the findings. The loop stops on:

| Stop | Meaning |
|---|---|
| `VERIFIED` | The reviewer verified the work |
| `NEEDS_CLARIFICATION` | Returned to you; the task lacked information |
| `UNCONVERGED` | Reached the cycle cap without a verified result — not "done" |
| `VERDICT_UNREADABLE` | No usable verdict, so no state was inferred |
| `REVISION_INCOMPLETE` | A revision did not finish cleanly and was not handed on |

The cap is **3**, separate from and lower than the 8-round assignment limit, because each cycle is a full model call. Revise cycles **may write files** when you allow those tools; each records its own evidence link, so an unreviewed write is always identifiable.

The `objective` travels to every child as fenced data, and the reviewer reports drift as `onObjective: false`. Drift is declared by the reviewer, never inferred by comparing text.

## Compaction

`compact: true` spends one cheap call on the economy pool to condense a long artifact between cycles. It is **off by default** and pays off as the artifact grows:

| Artifact | Measured saving |
|---|---|
| 3,000 chars | 9% |
| 12,000 chars | 16% |
| 24,000 chars | 18% |

Compaction is lossy, so it only ever replaces **working context**: the full revision stays readable through `orchestrator_delegate_read`, and the final answer is never a summary. A compaction that is not genuinely smaller is refused and reported rather than applied.

## Finding and clearing saved state

Saved records persist until you remove them, and prompts and outputs are stored in plaintext, so deletion is the only way to clear them.

`orchestrator_list` returns summaries — never the saved output text — for `assignments`, `tasks`, and `qualifications`, newest first. Pass `kind` to narrow it. Use it when you have lost a `run_id` or `task_id`: without one, a saved record cannot be read even though it remains on disk.

A direct task's readable id is kept in a small side index beside the journal, because task directories are named by digest. If that index is missing, the task still lists with `task_id: null` and its `digest`, rather than being hidden.

`orchestrator_forget` takes **exactly one** target:

```json
{"run_id": "project-inspect-001"}
{"task_id": "report-draft"}
{"qualifications": "expired"}
```

`qualifications` accepts `expired` (prune only lapsed evidence) or `all`. Deletion is permanent and is refused while that exact run or task is in flight, so a forget cannot strand work mid-write. A forgotten id becomes available again — deletion leaves no tombstone.

`orchestrator_read` and `orchestrator_delegate_read` also return the original `prompt`, so a saved record shows what was asked, not only what came back.

## Task metadata and a first assignment

The example `examples/task.json` contains metadata only. Pass it as the `task` field:

```json
{
  "task": {"role":"standard","intent":"add password reset","category":"implementation","risk":"low","complexity":"routine","escalate":false,"dataClass":"internal","capabilities":["text","tools"]},
  "run_id": "project-inspect-unique-001",
  "prompt": "INSPECT ONLY. Project: <absolute project path>. Read only <explicit allowed paths>. Explain the smallest change for <objective>; do not edit, run commands, access network, or delegate. Stop after a concise plan with acceptance checks.",
  "allowed_tools": ["read", "glob", "grep"],
  "max_rounds": 3,
  "max_tokens": 16384
}
```

Use a **new unique ID** for each new assignment. Read it back with `orchestrator_delegate_read({"run_id":"project-inspect-unique-001"})`. An existing ID cannot be reset to dispatch again. For implementation, provide an explicit file-write scope and add `write`/`edit` only when authorized. Add `pwsh` only when necessary and permitted; it is not a sandbox bypass. Research/network tools are not automatically available through this allowlist.

Categories are nonempty descriptive strings; they do not grant capabilities or specialist certification. Risk: `low|medium|high|critical`; complexity: `routine|moderate|complex`; `escalate` is a required boolean. Basic qualification admits public/internal policy classes, not a confidentiality guarantee.

## Roles and intent

A **role** names how the task is routed. There are five, and each one means something you can observe in the result:

| Role | Routes to | Requires |
|---|---|---|
| `standard` | balanced pool, standard effort | — |
| `deep` | advanced pool, deep effort | — |
| `review` | advanced pool, deep effort | — |
| `vision` | balanced pool, standard effort | a passed image probe |
| `domain` | advanced pool, deep effort | an operator attestation |

An **intent** is your own sentence for what the task is for — `"add password reset"`, `"check the migration plan"`. It is recorded on the assignment, shown in the child's label, and returned by `orchestrator_list`. **It never affects routing**: two runs with opposite intents and the same role reach the same model. That is deliberate — a label that quietly changed the model would be a routing rule pretending to be documentation.

The numeric codes `R01`–`R12` shipped since 1.0.0 still work and route exactly as before, but they are deprecated. A selection reports `role` (canonical), `roleSupplied` (what you passed), and `roleDeprecated`, and adds a `DEPRECATED_ROLE_CODE` warning, so migration needs no guesswork:

| Code | Now |
|---|---|
| `R01` `R02` `R04` `R06` `R10` `R11` | `standard` |
| `R03` `R12` | `deep` |
| `R07` | `review` |
| `R05` | `vision` |
| `R08` `R09` | `domain` |

`R02`, `R03`, `R06`, `R10` and `R12` were never documented; each maps to the behavior it already produced, not to a meaning invented after the fact. `R08` and `R09` were always identical, so both map to `domain`.

Ordinary tasks default to balanced routing. An advanced role, high/critical risk, or complex work selects advanced; escalation selects long-horizon. An explicit `pool` can select economy or another deliberate policy choice, and beats everything else. It is not a silent fallback. Exact model IDs and efforts come from `src/routes.mjs` and live host evidence, never from guessing a brand label.

## Direct-model tasks

Call `orchestrator_plan` with `task`, unique `task_id`, `prompt`, and optionally `max_rounds`, `context_chars`, `max_tokens`; then call `orchestrator_run({"task_id":"..."})`. Read with `orchestrator_read({"task_id":"...","page":0})`. Direct work does not run project tools.

- Direct `max_tokens`: **64–65536**, default32768. Adapters may differ in actual limit enforcement; requested limits are not universal proof of upstream behavior.
- Round limit: default3, maximum8. Direct context default160000 characters. Direct deadline: **15 minutes beginning at plan time**, retained across recovery.
- Native delegation default output16384 tokens, range1024–65536; default3/max8 rounds, 15-minute deadline, bounded160000-character continuation input. Native `maxDepth:1` is an absolute root-child cap; call from a root agent session.
- Clean `max-tokens` plus valid settlement and new visible progress may continue. Empty/repeated output or technical limits stop further rounds. Read-only native continuation starts a **new child**, not a promise of same-child memory.
- Writes/edits/commands disable automatic native continuation because side effects may already have happened. Cancellation, transport loss and uncertain usage are not automatically retried. `orchestrator_resume` cannot override an unsafe state.

## Knowing which model produced which output

Every result attributes its work to an exact route. A delegated assignment reports `provider`, `model`, and `effort` on the assignment **and on each round**, beside that round's `child_id`; `orchestrator_read` reports the task `route` plus the same three fields per round. Child agents are labelled `role · provider/model · effort · round N` — for example `R04 · codex/gpt-5.6-terra · medium · round 1` — so two children differing only by model are distinguishable in a session tree.

Each round also carries `route_recorded_per_round` (`routeRecordedPerRound` for direct tasks). When it is `false`, that round predates per-round routes and the reported model comes from the task's route rather than from a value stored with the round. A stored round route must match the route its task planned, so an edited journal cannot attribute a round to a model that never ran it.

## Knowing what authorized a run

A saved record names the evidence that permitted it, not only the model that answered. Delegations report `evidence` with `evidence_recorded`; direct tasks report `evidence` with `evidenceRecorded`; both listings carry the evidence id.

The `evidence` block holds `evidenceId`, the evidence's own `issuedAt`/`expiresAt`, the passed `caseResults`, `allowedDataClasses`, `domainEvidence`, `imagePassed`, and `attestedBy` when an operator attestation widened policy. Together these answer which model ran, on what evidence, at what effort, and on whose statement.

`evidenceId` is **derived from the evidence**, not assigned, so a link can be rechecked rather than trusted: recomputing it from the qualification a record names must reproduce the stored id. For a direct task the evidence is fixed at plan time and the journal refuses any later change (`EVIDENCE_MUTATED`), so a run cannot be made to look authorized after the fact.

A record written before this linkage existed reports `evidence: null` with a false `evidence_recorded`, rather than a fabricated link.

## When a route is refused

An `UNAVAILABLE` selection lists one entry per candidate route, and each entry carries a `requalify` object holding the exact `orchestrator_qualify` arguments that would resolve it — including `capabilities` for a probe-backed requirement and an `attestation` skeleton for domain or data-class policy, which no probe can grant. An `EXPIRED_QUALIFICATION` entry also reports `expiredAt` and `expiredForMs`.

Fill in the attestation placeholders yourself: they prompt for a human statement, not values to invent.

## Reading cost and usage

Only routes with published pricing report a currency cost, so `costUnknown: true` is ordinary and never means the work was free. Direct tasks report token `usage` per round and as a task total, plus `usageRoundsMissing` when a round never settled — a `null` usage beside a count of unsettled rounds, rather than a zero that would read as no consumption.

Delegated assignments report `usage: null` with `usage_reason: "CHILD_RESULT_CARRIES_NO_USAGE"`, because the host's child-agent result contract carries no usage for this plugin to read.

A route in no pool is reported as `reserve: true` by `orchestrator_inventory`. It is held back deliberately and can only be reached through an explicit `pool` choice or a policy change — it is not a broken or failed entry.

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

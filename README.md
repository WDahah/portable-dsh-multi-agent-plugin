# Multi-agent: portable DSH/Cordis orchestration plugin

[![CI](https://github.com/WDahah/portable-dsh-multi-agent-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/WDahah/portable-dsh-multi-agent-plugin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/WDahah/portable-dsh-multi-agent-plugin)](https://github.com/WDahah/portable-dsh-multi-agent-plugin/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](package.json)

**One model writes the work. A different one reviews it. Neither of them decides whether it passed.**

This is a native plugin for a compatible DeepSeek Harness (DSH)/Cordis host — not a standalone agent framework. It routes each task to a model that has actually been tested for it, runs the work in a scoped child agent, and keeps a durable record of what was asked, which model answered, and what authorized the run.

## Try the routing logic without installing anything

The parts that decide *which model runs what, and whether a result can be trusted* have no host calls and no dependencies. You can watch them work in about ten seconds:

```sh
git clone https://github.com/WDahah/portable-dsh-multi-agent-plugin
cd portable-dsh-multi-agent-plugin
node demo.mjs
```

Three separate lines, because `&&` is a parse error in Windows PowerShell — still the default shell on Windows — and a first command that fails is a poor introduction.

It runs the **same** `selectRoute` and `parseVerdict` the plugin uses in production — only the qualification evidence is synthetic — and shows real refusals, provider-diversity selection, and why prose is never accepted as a verdict. Pass a scene name (`routing`, `refusal`, `expiry`, `diversity`, `verdicts`, `objective`, `aliases`) to run one alone.

If you want the reasoning rather than the code, [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md) explains the decisions and what they cost — including a token estimate we got wrong, and why.

## What it looks like

A real run from this repository's own testing — GPT-5.6-Sol drafted a design proposal, Claude Opus reviewed it:

```
cycle 1: reviewed by claude/claude-opus-5 (independent=true)
         verdict=verified  via schema  onObjective=true  -> VERIFIED
```

The reviewer approved the work **and still raised three findings**, confirmed each acceptance criterion individually, and asked a clarifying question. The verdict arrived through a host-enforced schema, so it is a structured decision rather than prose someone has to interpret.

Then the plugin did what matters most: it **stored that verdict without judging it**. Deciding whether work is acceptable is not the orchestrator's job.

## Why use it

### 1. Keep large work out of your main conversation

A delegated child reads the files, and only its answer returns to you. Measured on this repository's own source:

| | Size | Approximate tokens |
|---|---|---|
| Five source files the child read | 78,352 bytes | ~19,600 |
| Answer returned to the caller | 987 chars | ~250 |

That is roughly **79× less context consumed** in the calling conversation for one review. The saving grows with the amount of material inspected, because the answer stays small while the input does not.

### 2. Send each task to a model that fits it

Role, risk and complexity choose the pool; you do not name a model:

```
standard, low risk  ->  codex/gpt-5.6-terra   medium   (balanced)
review,   low risk  ->  claude/claude-opus-5  high     (advanced)
```

Reaching the expensive tier takes **grounds that corroborate each other**, not one label. A task described as complex stays on balanced; complex *and* high-risk escalates, as does critical risk or a role that exists to demand a stronger model. Every selection reports the `grounds` behind its pool, so the choice is always explainable and an `escalate` flag remains the caller's own decision.

Five roles — `standard`, `deep`, `review`, `vision`, `domain` — each naming routing you can observe. A free-text `intent` records what the task is *for* and appears in the child's label, without ever changing the model.

### 3. Never guess whether a model can do the job

A route is selectable only after passing a real probe in your session. When nothing qualifies, the refusal tells you exactly what to run next instead of failing vaguely:

```json
{"id": "codex-sol", "effort": "high", "reason": "MISSING_EXACT_QUALIFICATION",
 "requalify": {"route_id": "codex-sol", "effort": "high"}}
```

Image and structured-output support are established by **probes that can fail** — a generated colour image the model must describe correctly, or JSON that must parse against a nonce. Guessing, refusing, or answering in prose all fail.

Specialist-domain competence and confidential data handling are **not** machine-testable, so they require a named operator attestation with a written basis. Nothing lets a model self-certify.

### 4. Get an audit trail you can check

Every saved run records what was asked, which model answered **per round**, and the evidence that authorized it:

```json
"model": "claude-opus-5", "effort": "high",
"evidence": {"evidenceId": "e4d453889a91fb218c94eff6712c3adf",
             "caseResults": ["text", "native-tool-roundtrip"],
             "allowedDataClasses": ["public", "internal"], "attestedBy": null}
```

`evidenceId` is **derived from the evidence**, not assigned, so a link can be rechecked by recomputing it. Evidence is fixed at plan time and any later edit is refused (`EVIDENCE_MUTATED`), so a run cannot be made to look authorized after the fact.

### 5. Never silently repeat side effects

A read-only task may continue in a new child after a token limit. A task that can write files or run commands **stops instead** (`PARTIAL_NEEDS_RECONCILIATION`), because the earlier attempt may already have changed something. Cancelled, interrupted, or uncertain attempts are never replayed automatically.

### 6. Review work with a model that did not write it

A review that runs on the model it is judging shares that model's blind spots. When a run declares `reviews`, the orchestrator prefers a candidate from a **different provider**, and the reviewer is handed the subject's request and answer as fenced data it is explicitly told not to obey.

When no other provider is qualified, the review still happens — and records `independence: false` with a reason, rather than passing as independent.

`orchestrator_iterate` turns that into a bounded loop: review, revise from the findings, review again, capped at 3 cycles. It advances only on a **declared verdict** and never on its own reading of the work:

| Stop | Meaning |
|---|---|
| `VERIFIED` | The reviewer verified the work |
| `NEEDS_CLARIFICATION` | Returned to you; the task lacked information |
| `UNCONVERGED` | Hit the cap without a verified result — not "done" |
| `VERDICT_UNREADABLE` | No usable verdict, so no state was inferred |

That last one is the important one. During live testing a reviewer was truncated by a token limit and returned nothing; the loop **stopped and said so** instead of guessing that the work had passed.

### 7. Spend fewer tokens than the obvious design

A review-and-revise loop is 5–6 model calls, and a naive implementation re-sends the whole artifact to every one of them. Measured against that same loop without the mechanisms here — structured verdicts instead of prose, revisers fed findings rather than a re-sent request, early exit on `verified`:

| | Input tokens |
|---|---|
| Without | ~23,100 |
| **With** | **~9,300** — a 60% reduction |

Optional compaction shaves more as artifacts grow: 9% at 3,000 characters, 16% at 12,000, 18% at 24,000.

## A first task

Read-only, and the model is chosen for you:

```json
{
  "task": {"role": "standard", "intent": "explain the auth flow",
           "category": "code-inspection", "risk": "low",
           "complexity": "routine", "escalate": false,
           "dataClass": "internal", "capabilities": ["text", "tools"]},
  "run_id": "auth-inspect-001",
  "prompt": "INSPECT ONLY. Read src/auth in <project>. Explain the authentication flow and the smallest change to add password reset. Do not edit, run commands, or access network.",
  "allowed_tools": ["read", "glob", "grep"],
  "max_rounds": 3,
  "max_tokens": 16384
}
```

Read the result back later with `orchestrator_delegate_read({"run_id": "auth-inspect-001"})`. Implementation work uses the same shape with `write`/`edit` added and an explicit file scope.

## The thirteen tools

| Tool | Purpose |
|---|---|
| `orchestrator_inventory` | Configured routes and recorded evidence; no provider call |
| `orchestrator_qualify` | Real probe for one exact route and effort, plus optional capability probes and an operator attestation |
| `orchestrator_delegate` | Select a qualified route and run a scoped child agent |
| `orchestrator_delegate_read` | Read saved assignment output without restarting it |
| `orchestrator_plan` / `orchestrator_run` | Persist and run a direct model task with bounded continuation |
| `orchestrator_read` | Saved output, route, prompt and accounting |
| `orchestrator_resume` | Resume only a settled, safe state; never an uncertain replay |
| `orchestrator_iterate` | Review a run and, while its verdict asks for more, run bounded revise cycles |
| `orchestrator_capacity` | What can be dispatched now, per pool, and the probe that would fix anything unusable |
| `orchestrator_list` | Find saved assignments, tasks and evidence; summaries only |
| `orchestrator_forget` | Permanently delete a saved record or lapsed evidence |
| `orchestrator_qualification_echo` | Internal probe helper; no filesystem or network access |

Full argument details are in [docs/USAGE.md](docs/USAGE.md).

## What it does not do

Being clear about this matters more than the feature list, because every claim above is bounded by it.

- **It does not judge your work.** A verdict is the reviewer's declaration, stored verbatim. The plugin reads the declared state to decide whether a cycle may continue; it never reads prose to decide whether work is good.
- **It is not a budget cap.** `$1` is a soft target; requests can exceed it. Most routes report `costUnknown` with token counts instead of a price, and unknown cost never means free.
- **It is not a security boundary.** It connects to real host services under your existing sandbox, permissions and approval policy.
- **It does not certify competence.** A passed probe shows one route answered one bounded challenge. Specialist-domain and confidential work require a named human attestation precisely because no probe can establish them.
- **It does not run several models in parallel on one task.** One delegation is one scoped child at a time; a review is a separate run, not a second opinion fetched concurrently.
- **Agents do not talk to each other.** The host caps delegation at one level, and every hand-off is recorded through the parent as data. There is no side channel whose outcome escapes the journal.

## Start here

- [demo.mjs](demo.mjs): run the routing and verdict logic with no host — `node demo.mjs`.
- [docs/DESIGN-NOTES.md](docs/DESIGN-NOTES.md): the decisions and what they cost, readable without installing anything.
- [START-HERE.md](START-HERE.md): shortest installation path.
- [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md): complete copy-paste installation prompt.
- [docs/USAGE.md](docs/USAGE.md): tool calls and task metadata.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): host integration and persistence.
- [docs/SECURITY-AND-LIMITS.md](docs/SECURITY-AND-LIMITS.md): read before enabling paid calls or project writes.
- [CHANGELOG.md](CHANGELOG.md): released behavior changes.
- [SECURITY.md](SECURITY.md): report security vulnerabilities privately.
- [CONTRIBUTING.md](CONTRIBUTING.md): development checks and pull request guidance.
- [examples/PROJECT-PROMPT.md](examples/PROJECT-PROMPT.md): scoped task prompt for any project.

## Requirements

- Node.js **22 or newer**.
- An installed, running, compatible DSH/Cordis host with native tool registration, LLM preparation/streaming, and child-agent APIs.
- The actual destination host's `dsh-tools/lib/index.js` module, not a path copied from another machine.
- Provider adapters and accounts authenticated through the host's supported UI or official authentication flow.

The source integration was developed against `dsh-tools` **0.1.5-rc.2** with Cordis **^4.0.2**. This is a compatibility reference, not a guarantee for every release. If DSH is missing, consult its current official installation documentation; this folder does not install DSH and does not invent a universal host-install command.

## Offline preparation

From this folder, after confirming the package and scripts are present:

```sh
node scripts/verify.mjs
npm test
node scripts/setup.mjs --tools-module "<actual-host-dsh-tools/lib/index.js>" --state-root "<absolute fresh state directory>"
node scripts/doctor.mjs
```

The verifier checks listed file hashes in `portable-manifest.json` and detects missing/modified listed files. It is not an authenticity signature and does not reject unlisted extra files. Use a complete, finalized distribution with its manifest; do not fabricate a new manifest to conceal a failed check.

Whether you clone or copy the folder, the files must keep their committed bytes. `.gitattributes` disables line-ending translation for exactly this reason. If verification reports many or all files as modified, the checkout rewrote line endings rather than the code being tampered with — re-clone it, or run `git rm -r --cached .` followed by `git reset --hard`, instead of regenerating the manifest.

`--state-root` is optional; use it explicitly when isolating this installation. Supply exactly one of `--tools-module` or the alternative `--harness-root "<absolute installed host directory>"` discovery option, not both. The portable code uses Node built-ins; **`npm install` is not required for this package**. That does not remove the separate DSH host requirement.

Setup generates only **`.local/entry.mjs` and `.local/host-patch.yml`**. It does not edit or activate a host profile. Doctor checks the local/generated integration offline; it can also accept the tools-module argument. Neither doctor nor `npm test` authenticates a provider, makes live qualification claims, or proves that the running host loaded the plugin.

Back up the **active user-owned host patch**, inspect `.local/host-patch.yml`, and merge its root insertion without overwriting existing rows. Never edit shipped presets. Detect existing `orchestrator_*` registrations before activation: resolve a collision only through an explicitly identified, backed-up old plugin row and appropriate user authority. See the AI guide for the complete sequence.

## What installation does — and does not — prove

| Stage | Evidence |
|---|---|
| `npm test` passes | Offline synthetic behavior only |
| Setup and doctor pass | Local entry/candidate patch and offline compatibility checks |
| Host loads the entry | Native tool registration in that running host |
| Fresh `orchestrator_qualify` passes | One exact route/effort's live probe in the calling owner session |
| Routed task succeeds | End-to-end behavior for that task and scope |

No credentials, authenticated accounts, previous state or transferable live qualifications are bundled. Previous-machine successes do not qualify this machine. Qualifications are **owner/root-session scoped**, expire after **24 hours**, and must be created in the same root agent session that dispatches work. A new project/session must establish its own evidence.

## Routing policy

The bundled candidate mapping in `src/routes.mjs` reflects one deployment, not universal provider availability:

| Pool | Candidate order |
|---|---|
| economy | Luna, DeepSeek V4 Flash |
| balanced | Terra, Sonnet, DeepSeek V4.1 Flash label |
| advanced | Sol, Opus, K3 |
| long-horizon | Fable, Astra, K3 |
| vision | DeepSeek V4 vision (explicit choice only) |

Routes in no pool are reported as `reserve: true`: held back deliberately, not broken. Only exact, current, qualified route/effort combinations can be selected, and a model is never silently aliased. If another host needs different identifiers, review the route definitions, pool priorities and effort expectations together, then qualify the new mappings. Synthetic test records are never live qualification evidence.

## Operating limits

- **$1 is a soft estimated target, not a financial ceiling.** Requests can exceed it without a per-call budget approval. Normal host permissions and approval policies still apply; there is no security bypass.
- Native/subscription costs may be **unknown**, not zero. Direct tasks report token usage where no price exists; delegated runs report why no token count is available.
- Direct tasks can continue clean token-limit stops; uncertain interrupted attempts are not blindly retried. File-changing agents do not automatically repeat potentially completed side effects.
- Raw concatenation of saved continuation rounds can omit a newline at a boundary. Saved content is not a guarantee of correctly formatted or semantically complete output.
- Basic smoke evidence does not qualify the `vision` or `domain` roles; each needs its own probe or attestation.
- At most two qualifications and two delegations run concurrently per owner; further calls are refused rather than queued.

Use a fresh state directory on the destination machine. Keep it private: prompts and visible outputs are stored in plaintext until you delete them with `orchestrator_forget`. Review the full security document before use.

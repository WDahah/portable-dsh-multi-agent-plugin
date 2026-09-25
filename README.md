# Multi-agent: portable DSH/Cordis orchestration plugin

[![CI](https://github.com/WDahah/portable-dsh-multi-agent-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/WDahah/portable-dsh-multi-agent-plugin/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/WDahah/portable-dsh-multi-agent-plugin)](https://github.com/WDahah/portable-dsh-multi-agent-plugin/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%E2%89%A522-brightgreen)](package.json)
[![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)](package.json)

**Route tasks, run scoped agents, collect parallel findings, and record structured reviews—with explicit limits and durable history.**

Adding a second agent is easy. Knowing which agent did what, with which tool, under which policy, and when it must stop is the hard part. Multi-agent gives your DSH harness that coordination layer as fifteen native tools, with no dependencies to install. v1.14 also adds an opt-in **governance gate**: a six-stage, human-authorized path from plan to reviewed candidate.

- **One accountable supervisor.** Workers get a scoped prompt and a tool allowlist, and can't delegate further.
- **Evidence before dispatch.** A route is used only after a fresh live qualification in your own session.
- **Defined stopping points.** Round caps, review-cycle caps, deadlines and author-attempt budgets are fixed in advance.
- **A traceable record.** Every assignment keeps its route, model, prompt, output and failure state.

This is a native plugin for a compatible **DeepSeek Harness (DSH)/Cordis host**, not a standalone framework or hosted service. It selects routes from fresh session-scoped smoke evidence, runs bounded work, and records prompts, results, model identity and failure states. A reviewer declares whether work passed; the plugin follows that declaration, not its own judgment of the answer.

**Multi-agent does not automatically save tokens.** In the [27-trial benchmark](docs/BENCHMARK.md), parallel workers plus integration consumed **92.2% more tokens than one agent**. They were **23.5% faster than the same workers run sequentially**, but slower than one agent. Use delegation for useful separation of work—not an assumed token discount.

## Contents

- [Why a control plane](#why-a-control-plane)
- [Features](#features)
- [New: governance gate](#new-governance-gate)
- [Mandatory conditions](#mandatory-conditions)
- [Does it save tokens?](#does-it-save-tokens)
- [Try it without a host](#try-it-without-a-host)
- [Requirements and installation](#requirements-and-installation)
- [First tasks](#first-tasks)
- [The fifteen tools](#the-fifteen-tools)
- [Routing and qualification](#routing-and-qualification)
- [Limits and safety](#limits-and-safety)
- [Validation and development](#validation-and-development)
- [Documentation](#documentation)

## Why a control plane

Rod Trent's [*Multi-Agent Systems and Orchestration: The Hard Problem Is Coordination*](https://rodtrent.substack.com/p/multi-agent-systems-and-orchestration) argues that orchestration is architecture, not a prompt. It lists seven things a coordination layer must specify on purpose. This plugin's answer to each:

| Requirement | How Multi-agent handles it |
|---|---|
| **Endpoints and contracts** | Each call carries a typed `task` object, an explicit prompt and a tool allowlist. Refusals return a named reason, such as `MISSING_EXACT_QUALIFICATION`. |
| **Topology** | A star: the parent supervises and children have delegation depth one. No peer mesh, so every decision can be traced back through the parent. |
| **Authority** | Reviewers *declare* verdicts; the plugin records them and doesn't judge the work. In the governance gate, only a human can authorize a plan, and model output can't. |
| **State** | Durable per-owner journals for assignments, batches, qualifications and direct tasks, readable without calling a model. Chat history isn't the system of record. |
| **Aggregation** | Explicit, not hidden: batches return findings in request order, and you add an integration step yourself and count its cost. |
| **Termination** | `max_rounds`, at most three review/revise cycles, per-call deadlines, 24-hour qualification expiry, and three author attempts in the governance gate. |
| **Failure policy** | Uncertain work is never replayed automatically. Failover is opt-in and only for pre-dispatch refusals. `needs-clarification` and contradictory verdicts stop the loop and hand back to you. |

The article's practical advice is also built in: keep workers narrow, prefer deterministic scaffolding (a fixed stage order in the gate), record every handoff, and keep a human at the points that need judgment.

## Features

| Feature | What it does | Important limit |
|---|---|---|
| **Task-based routing** | Uses role, risk, complexity, data class and requested capabilities to select a qualified route; reports selection grounds | Deterministic policy, not a quality predictor or cheapest-price optimizer |
| **Live qualification** | Probes one exact provider/model/effort for text and native tool round-trip; optional image/structured-output probes and operator attestations | A bounded smoke test does not certify competence on your task |
| **Scoped delegation** | Runs a native child with an explicit prompt and tool allowlist; records its model and output per round | Prompt scopes are not path-level sandbox enforcement |
| **Read-only parallel batches** | Accepts 2–8 independent tasks, runs up to two workers, and collects bounded findings in request order | Caller supplies scopes; no automatic decomposition, dependency graph, synthesis or semantic verification |
| **Provider-diverse review** | Prefers a reviewer from another provider and records whether that preference was satisfied, including after failover | Different provider does not prove independent reasoning or correctness |
| **Bounded review/revise loops** | Follows structured verdicts for up to three cycles; stops on clarification, incoherence, unreadable output or the cap | `VERIFIED` is the reviewer's declaration, not an independent test result |
| **Durable records** | Stores assignment, batch, qualification and direct-task state; supports read/list/delete without model dispatch | Plaintext local state; single-process coordination, not distributed locking |
| **Conservative continuation** | Can continue clean token-limit stops for eligible read-only work; does not automatically repeat write-capable work | Continuation creates another child and spends more tokens; uncertain work is not replayed |
| **Opt-in distribution and failover** | Deterministically rotates eligible routes; can try an alternate after a recognized pre-dispatch refusal for read-only work | Not live load balancing, provider quota scheduling or general error retry |
| **Separate accounting signals** | Direct tasks expose available per-round usage and missing-usage counts; native assignments expose commitments, returned children and timing | Native child results do not expose cumulative token usage to this plugin |

### Parallel batches in v1.14.0

Batch workers share **two native execution slots** with ordinary delegations and compactions. Remaining batch work can wait in an internal FIFO queue of at most **eight pending reservations**. Ordinary delegate/compact calls refuse when busy; there is at most one active batch per owner.

Workers use only `read`, `glob` and `grep`, with one delegated round each. They return a short summary, at most five findings with evidence, and up to three uncertainties. A delegated round may contain several model/tool steps. Batch workers have no automatic continuation, failover or compaction. **The batch does not include an integration call**; add one explicitly if you need a combined answer and count its cost.

Slots stay occupied until child results and disposal settle, even after cancellation. Saved batch IDs cannot be replayed; unfinished recovered batches report `INTERRUPTED_UNKNOWN`. [Full batch behavior and limits →](docs/USAGE.md#parallel-read-only-batches)

Native `orchestrator_delegate` and `orchestrator_iterate` calls may now run for up to **2,500,000 ms (about 42 minutes)**, up from 15 minutes, so longer reviews can finish. This is a ceiling, not a typical duration: a short delegation usually returns in seconds.

## New: governance gate

The governance gate is a separate, **opt-in** entry for work that needs a person to sign off at each step. It turns one configured job into a fixed six-stage sequence, and each stage must be requested by a human:

```text
open → plan-review → human authorization → author → seal → validate → review
```

- **Human commands in the chat box.** In the dedicated host, the operator types `/gov-status`, `/gov-open`, `/gov-stage`, `/gov-authorize` and the other commands directly into the DSH Web GUI. The input box shows a hint with each command's arguments. Model output, copied text or a nested model call can't authorize anything.
- **Independent checks.** The plan is reviewed before any author runs. The author's candidate is sealed byte-for-byte, then validated with pinned trusted tests and reviewed separately.
- **A hard attempt budget.** Three author attempts in total: the first plus two corrections. Nothing refunds an attempt, including pause, restart or a new workspace.
- **Same-owner pause and resume.** `/gov-pause` returns a one-time checkpoint; `/gov-resume <checkpoint> author` consumes it exactly once.
- **Bounded, read-only diagnostics.** `/gov-read` pages status, history, evidence and artifacts at no more than 16 KiB per reply. It isn't a file reader.
- **Qualification and offline acceptance.** `/gov-accept`, `/gov-qualify` and `/gov-export` in the disposable qualification host produce receipts. Every receipt carries `qualificationOnly:true`, `operationallyAccepted:false` and `gateActive:false`.

### Example: one job from plan to export

A walkthrough typed by hand in the receiver session. Each line is sent as its own message, and the digests are shortened here. Copy the real values from the reply to the step before; each reply names the next allowed step.

| You type | What happens | Key field in the reply |
|---|---|---|
| `/gov-status` | Reads the job before anything starts | `gateActive:false` |
| `/gov-open <projectId> <planDigest>` | Opens the one configured project and plan | `headAuthenticity:"live-verified"` |
| `/gov-stage plan-review` | An independent reviewer checks the plan | `phase:"AWAITING_HUMAN"`, `resultId` |
| `/gov-authorize <planDigest> <resultId> authorize` | You approve this exact plan | the plan-review result becomes a human decision |
| `/gov-stage author` | The author writes a candidate (uses 1 of 3 attempts) | `phase:"AUTHORING"` |
| `/gov-stage seal` | The candidate's exact bytes are frozen | `candidateDigest:"1422…"` |
| `/gov-stage validate` | Pinned trusted tests run against the sealed bytes | `outcome:"completed-pass"` |
| `/gov-stage review` | A separate reviewer judges the candidate | `phase:"DIAGNOSTIC_READY"` |
| `/gov-accept <candidateDigest> <headDigest>` | Records an offline acceptance, with no activation | `acceptanceRecorded:true` |
| `/gov-qualify <candidateDigest> <newHeadDigest>` | Rechecks everything and issues a receipt | `qualificationReceiptDigest:"4cce…"` |
| `/gov-export <receiptDigest> <destinationId>` | Copies the candidate once to the fixed destination | `deliveryPhase:"completed"` |
| `/gov-export …` (same line again) | The replay is refused | `reason:"DELIVERY_NOT_AUTHORIZED"` |
| `/gov-stop` | Revokes admission and shuts the owner down | — |

Accept and qualify each add an event, so read the current `headDigest` with `/gov-status` before the next step. Every step can refuse with a named `reason`, and nothing moves forward on its own. The export folder then contains exactly `payload/`, `descriptor.json`, `qualification-receipt.json` and `complete.json`. The repository you're working in is never modified.

Two common mistakes:
- **Commands sent in a new session.** Type the commands in the receiver session, not a **New Session**. Anywhere else they are refused with `M4_HUMAN_RECEIVER`.
- **Several commands in one message.** Send one command per message; several pasted together are treated as a single chat message.

What it is **not**: it doesn't activate itself in your everyday harness, apply candidates to your checkout, or survive a cold restart. After process loss, a store is read-only and marked `RECONCILIATION_REQUIRED`. A walkthrough typed by hand in the stock Web GUI has been exercised in a disposable qualification host; that is qualification evidence, not operational acceptance.

[Full governance guide: setup, commands, diagnostics, pause/resume and limits →](docs/GOVERNANCE.md)

## Mandatory conditions

Check these before you install. If one isn't met, the tools either won't appear or will refuse work.

**For the orchestrator (all users):**

1. **Node.js 22 or newer** and **Git**.
2. **A running, compatible DSH/Cordis host** that provides native tools, LLM streaming and child agents. This plugin doesn't run on its own.
3. **The host's own `dsh-tools/lib/index.js`**, passed to setup as an absolute path. Don't copy that module from another install.
4. **Provider accounts already authenticated in the host.** No credentials are bundled.
5. **Explicit enablement and a host restart.** The plugin is disabled by default. Add the generated patch to your *user-owned* profile, set `enabled: true`, then restart DSH. Never edit the shipped presets.
6. **Qualification in the same root session that dispatches work.** Qualifications expire after 24 hours, and nothing transfers between sessions or machines.

**For the governance gate (additionally):**

1. **Windows x64 with Node 26.9.0.** This is the only guarded execution lane.
2. **A dedicated, disposable host.** Never your everyday profile. Setup generates an inert candidate and never mounts it for you.
3. **A reviewed configuration** with exact pins: bundle and install hashes, Node/Git/host files, stage routes, a fixed receiver ID, and six distinct canonical roots.
4. **A restricted session policy.** `danger-full-access`, missing services or changed pins block stage admission.
5. **A human at the keyboard.** The commands must come from the registered receiver session. Open that session by clicking it in the sidebar, not **New Session**. A brand-new session with no turns shows the Web landing page instead of command replies.

## Does it save tokens?

**Not in the measured workloads below.** Keeping file contents in child sessions can reduce the main conversation's context, but those children still consume tokens. Repeated instructions, separate contexts, reviews and integration can cost more than one agent doing the work.

The benchmark used three bounded repository-inspection workloads, three repetitions, and the same Codex `gpt-5.6-luna` model at medium effort for all approaches. Both multi-agent approaches include a final integration call.

| Approach | Accepted | Mean tokens per trial | Tokens per accepted result¹ | Mean elapsed time |
|---|---:|---:|---:|---:|
| Single agent | 6/9 | **17,729** | **26,594** | **18.0 s** |
| Sequential workers + integration | 9/9 | 34,404 | 34,404 | 38.2 s |
| Parallel workers + integration | 8/9 | 34,076 | 38,335 | 29.2 s |

¹ All tokens consumed, including failed answers, divided by accepted results. This is not an estimate of retry cost.

- Usage was captured for **108/108 observed model calls** across **63 native child sessions**, using temporary host telemetry outside the shipped plugin's accounting interface.
- Parallel used **44.2% more tokens per accepted result** than single-agent execution, with only a **1.0% aggregate token difference** versus sequential workers.
- Three single-agent answers omitted half the questions. One parallel answer was factually correct but returned five findings instead of the required four. All costs remain included.
- Setup, qualification, pilots, outer conversation and external acceptance scoring are excluded. These are bounded task-execution totals, **not the entire experiment's token bill**. Dollar cost is unknown.
- Scoring was not blind, cache/provider load was uncontrolled, and there were only three repetitions per workload. The benchmark used the pre-review-fix v1.14.0 working snapshot, not an old/new release A/B test; it has not been rerun on the final fixes.

**Recommendation:** use one agent by default for small inspections. Choose parallel specialists when independent scopes or latency relative to sequential specialists justify the overhead. These measurements do not establish a general token-saving claim or predict larger tasks.

[Methodology, totals and limitations](docs/BENCHMARK.md) · [All 27 trial measurements (CSV)](docs/benchmarks/native-readonly-trials.csv)

## Try it without a host

With Node.js 22 or newer and Git installed:

```sh
git clone https://github.com/WDahah/portable-dsh-multi-agent-plugin
cd portable-dsh-multi-agent-plugin
node demo.mjs
```

The demo runs the project's real routing and verdict parsing logic with **synthetic qualification evidence**. It makes no provider calls and does not prove that any route is available or that an answer is correct. It demonstrates selection, refusals, expiry, provider-diversity preference and declared verdict handling.

You can run a single scene: `node demo.mjs routing`. Other scenes are `refusal`, `expiry`, `diversity`, `verdicts`, `objective` and `aliases`.

## Requirements and installation

For live work you need:

- Node.js **22+** and a running compatible DSH/Cordis host.
- Host APIs for native tools, LLM preparation/streaming and child agents.
- The destination host's actual `dsh-tools/lib/index.js` module.
- Provider adapters and accounts authenticated through the host's supported mechanisms.

This package uses Node built-ins and has no package dependencies; **`npm install` is not required here**. That does not remove the host requirement. Integration was developed against `dsh-tools` **0.1.5-rc.2** and Cordis **^4.0.2**, not every host version.

1. Follow [START-HERE.md](START-HERE.md), or use the scoped prompt in [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md).
2. Verify the supplied manifest and run the offline tests.
3. Generate and inspect the local entry and candidate host patch using your actual host module path.
4. Back up and update the **active user-owned host composition** using its supported reload procedure. Never edit shipped presets or silently add colliding `orchestrator_*` registrations.
5. Verify all fifteen tools are visible, then qualify needed routes in the **same root session** that will dispatch work.

The core commands, from the package root:

```sh
node scripts/manifest.mjs --check
node scripts/setup.mjs --harness-root <absolute installed DSH directory> --state-root <absolute state directory>
node scripts/doctor.mjs
```

Then copy the `insert` entry from `.local/host-patch.yml` into your profile's `cordis.patch.yml`, set `enabled: true`, and restart DSH.

Setup generates `.local/entry.mjs` and `.local/host-patch.yml`; it does not install DSH, activate the plugin or authenticate accounts. Doctor checks the local integration offline. The plugin defaults disabled until deliberately enabled in the host configuration.

The integrity manifest detects missing or changed listed files; it is **not an authenticity signature** and the verifier does not reject unlisted extras. A hash mismatch can mean a changed file, corruption or line-ending conversion. Investigate it; do not regenerate the manifest to conceal an unexpected mismatch or run a destructive reset on valuable local work.

## First tasks

### Delegate one read-only inspection

After activation and qualification, invoke `orchestrator_delegate` with arguments such as:

```json
{
  "task": {
    "role": "standard",
    "intent": "explain the auth flow",
    "category": "code-inspection",
    "risk": "low",
    "complexity": "routine",
    "escalate": false,
    "dataClass": "internal"
  },
  "run_id": "auth-inspect-001",
  "prompt": "Inspect src/auth only. Explain the authentication flow with file:line evidence. Do not edit files, run commands, or access the network.",
  "allowed_tools": ["read", "glob", "grep"],
  "max_rounds": 1,
  "max_tokens": 16384
}
```

These are **host tool arguments**, not a shell command. Replace the path with a real scope in your project. Read saved output with `orchestrator_delegate_read({"run_id":"auth-inspect-001"})`. Explicitly authorized implementation tasks can add `write`/`edit`; they do not get automatic new-child continuation after a token limit.

### Inspect two independent scopes

Invoke `orchestrator_batch` with a shared brief and independently scoped tasks:

```json
{
  "batch_id": "inspect-001",
  "brief": "Read-only inspection. Report bounded findings with file:line evidence, not edits.",
  "tasks": [
    {
      "id": "dispatch",
      "scope": "src/agent-dispatch.mjs",
      "prompt": "Inspect admission and cancellation behavior only.",
      "task": {"role":"standard","category":"code-inspection","risk":"low","complexity":"routine","escalate":false}
    },
    {
      "id": "routing",
      "scope": "src/routes.mjs",
      "prompt": "Inspect route selection and evidence checks only.",
      "task": {"role":"standard","category":"code-inspection","risk":"low","complexity":"routine","escalate":false}
    }
  ]
}
```

`orchestrator_batch_read({"batch_id":"inspect-001"})` returns summaries; add `"details":true` for findings. `COMPLETED` means workers finished and declared complete—not that their findings were verified. [Argument limits and recovery →](docs/USAGE.md#parallel-read-only-batches)

## The fifteen tools

| Tool | Purpose |
|---|---|
| `orchestrator_inventory` | Configured routes and recorded evidence; no provider call |
| `orchestrator_qualify` | Exact route/effort smoke test, optional capability probes and operator attestation |
| `orchestrator_qualification_echo` | Internal active-challenge helper |
| `orchestrator_capacity` | Recorded route eligibility and suggested requalification; not real-time provider capacity |
| `orchestrator_delegate` | Select a qualified route and run a scoped native child |
| `orchestrator_delegate_read` | Read saved assignment output without dispatch |
| `orchestrator_batch` | Collect bounded findings from 2–8 read-only tasks using two workers |
| `orchestrator_batch_read` | Read saved batch summaries or detailed findings |
| `orchestrator_iterate` | Bounded review/revise cycles driven by declared verdicts |
| `orchestrator_plan` | Select and persist a direct-model task |
| `orchestrator_run` | Execute a planned direct task with eligible bounded continuation |
| `orchestrator_read` | Read direct-task output and available accounting |
| `orchestrator_resume` | Resume only an engine-approved safe state, never uncertain work |
| `orchestrator_list` | List assignments, batches, direct tasks or qualification evidence |
| `orchestrator_forget` | Permanently delete eligible saved records; in-flight/reference checks apply |

[Full tool reference →](docs/USAGE.md)

## Routing and qualification

Roles are `standard`, `deep`, `review`, `vision` and `domain`. A free-text `intent` describes the task without changing routing. Ordinary work defaults to **balanced**. An advanced role or critical risk can justify **advanced** alone; otherwise escalation needs corroborating grounds. `escalate:true` requests **long-horizon**. An explicit `pool` overrides the default policy; **economy is not selected automatically** just because a task looks easy.

[Bundled routes](src/routes.mjs) are deployment-specific candidates, not universal availability promises:

| Pool | Candidate priority |
|---|---|
| economy | Luna, DeepSeek V4 Flash |
| balanced | Terra, Sonnet, DeepSeek V4.1 Flash label |
| advanced | Sol, Opus, K3 |
| long-horizon | Fable, Astra, K3 |
| vision | DeepSeek V4 vision, explicit pool choice |

Model labels/identifiers are those configured in the source, not pinned model versions. Your host must expose the exact provider/model/effort and pass fresh qualification. Route mappings may need a reviewed change on another host. No credentials or transferable qualifications are bundled.

Qualification is owner/root-session scoped and expires after **24 hours**. Text/tool probes establish basic reachability; image and structured-output probes cover those specific capabilities. Domain competence and broader data-class permission require a named operator attestation. An attestation records a decision—it does not prove expertise or provider data handling.

Priority order is the default. `spread:true` is deterministic rotation, not live load balancing or guaranteed equal distribution; reviewer-provider preference takes precedence. `failover:true` is opt-in and restricted to recognized pre-dispatch refusals without output in read-only assignments. A later successful call is never guaranteed by earlier qualification.

## Limits and safety

- **No automatic correctness guarantee.** Structured output validates fields, not truth. The reviewer declares `verified`, `partial`, `failed` or `needs-clarification`. Contradictory verdicts stop the loop; they do not get silently resolved.
- **No guaranteed token savings or hard spending cap.** Direct tasks report a soft $1 estimated target where pricing is available; native/subscription monetary cost can be unknown. Requested token limits and deadlines are not financial ceilings.
- **No complete native usage ledger in the plugin.** Native assignments/batches report usage as unknown; child commitments and returned-child counts are not model-call counts. Direct tasks expose available usage and missing rounds. The published benchmark used separate temporary telemetry.
- **Host policies still apply.** Tool allowlists restrict exposed tools, but prompt scopes are not an independent filesystem security boundary. This plugin does not bypass sandbox or approval controls.
- **No automatic replay of uncertain work.** Read-only continuation after clean token limits is bounded; write-capable partial work needs reconciliation. Saved text can still be incomplete or incorrectly formatted.
- **Small, owner-local concurrency.** At most two qualifications and two native delegate/compact assignments run per owner. Batch workers share the native slots and may queue internally; ordinary busy calls refuse. Direct-model tasks and qualifications do not share the native admission pool. This is not a provider-wide quota controller.
- **No peer-agent protocol or shared-write coordination.** Children have delegation depth one; the plugin passes recorded results through the parent. Batches are read-only and cannot prove caller-supplied scopes are independent.
- **Local durability has limits.** Journals coordinate one process, not several processes or machines. A batch-journal failure aborts siblings; an isolated assignment-journal failure leaves that task incomplete while others may continue. Review uncertain records before replacement work.
- **Plaintext retention.** Prompts and visible outputs stay in the state directory until removed. Keep it private and use a fresh state directory on another installation. Deletion is permanent; it does not undo external side effects.

[Read the security and limits guide before enabling paid calls or project writes.](docs/SECURITY-AND-LIMITS.md)

## Validation and development

For the v1.14.0 review-fix snapshot, the local Windows/Node 26.9.0 run passed **224 tests**, with no failures or skips. Focused regressions were first run against the pre-fix source to confirm the reported failures. An independent source review found no remaining blocking issue in that delta. These are not proof of correctness or a substitute for CI.

CI is configured for **Linux, Windows and macOS on Node 22 and 24**. Check the CI badge or the specific commit's run; a configured matrix is not a claim that every leg has passed. The live benchmark is separate evidence from the offline suite and covers only its stated tasks and snapshot.

From a complete checkout:

```sh
node scripts/manifest.mjs --check
node scripts/verify.mjs
npm test
```

Contributors who intentionally change packaged files must regenerate the manifest with `node scripts/manifest.mjs`, review the diff, and verify again. Keep `.local/`, credentials and state out of commits. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [START-HERE.md](START-HERE.md) — shortest installation path.
- [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md) — scoped installation instructions for an assistant.
- [Usage](docs/USAGE.md) — tool arguments, limits, review loops and recovery.
- [Governance](docs/GOVERNANCE.md) — opt-in six-stage gate, human commands, diagnostics and limits.
- [Architecture](docs/ARCHITECTURE.md) — host integration and persistence.
- [Security and limits](docs/SECURITY-AND-LIMITS.md) — permissions, spending and retained state.
- [Benchmark](docs/BENCHMARK.md) — measured token/latency results and limitations.
- [Design notes](docs/DESIGN-NOTES.md) — rationale and historical experiments, not current performance guarantees.
- [Changelog](CHANGELOG.md) — versioned behavior changes.
- [Example project prompt](examples/PROJECT-PROMPT.md) — a starting point for scoped work.
- [Security reporting](SECURITY.md) · [Issues](https://github.com/WDahah/portable-dsh-multi-agent-plugin/issues)

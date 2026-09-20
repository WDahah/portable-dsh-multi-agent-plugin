# Multi-agent: portable DSH/Cordis orchestration plugin

**A native plugin for a compatible DeepSeek Harness (DSH)/Cordis host — not a standalone agent framework.** It routes each task to a model that has actually been tested for it, runs the work in a scoped child agent, and keeps a durable record of what was asked, which model answered, and what authorized the run.

Any capable AI assistant can follow the installation guide. That does **not** mean every AI application can run this plugin: the destination host must provide compatible native `tools`, `llm` and `subagents` APIs.

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

Cheap models handle routine work; expensive ones are reserved for review, high risk, or complex tasks. An `escalate` flag reaches the long-horizon pool.

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
| `orchestrator_capacity` | What can be dispatched now, per pool, and the probe that would fix anything unusable |
| `orchestrator_list` | Find saved assignments, tasks and evidence; summaries only |
| `orchestrator_forget` | Permanently delete a saved record or lapsed evidence |
| `orchestrator_qualification_echo` | Internal probe helper; no filesystem or network access |

Full argument details are in [docs/USAGE.md](docs/USAGE.md).

## What it does not do

- **It is not a budget cap.** `$1` is a soft target; requests can exceed it. Most routes report `costUnknown` with token counts instead of a price, and unknown cost never means free.
- **It is not a security boundary.** It connects to real host services under your existing sandbox, permissions and approval policy.
- **It does not certify competence.** A passed probe shows one route answered one bounded challenge; it is not proof of skill, and a completed run is not proof the answer is correct.
- **It does not run several models in parallel on one task.** One delegation is one scoped child at a time; eligible read-only continuation uses a further child.

## Start here

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

Whether you clone or copy the folder, the files must keep their committed bytes. `.gitattributes` disables line-ending translation for exactly this reason. If verification reports many or all files as modified, the checkout rewrote line endings rather than the code being tampered with — refresh it with `git rm -r --cached . && git reset --hard` (or re-clone) instead of regenerating the manifest.

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

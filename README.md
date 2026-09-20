# Multi-agent: portable DSH/Cordis orchestration plugin

**This is a native plugin for a compatible DeepSeek Harness (DSH)/Cordis host—not a standalone agent framework.** It adds task-driven model/effort selection, scoped child-agent dispatch, saved results and bounded continuation. It can be used with an unrelated software project; no project-specific runtime is required.

Any capable AI assistant can follow the installation guide. That does **not** mean every AI application can run this plugin: the destination host must provide compatible native `tools`, `llm` and `subagents` APIs.

## Start here

- [START-HERE.md](START-HERE.md): shortest installation path.
- [INSTALL-WITH-AI.md](INSTALL-WITH-AI.md): complete copy-paste installation prompt.
- [docs/USAGE.md](docs/USAGE.md): tool calls and task metadata.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): host integration and persistence.
- [docs/SECURITY-AND-LIMITS.md](docs/SECURITY-AND-LIMITS.md): read before enabling paid calls or project writes.
- [SECURITY.md](SECURITY.md): report security vulnerabilities privately.
- [CONTRIBUTING.md](CONTRIBUTING.md): development checks and pull request guidance.
- [examples/PROJECT-PROMPT.md](examples/PROJECT-PROMPT.md): scoped task prompt for any project.
- [examples/task.json](examples/task.json): task metadata, not a complete delegation request.

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

## What installation does—and does not—prove

| Stage | Evidence |
|---|---|
| `npm test` passes | Offline synthetic behavior only |
| Setup and doctor pass | Local entry/candidate patch and offline compatibility checks |
| Host loads the entry | Native tool registration in that running host |
| Fresh `orchestrator_qualify` passes | One exact route/effort's live text-and-tool smoke in the calling owner session |
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

Only exact, current, qualified route/effort combinations can be selected. Do not silently alias models. If another host needs different identifiers, explicitly review/update the route definitions, pool priorities and effort expectations together, then qualify the new mappings. Synthetic test records are never live qualification evidence.

## Operating limits

- **$1 is a soft estimated target, not a financial ceiling.** Requests can exceed it without a per-call budget approval. Normal host permissions and approval policies still apply; there is no security bypass.
- Native/subscription costs may be **unknown**, not zero. Some explicit API estimates use historical rates rather than current invoices.
- Direct tasks can continue clean token-limit stops; uncertain interrupted attempts are not blindly retried. File-changing agents do not automatically repeat potentially completed side effects.
- Raw concatenation of saved continuation rounds can omit a newline at a boundary. Saved content is not a guarantee of correctly formatted or semantically complete output.
- Basic smoke tests do not qualify image work (`R05`) or specialist-domain work (`R08`/`R09`).

Use a fresh state directory on the destination machine. Keep it private: prompts and visible outputs are stored in plaintext. Review the full security document before use.

# Governance diagnostics and same-owner pause/resume

Use this separate, opt-in entry to inspect one configured governance job and, in an explicitly authorized disposable host, request individual reviewed stages. **Diagnostic mode is the default. Cold restart continuation is not supported.** Diagnostic readiness never means operational acceptance: `gateActive` remains `false`.

This entry does not activate the legacy orchestrator, install a profile, apply a candidate to a checkout, or export accepted work. This guide describes the current interfaces, not an independent validation verdict or proof of a live human GUI walkthrough.

## Contents

- [Prepare an inert candidate](#prepare-an-inert-candidate)
- [Inspect configuration or stored history](#inspect-configuration-or-stored-history)
- [Human commands](#human-commands)
- [Read bounded diagnostics](#read-bounded-diagnostics)
- [Pause and resume the same owner](#pause-and-resume-the-same-owner)
- [Restart, refusal and support limits](#restart-refusal-and-support-limits)
- [Disposable finalization and export qualification](#disposable-finalization-and-export-qualification)
- [Offline acceptance record](#offline-acceptance-record)

## Prepare an inert candidate

Start with [the example policy](../examples/governance-policy.json). Its placeholders deliberately fail validation. A trusted operator must supply the exact reviewed v2 plan, pinned Node/Git/host files, stage routes, fixed receiver ID, and distinct canonical roots for project, governance, workspace, scratch, legacy protection and configuration protection. The preset ID is `governed-preset`. Setup accepts only `mode:"diagnostic"`.

The following is CLI syntax, not a configuration with usable pins:

```text
node scripts/setup-governance.mjs --bundle-root <absolute> --bundle-sha256 <manifest-hash> --install-root <absolute> --install-sha256 <package-hash> --config <absolute-json> --config-sha256 <hash> --output-root <absent-absolute>
```

All seven options are required. Hashes are lowercase, 64-character raw-file SHA-256 values:

| Option | Selected input |
|---|---|
| `--bundle-root` | This portable package root; setup verifies every indexed file |
| `--bundle-sha256` | Hash of that root's `portable-manifest.json` |
| `--install-root` | Explicit compatible DSH installation root |
| `--install-sha256` | Hash of that installation's `package.json` |
| `--config` / `--config-sha256` | Absolute reviewed configuration path and its exact file hash |
| `--output-root` | Absent absolute output directory whose parent already exists |

Quote paths containing spaces. Setup rejects pre-existing outputs, links, aliases and protected-root overlaps. It writes only these files inside the new directory:

- `entry.mjs`
- `host-patch.yml`
- `governed-preset/agent.cordis.yml`
- `governed-preset/preset.yml`
- `generation-report.json`

A complete generation report describes an **inert candidate**, not a running host. Setup does not mount its patch, modify the installation, create runtime roots, or call providers. Failure retains incomplete output; do not treat it as a usable profile or delete foreign replacements to retry.

Only the separately authorized disposable qualification composition may select `mode:"same-owner"`. Do not switch a normal profile to that mode or merge the candidate into a live configuration. The dedicated host requires exactly the owned preset, no inherited raw tools, and restricted default and effective session policies. `danger-full-access`, missing services, changed pins/routes/preset, or unavailable confinement prevents stage admission.

## Inspect configuration or stored history

Doctor uses one explicit selector and an absolute input path:

```text
node scripts/doctor-governance.mjs --config <absolute-config.json>
node scripts/doctor-governance.mjs --state <absolute-config.json>
node scripts/doctor-governance.mjs --report <absolute-m0-report.json>
```

`--config` checks the closed configuration and paths; `STARTUP_NOT_PROBED` means it has not established host eligibility. `--state` inspects the configured v2 journal and returns cold diagnostics or a bounded failure reason. `--report` retains the earlier M0 report-diagnosis interface. Doctor never starts a host, repairs history, creates locks, tests providers, or grants approval.

Cold reports use `headAuthenticity:"unproven"`. A consistent history does not prove that its latest suffix was not removed, so a cold report cannot establish an authoritative remaining budget. A failed inspection must not be interpreted as an empty job or permission to begin again.

## Human commands

These are commands for the captured human receiver in the dedicated host, not shell commands or model tools. The authenticated command transport and exact registered receiver/definition are required. Model output, copied command text, a nested model call, or a caller-supplied identity does not authorize execution.

Command results carry JSON in their response text. Read the returned status or `reason`; a command response alone is not acceptance. The exact command grammar is:

| Command | Effect |
|---|---|
| `/gov-status` | Read compact status and, for a live owner, pause/resume eligibility |
| `/gov-read <kind> <id-or-> <offset> <limit> [cursor-or-]` | Read one bounded diagnostic page; see below |
| `/gov-open <project-id> <plan-digest>` | Open only the sole configured project/plan after startup checks |
| `/gov-stage plan-review` | Request independent plan review; does not start an author |
| `/gov-authorize <plan-digest> <review-result-id> <authorize\|reject>` | Record the separate exact-plan human decision |
| `/gov-stage <author\|seal\|validate\|review>` | Request one permitted stage, without authorizing the next |
| `/gov-pause` | Pause at an eligible idle boundary; otherwise stop nonresumably |
| `/gov-resume <checkpoint-digest> author` | Consume one live checkpoint and enable the next author request only |
| `/gov-stop` | Revoke admission and drain owned work; no resume |
| `/gov-reassess <checkpoint-or-head-digest>` | Explain remaining conditions/budget without changing plan, state or grants |

Obtain digests, review-result IDs and checkpoints from current responses, not from model-generated summaries. The stage sequence is explicit: open, plan review, fresh human authorization, author, seal, validation, then review. Each step can refuse; no later step is automatic.

## Read bounded diagnostics

`kind` is exactly `status`, `history`, `evidence`, or `artifact`. Use `-` for the ID of the first three kinds; `artifact` requires a referenced artifact's 64-character hash. This is **not an arbitrary file reader** and accepts no filesystem path.

- Status uses offset `0` and limit `1`. `/gov-status` adds live continuity details that a basic status page may omit.
- History/evidence pages accept limits from `1` to `64` rows. An artifact projection accepts `1` to `8192` text characters.
- Every complete JSON response is at most **16 KiB**; a page may contain less than the requested limit.
- Begin at offset `0` with no cursor or `-`. Continue using the returned `nextOffset` and exact `cursor`; every nonzero offset requires a cursor. A changed journal head rejects the old cursor—start a fresh read rather than combining different heads.
- `complete:false` means more pages remain, not a complete authority record. Artifact text is a bounded public projection, not unrestricted persisted JSON. Log projections expose metadata with `rawTextAvailable:false`, not raw log contents.

Live reads recheck retained ownership. Cold reads recheck disk consistency but remain unauthenticated diagnostics. Neither mode turns a fragment, artifact hash or historical receipt into a live capability.

## Pause and resume the same owner

A resumable pause requires the original process-local owner and a fully settled `PLAN_AUTHORIZED` or `CORRECTION_REQUIRED` phase with budget remaining. Pause denies new work first, drains admitted operations, and revokes/closes old workspace, custody and runner capabilities while preserving evidence and the original store ownership.

A successful pause returns `checkpointDigest` and `nextAction:"author"`. The persisted control record is an audit record, **not a resume grant**. A fresh human `/gov-resume <checkpoint-digest> author` rechecks the same owner, head, plan, decision and attempt ledger, then consumes the checkpoint once. It does not create an actor or run a stage; issue a separate `/gov-stage author` afterward.

Repeated, concurrent, stale, copied or post-close resume requests cannot dispatch work. Consumption or persistence failure makes the owner blocked; uncertainty does not restore the checkpoint. Pause during busy work, or at frozen/validating/reviewing/ready phases, is nonresumable in this milestone.

The budget is **three author attempts total: initial plus two corrections**. Reservation spends the attempt before actor creation. Cancellation, setup failure, pause, restart, new IDs or a new workspace does not refund it. Corrections use fresh actors/workspaces while preserving findings and prior evidence. Reassessment cannot change the plan or reset the ledger.

## Restart, refusal and support limits

After process loss, clean close, unload or owner replacement, every existing store remains read-only `RECONCILIATION_REQUIRED`, including a previously ready store. Cold recovery and durable continuation are unimplemented. Do not reclaim locks by age/PID, deserialize checkpoints, replay an uncertain stage, shorten history, or select another root/job to reset its budget. Preserve evidence and inspect it read-only; a new recovery design requires separate authorization.

The guarded execution lane is **Windows x64, Node 26.9.0**, with pinned toolchain, exact reviewed provider/model/effort routes and fixed trusted test programs. The runner admits only approved command IDs for pinned Node with `--test --test-isolation=none --test-reporter=tap` and explicit protected tests. Arbitrary repositories, shell/npm commands, dynamic test discovery, and hostile programs are outside this lane.

Windows confinement is partial, not proof of complete filesystem, network or hostile-descendant isolation. Managed-process settlement and trusted flat ASCII TAP inputs are required; detached/escaped descendants remain unproven. Readiness still grants no automatic export, checkout application, production installation or operational activation.

The acceptance record is an offline attestation, not activation. Its four owner facts are attested at record time and are not re-proved when the journal is read back. Export is not yet bound to an acceptance record.

## Verification ownership

The setup help syntax was checked against the current CLI. Configuration generation, authenticated commands, pause/resume and crash behavior require the separately owned disposable acceptance driver and independent validation on the exact source version. This guide does not claim those checks have passed or that stock-GUI human clicks were tested. Implementation owners: [setup](../scripts/setup-governance.mjs), [doctor](../scripts/doctor-governance.mjs), [host commands](../src/governance/host.mjs), [continuity controller](../src/governance/controller.mjs), and [bounded reads](../src/governance/store.mjs).

## Disposable finalization and export qualification

The default entry and generated setup remain diagnostic. A separate `createGovernanceQualificationPluginM4B` factory is reserved for the explicitly authorized disposable acceptance driver; no M4 configuration flag or environment variable selects it. Do not mount it in a normal profile or use it to export this package.

In that isolated host, `/gov-qualify <candidate-digest> <head-digest>` asks the original live controller to recheck the exact authorized plan, retained frozen bytes, complete test evidence and completed independent judgments. It creates no files at the delivery destination. A human request, model prose or copied JSON cannot declare a passing result or waive failed tests.

After successful qualification, `/gov-export <qualification-receipt-digest> <destination-id>` separately requests one export to the destination fixed by the trusted host. It accepts no raw path, override or retry. The owner consumes the one-use admission before asynchronous work and records the reservation before allocating output. Replayed, concurrent, foreign and post-close requests cannot create a second copy.

Qualification output contains exactly:

- `payload/`: the complete frozen present-file inventory, with exact bytes and independent copies; deleted paths stay absent.
- `descriptor.json`: the unchanged canonical frozen descriptor and candidate digest.
- `qualification-receipt.json`: bytes identical to the protected completed-delivery receipt.
- `complete.json`: a final marker binding the acknowledged delivery event and receipt hash.

Two uncoordinated concurrent HTTP command tests observed one export acknowledgement and one connection reset during a long copy. Nonpooled connections did not eliminate it; the server-side cause remains unresolved. The qualification concurrency control therefore uses a deterministic reservation barrier to prove explicit refusal while the first export is active. This does not establish reliable overlapping HTTP acknowledgements or production responsiveness. Filesystem identity and inventory checks include synchronous work; while one of these checks is running, the same Node event loop cannot serve status, stop or another HTTP request. Total export duration is not a measurement of one uninterrupted stall. The qualification driver records observed event-loop delay separately; it does not prove the connection-reset cause. On connection loss, do not retry an export or infer success from a marker; preserve evidence and diagnose read-only when the host is responsive.

The container hash is not the candidate digest. The source checkout is not modified. Existing destinations, aliases, substitutions or changed contents refuse. Delivery records and output files are not one atomic transaction: failures retain partial evidence without repair, rollback or overwrite. A marker alone is neither live authority nor proof that a caller received success.

All finalization/delivery artifacts carry `qualificationOnly:true`, `operationallyAccepted:false` and `gateActive:false`. `qualifiedAccepted:true` describes only the original live owner's computed qualification result; default M4 `accepted` remains false. No receipt can be imported to restore authority. Closing or restarting the owner still blocks execution and cannot reset its budget.

Qualification status adds a bounded `qualification` object and stable `workPacket`. Advisory conversation summaries do not alter its plan/criteria identities, findings, spent attempts or allowed action. Cold status uses `headAuthenticity:'unproven'` and never enables an action: a reservation remains `reserved`; a completed journal record with missing or inconsistent output is `uncertain`; `completed` requires matching journal, receipt, payload and marker and still describes unauthenticated historical consistency.

The explicit driver lane is `--milestone M4B`; existing M3 and M4 lanes remain distinct. The driver owns verification of the real positive/negative command flows, exact output, process-kill refusal and independent-process destination contention. This section does not establish a real human GUI walkthrough, full release acceptance, operational activation or durable cold recovery. Those require separate authority and evidence.

## Offline acceptance record

In the same isolated qualification host, `/gov-accept <candidate-digest> <head-digest>` asks the original live controller to recompute the four owner facts — custody verified, journal healthy, scope clean and identity recheck — together with all nine acceptance predicates. On success it appends exactly one `ACCEPTANCE_RECORDED` event carrying an `acceptance-recorded` receipt, and nothing else. The phase stays `DIAGNOSTIC_READY`; `gateActive` and `operationallyAccepted` stay `false`.

The record must precede `/gov-qualify` and is refused after qualification. It never authorizes export: export still requires the qualification receipt, and the acceptance receipt digest is not accepted in its place. Scope cleanliness is a subset check against the plan, so it relies on the trusted workspace producer's complete change list. A reader from before this format refuses a journal that contains the event.

## Six-stage candidate check

Assess the exact checkout facts and unknowns first. Freeze a plan that names files, behavioral invariants, risks, focused tests, and recovery; then obtain an independent plan review and the separate human decision bound to that plan digest and review result. Only afterward may the author create a candidate. Seal its exact bytes into custody, run independent validation, and obtain a separate review before accepting that exact candidate. Stop rather than substituting evidence or changing criteria. The budget is the initial author attempt plus two corrections; after the third attempt, reassess instead of starting a fourth.

Run the focused candidate check serially from the candidate root:

```text
npm run test:governance
```

For the shortest newly added check, run `node --test --test-concurrency=1 tests/governance-six-stage.test.mjs`. It uses the actual V2/M4B controller, store, workspace, and custody with an explicitly scripted model/test producer. It verifies diagnostic readiness only: `accepted:false` and `gateActive:false`. It is not a full-host qualification, live human GUI walkthrough, workspace benchmark, production activation, or proof of cold recovery. Existing Windows confinement and restart limitations above remain unchanged.

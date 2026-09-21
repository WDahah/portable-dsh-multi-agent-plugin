# Changelog

This project records user-visible behavior changes. Evidence levels stay distinct here:
offline tests, generated artifacts, host activation, and live qualification are separate
claims, and none of them is promoted by a release note.

## 1.14.0

### Added

- `orchestrator_batch` collects 2–8 independent read-only tasks with two workers, a bounded queue, one child round per task and no model-driven scheduling or synthesis. Callers provide nonoverlapping scopes; the plugin does not infer dependencies.
- `orchestrator_batch_read` returns saved summaries by default and bounded findings with `details:true`. Batch records support list/forget, prevent same-ID replay and protect referenced assignments from ordinary deletion.
- Batch findings have explicit completion/partial/clarification states and evidence references. Malformed or oversized results remain unreadable rather than losing fields silently. Valid partial findings retain their incomplete execution status.
- Timing, round commitments and returned child IDs are reported separately. Native usage and model-call totals remain unknown; no measured total-token savings or spending cap is claimed.

### Fixed

- Compaction shares delegation admission, synchronous ID reservations and cancellation ownership. It journals intent before dispatch and records unsuccessful attempts, not only useful summaries.
- Assignment-store public reads, listings, writes and deletion share an in-process namespace queue, preventing live readers from seeing a partially written revision.
- Assignment deletion is excluded during owner delegation/compaction/batch activity, and new work cannot enter during its reference check and deletion.
- Child disposal is memoized on cancellation; slots remain owned until result and teardown settle. Dispatcher queue wait is bounded by the same cooperative deadline.
- Evidence expiry after journal creation is retained as `failure_code: "EVIDENCE_EXPIRED"` in assignment reads and surfaced by batch/compaction outcomes. Compaction rechecks expiry after its dispatch commitment is saved, before native start.
- Batch-journal failures preserve `PERSISTENCE_FAILED` as the task reason rather than reporting deadline or cancellation. Usage documentation distinguishes batch-journal aborts from isolated assignment-journal failures.
- Onboarding checks name all fifteen tools, including batch list/forget support; compaction documentation distinguishes pre-record refusals from recorded failures.

### Validation scope

Deterministic offline tests cover overlapping workers, FIFO admission, duplicate IDs, compaction failures, queued cancellation, disposal draining, persistence failures, reference protection and recovery without replay. Native host activation, live provider throughput, token usage and billing are not established by these fixtures. Coordination remains single-process; no host-wide provider quota controller or parallel-write support is added.

A separate [27-trial live benchmark](docs/BENCHMARK.md) of the pre-review-fix snapshot found no token savings: parallel workers plus integration used 92.2% more tokens than one agent, while finishing 23.5% faster than the same workers run sequentially. README feature claims distinguish smoke qualification from competence, parent context from total tokens, and deterministic distribution from live load balancing. The benchmark used temporary host telemetry, not a new usage-ledger feature in this plugin.

## 1.13.0

A second round of outside review found five more defects. Three are honesty defects: the
record could claim something that was not so.

### Fixed

- **A review that failed over could claim independence from the provider it ran on.** A
  failover updated the provider, model and evidence but left `independence` as computed
  for the route that never ran, so a review avoiding one provider could move onto it and
  still record `independent: true`. Independence is now recomputed against the route that
  actually ran, with `FAILOVER_TO_AVOIDED_PROVIDER` as the reason, and the failover entry
  keeps `independence_before` and `independence_after`. This was a false claim in the
  feature the project leads with.
- **A reviser lost the original request.** `reviewMaterial()` dropped it whenever any
  objective existed, but a short objective need not carry the path restrictions or
  prohibitions written into the original prompt, and after one revision `subject.prompt`
  is the revise prompt rather than the request. An immutable `original_prompt` now travels
  with the assignment.
- **A compaction could stand in for the work it summarized.** `compact()` accepted
  parsable output without requiring the run to finish, and the loop replaced the review
  subject with the compaction, so the next review measured independence against the
  compactor rather than the author and `finalSubject` could name a summary. Compacted text
  is now separate working context, and an unfinished compaction is refused with
  `COMPACTION_DID_NOT_COMPLETE`.
- **The record store could write past its own listing limit.** `entries()` refuses a
  namespace holding more than 256 directories while `save()` did not enforce it, so the
  257th assignment broke both listing and the deletion reference scan. A new key at capacity
  is now refused with `JOURNAL_BOUND`; existing records stay updatable.
- **Two bounded verdict fields reported no loss.** Dropped `clarifications` and
  `verified` entries are now reported alongside summary and finding losses, and the claim
  that verdicts are stored verbatim is gone from the last two places it survived.

### How this release was produced

The defects were found by a model from another provider reviewing the codebase, and the
fixes were written by that same model. The fixes were then verified independently rather
than accepted: each defect was reproduced first, each fix checked against that
reproduction, and the eight new regression tests were run against the pre-fix commit to
confirm they fail on the old code. Seven of eight did; the eighth guards a case that was
always correct, against the fix overcorrecting.

The model that wrote the fixes added no tests, reading a constraint about editing tests as
a prohibition on adding them. That gap was filled during verification, which is the reason
a proposal from a model is not the same as a change that can be trusted.
## 1.12.0

Found by dispatching this project to an outside model for review, then asking that model to
propose fixes for what it found. It located a hole in the first fix.

### Fixed

- **A self-contradictory verdict was treated as a pass.** A reviewer could return
  `verified` while also reporting `onObjective: false`, or leaving a `blocker` finding
  standing, and the loop accepted it. Such a verdict now stops the loop with
  `VERDICT_INCOHERENT` and lists the contradictions. This compares the reviewer's own
  fields against each other, which is structural: neither reading is inferred, and the
  plugin still never judges the work.
- **The contradiction check read the wrong data.** The first fix inspected findings after
  normalization, so a blocker past the fifty-finding cap, or one whose detail exceeded the
  length limit, disappeared and the verdict passed — failing precisely when a reviewer had
  the most to say. It now reads what the reviewer declared.
- **A verdict from an unfinished review was accepted.** `loopDecision` now stops with
  `REVIEW_DID_NOT_COMPLETE` rather than treating a truncated opinion as a settled one.
- **`orchestrator_iterate` lost the task when no objective was passed.** It forwarded only
  `args.objective`, while a reviser is deliberately not re-sent the original request
  because the objective is supposed to carry it. With neither, a loop could converge on
  satisfying review feedback while drifting from the user's actual request. It now inherits
  the objective the reviewed assignment recorded, reports `objectiveSource`, and falls
  back to giving the reviser the original request when no objective exists at all.

### Added

- Verdicts report `normalized`, naming what storage limits cost — for example
  `SUMMARY_TRUNCATED` or `FINDINGS_DROPPED:1`. The README previously described stored
  verdicts as verbatim, which was never true of a record that trims and caps.
- `verdictInstruction` states the consistency contract, so a reviewer can satisfy the rule
  rather than trip a check it was never told about.

### Unchanged

Well-formed verdicts behave exactly as before, verified across every state and cycle
position. Only verdicts that disagree with themselves, or come from reviews that did not
finish, reach a different outcome.
## 1.11.0

Acting on user feedback about task selection. Two of the four proposals were already
possible and are now documented rather than changed; three concrete gaps are fixed.

### Changed

- **Escalation now needs grounds that corroborate each other.** Any single signal used to
  be sufficient, which sent **82% of ordinary task shapes** to the most expensive tier: a
  low-risk task reached `advanced` purely because its caller described it as complex.
  High risk, complexity and restricted data each count as one ground and any two escalate,
  while critical risk and the roles that exist to demand a stronger model still escalate
  alone, because both are statements about the work rather than descriptions of it.
  Measured across 408 task shapes: 36 move from advanced to balanced, none move up.
- Every selection reports `grounds`, so a pool is explainable. An empty list means
  nothing about the task argued for a stronger model.

### Added

- **A bare `role: "review"` now prefers a different provider.** Cross-provider review
  previously applied only when `reviews: <run_id>` named a subject, so a role whose whole
  purpose is independent judgement could quietly run on the provider it would review.
  `avoid_provider` overrides the inference when the caller knows who produced the work.
- **`routed_by` records who chose the route**, `SELECTOR` or `CALLER_SUPPLIED`, with
  `selection_grounds` for a selector-chosen one. A hand-picked route and a computed one
  were previously indistinguishable in the journal, and only the second is reproducible.

### Unchanged by decision

Fixed pool priority and the use of qualified alternatives were raised as problems. Both
already have mechanisms — `spread`, `failover`, `reviews` and explicit `pool` — and
all of them stay opt-in. Making distribution automatic would cost the property that the
same task with the same evidence reaches the same model, which is what makes a run
reproducible and an audit trail meaningful.

Economy remains reachable only by asking for it. An earlier draft of this release routed
routine low-risk work there automatically; that was reverted before release because the
cheap tier is the least likely to be qualified, so the change turned ordinary work into
refusals and lowered quality where it did succeed.
## 1.10.0

Reported: qualifying every route in a pool did not make those routes receive work. That was
correct behaviour and a genuine gap, because nothing said so and `orchestrator_capacity`
implied otherwise.

### Added

- **`spread: true` distributes work across every qualified route in a pool.** Measured on
  the advanced pool with three routes qualified: 100/0/0 by default, 33/33/34 with
  spreading. The rotation is keyed by `run_id`, so the same request still resolves to the
  same route — distribution without giving up reproducibility. It rotates only among routes
  that already passed every evidence rule, and never overrides review independence.
- **`failover: true` moves a run to a standby route when the first provider refuses.**
  Deliberately narrow: the failure must be a refusal issued before the child started, the
  child must have produced no output, and the tool scope must be read-only. Anything else
  records the attempt with its reason and fails rather than risking a repeated side effect.
  A run that moves is authorized by the new route's evidence, never the old one's.
- A selection now reports `standby`, `selectionOrder`, and a
  `LOWER_PRIORITY_ROUTES_IDLE_UNTIL_FAILOVER` warning whenever a qualified route is idle.

### Fixed

- **`orchestrator_capacity` implied that every dispatchable route shares the work.** Each
  number it printed was true, and a reader would still conclude the wrong thing. It now
  reports `selects`, `idle`, `spreadWouldUse`, and `failoverAvailable` per pool, and
  marks each route `selected` or `LOWER_PRIORITY_THAN_SELECTED`.
- The documentation never stated that pools are priority-ordered rather than balanced.

### Unchanged

Default routing is identical. All 238 role-and-variant outcomes from the previous build
were replayed against this one and none changed: spreading and failover are opt-in, and a
caller that asks for neither sees exactly what it saw before.
## 1.9.2

### Fixed

- **Two formatting blemishes in the demo**, spotted in a pasted transcript. One override
  row was longer than the fixed padding width, so its arrow jutted out of the column, and
  the objective block stacked three blank lines because that material already begins with
  its own separator. The demo is the first thing most readers see, and ragged output
  undercuts a project whose argument is that it is careful about detail.
- Column widths are now derived from the longest entry rather than hard-coded, so adding a
  case later cannot silently misalign a table. A test rejects trailing whitespace, stacked
  blank lines, and misaligned columns in the demo output.

## 1.9.1

### Fixed

- **The quickstart failed in Windows PowerShell.** `cd … && node demo.mjs` is a parse error
  there, and Windows PowerShell is still the default shell on Windows, so the first command
  a new reader ran produced `The token '&&' is not a valid statement separator`. The
  quickstart is now three separate lines. Reported by a reader running exactly what the
  README said to run.
- A test now rejects `&&` in any shell block in `README.md` or `docs/DESIGN-NOTES.md`. The
  original verification ran the steps separately under pwsh 7, which accepts `&&`, so it
  never executed the literal line being shipped.

## 1.9.0

Nothing in the plugin changed. This release is about letting someone evaluate the project
without a DSH/Cordis host.

### Added

- **`demo.mjs` runs the routing and verdict logic with no host and no dependencies.** It
  calls the same `selectRoute` and `parseVerdict` used in production; only the
  qualification evidence is synthetic, and the demo says so. Seven scenes, each runnable
  alone, showing refusals as prominently as successes.
- **`docs/DESIGN-NOTES.md`** records the reasoning behind the decisions, readable without
  installing anything, including the token estimate that was wrong and the agents that were
  rejected after measuring what they would cost.
- Repository signals: status badges, issue and pull-request templates, and a code of
  conduct.
- Seven tests keep the demo honest: CI fails if a scene stops running, if the
  synthetic-evidence disclaimer disappears, if a refusal stops being demonstrated, or if
  colour escapes leak into piped output.

## 1.8.1

Three gaps that only appeared once the loop ran against real models rather than stubs.

### Fixed

- **A reviewer answering only through the structured channel saved an empty answer.** The
  verdict was stored, but the record read back with no text, and the review could never
  itself be reviewed (`REVIEW_SUBJECT_EMPTY`). The verdict is now rendered as the saved
  answer when the model supplies no text of its own. The parsed verdict remains the
  authority; the rendering is a view of it.
- **Deleting a run left any later review pointing at a record that no longer existed.**
  `orchestrator_forget` now refuses with `ASSIGNMENT_REFERENCED_BY_REVIEW` and names the
  reviews that block it. Cascading would destroy the review and clearing the link would
  erase what it judged, so neither is done; `force: true` accepts a dangling reference
  deliberately rather than silently.
- **`VERDICT_UNREADABLE` did not say why.** A reviewer cut off by a token limit and one
  that returned prose need opposite responses, and telling them apart meant reading the
  review run separately. Each cycle now reports `reviewState` and an `unreadableCause` of
  `REVIEWER_HIT_TOKEN_LIMIT`, `REVIEWER_RETURNED_NO_USABLE_VERDICT`, or
  `REVIEWER_DID_NOT_COMPLETE`.

### Note

A reviewer needs room to think before it answers. A 2,048-token ceiling truncated a real
reviewer before it emitted anything; the default of 16,384 was sufficient. The loop failed
safe in that case — it reported no verdict rather than inferring one — but the cause was
not visible, which is what the third fix addresses.

## 1.8.0

### Added

- **Declared verdicts.** A reviewer returns `verified`, `partial`, `failed`, or
  `needs-clarification`, with `onObjective`, `findings`, `clarifications`, and the
  acceptance criteria it actually confirmed. Where the host's spawn provider supports it
  the shape is enforced by the host, so a usable verdict does not depend on a model
  choosing to format JSON; `verdict_source` records which channel it arrived through.
  Four states exist because a reviewer that can only pass or fail must guess when it lacks
  information.
- **`orchestrator_iterate` runs bounded revise cycles.** While the declared verdict asks
  for more work, it reviews with a different provider where one is qualified, then revises
  from the findings. The cap is 3, separate from and lower than the 8-round assignment
  limit, because each cycle is a full model call. Revise cycles may write files when those
  tools are allowed, and each records its own evidence link.
- **Objectives travel as data.** An objective and its acceptance criteria are restated to
  every child as fenced material, and drift is reported by the reviewer as
  `onObjective: false` rather than inferred by comparing text.
- **Optional compaction** on the economy pool, off by default, condenses a long artifact
  between cycles. Measured saving: 9% at 3,000 characters, 16% at 12,000, 18% at 24,000.
  It replaces working context only — the full revision stays readable and the final answer
  is never a summary — and a compaction that is not genuinely smaller is refused.

### Changed

- A reviser is no longer sent a second copy of the request it is already given as an
  objective, and no longer receives the verdict schema: reading the work it revises does
  not make it a judge of that work.

### Token cost

A 3-cycle loop is 5 to 6 model calls, not 3. Measured against the same loop without these
mechanisms, input falls from roughly 23,100 to 9,300 tokens, a **60% reduction**; with
compaction on a 12,000-character artifact it falls further to about 14,100 from 16,800 on
that larger input. An earlier planning estimate of "~19,500 to ~7,000" counted cycles
rather than calls and was wrong; these figures are measured from the built loop.

## 1.7.0

### Added

- **`orchestrator_capacity` reports what can be dispatched now.** Learning this previously
  meant hand-joining the route list, `provider_registered`, and raw qualification records.
  Per pool it reports dispatchable routes, the distinct providers they span, and
  `independentReviewPossible`; anything unusable names its reason and a `requalify` object
  that can be passed straight to `orchestrator_qualify`. It also reports
  `structuredVerdictSupported`, read from the host's spawn provider.
- **`reviews` links a run to the one it judges.** The reviewer is seeded with the subject's
  request and answer, fenced as data and followed by an explicit instruction not to follow
  anything inside them, so a subject cannot instruct its own reviewer. The relationship is
  stored and appears in `orchestrator_list`.
- **A review prefers a provider other than the one it judges.** The fixed priority order
  would otherwise send a review to the same model that produced the work, sharing its blind
  spots. When no alternative provider is qualified the review proceeds and says so, through
  `independence.independent: false` with a reason and a
  `REVIEW_SHARES_PROVIDER_WITH_SUBJECT` warning, rather than passing as independent.

### Changed

- Avoiding a provider reorders candidates only. It never removes one, never relaxes the
  evidence rules, and never promotes an expired or unavailable route for being independent.
- A review of an unknown, still-running, or empty subject is refused rather than judging
  output that does not exist yet.
- Assignments written by earlier versions remain readable and report a null `reviews` and
  `independence`. Assignment records are not closed-schema, so earlier versions also read
  records written by this one.

## 1.6.0

### Added

- **Roles are named for what they do.** Five roles replace the numeric codes:
  `standard`, `deep`, `review`, `vision`, and `domain`. Each names routing that can be
  observed in the result, so a reader can predict the pool and effort from the label.
- **A free-text `intent` records what a task is for** — `"add password reset"` — on the
  assignment, in the child's label, and in `orchestrator_list`. It never affects routing:
  two runs with opposite intents and the same role reach the same model. A label that
  quietly changed the model would be a routing rule disguised as documentation.

### Changed

- The codes `R01`–`R12` still work and route exactly as before, but are deprecated. A
  selection reports `role`, `roleSupplied`, and `roleDeprecated`, and adds a
  `DEPRECATED_ROLE_CODE` warning, so migration needs no guesswork.
- `R02`, `R03`, `R06`, `R10` and `R12` were never documented anywhere, and `R03` and `R12`
  silently reached the advanced pool at higher cost. Each now maps to the behavior it
  already produced rather than to a meaning invented after the fact. `R08` and `R09` were
  always identical, so both map to `domain`.
- Behavior preservation was verified by capturing all 84 role-and-variant outcomes from
  the previous build and replaying them against this one: every outcome is unchanged.

## 1.5.0

### Added

- **Saved runs record the evidence that authorized them.** A record named which model
  answered but not what permitted it, so questions like "was this run authorized by
  evidence that had already expired?" or "whose attestation allowed this confidential
  task?" could not be answered from storage. Delegations and direct tasks now carry an
  `evidence` block holding the evidence id, its issue and expiry, the passed probe cases,
  allowed data classes, domain evidence, and the attesting operator when one widened
  policy.
- An evidence id is **derived from the evidence** rather than assigned, so a link is
  checkable: recomputing it from the qualification a record names must reproduce the
  stored id.

### Changed

- Direct-task journal records may carry an optional `evidence` block, fixed at plan time.
  The journal refuses any later addition, edit, or removal (`EVIDENCE_MUTATED`), so a run
  cannot be made to look authorized after the fact, and a malformed block is refused
  rather than silently ignored.
- Records written by earlier versions remain readable and report a null `evidence` with a
  false `evidence_recorded`, rather than a fabricated link.

### Upgrading

Reading is one-way, as in 1.2.0. This version reads journals written by 1.0.x through
1.4.x, but **older versions reject journals written by this one**, because their record
schema admits no `evidence` field. Finish or abandon in-flight direct tasks before
downgrading.

## 1.4.0

### Added

- **Every refusal names the probe that would resolve it.** An `UNAVAILABLE` selection now
  carries a `requalify` object per candidate route holding exact `orchestrator_qualify`
  arguments, including `capabilities` for a probe-backed requirement and an `attestation`
  skeleton for domain or data-class policy that no probe can grant. A hint given when no
  evidence exists covers everything the task needs, so following it produces evidence that
  actually satisfies the task rather than another refusal.
- `EXPIRED_QUALIFICATION` reports `expiredAt` and `expiredForMs`, so a lapsed route says
  when it lapsed and not merely that it did.
- **Token usage is reported where cost cannot be.** Only 2 of 15 routes carry published
  pricing, so `costUnknown` was the whole story for the rest. Direct tasks now report
  `usage` per round and as a task total, with `usageRoundsMissing` counting rounds that
  never settled — a null total beside that count, never a zero that would read as no
  consumption.
- Delegated assignments report `usage: null` with
  `usage_reason: "CHILD_RESULT_CARRIES_NO_USAGE"`, naming the reason rather than leaving an
  unknown cost to look like a free one.
- `orchestrator_inventory` marks a route in no pool as `reserve: true`, distinguishing a
  deliberately held-back route from a broken one.

## 1.3.0

### Added

- **`orchestrator_forget` deletes saved records.** Nothing pruned state before, so
  assignments, direct tasks, and expired qualification evidence accumulated indefinitely
  with prompts and outputs in plaintext, removable only by deleting directories by hand.
  It takes exactly one target — `run_id`, `task_id`, or `qualifications` (`expired` or
  `all`) — refuses a record that is in flight rather than deleting it beneath itself, and
  frees the id for reuse.
- **`orchestrator_list` shows what is stored.** Reading a saved record previously required
  remembering its exact id; without one the record was unreachable while still occupying
  disk. Listing returns summaries only — never the saved output text — for assignments,
  tasks, and qualifications, newest first, with a `kind` filter.
- `orchestrator_read` and `orchestrator_delegate_read` return the original `prompt`, so a
  saved record shows what was asked and not only what came back. The prompt was already
  stored; it was simply never surfaced.

### Changed

- A direct task's readable id is recorded in a side index beside its journal, because task
  directories are named by digest. The index is a convenience: a task missing from it
  still lists, reported with a null id and its digest rather than being hidden, and a
  failure to write the hint never fails the task itself.

## 1.2.1

### Fixed

- A deadline test failed intermittently on slow CI runners — observed once on
  Windows/Node 22 while the same commit passed on every other platform and on a rerun.
  The task deadline starts at plan time by design, but the fixture also depended on real
  elapsed time, so the journal write in `plan()` could consume the whole 100 ms budget
  before `run()` began; the engine then correctly declined to dispatch and returned
  `PARTIAL_LIMIT` where the test expected `INTERRUPTED_UNCERTAIN`. The fixture now freezes
  its clock, so only the in-flight abort under test decides the outcome. No source
  behavior changed, and the test still fails when the deadline abort is removed.

## 1.2.0

### Added

- **Results now say which model produced them.** Child agents are labelled
  `role · provider/model · effort · round N`, so two children differing only by model are
  distinguishable in a session tree; previously every child read as
  `Orchestrated <role> round N`. Qualification children name their route the same way.
- Each delegated round records and reports its own `provider`, `model`, and `effort`
  beside its `child_id`, and direct-task rounds do the same. The round is the unit of
  execution, so attribution belongs with it rather than only on the enclosing record.
- `orchestrator_read` reports the task `route`. It previously returned no provider,
  model, or effort at all, although the documentation told readers to inspect the
  selected route and the journal had stored it since 1.0.0.

### Changed

- Direct-task journal rounds may carry an optional `route`. Records written by earlier
  versions remain readable: a round without one reports the task's route and sets
  `routeRecordedPerRound: false` rather than claiming attribution it does not have. A
  stored round route must match the route its task planned, so an edited journal cannot
  attribute a round to a model that never ran it, and unknown round keys are still
  refused.

### Upgrading

Reading is one-way. This version reads journals written by 1.0.x and 1.1.x, but **older
versions reject journals written by this one** as corrupt, because their round schema
admits no `route` field. Finish or abandon in-flight direct tasks before downgrading.

## 1.1.1

### Fixed

- A probe test failed intermittently, roughly once in fifty runs. Its "blind guess" case
  named a fixed pair of colors while the image probe chooses its panels at random, so the
  guess was occasionally correct and the assertion that guessing must fail did not hold.
  The case now guesses colors the probe demonstrably did not use. No source behavior
  changed: this was the test coinciding with the very odds the probe is built around.

## 1.1.0

### Fixed

- **Windows clones failed integrity verification.** Without `.gitattributes`, Git checked
  out CRLF line endings while `portable-manifest.json` records LF bytes, so
  `node scripts/verify.mjs` reported every listed file as modified on a fresh Windows
  clone. Because the documentation makes a verification mismatch a stop condition, this
  blocked installation for exactly the users who followed instructions. Existing Windows
  clones must be re-cloned or refreshed (`git rm -r --cached . && git reset --hard`) for
  the normalized bytes to take effect.
- **The test suite failed on macOS and Windows** wherever the system temporary directory
  is reached through a link. Fixtures built their working directories on the raw
  `os.tmpdir()` value, and the journal correctly refuses any path containing a symbolic
  link, so those runs died with `UNSAFE_JOURNAL_PATH` for a reason unrelated to the
  behavior under test. Fixtures now resolve the temporary root first; the production
  path check is unchanged. This was visible only once CI covered more than Linux.
- Tool refusals no longer collapse every failure into one opaque status. A refusal now
  carries an allowlisted `reason` such as `UNKNOWN_ROUTE`, `INVALID_RUN_ID`, or
  `QUALIFICATION_BUSY`. Unrecognized failures still report `UNAVAILABLE`, so provider
  messages, paths, and credentials remain redacted.

### Added

- **Image capability probes.** `orchestrator_qualify` accepts
  `capabilities: ["image"]` and sends generated solid-color PNGs through the host
  attachment service, requiring the exact colors back. `R05` and any task requesting the
  `image` capability can now be satisfied by real evidence instead of being permanently
  unavailable.
- **Structured-output probes** via `capabilities: ["structured-output"]`, verified by
  parsing the reply against a per-probe nonce rather than trusting prose that claims JSON.
- **Operator attestations** for policy that no model self-report can establish. An
  `attestation` may widen `allowedDataClasses` to `confidential`/`restricted` or set
  `domainEvidence` for `R08`/`R09`, and it must name `attestedBy` and a written `basis`.
  Selection rejects any record whose policy exceeds ordinary smoke without one
  (`UNATTESTED_POLICY_WIDENING`).
- An explicit `vision` pool makes the dedicated vision route reachable by deliberate
  choice. It stays out of the ordinary pools, so it is never a silent substitute.
- `scripts/manifest.mjs` regenerates the integrity manifest, and `--check` fails when the
  committed manifest is stale. CI runs this check on every platform.

### Changed

- CI runs on Ubuntu, Windows, and macOS across Node.js 22 and 24. The previous
  Linux-only job could not observe the line-ending defect above.
- Probe capabilities are attempted only after the core text and tool smoke passes, and a
  failed capability probe never invalidates that core result.

### Security

- An attestation records a human claim with its author and basis. It is not a capability
  proof, an entitlement check, or a confidentiality guarantee, and it never substitutes
  for a machine probe result.

## 1.0.0

- Initial public release: routed model selection, scoped child delegation with
  read-only continuation, direct-model tasks with immutable journalled rounds, and
  owner/session-scoped qualification evidence with a 24-hour lifetime.

# Changelog

This project records user-visible behavior changes. Evidence levels stay distinct here:
offline tests, generated artifacts, host activation, and live qualification are separate
claims, and none of them is promoted by a release note.

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

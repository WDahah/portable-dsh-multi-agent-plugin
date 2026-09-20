# Changelog

This project records user-visible behavior changes. Evidence levels stay distinct here:
offline tests, generated artifacts, host activation, and live qualification are separate
claims, and none of them is promoted by a release note.

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

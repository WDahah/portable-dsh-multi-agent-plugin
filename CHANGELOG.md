# Changelog

This project records user-visible behavior changes. Evidence levels stay distinct here:
offline tests, generated artifacts, host activation, and live qualification are separate
claims, and none of them is promoted by a release note.

## 1.1.0

### Fixed

- **Windows clones failed integrity verification.** Without `.gitattributes`, Git checked
  out CRLF line endings while `portable-manifest.json` records LF bytes, so
  `node scripts/verify.mjs` reported every listed file as modified on a fresh Windows
  clone. Because the documentation makes a verification mismatch a stop condition, this
  blocked installation for exactly the users who followed instructions. Existing Windows
  clones must be re-cloned or refreshed (`git rm -r --cached . && git reset --hard`) for
  the normalized bytes to take effect.
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

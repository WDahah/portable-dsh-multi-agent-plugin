# Architecture

## Host boundary

This package is a **native DSH/Cordis plugin**, not an independent agent service. A compatible host supplies:

- `tools`: native registration, argument handling, visibility/restriction and normal execution policies.
- `llm`: registered provider/model discovery, exact call preparation, and streaming output/usage/finish records.
- `subagents`: scoped native child creation, result collection and lifecycle disposal.

The portable source uses Node built-ins. Its plugin factory receives the real host's `defineTool`; it does not bundle or replace DSH. Setup generates `.local/entry.mjs` bound to the destination's actual tools module and a candidate `.local/host-patch.yml`. Neither is a transferable proof of compatibility. The user-owned host composition must load the generated entry.

The development reference was `dsh-tools` 0.1.5-rc.2/Cordis ^4.0.2; the v1.14.0 local tests ran on Windows with Node 26.9.0. Node >=22 is the package requirement, not a claim that every supported OS/Node/host combination was exercised. Use offline tests and doctor, then actual runtime acceptance on the destination.

## Execution paths

```text
Root agent session
  -> private owner/session qualifications + routes policy
  -> exact selected provider/model/effort
     -> native agent dispatcher -> scoped child -> saved assignment output
     -> direct task engine -> prepared LLM stream -> saved rounds/accounting
```

`src/routes.mjs` holds candidate mappings, pool priorities and expected efforts. The inventory is descriptive; selection requires exact current evidence. Changing a provider surface, model ID, pool order or effort is an explicit policy change requiring aligned definitions/tests and new qualification—not an alias inferred from a similar name.

The qualifier creates one bounded native child with only the active echo challenge available. It verifies the returned marker, simple text result and child identity. Its machine-written record is not a model's self-reported certification. Evidence expires after24 hours and is private to the invoking root agent owner/session. Installing once does not qualify every future project/session.

## Ownership and persistence

Owner identity comes from the host execution context, never a tool-supplied owner ID. Child assignment IDs and direct task IDs are immutable within their stores. Use a fresh absolute state directory on a new machine; do not copy another installation's accounts or qualification/task history.

Direct tasks journal the original request, route, bounded round outputs, terminal state, usage and accounting. An attempt commitment precedes dispatch. Clean settled token-limit stops can lead to another attempt; recovered in-flight or uncertain work cannot silently dispatch again. Native assignments, including compactions, record startup/result stages but do not offer uncertain-assignment replay or durable same-child resume.

Read-only batches persist their brief, independent task scopes, generated assignment IDs and collected bounded findings in an owner-scoped `batches` namespace. Two worker loops consume tasks in order; result order stays stable despite completion order. They share the dispatcher's two slots, with no extra model calls for planning, scheduling or synthesis. Batch recovery reports unfinished records as uncertain rather than dispatching again. Native usage stays explicitly unavailable; round commitments, returned child IDs and model calls are different quantities.

Storage uses immutable numbered revisions, validation/checksums and file synchronization. This supports ordinary process-restart recovery under a single trusted coordinator. It is not encrypted/authenticated storage, distributed exactly-once execution, or a power-loss durability guarantee. Direct diagnostic leaves are process-local and may disappear after restart; they do not add hidden reasoning to the journal.

## Lifetime and limits

Cordis lifecycle disposal cancels owned work and removes registered tools. Cancellation is cooperative; it does not prove upstream billing stopped. The dispatcher allows scoped read-only continuation through new children, while potentially file-changing tools prevent automatic repetition. Direct continuation preserves visible history; neither path certifies semantic completeness or formatting at round boundaries.

Tests are offline fixtures, separate from real provider qualification. Setup/doctor are offline installation checks, separate from host activation. Keep these evidence levels distinct when reporting readiness. See [SECURITY-AND-LIMITS.md](SECURITY-AND-LIMITS.md) for permission, privacy and cost constraints.

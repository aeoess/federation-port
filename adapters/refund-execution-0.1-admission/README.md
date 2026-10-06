# refund-execution/0.1 admission component (local prototype)

Part of the refund-execution/0.1 envelope profile. The executor is in `../refund-execution-0.1-execution`.

## What the profile shows

The unchanged core (no change under `src/` or `spec/`) can carry a refund-execution/0.1 handoff when
`action.args` holds the whole handoff. The runtime's action digest then binds the nested arguments and every
handoff reference (`approval_ref`, `pic_evidence_ref`, `aps_evidence_ref`) to the operation id. A retry that
changes any of them is refused with `operation_id_reused_for_different_action`.

This component checks, for each admission:

- `handoff.well_formed`: exact handoff fields, tool `refund`, nested `arguments` with `payment_id`, `currency`
  and an integer `amount_minor` of at least 1.
- `handoff.operation_id_matches`: the handoff `operation_id` equals the port operation id.
- `handoff.approval_ref_matches`: the handoff `approval_ref` equals the approval id the runtime consumes.
- `aps_evidence_ref.well_formed`: the reference is present and is a printable ASCII string of 1 to 256
  characters. It is a reference only. Its content is not resolved or verified.
- `aps.*`: APS authority over the nested `arguments` tuple only. The outer handoff is never hashed into the
  APS payload. The approach follows `../aps-authority`, written again as new code.
- `pic.verified`: always `not_established` with a reason. The workflow lists it as optional so the result
  is recorded. A workflow that requires it admits nothing.

## What it does not establish

- No PIC verification of any kind.
- No real provider. The executor talks to a local simulator in `sim/refund-execution-0.1/`.
- No isolation. Components run in the runtime's process, see `spec/CONTRACT.md` section 10.
- Not an implementation of any other project, and not interoperability with one.
- The handoff is not authenticated. Equality checks compare labels.
- All keys are synthetic and generated per test run.
- Field names follow a draft public contract text that may change.

## Open policy question

Whether a second distinct approval for the same `pay_A / EUR / 4000` tuple may create a second logical
operation is left open by the contract text. Test `RE-j` records what the profile does today (both
operations are admitted and two effects occur in the simulator) and asserts only that this is deterministic.
That is a record of current behaviour, not a decision.

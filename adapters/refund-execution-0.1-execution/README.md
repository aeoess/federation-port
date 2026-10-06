# refund-execution/0.1 execution component (local prototype)

Part of the refund-execution/0.1 envelope profile. The admission side is in `../refund-execution-0.1-admission`.

## What the profile shows

The executor receives the admitted action, whose `args` are the full handoff, and sends it unchanged to the
configured endpoint. Attempts after the first ask the endpoint to reconcile the same operation first, and
dispatch again only when the endpoint reports `observed_failure` (no effect recorded).

Each native `refund-execution-result/0.1` response is checked before it is mapped:

- `schema` is `refund-execution-result/0.1`
- `operation_id` equals the port operation id
- `arguments_digest` equals the digest of the admitted tuple
- `attempt_id` and `observation_ref` are present
- `effect_ref` is present for `observed_success` and null for `observed_failure`

Only then: `observed_success` maps to `provider_confirmed`, `observed_failure` to `failed` (retriable), and
`unresolved` to `unknown`. A malformed, mismatched or missing result maps to `unknown` with a reason. A
transport error, including a refused connection, is `unknown`.

The response bytes that decided the outcome are kept unmodified in `ExecuteOutput.evidence` and so in the
store under `execute:<attempt>`. `effect_ref` becomes `provider_ref`.

The local simulator in `sim/refund-execution-0.1/simulator.ts` keeps a durable operation binding in SQLite,
derives the provider idempotency key from `operation_id`, suppresses duplicate deliveries, and can inject a
pre-dispatch failure, a response lost after a committed effect, and an unresolved result.

## Local choices the contract text leaves open

- `arguments_digest` is `sha256:` plus the hex SHA-256 of sorted-key JSON of `{payment_id, currency, amount_minor}`.
- `attempt_id` is assigned by the endpoint as `<operation_id>/<execute|reconcile>/<n>`, counting every
  delivery including duplicates.
- Reconciliation is a second endpoint path that takes the same handoff. The contract text defines no reconcile request.
- A provider rejection before any effect is reported as `observed_failure`.

## What it does not establish

- No real provider and no real money movement.
- No PIC verification. The handoff is not authenticated.
- No isolation. Components run in the runtime's process, see `spec/CONTRACT.md` section 10.
- Not an implementation of any other project, and not interoperability with one.
- All keys are synthetic and generated per test run.
- Field names follow a draft public contract text that may change.
- Known core gap, recorded in test `RE-gap` and not fixed: a retry of a `provider_confirmed` operation does
  not compare changed `SubmitRequest.evidence`, and the confirmed result replays.

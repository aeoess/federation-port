# federation-port/v0 contract

Candidate contract, published for discussion on aeoess/agent-governance-vocabulary#177. Not an adopted
federation contract. No third-party project is a participant until it says so. Revision V0b (2026-10-05) adds the admission deadline (section 5, rule 5), the
execution-context binding of retries (section 7) and the trust statement in section 10. The `contract` string
stays `federation-port/v0`; both additions are optional fields. Revision 2026-10-07 binds retries to the
submitted evidence (section 7). TypeScript types: `src/contract/types.ts`.

## 1. Parties

- **Component**: a manifest plus an adapter module, maintained by its publisher.
- **Runtime** (`src/runtime`): loads pinned components, admits or refuses actions, dispatches, keeps durable
  state, provenance and usage.
- **Customer policy**: which components and versions are trusted, what each is granted, and which claims each
  workflow requires or records as optional.

## 2. Manifest

`manifest.json` next to the adapter. Fields (all required unless marked optional):

| field | meaning |
|---|---|
| `contract` | `"federation-port/v0"` |
| `id` | namespaced component id |
| `publisher`, `maintainer` | name, optional contact |
| `artifact.version` | immutable version string |
| `artifact.entry` | module exporting `createAdapter(ctx)` |
| `artifact.files` | files covered by the digest; must include `entry`; no absolute or `..` paths |
| `artifact.digest` | `sha256:` digest per section 3 |
| `artifact.dependencies` | optional; declared, not verified in V0 |
| `role` | `authority_evidence`, `action_evaluation`, `tool_admission`, `execution`, `payment_verification`, `receipt_verification` |
| `schemas` | media type and description of accepted and returned native evidence; `execute_input` for executors |
| `claims[]` | `id`, `establishes` (one sentence), `limits[]` (what an established result does not mean) |
| `profiles[]` | named profiles the component implements |
| `tools[]` | execution role only: tool name, description, input JSON Schema. Pinned with the manifest |
| `privileges_requested[]` | e.g. `secret:<name>`, `side_effect:<kind>` |
| `data_destinations[]` | origins the component sends data to, e.g. `http://127.0.0.1:*` |
| `keys[]` | key id, purpose, holder (`publisher`, `customer`, `none`), lifecycle |
| `license` | SPDX id and attribution text |
| `price_terms` | optional, informational only; V0 has no settlement or revenue logic |

## 3. Digests

- Manifest digest: SHA-256 over sorted-key JSON of the manifest (`canonicalJson` in `src/runtime/canonical.ts`).
- Artifact digest: SHA-256 over the files sorted by relative path, each framed as `path \n byteLength \n bytes`.
  The manifest is not part of the artifact digest; it is pinned separately by its own digest.

## 4. Adapter interface

```ts
interface Adapter {
  describe(): Manifest                               // must equal the pinned manifest
  check?(input: CheckInput): Promise<CheckOutput>    // all roles except execution
  execute?(op: ExecuteOp): Promise<ExecuteOutput>    // execution role
}
type ClaimStatus = 'established' | 'not_established' | 'failed' | 'unsupported'
```

- `established`: the check ran and the claim holds.
- `not_established`: the check ran and the claim does not hold.
- `failed`: the check could not complete (malformed input, internal error).
- `unsupported`: the input uses a profile or variant the component does not implement.

`CheckInput` carries the operation id, workflow, the caller's tenant id if any, approval id, a frozen copy of
the exact action that will be dispatched, the native evidence bytes addressed to this component only, and the
evaluation instant. `CheckOutput` is `{ evidence: Uint8Array, claims: ClaimResult[], valid_until?: string }`.

`ExecuteOp` carries the logical operation id, the provider idempotency key (equal to the operation id in V0),
the attempt number and the admitted action. `ExecuteOutput.outcome` is `provider_confirmed`, `failed` (with
`retriable` true only when the provider did not perform the side effect) or `unknown`.

`createAdapter(ctx)` receives `ctx.config` (from policy), `ctx.secrets` (only names granted as `secret:<name>`)
and `ctx.fetch` (refuses origins outside the declared and granted destinations, and refuses redirects instead of following them).

## 5. Evidence rule (enforced in `normalizeCheckOutput`, `src/runtime/runtime.ts`)

1. Evidence must be returned as bytes. The runtime stores them unmodified per component and records only
   their digest in provenance. It never parses them.
2. Claims are always qualified by component id. Policy names `{component, claim}`. A claim with the same name
   from another component cannot satisfy it, and evidence addressed to one component is never passed to another.
3. Only claims declared in that component's manifest count. Undeclared claims are dropped and recorded as
   violations. Unknown status values or duplicates make that claim `unavailable`.
4. A declared claim the adapter did not report is `unavailable`. A thrown error or timeout makes all its
   claims `unavailable`. `unavailable` is never success.
5. `valid_until`, when present, is the last instant at which this component's established claims may be acted
   on. Form: exact UTC milliseconds, `YYYY-MM-DDTHH:MM:SS.sssZ`, a real calendar instant. Any other form (no
   milliseconds, an offset, `2026-02-30…`, a non-string) makes every claim of the component `unavailable`
   (`adapter_protocol_violation:valid_until`). Boundary: inclusive, admissible while `now <= valid_until` at
   millisecond precision, the same rule the APS authority component applies to its own `approval.unexpired`.

## 6. Admission

Before any side effect, in order: workflow and tool known; component `describe()` still matches the pin;
action args valid against the pinned tool schema; approval id present when the workflow requires one;
approval not already consumed; every required claim `established`. Anything else refuses. Optional claims
are recorded with their status, or `unevaluated` when the component was unavailable.

The admission deadline is the earliest `valid_until` reported by a component that supplies at least one
required claim of the workflow. Optional components cannot shorten it, since their results never block. A
workflow with `approval: "required"` and no such deadline is refused (`admission_deadline_missing`).

Admission then runs one SQLite `BEGIN IMMEDIATE` transaction. The clock is read after the write lock is held,
so waiting on another writer counts against the deadline. Inside it: refuse with
`approval_expired_at_admission` if that instant is past the deadline; otherwise insert the approval
consumption (`approval_id` primary key), the operation row (`operation_id` primary key) and the claim of
attempt 1, all stamped with that instant. The executor is called right after the commit. No asynchronous
work, including any component check, runs while the lock is held. A second consumer of the same approval, in
the same process or another process on the same store, gets `approval_already_consumed`. A process that dies
before this transaction commits has consumed nothing.

## 7. Operation states and retries

`dispatched` → `provider_confirmed` | `failed` | `unknown`. There is no persisted `authorized` state: admission
and the first dispatch claim commit together. A transport error after the request may have been sent is
`unknown`, never `failed`. Dispatch is claimed under a lease, so concurrent retries do not double-dispatch; a
lease left by a crashed worker expires. A confirmed operation replays its result without dispatch.

At admission the operation row stores its workflow name, tenant (or none), approval id, action digest, a
digest of the evidence submitted with the request, admission deadline, and an execution context: policy id, digest of the workflow definition, and for each
component the workflow uses its pinned version, manifest digest, artifact digest and a digest of its
configuration. Secrets are not part of it. Resubmitting the same operation id is a retry: no re-admission,
no re-consumption, the same idempotency key, and only under that stored binding. Otherwise it is refused,
checked in this order:

| code | when |
|---|---|
| `operation_workflow_mismatch` | the retry names another workflow, even one with an identical definition |
| `operation_tenant_mismatch` | tenant differs, including present versus absent |
| `operation_id_reused_for_different_action` | action (payment, amount, currency, tool) or approval id differs |
| `operation_evidence_changed` | the evidence submitted with the retry differs from the evidence submitted at admission |
| `operation_context_changed:policy_id` | the running policy has another `policy_id` |
| `operation_context_changed:workflow_definition` | the workflow's definition changed (claims, executor, timeouts, approval rule) |
| `operation_context_changed:component_pin:<id>` | a component's pinned version or digests changed, or one was added or removed |
| `operation_context_changed:component_config:<id>` | a component's configuration changed, e.g. the executor's provider endpoint |

A refused retry does not change the stored operation, so the original request still recovers. Changing the
policy therefore never reroutes a stored operation to another provider or check set.

Retries after the admission deadline: an `unknown` outcome (or an expired lease) is retried with the same
idempotency key, because the side effect may already have happened and the retry resolves it. A `failed`
outcome marked retriable (the provider reported no side effect) is closed instead, result `failed` with
reason `approval_expired_before_retry`, because dispatching it would be a first side effect after expiry.

## 8. Loading

Refused at load: manifest digest differs from the pin (`manifest_changed`), artifact digest differs from the
manifest or pin, version differs from the pin, requested privileges or destinations exceed the grant,
secret not provisioned, entry missing `createAdapter`, role method missing, `describe()` differs from the file.

## 9. Provenance and usage

Per logical operation: policy id, workflow, tenant, execution context and its digest, action digest, approval id, state, every admission decision (components with
version and digests, per-claim status and requirement, evidence digests), every attempt with outcome. No action
arguments, evidence bytes or secrets. Usage: one row per component per logical operation, `calls` counting
invocations including retries, `outcome` the last state. No settlement, pricing or revenue logic.

## 10. Trust boundary and limits

**V0 trusts local adapters.** Components are imported into the runtime's own process. The load-time checks
compare a manifest's requested privileges and destinations with the operator's grant, and they control which
secrets and which `ctx.fetch` a component receives. They do not confine the component's code. An adapter can
call the global `fetch`, read files, read `process.env`, import other modules, alter shared objects such as
another loaded component, or block the event loop. The V0b tests use the same in-process access, from test
code, to wrap a loaded component and delay its check.
A manifest privilege check is therefore a declaration that is checked, not an enforced sandbox. Running
untrusted or third-party adapter code in V0 gives that code the runtime's full authority, including the
provider credential held by the execution component.

**V1 isolation item.** Run each component outside the runtime's process (a separate worker process or a remote
component behind an authenticated endpoint), with no ambient network, file or environment access. Secrets and
destinations would be supplied per grant, with resource and time budgets, and only bytes and claim results
would cross the boundary. Until then, a manifest's privileges describe intent and grant scope only.

Other limits:
- The artifact is hashed then imported from the same path, so a swap between the two is not detected.
- Dependencies are declared, not verified.
- No revocation, trusted time source, remote components, catalog, multi-tenant data isolation or key rotation.
- Deadlines rely on the local clock of each process sharing the store. Clock skew between workers is not handled.
- The tenant is a caller-supplied label that binds an operation id. The runtime does not authenticate it.
- The tool-admission check runs at admission, not at each retry.
- There is no reconciliation endpoint. An `unknown` operation is resolved only when the caller retries.

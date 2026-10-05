# federation-port/v0 contract

Exploratory prototype, local only. Not a public proposal and not an adopted contract. No third-party
project is a participant. TypeScript types: `src/contract/types.ts`. Governed by the 2026-10-05 common-port design note
(internal, not in this repo).

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

`CheckInput` carries the operation id, workflow, approval id, a frozen copy of the exact action that will be
dispatched, the native evidence bytes addressed to this component only, and the evaluation instant.
`CheckOutput` is `{ evidence: Uint8Array, claims: ClaimResult[] }`.

`ExecuteOp` carries the logical operation id, the provider idempotency key (equal to the operation id in V0),
the attempt number and the admitted action. `ExecuteOutput.outcome` is `provider_confirmed`, `failed` (with
`retriable` true only when the provider did not perform the side effect) or `unknown`.

`createAdapter(ctx)` receives `ctx.config` (from policy), `ctx.secrets` (only names granted as `secret:<name>`)
and `ctx.fetch` (refuses origins outside the declared and granted destinations).

## 5. Evidence rule (enforced in `normalizeCheckOutput`, `src/runtime/runtime.ts`)

1. Evidence must be returned as bytes. The runtime stores them unmodified per component and records only
   their digest in provenance. It never parses them.
2. Claims are always qualified by component id. Policy names `{component, claim}`. A claim with the same name
   from another component cannot satisfy it, and evidence addressed to one component is never passed to another.
3. Only claims declared in that component's manifest count. Undeclared claims are dropped and recorded as
   violations. Unknown status values or duplicates make that claim `unavailable`.
4. A declared claim the adapter did not report is `unavailable`. A thrown error or timeout makes all its
   claims `unavailable`. `unavailable` is never success.

## 6. Admission

Before any side effect, in order: workflow and tool known; component `describe()` still matches the pin;
action args valid against the pinned tool schema; approval id present when the workflow requires one;
approval not already consumed; every required claim `established`. Anything else refuses. Optional claims
are recorded with their status, or `unevaluated` when the component was unavailable.

Admission then runs one SQLite `BEGIN IMMEDIATE` transaction that inserts the approval consumption
(`approval_id` primary key) and the operation row (`operation_id` primary key) together. A second consumer of
the same approval, in the same process or another process on the same store, gets `approval_already_consumed`.

## 7. Operation states and retries

`authorized` → `dispatched` → `provider_confirmed` | `failed` | `unknown`. A transport error after the request
may have been sent is `unknown`, never `failed`. Resubmitting the same operation id with the same action and
approval is a retry: no re-admission, no re-consumption, the same idempotency key. Dispatch is claimed under a
lease, so concurrent retries do not double-dispatch; a lease left by a crashed worker expires. A different action
or approval under an existing operation id is refused. A confirmed operation replays its result without dispatch.

## 8. Loading

Refused at load: manifest digest differs from the pin (`manifest_changed`), artifact digest differs from the
manifest or pin, version differs from the pin, requested privileges or destinations exceed the grant,
secret not provisioned, entry missing `createAdapter`, role method missing, `describe()` differs from the file.

## 9. Provenance and usage

Per logical operation: policy id, action digest, approval id, state, every admission decision (components with
version and digests, per-claim status and requirement, evidence digests), every attempt with outcome. No action
arguments, evidence bytes or secrets. Usage: one row per component per logical operation, `calls` counting
invocations including retries, `outcome` the last state. No settlement, pricing or revenue logic.

## 10. Not covered by V0

Components run in the runtime's process: `ctx.fetch` restricts only that handle, not global `fetch`, file or
process access. The artifact is hashed then imported from the same path, so a swap between the two is not
detected. Dependencies are declared, not verified. No revocation, trusted time, remote components, catalog,
multi-tenant isolation or key rotation.

# federation-port

Written by Tymofii Pidlisnyi as an experiment. This is not a federation standard or an adopted federation
component, and no project is a participant until it says so.

One possible integration boundary for independent agent-governance projects. It has one small adapter
contract, a runtime that admits or refuses an action before calling its executor, and a durable record of
what each component checked. Each project writes and owns its own adapter. The runtime core does not depend on any one
project's protocol.

Status: V0 prototype, published for discussion on
[aeoess/agent-governance-vocabulary#177](https://github.com/aeoess/agent-governance-vocabulary/issues/177).

## What it does

- **Contract** ([`spec/CONTRACT.md`](spec/CONTRACT.md), `src/contract/types.ts`). A component is a manifest
  plus an adapter module. A checker component states which claims it can establish. An execution component
  performs the side effect. Manifests and artifacts are pinned by digest.
- **Runtime** (`src/runtime`). For each workflow it evaluates required and optional claims, refuses before
  dispatch when a required claim is not established, checks the admission deadline inside the write,
  consumes an approval once across processes and restarts sharing the same store, and binds every retry to the admitted workflow,
  tenant, action, approval, submitted evidence and execution context. State lives in one SQLite file.
- **Record.** Per logical operation it keeps every admission decision (components with version and digests,
  per-claim status, evidence digests), every attempt and its outcome, and one usage row per component. No
  action arguments or evidence bytes in the provenance output. Native evidence bytes are stored in SQLite.
  Adapter reasons are also recorded, so adapters must keep sensitive data out of their reasons and errors.
  No settlement, pricing or revenue logic.

## What is in this repo

| path | what |
|---|---|
| `adapters/aps-authority` | checks an Agent Passport System approval against the exact action (uses `agent-passport-system`) |
| `adapters/tool-admission` | checks that the served tool definition still matches its pin |
| `adapters/refund-execution-0.1-*` | admission and execution components for a bounded refund profile |
| `sim/` | local refund provider and simulator (no real payment) |
| `compare/` | the same refund flow written directly and through the port, with results in `compare/RESULTS.md` |
| `test/` | `npm test` (Node 24, node:test, node:sqlite) |

The APS adapter is one adapter among others. Nothing under `src/` imports it.

## Try it

```console
$ npm ci
$ npm test          # 44 tests
$ npm run compare   # regenerates compare/RESULTS.md against the local simulator
```

## Limits

- **Adapters run in the runtime's own process.** Manifest privileges are checked declarations, not a
  sandbox. Running third-party adapter code in V0 gives it the runtime's authority. Out-of-process
  isolation is the first V1 item (spec section 10).
- **One author, no outside adapter yet.** Independent interoperability is not shown until another project
  writes an adapter against the contract without changes to `src/`.
- **Simulated provider only.** The comparison numbers come from a local simulator on one machine.
- Also from the spec: no revocation, trusted time source, remote components, catalog, multi-tenant
  isolation or key rotation, and the tenant label is not authenticated.

## Taking part

Write an adapter for your project against `spec/CONTRACT.md`, in your own repository or as a PR here. You
keep ownership of it. The most useful first contribution is an adapter for a check your project already
performs, run through the existing tests or a test of your own. Contract changes are discussed on #177 or
in an issue here before code.

## Licence

Apache-2.0, see `LICENSE`.

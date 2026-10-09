# v0 composition run, four components

A demonstration against contract v0 at `3a2f6ce`. It is not a v1 conformance test and adds nothing to the contract. Discussion is on [aeoess/agent-governance-vocabulary#177](https://github.com/aeoess/agent-governance-vocabulary/issues/177).

One workflow requires every claim of four components written by four projects, on the unmodified runtime, with the simulated refund executor:

| component | project | fetched at | artifact digest |
|---|---|---|---|
| `aeoess.aps/exact-approval-authority` 0.2.0 | Agent Passport System | federation-port `3a2f6ce` | `sha256:0ef8faf0…` |
| `invinoveritas/verdict-check` 0.1.0 | babyblueviper1/preaction-governance-conformance | `bcfa6df` | `sha256:9c11769f…` |
| `horizonshield.nenrin/conduct-walk-check` 0.1.0 | ogasurfproject-jpg/horizon-shield | `6a4581c` | `sha256:50bff064…` |
| `agentavow.com/mcp-tool-admission` 0.1.1 | AgentAvow/AgentAvow | `40db5d3` | `sha256:c7d2a415…` |

Full digests and fixture hashes are in `reproduce.sh` and `pins.ts`. These are the versions the run used. invinoveritas 0.2.0 (`31cdcb0`) is newer and is not used here.

## Run it

    ./compose/reproduce.sh

It clones federation-port and the three components at the commits above into a temporary directory, checks every component and fixture digest, runs `npm ci`, and runs `composition.test.ts`. The fetched components are third-party code and run in the test's own process with its authority. Use a disposable environment if that matters to you.

## Expected result

    ok  aeoess.aps/exact-approval-authority 0.2.0 sha256:0ef8faf0…
    ok  invinoveritas/verdict-check 0.1.0 sha256:9c11769f…
    ok  horizonshield.nenrin/conduct-walk-check 0.1.0 sha256:50bff064…
    ok  agentavow.com/mcp-tool-admission 0.1.1 sha256:c7d2a415…
    core unmodified (src/ clean)
    tests 8, pass 8, fail 0, skipped 0

- C0: all four positive, admitted, one dispatch, claims and evidence recorded for every component.
- C1 to C4: a genuine negative from one component, the other three positive. Refused, no dispatch, the other three still established, every refusal reason names only that component.
- C5: one component's evidence missing. Refused the same way.
- C6: an observation, not a pass condition. The four positives concern different subjects (the refund action, an A2A endpoint, a tool on another MCP server) and v0 admits. This is what #177 discusses.
- C7: every AgentAvow scan request went to the local stub.

## Limits

- The AgentAvow attestation is the published payload re-signed by a test key generated inside the test, with its validity window moved to the evaluation instant, because the published attestation expired before the other fixtures were signed. The agentavow.com scan is a local stub. Nothing here says anything about AgentAvow's deployed verifier.
- The invinoveritas verdicts and the NENRIN walk are the authors' real signed fixtures, evaluated at a fixed instant, 2026-10-07T21:20:00.000Z.
- The executor is the local simulator. No request reaches a remote service during the test.
- All components run in one process. This shows mechanical composition and refusal attribution under v0. It shows nothing about isolation, subject agreement between components, or production use.

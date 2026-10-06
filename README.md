# federation-port (V0b, private prototype)

Exploratory local prototype of a common port: a small adapter contract, a runtime that admits or refuses an
action before its side effect, and a local refund simulator. Not a public proposal, not an adopted contract.
No third-party project is integrated or treated as a participant.

- Contract: `spec/CONTRACT.md`, `src/contract/types.ts`
- Runtime: `src/runtime`
- Simulator: `sim/` (refund provider, exact EUR 40.00 pay_A profile, execution component)
- Components: `adapters/`
- Tests: `npm test` (Node 24, node:test, node:sqlite)

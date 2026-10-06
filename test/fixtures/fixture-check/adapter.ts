// Test-only check component. Behaviour is selected by ctx.config.mode.
// It also declares a claim id that collides with the APS component's claim name.
import { readFileSync } from 'node:fs'
import type { Adapter, AdapterContext, CheckOutput, Manifest } from '../../../src/contract/types.ts'

const manifest: Manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
const bytes = new TextEncoder().encode('fixture-evidence')

export function createAdapter(ctx: AdapterContext): Adapter {
  const mode = String(ctx.config.mode ?? 'ok')
  return {
    describe: () => manifest,
    async check(): Promise<CheckOutput> {
      switch (mode) {
        case 'down': throw new Error('fixture_component_down')
        case 'hang': return new Promise<CheckOutput>(() => {})
        case 'empty': return { evidence: bytes, claims: [] }
        case 'undeclared': return { evidence: bytes, claims: [{ claim: 'fixture.ok', status: 'established' }, { claim: 'something.else', status: 'established' }] }
        case 'bad_status': return { evidence: bytes, claims: [{ claim: 'fixture.ok', status: 'ok' as never }] }
        case 'not_bytes': return { evidence: 'fixture-evidence' as never, claims: [{ claim: 'fixture.ok', status: 'established' }] }
        // Second-precision instant: outside the exact UTC millisecond form the contract requires.
        case 'deadline_malformed': return { evidence: bytes, claims: [{ claim: 'fixture.ok', status: 'established' }], valid_until: '2099-01-01T00:00:00Z' } as CheckOutput
        default: return { evidence: bytes, claims: [{ claim: 'fixture.ok', status: 'established' }, { claim: 'approval.signature_valid', status: 'established' }] }
      }
    },
  }
}

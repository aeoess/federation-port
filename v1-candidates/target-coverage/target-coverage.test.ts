// Candidate v1 target-coverage vectors (aeoess/agent-governance-vocabulary#177). Not a contract test: v0 has no CheckInput.target.
// Two layers per case: (1) the component, given CheckInput.target, reports these claim statuses and this subject;
// (2) the candidate v1 rule below decides the target-bound requirement from the reported subject and the runtime target.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const V = JSON.parse(readFileSync(new URL('./vectors.json', import.meta.url), 'utf8'))
const { createAdapter } = await import('../../adapters/invinoveritas-verdict/adapter.ts')

type Claim = { claim: string; status: string; reason?: string }
type Requirement = { claim: string; binds: 'action' | 'target' | 'context' }

/** The subject a claim reports. v0 has no subject field, so components carry it as `subject:<field>=<value>` in the reason. */
const reportedTarget = (c?: Claim) => c?.status === 'established' && c.reason?.startsWith('subject:target=') ? c.reason.slice('subject:target='.length) : undefined

/**
 * Candidate v1 rule, as proposed in #177. A requirement is satisfied only when the claim is established AND the component declares
 * that claim binds what the requirement asks for (a missing declaration fails closed; an action-bound claim never satisfies a
 * target-bound requirement). For a target-bound requirement the runtime must have a declared target, and the subject the component
 * reported from its verified evidence must equal it, exact string. The runtime does this comparison; the component only reports.
 */
export function decide(reqs: Requirement[], claims: Claim[], coverage: Record<string, string>, runtimeTarget: string | null): { decision: 'admit' | 'refuse'; refusal?: string } {
  for (const r of reqs) {
    const c = claims.find(x => x.claim === r.claim)
    if (coverage[r.claim] !== r.binds) return { decision: 'refuse', refusal: r.binds === 'target' ? 'claim_does_not_bind_target' : 'claim_coverage_mismatch' }
    if (r.binds === 'target' && runtimeTarget === null) return { decision: 'refuse', refusal: 'no_runtime_target' }
    if (!c || c.status !== 'established') return { decision: 'refuse', refusal: `required_claim_not_established:${r.claim}` }
    if (r.binds === 'target') {
      const t = reportedTarget(c)
      if (t === undefined) return { decision: 'refuse', refusal: 'no_reported_subject' }
      if (t !== runtimeTarget) return { decision: 'refuse', refusal: 'reported_target_is_not_the_runtime_target' }
    }
  }
  return { decision: 'admit' }
}

const bytes = (o: unknown) => new Uint8Array(Buffer.from(JSON.stringify(o)))
for (const k of V.cases) {
  test(`${k.id} ${k.name}`, async () => {
    const a = createAdapter({ config: V.component_config, secrets: {}, fetch })
    const input: any = { operation_id: `op_${k.id}`, workflow: 'refund', action: structuredClone(k.action), evidence: bytes(k.evidence), now: V.now }
    if (k.runtime_target !== null) input.target = k.runtime_target
    const out = await a.check!(input)
    const got = Object.fromEntries(out.claims.filter((c: Claim) => c.claim in k.expected.claims).map((c: Claim) => [c.claim, c.status]))
    assert.deepEqual(got, k.expected.claims)
    const tgt = out.claims.find((c: Claim) => c.claim === 'invinoveritas.verdict_covers_target')
    if (k.expected.reported_target) assert.equal(reportedTarget(tgt), k.expected.reported_target)
    if (k.expected.reason) assert.equal(tgt.reason, k.expected.reason)
    const d = decide(k.requirements, out.claims, V.component_coverage, k.runtime_target)
    assert.equal(d.decision, k.expected.decision, JSON.stringify(d))
    if (k.expected.refusal) assert.equal(d.refusal, k.expected.refusal)
  })
}

test('R1 the runtime comparison holds on its own: an established claim reporting A does not satisfy runtime target B', () => {
  const claims = [{ claim: 'x.covers_target', status: 'established', reason: 'subject:target=https://a.example/a2a' }]
  const cov = { 'x.covers_target': 'target' }
  assert.deepEqual(decide([{ claim: 'x.covers_target', binds: 'target' }], claims, cov, 'https://b.example/a2a'), { decision: 'refuse', refusal: 'reported_target_is_not_the_runtime_target' })
  assert.deepEqual(decide([{ claim: 'x.covers_target', binds: 'target' }], [{ ...claims[0], reason: undefined }], cov, 'https://a.example/a2a'), { decision: 'refuse', refusal: 'no_reported_subject' })
  assert.deepEqual(decide([{ claim: 'x.covers_target', binds: 'target' }], claims, {}, 'https://a.example/a2a'), { decision: 'refuse', refusal: 'claim_does_not_bind_target' })
  assert.deepEqual(decide([{ claim: 'x.covers_target', binds: 'target' }], claims, cov, 'https://a.example/a2a'), { decision: 'admit' })
})

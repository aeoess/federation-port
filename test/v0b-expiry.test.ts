// V0b, defect 1: an approval that expires while checks run, or while the admission write waits
// on the store lock, must not be consumed or dispatched. Reproduces the review finding on V0.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { APPROVED_REFUND } from '../sim/profile.ts'
import { APS, FIXTURE, ROOT, child, delayCheck, opId, pinFromDisk, request, restart, setup } from './helpers.ts'

const reasonsOf = (r: { status: string } & Record<string, unknown>) => (r.reasons as string[] | undefined) ?? []
const fixturePin = (mode: string) => pinFromDisk(join(ROOT, 'test/fixtures/fixture-check'), { config: { mode } })

// ---- Defect 1: approval expiry during checks ----

test('D1a approval expires while a checker is delayed: refused at the admission write, nothing consumed or dispatched', async () => {
  const env = await setup()
  try {
    delayCheck(env.rt, APS, 250)
    const { a, req } = request(env, undefined, undefined, { ttlMs: 100 })
    const r = await env.rt.submit(req)
    assert.equal(r.status, 'refused', JSON.stringify(r))
    assert.deepEqual(reasonsOf(r), ['approval_expired_at_admission'])
    assert.equal(env.provider.requests, 0)
    assert.equal(env.rt.store.countDispatches(), 0)
    assert.equal(env.rt.store.approvalConsumedBy(a.approval_id), undefined)
    assert.equal(env.rt.store.getOperation(req.operation_id), undefined)
    const adm = (env.rt.provenance(req.operation_id) as any).admissions.at(-1)
    assert.equal(adm.decision, 'refused')
    assert.ok(adm.at > a.valid_until, `recorded instant ${adm.at} is the fresh admission clock, after ${a.valid_until}`)
  } finally { await env.close() }
})

test('D1b approval expires while waiting on the store lock held by another OS process: refused', async () => {
  const env = await setup()
  try {
    const holder = child(join(ROOT, 'test/fixtures/hold-lock.ts'), [env.dbPath, '700'])
    await holder.line('locked')
    const { a, req } = request(env, undefined, undefined, { ttlMs: 300 })
    const r = await env.rt.submit(req)
    assert.equal((await holder.done).code, 0)
    assert.equal(r.status, 'refused', JSON.stringify(r))
    assert.deepEqual(reasonsOf(r), ['approval_expired_at_admission'])
    assert.equal(env.provider.requests, 0)
    assert.equal(env.rt.store.approvalConsumedBy(a.approval_id), undefined)
    assert.ok((env.rt.provenance(req.operation_id) as any).admissions.at(-1).at > a.valid_until)
  } finally { await env.close() }
})

test('D1c equality boundary under an injected clock: admitted at valid_until exactly, refused 1 ms later; recorded times are the admission instant', async () => {
  const env = await setup()
  try {
    const T0 = new Date('2026-10-05T12:00:00.000Z')
    let now = new Date(T0.getTime() + 1000)
    await restart(env, env.policy, () => now)
    const ok = env.operator.issue(APPROVED_REFUND, { issuedAt: T0, ttlMs: 60_000 })
    // The check runs at T0+1s; the clock then jumps to valid_until (+ bump ms) before admission.
    let bump = 0
    delayCheck(env.rt, APS, async () => { now = new Date(Date.parse(ok.valid_until) + bump) })
    const r1 = await env.rt.submit({ workflow: 'refund', operation_id: opId(), approval_id: ok.approval_id, action: { tool: 'refund', args: { ...APPROVED_REFUND } }, evidence: { [APS]: ok.evidence } })
    assert.equal(r1.status, 'provider_confirmed', JSON.stringify(r1))
    const prov = env.rt.provenance(r1.operation_id) as any
    assert.equal(prov.admissions[0].at, ok.valid_until)
    assert.equal(prov.attempts[0].started_at, ok.valid_until)

    bump = 1
    const late = env.operator.issue({ ...APPROVED_REFUND, payment_id: 'pay_B' }, { issuedAt: T0, ttlMs: 60_000 })
    now = new Date(T0.getTime() + 1000)
    // Same valid_until as `ok` (same issue time and ttl), so the jump lands 1 ms past it.
    assert.equal(late.valid_until, ok.valid_until)
    const r2 = await env.rt.submit({ workflow: 'refund', operation_id: opId(), approval_id: late.approval_id, action: { tool: 'refund', args: { ...APPROVED_REFUND, payment_id: 'pay_B' } }, evidence: { [APS]: late.evidence } })
    assert.deepEqual(reasonsOf(r2), ['approval_expired_at_admission'])
    assert.equal(env.provider.refunds.length, 1)
  } finally { await env.close() }
})

test('D1d deadline rule: malformed valid_until makes the component unavailable; approval workflow with no reported deadline refused', async () => {
  let env = await setup({ extraComponents: { [FIXTURE]: fixturePin('deadline_malformed') },
    required: [{ component: APS, claim: 'approval.signature_valid' }, { component: FIXTURE, claim: 'fixture.ok' }] })
  try {
    const r = await env.rt.submit(request(env).req)
    assert.deepEqual(reasonsOf(r), [`required_claim_unavailable:${FIXTURE}#fixture.ok:adapter_protocol_violation:valid_until`])
    assert.equal(env.provider.requests, 0)
  } finally { await env.close() }

  // Approval required, but the only required component reports no deadline.
  env = await setup({ extraComponents: { [FIXTURE]: fixturePin('ok') }, required: [{ component: FIXTURE, claim: 'fixture.ok' }] })
  try {
    const r = await env.rt.submit(request(env).req)
    assert.deepEqual(reasonsOf(r), ['admission_deadline_missing'])
    assert.equal(env.provider.requests, 0)
  } finally { await env.close() }
})

test('D1e after the deadline nothing is dispatched: a retriable failure is closed; an unknown outcome stays unknown for reconciliation', async () => {
  const env = await setup()
  try {
    const T0 = new Date(Date.now() - 1000)
    let now = new Date(T0.getTime() + 500)
    await restart(env, env.policy, () => now)
    const a = env.operator.issue(APPROVED_REFUND, { issuedAt: T0, ttlMs: 60_000 })
    const req = { workflow: 'refund', operation_id: opId(), approval_id: a.approval_id, action: { tool: 'refund', args: { ...APPROVED_REFUND } }, evidence: { [APS]: a.evidence } }
    env.provider.setFault({ mode: 'outage', count: 1 })
    assert.equal((await env.rt.submit(req)).status, 'failed')
    const before = env.provider.requests
    now = new Date(Date.parse(a.valid_until) + 1)
    const late = await env.rt.submit(req)
    assert.equal(late.status, 'failed')
    assert.equal((late as any).reason, 'approval_expired_before_retry')
    assert.equal(env.provider.requests, before)
    assert.equal(env.provider.refunds.length, 0)

    now = new Date(T0.getTime() + 500)
    const b = env.operator.issue({ ...APPROVED_REFUND, payment_id: 'pay_B' }, { issuedAt: T0, ttlMs: 60_000 })
    const reqB = { ...req, operation_id: opId(), approval_id: b.approval_id, action: { tool: 'refund', args: { ...APPROVED_REFUND, payment_id: 'pay_B' } }, evidence: { [APS]: b.evidence } }
    env.provider.setFault({ mode: 'drop_after_commit', count: 1 })
    assert.equal((await env.rt.submit(reqB)).status, 'unknown')
    const beforeB = env.provider.requests
    now = new Date(Date.parse(b.valid_until) + 1)
    // The refund exists, but after the authorization expired the runtime may not send anything to find
    // out: the operation stays unknown and needs a read-only reconciliation (section 7).
    const pending = await env.rt.submit(reqB)
    assert.equal(pending.status, 'unknown')
    assert.equal((pending as any).reason, 'reconciliation_required')
    assert.equal(env.provider.requests, beforeB)
    assert.equal(env.provider.refunds.length, 1)
  } finally { await env.close() }
})

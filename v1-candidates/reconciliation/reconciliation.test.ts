// Candidate v1 reconciliation (aeoess/federation-port#2). Not a contract test: v0 has no reconcile().
// The first two cases are the two failure cases asked for on #2; the rest are the retry, retention,
// trust, budget and concurrency rules around them.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { Runtime } from '../../src/runtime/index.ts'
import type { CustomerPolicy } from '../../src/runtime/index.ts'
import { createOperator } from '../../sim/operator.ts'
import { APPROVED_REFUND } from '../../sim/profile.ts'
import { APS, ROOT, buildPolicy, pinFromDisk, tmp } from '../../test/helpers.ts'
import { startReconcileProvider } from './provider.ts'
import type { ReconcileProvider } from './provider.ts'
import { Reconciler, decide, naiveDecide, retryAllowed, submitWithReconciliation } from './reconcile.ts'
import type { ReconcileResult, ReconciliationPolicy } from './reconcile.ts'

const RX = 'example.sim/refund-executor-reconcile'
const RETENTION_MS = 600_000 // the executor manifest declares 10 minutes
const TTL_MS = 60_000

interface World {
  now: { ms: number }
  provider: ReconcileProvider
  policy: CustomerPolicy
  rpolicy: Record<string, ReconciliationPolicy>
  rt: Runtime
  rec: Reconciler
  dbPath: string
  apiKey: string
  valid_until: number
  req: { workflow: string; operation_id: string; approval_id: string; action: { tool: string; args: Record<string, unknown> }; evidence: Record<string, Uint8Array> }
  restart(): Promise<void>
  close(): Promise<void>
}

const TRUST = (p: ReconcileProvider) => ({ provider_account: p.account, key_namespace: p.keyNamespace, lookup_complete: true, accepts_key_finality: true })

async function world(o: { rpolicy?: (p: ReconcileProvider) => ReconciliationPolicy; providerRetentionMs?: number } = {}): Promise<World> {
  const T0 = Date.now() - 1_000
  const now = { ms: T0 + 500 }
  const clock = () => new Date(now.ms)
  const apiKey = randomBytes(24).toString('hex')
  const provider = await startReconcileProvider({ apiKey, clock: () => now.ms, retentionMs: o.providerRetentionMs ?? RETENTION_MS })
  const operator = createOperator()
  const policy = buildPolicy(operator, provider.url, {
    extraComponents: { [RX]: pinFromDisk(join(ROOT, 'v1-candidates/reconciliation/executor'), { config: { base_url: provider.url } }) },
    workflow: { executor: RX },
  })
  const rpolicy = { [RX]: o.rpolicy ? o.rpolicy(provider) : { max_skew_ms: 1_000, lookup_timeout_ms: 1_000, lookup_budget: 3, trust: TRUST(provider) } }
  const dbPath = join(tmp('fp-rec-'), 'port.db')
  const a = operator.issue(APPROVED_REFUND, { issuedAt: new Date(T0), ttlMs: TTL_MS })
  const w: World = {
    now, provider, policy, rpolicy, dbPath, apiKey, valid_until: Date.parse(a.valid_until),
    rt: await Runtime.create({ policy, dbPath, secrets: { provider_api_key: apiKey }, clock }),
    rec: undefined as unknown as Reconciler,
    req: { workflow: 'refund', operation_id: `op-rec-${process.pid}-${randomBytes(4).toString('hex')}`, approval_id: a.approval_id,
      action: { tool: 'refund', args: { ...APPROVED_REFUND } }, evidence: { [APS]: a.evidence } },
    async restart() {
      w.rt.close()
      w.rt = await Runtime.create({ policy, dbPath, secrets: { provider_api_key: apiKey }, clock })
      w.rec = new Reconciler(w.rt, w.rpolicy, clock)
    },
    async close() { w.rt.close(); await provider.close() },
  }
  w.rec = new Reconciler(w.rt, w.rpolicy, clock)
  return w
}

const events = (w: World, id: string) => (w.rec.provenance(id).events as { kind: string; detail: Record<string, unknown> }[])
const lookups = (w: World, id: string) => w.rec.provenance(id).lookups as { outcome: string | null; decision: string | null; reason: string | null }[]

// ── The two failure cases from #2 ──────────────────────────────────────────

test('F1 an earlier request settles after an absent lookup: the operation stays unknown, then resolves to the refund, never failed', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    assert.equal((await w.rt.submit(w.req)).status, 'unknown')
    // The provider has the request but has not settled it, and its lookup cannot see it: not_found, not final.
    const first = await w.rec.reconcile(w.req.operation_id)
    assert.equal(first.state, 'unknown')
    assert.equal(first.reason, 'absent_not_final')
    // The rule this candidate replaces would have closed it here, with the refund still to come.
    const r: ReconcileResult = { outcome: 'absent', authoritative: true, final: false, scope: { provider_account: w.provider.account, key_namespace: w.provider.keyNamespace }, evidence: new Uint8Array() }
    assert.equal(naiveDecide(r).kind, 'close_absent')
    assert.equal(decide(r, { policy: w.rpolicy[RX], lookupInsideRetention: true, attemptInFlight: false }).kind, 'stay_unknown')
    w.now.ms += 5_000
    assert.ok(w.provider.settle(w.req.operation_id))
    const second = await w.rec.reconcile(w.req.operation_id)
    assert.equal(second.state, 'provider_confirmed')
    assert.equal(second.status, 'resolved_confirmed')
    assert.equal(w.provider.refunds.length, 1)
    assert.deepEqual(lookups(w, w.req.operation_id).map(l => l.outcome), ['absent', 'provider_confirmed'])
  } finally { await w.close() }
})

test('F2 a request sent before the deadline settles after it: no dispatch after expiry, the effect is recorded as after expiry, the operation ends confirmed', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    assert.equal((await w.rt.submit(w.req)).status, 'unknown')
    const dispatchedAt = Date.parse((w.rt.store.attempts(w.req.operation_id)[0] as { started_at: string }).started_at)
    assert.ok(dispatchedAt <= w.valid_until)
    w.now.ms = w.valid_until + 2_000
    const requestsBefore = w.provider.requests
    // v0 already refuses to dispatch past the deadline.
    const retry = await w.rt.submit(w.req)
    assert.equal(retry.status, 'unknown')
    assert.equal((retry as { reason?: string }).reason, 'reconciliation_required')
    assert.equal(w.provider.requests, requestsBefore)
    // The request sent before the deadline settles after it.
    assert.ok(w.provider.settle(w.req.operation_id))
    const out = await w.rec.reconcile(w.req.operation_id)
    assert.equal(out.state, 'provider_confirmed')
    const after = events(w, w.req.operation_id).find(e => e.kind === 'effect_after_expiry')
    assert.ok(after, 'effect_after_expiry recorded')
    assert.equal(after!.detail.dispatched_before_expiry, true)
    assert.ok(Date.parse(String(after!.detail.settled_at)) > w.valid_until)
    for (const a of w.rt.store.attempts(w.req.operation_id) as { started_at: string }[]) assert.ok(Date.parse(a.started_at) <= w.valid_until)
  } finally { await w.close() }
})

// ── What an absence may conclude ───────────────────────────────────────────

test('A1 a trusted, key-scoped final absence inside retention closes the operation as failed, and no later request can settle', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.cancel(w.req.operation_id)
    const out = await w.rec.reconcile(w.req.operation_id)
    assert.equal(out.state, 'failed')
    assert.equal(out.status, 'resolved_absent')
    assert.equal(w.provider.refunds.length, 0)
    assert.equal(w.provider.settle(w.req.operation_id), undefined)
    assert.ok(events(w, w.req.operation_id).some(e => e.kind === 'reconciled_absent'))
    // The closed operation replays failed and dispatches nothing.
    const n = w.provider.requests
    assert.equal((await w.rt.submit(w.req)).status, 'failed')
    assert.equal(w.provider.requests, n)
  } finally { await w.close() }
})

test('A2 an absence the operator does not trust stays unknown: no trust, lookup not complete, or finality not accepted', async () => {
  for (const trust of [undefined, 'incomplete', 'no_finality'] as const) {
    const w = await world({ rpolicy: p => ({ max_skew_ms: 1_000, lookup_timeout_ms: 1_000, lookup_budget: 3,
      ...(trust === undefined ? {} : { trust: { ...TRUST(p), lookup_complete: trust !== 'incomplete', accepts_key_finality: trust !== 'no_finality' } }) }) })
    try {
      w.provider.hold(1)
      await w.rt.submit(w.req)
      w.provider.cancel(w.req.operation_id)
      const out = await w.rec.reconcile(w.req.operation_id)
      assert.equal(out.state, 'unknown', String(trust))
      assert.equal(out.reason, 'absent_not_trusted')
    } finally { await w.close() }
  }
})

test('A3 a final absence reported for another account than the one the operator trusts stays unknown', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.cancel(w.req.operation_id)
    w.provider.setReportedAccount('acct_other')
    const out = await w.rec.reconcile(w.req.operation_id)
    assert.equal(out.state, 'unknown')
    assert.equal(out.reason, 'absent_scope_mismatch')
  } finally { await w.close() }
})

test('A4 outside the retention window no lookup is made and the operation needs an operator; the effect stays unknown', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.cancel(w.req.operation_id)
    w.now.ms += RETENTION_MS
    const n = w.provider.lookups
    const out = await w.rec.reconcile(w.req.operation_id)
    assert.equal(out.state, 'unknown')
    assert.equal(out.status, 'operator_required')
    assert.equal(out.reason, 'retention_passed')
    assert.equal(w.provider.lookups, n)
  } finally { await w.close() }
})

test('A5 an absence later contradicted by the provider: the confirmation wins and the contradiction is recorded', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.setMisreportFinal(true) // a faulty provider calls a pending request final absence
    assert.equal((await w.rec.reconcile(w.req.operation_id)).state, 'failed')
    w.provider.setMisreportFinal(false)
    w.provider.settle(w.req.operation_id)
    const [swept] = await w.rec.sweep()
    assert.equal(swept.state, 'provider_confirmed')
    assert.equal(w.rt.store.getOperation(w.req.operation_id)!.state, 'provider_confirmed')
    assert.deepEqual(events(w, w.req.operation_id).map(e => e.kind), ['reconciled_absent', 'absence_contradicted'])
    // Attempt rows are never rewritten.
    assert.deepEqual(w.rt.store.attempts(w.req.operation_id).map(a => a.outcome), ['unknown'])
  } finally { await w.close() }
})

// ── Retries bounded by the idempotency window ──────────────────────────────

test('R1 the retry formula: inside the window and before the deadline only, and never without a declared retention', () => {
  const base = { validUntilMs: 100_000, firstDispatchMs: 0, retentionMs: 60_000, executeTimeoutMs: 1_000, maxSkewMs: 500 }
  assert.equal(retryAllowed({ ...base, nowMs: 58_000 }), true)      // 58000 + 1000 + 1000 = 60000
  assert.equal(retryAllowed({ ...base, nowMs: 58_001 }), false)
  assert.equal(retryAllowed({ ...base, nowMs: 10_000, validUntilMs: 9_999 }), false)
  assert.equal(retryAllowed({ ...base, nowMs: 0, retentionMs: null }), false)
})

test('R2 an unknown operation past its idempotency window is reconciled, not re-sent', async () => {
  const w = await world({ rpolicy: p => ({ retention_cap_ms: 5_000, max_skew_ms: 1_000, lookup_timeout_ms: 1_000, lookup_budget: 3, trust: TRUST(p) }) })
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.now.ms += 3_500 // still before the deadline, but 3500 + 1000 + 2000 > 5000
    const n = w.provider.requests
    const out = await submitWithReconciliation(w.rt, w.rec, w.rpolicy, w.req, () => new Date(w.now.ms))
    assert.equal((out as { status_kind?: string }).status_kind, 'reconciled')
    assert.equal(w.provider.requests, n, 'no effect-producing retry')
  } finally { await w.close() }
})

test('R3 inside the window the same request is retried with the same key and resolves', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.settle(w.req.operation_id)
    w.now.ms += 2_000
    const out = await submitWithReconciliation(w.rt, w.rec, w.rpolicy, w.req, () => new Date(w.now.ms))
    assert.equal(out.status, 'provider_confirmed')
    assert.equal(w.provider.refunds.length, 1)
  } finally { await w.close() }
})

// ── Budgets, crashes, concurrency, scheduling ──────────────────────────────

test('B1 inconclusive lookups (provider unavailable) leave the effect unknown and end in operator_required at the budget', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.setLookupDown(true)
    const outs = [await w.rec.reconcile(w.req.operation_id), await w.rec.reconcile(w.req.operation_id), await w.rec.reconcile(w.req.operation_id)]
    assert.deepEqual(outs.map(o => o.state), ['unknown', 'unknown', 'unknown'])
    assert.equal(outs[2].status, 'operator_required')
    assert.equal(outs[2].reason, 'budget_exhausted')
    const n = w.provider.lookups
    assert.equal((await w.rec.reconcile(w.req.operation_id)).looked_up, false)
    assert.equal(w.provider.lookups, n)
  } finally { await w.close() }
})

test('B2 the budget survives a restart, and a policy raised after it does not reset or raise it', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.setLookupDown(true)
    await w.rec.reconcile(w.req.operation_id)
    await w.rec.reconcile(w.req.operation_id)
    w.rpolicy[RX] = { ...w.rpolicy[RX], lookup_budget: 50 }
    await w.restart()
    const third = await w.rec.reconcile(w.req.operation_id)
    assert.equal(third.status, 'operator_required')
    assert.equal(w.rec.reconciliation(w.req.operation_id)!.lookups, 3)
  } finally { await w.close() }
})

test('B3 a crash between the lookup and recording it changes nothing, counts against the budget, and the next lookup proceeds', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.settle(w.req.operation_id)
    // The reservation commits; the process dies before the result is applied.
    w.rt.store.tx(() => (w.rec as unknown as { reserve(id: string): unknown }).reserve(w.req.operation_id))
    await w.restart()
    assert.equal(w.rt.store.getOperation(w.req.operation_id)!.state, 'unknown')
    assert.deepEqual(lookups(w, w.req.operation_id).map(l => l.outcome), [null])
    const out = await w.rec.reconcile(w.req.operation_id)
    assert.equal(out.state, 'provider_confirmed')
    assert.equal(w.rec.reconciliation(w.req.operation_id)!.lookups, 2)
  } finally { await w.close() }
})

test('B4 two workers reconciling at once: the budget is never exceeded and the outcome is recorded once', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.settle(w.req.operation_id)
    const rt2 = await Runtime.create({ policy: w.policy, dbPath: w.dbPath, secrets: { provider_api_key: w.apiKey }, clock: () => new Date(w.now.ms) })
    const rec2 = new Reconciler(rt2, w.rpolicy, () => new Date(w.now.ms))
    const outs = await Promise.all([w.rec.reconcile(w.req.operation_id), rec2.reconcile(w.req.operation_id), w.rec.reconcile(w.req.operation_id), rec2.reconcile(w.req.operation_id)])
    assert.ok(outs.every(o => o.state === 'provider_confirmed' || o.state === 'unknown'))
    assert.equal(w.rt.store.getOperation(w.req.operation_id)!.state, 'provider_confirmed')
    assert.ok(w.rec.reconciliation(w.req.operation_id)!.lookups <= 3)
    assert.equal(events(w, w.req.operation_id).filter(e => e.kind === 'absence_contradicted').length, 0)
    rt2.close()
  } finally { await w.close() }
})

test('B5 a late confirmation from an attempt in flight wins over a reconciliation that could not conclude', async () => {
  const w = await world()
  try {
    // Attempt 1 is still running under its lease: reconciliation does not look up, and cannot close anything.
    const c = w.rt.component(RX)!
    const original = c.adapter.execute!.bind(c.adapter)
    let release!: () => void
    const gate = new Promise<void>(ok => { release = ok })
    let entered!: () => void
    const inside = new Promise<void>(ok => { entered = ok })
    c.adapter.execute = async op => { entered(); await gate; return original(op) }
    const pending = w.rt.submit(w.req)
    await inside
    const out = await w.rec.reconcile(w.req.operation_id)
    assert.equal(out.reason, 'attempt_in_flight')
    assert.equal(out.looked_up, false)
    release()
    assert.equal((await pending).status, 'provider_confirmed')
  } finally { await w.close() }
})

test('S1 the runtime can sweep: every unknown operation is resolved or handed to an operator without a caller resubmitting', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.provider.settle(w.req.operation_id)
    const swept = await w.rec.sweep()
    assert.equal(swept.length, 1)
    assert.equal(swept[0].state, 'provider_confirmed')
    assert.deepEqual(await w.rec.sweep(), [])
  } finally { await w.close() }
})

test('O1 an operator decision is its own provenance entry; the effect state and attempt rows are not rewritten', async () => {
  const w = await world()
  try {
    w.provider.hold(1)
    await w.rt.submit(w.req)
    w.now.ms += RETENTION_MS
    assert.equal((await w.rec.reconcile(w.req.operation_id)).status, 'operator_required')
    const before = JSON.stringify(w.rt.store.attempts(w.req.operation_id))
    const r = w.rec.recordOperatorDecision(w.req.operation_id, { operator: 'ops@example', conclusion: 'no_effect', evidence: new TextEncoder().encode('{"ticket":"T-1"}') })
    assert.equal(r.status, 'operator_resolved')
    assert.equal(w.rt.store.getOperation(w.req.operation_id)!.state, 'unknown')
    assert.equal(JSON.stringify(w.rt.store.attempts(w.req.operation_id)), before)
    const d = events(w, w.req.operation_id).find(e => e.kind === 'operator_decision')!
    assert.equal(d.detail.conclusion, 'no_effect')
    assert.equal(d.detail.effect_state, 'unknown')
    assert.throws(() => w.rec.recordOperatorDecision(w.req.operation_id, { operator: 'x', conclusion: 'effect_exists', evidence: new Uint8Array() }), /operator_decision_not_required/)
  } finally { await w.close() }
})

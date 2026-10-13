// Candidate v1 reconciliation for uncertain provider operations (aeoess/federation-port#2).
// Not part of contract v0 and changes nothing under src/. It runs next to the v0 Runtime, on the
// same SQLite store, in its own tables.
//
// What it adds, in the order the issue asked for:
//  1. A read-only lookup of the provider outcome by idempotency key (`reconcile` on the executor).
//  2. What a lookup may conclude (`decide`): a confirmation always wins; an absence closes an
//     operation only with finality evidence that covers every request with the key, from a lookup
//     scope the operator declared it trusts, inside the idempotency retention window, with no
//     attempt in flight. Anything else leaves the effect `unknown`.
//  3. A bound on effect-producing retries (`retryAllowed`): only while the provider is known to
//     remember the key, under written-down timing assumptions.
//  4. An explicit reconciliation status next to the effect state: `pending`, `operator_required`,
//     `resolved_confirmed`, `resolved_absent`, `operator_resolved`. The effect state and attempt rows
//     are never rewritten by an operator decision.
//  5. Budgets in the store, so a restart cannot reset them.
import { createHash } from 'node:crypto'
import { digestJson } from '../../src/runtime/canonical.ts'
import type { Runtime, SubmitRequest, SubmitResult } from '../../src/runtime/runtime.ts'
import type { OperationRow, Store } from '../../src/runtime/store.ts'

// ── Contract additions (candidate) ─────────────────────────────────────────

/**
 * The lookup is by idempotency key. The runtime stores the admitted action only as a digest (section 9),
 * so the query carries that digest, not the action, unlike the shape first proposed in #2.
 */
export interface ReconcileQuery { operation_id: string; idempotency_key: string; action_digest: string; attempts: number }

/**
 * What the executor's lookup reports. Every field is the adapter's claim; `decide` checks it
 * against what the operator declared before any of it can close an operation.
 */
export interface ReconcileResult {
  outcome: 'provider_confirmed' | 'absent' | 'unknown'
  /** The adapter's claim that the lookup is complete for the key it asked about. */
  authoritative: boolean
  provider_ref?: string
  /** Provider instant the effect settled, exact ISO string, when the provider reports one. */
  settled_at?: string
  /** For `absent`: the provider states that no request with this key can produce an effect later. */
  final?: boolean
  /** What the finality covers. Only `key` (every request with the key, past and future) can close. */
  final_scope?: 'key' | 'unspecified'
  /** The provider account and key namespace the lookup actually covered, as the provider reported them. */
  scope?: { provider_account: string; key_namespace: string }
  reason?: string
  evidence: Uint8Array
}

/** Manifest fields the candidate reads from an execution component. */
export interface ReconciliationManifest {
  idempotency?: { retention_ms: number; measured_from?: string }
}

/** Operator-side, per executor. Runtime configuration, like CustomerPolicy. */
export interface ReconciliationPolicy {
  /** The operator's cap on the manifest's retention. The effective window is the smaller of the two. */
  retention_cap_ms?: number
  /** Bound on the difference between the runtime clock and the provider clock (assumption T2). */
  max_skew_ms: number
  /** Bound on how long a lookup can take to reach the provider (assumption T3). */
  lookup_timeout_ms: number
  /** Lookups per operation before it needs an operator. Stored with the operation at its first lookup. */
  lookup_budget: number
  /**
   * What the operator trusts about the lookup. Without it, no absence is accepted. The adapter's
   * `authoritative` flag is never enough on its own: the provider must report this exact account and
   * namespace, and the operator must have declared both that the lookup is complete for that scope and
   * that the provider's key-scoped finality (a cancellation) is a guarantee they accept.
   */
  trust?: { provider_account: string; key_namespace: string; lookup_complete: boolean; accepts_key_finality: boolean }
}

// ── Timing (written down because the formula depends on it) ───────────────
//
// T1 Retention: the provider remembers a key for at least `retention_ms` after it first received a
//    request with that key, measured on the provider clock.
// T2 Skew: |runtime clock - provider clock| <= max_skew_ms, and the runtime reads `first_dispatch_at`
//    (attempt 1's started_at) before that request can have reached the provider.
// T3 Delivery: a request reaches the provider within its timeout (execute_timeout_ms for a dispatch,
//    lookup_timeout_ms for a lookup) or never. HTTP does not guarantee this; it is an assumption, and
//    where it fails a late request can still reach a provider that forgot the key.
//
// The provider first saw the key no earlier than first_dispatch_at - max_skew (T2), so it remembers
// the key at least until first_dispatch_at - max_skew + retention (T1). A request sent at runtime
// instant `now` arrives by now + max_skew + timeout (T2, T3). It is safe while
//
//     now + timeout + 2 * max_skew <= first_dispatch_at + retention
//
// Retention and lookup completeness are separate guarantees: T1 says a replay is deduplicated, not
// that a lookup sees everything. `trust.lookup_complete` is the second one.

export function effectiveRetentionMs(manifest: ReconciliationManifest, policy: ReconciliationPolicy): number | null {
  const declared = manifest.idempotency?.retention_ms
  if (typeof declared !== 'number' || !Number.isFinite(declared) || declared <= 0) return null
  return policy.retention_cap_ms === undefined ? declared : Math.min(declared, policy.retention_cap_ms)
}

export function insideRetention(nowMs: number, firstDispatchMs: number, retentionMs: number | null, timeoutMs: number, maxSkewMs: number): boolean {
  return retentionMs !== null && nowMs + timeoutMs + 2 * maxSkewMs <= firstDispatchMs + retentionMs
}

/**
 * May an `unknown` operation be retried with an effect-producing request now? Only before the admission
 * deadline (the v0 rule) and while the provider is known to remember the key. An executor that declares
 * no retention gets no effect-producing retry of an unknown operation: it goes to reconciliation.
 * The v1 runtime must evaluate this inside claimDispatch's transaction, as it does the deadline.
 */
export function retryAllowed(p: { nowMs: number; validUntilMs: number | null; firstDispatchMs: number; retentionMs: number | null; executeTimeoutMs: number; maxSkewMs: number }): boolean {
  if (p.validUntilMs !== null && p.nowMs > p.validUntilMs) return false
  return insideRetention(p.nowMs, p.firstDispatchMs, p.retentionMs, p.executeTimeoutMs, p.maxSkewMs)
}

export type Decision =
  | { kind: 'confirm' }
  | { kind: 'close_absent' }
  | { kind: 'stay_unknown'; reason: string }

/**
 * The candidate rule for what one lookup result concludes. Pure: every input is passed in.
 * A confirmation is positive evidence of the effect and always wins, trusted or not, because
 * treating an existing effect as absent is the failure this rule exists to prevent.
 */
export function decide(r: ReconcileResult, c: { policy: ReconciliationPolicy; lookupInsideRetention: boolean; attemptInFlight: boolean }): Decision {
  if (r.outcome === 'provider_confirmed') return { kind: 'confirm' }
  if (r.outcome !== 'absent') return { kind: 'stay_unknown', reason: r.reason ? `lookup_unknown:${r.reason}` : 'lookup_unknown' }
  const t = c.policy.trust
  if (!t || !t.lookup_complete || !t.accepts_key_finality) return { kind: 'stay_unknown', reason: 'absent_not_trusted' }
  if (!r.authoritative) return { kind: 'stay_unknown', reason: 'absent_not_authoritative' }
  if (!r.scope || r.scope.provider_account !== t.provider_account || r.scope.key_namespace !== t.key_namespace) {
    return { kind: 'stay_unknown', reason: 'absent_scope_mismatch' }
  }
  // An absence now is not an absence later: a request sent earlier may still settle. Only a provider
  // guarantee that covers every request with the key closes the operation.
  if (r.final !== true || r.final_scope !== 'key') return { kind: 'stay_unknown', reason: 'absent_not_final' }
  if (!c.lookupInsideRetention) return { kind: 'stay_unknown', reason: 'absent_outside_retention' }
  if (c.attemptInFlight) return { kind: 'stay_unknown', reason: 'attempt_in_flight' }
  return { kind: 'close_absent' }
}

/** The rule this candidate replaces, kept only so the tests can show the case it gets wrong. */
export function naiveDecide(r: ReconcileResult): Decision {
  if (r.outcome === 'provider_confirmed') return { kind: 'confirm' }
  if (r.outcome === 'absent' && r.authoritative) return { kind: 'close_absent' }
  return { kind: 'stay_unknown', reason: 'naive' }
}

// ── Durable reconciliation state ───────────────────────────────────────────

export type ReconciliationStatus = 'pending' | 'operator_required' | 'resolved_confirmed' | 'resolved_absent' | 'operator_resolved'

export interface ReconciliationRow {
  operation_id: string
  status: ReconciliationStatus
  status_reason: string | null
  lookups: number
  lookup_budget: number
  policy_digest: string
  updated_at: string
}

export interface ReconcileOutcome {
  operation_id: string
  state: OperationRow['state'] | 'not_admitted'
  status: ReconciliationStatus | 'not_applicable'
  reason?: string
  looked_up: boolean
}

export const RECONCILIATION_SCHEMA = 'federation-port/reconciliation-candidate/v1'

/** The stored budget is authoritative; a policy can only tighten it, never raise or reset it. */
export const lookupBudget = (rec: { lookup_budget: number }, policy: ReconciliationPolicy) => Math.min(rec.lookup_budget, policy.lookup_budget)

const sha256 = (b: Uint8Array) => 'sha256:' + createHash('sha256').update(b).digest('hex')

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> => {
  let t: NodeJS.Timeout
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error('timeout:reconcile')), ms) })])
    .finally(() => clearTimeout(t))
}

type ReconcilingAdapter = { reconcile?: (q: ReconcileQuery) => Promise<ReconcileResult> }

export class Reconciler {
  private readonly rt: Runtime
  private readonly policies: Record<string, ReconciliationPolicy>
  private readonly store: Store
  private readonly clock: () => Date

  constructor(rt: Runtime, policies: Record<string, ReconciliationPolicy>, clock?: () => Date) {
    this.rt = rt
    this.policies = policies
    this.store = rt.store
    this.clock = clock ?? (() => new Date())
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS reconciliation (
        operation_id TEXT PRIMARY KEY, status TEXT NOT NULL, status_reason TEXT, lookups INTEGER NOT NULL,
        lookup_budget INTEGER NOT NULL, policy_digest TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reconciliation_lookups (
        operation_id TEXT NOT NULL, seq INTEGER NOT NULL, started_at TEXT NOT NULL, ended_at TEXT,
        outcome TEXT, authoritative INTEGER, final INTEGER, decision TEXT, reason TEXT, provider_ref TEXT,
        settled_at TEXT, evidence_digest TEXT, PRIMARY KEY (operation_id, seq));
      CREATE TABLE IF NOT EXISTS reconciliation_events (
        operation_id TEXT NOT NULL, seq INTEGER NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL,
        PRIMARY KEY (operation_id, seq));
    `)
  }

  private policyFor(row: OperationRow): { policy: ReconciliationPolicy; executor: string; timeoutMs: number } {
    const wf = this.rt.policy.workflows[row.workflow]
    const policy = this.policies[wf.executor]
    if (!policy) throw new Error(`reconciliation_policy_missing:${wf.executor}`)
    return { policy, executor: wf.executor, timeoutMs: wf.execute_timeout_ms }
  }

  private retentionFor(executor: string, policy: ReconciliationPolicy): number | null {
    const manifest = this.rt.component(executor)!.manifest as unknown as ReconciliationManifest
    return effectiveRetentionMs(manifest, policy)
  }

  private firstDispatchMs(opId: string): number {
    const a = this.store.attempts(opId)[0] as { started_at: string }
    return Date.parse(a.started_at)
  }

  reconciliation(opId: string): ReconciliationRow | undefined {
    return this.store.db.prepare('SELECT * FROM reconciliation WHERE operation_id = ?').get(opId) as unknown as ReconciliationRow | undefined
  }

  private event(opId: string, at: string, kind: string, detail: Record<string, unknown>): void {
    const n = (this.store.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM reconciliation_events WHERE operation_id = ?').get(opId) as { n: number }).n
    this.store.db.prepare('INSERT INTO reconciliation_events VALUES (?, ?, ?, ?, ?)').run(opId, n, at, kind, JSON.stringify(detail))
  }

  private setStatus(opId: string, status: ReconciliationStatus, reason: string | null, at: string): void {
    this.store.db.prepare('UPDATE reconciliation SET status = ?, status_reason = ?, updated_at = ? WHERE operation_id = ?').run(status, reason, at, opId)
  }

  /**
   * Is an operation's latest attempt still running under a live lease? Then it may still settle and
   * report, and no absence can close it.
   */
  private inFlight(row: OperationRow, nowMs: number): boolean {
    return row.state === 'dispatched' && row.lease_until > nowMs
  }

  /**
   * One reconciliation step for one operation. Read-only at the provider. Safe to call from several
   * workers at once: the lookup is reserved (and counted against the budget) in a transaction before
   * the provider is asked, and its result is applied in another one against a fresh read of the row.
   */
  async reconcile(opId: string): Promise<ReconcileOutcome> {
    const reserved = this.store.tx(() => this.reserve(opId))
    if (reserved.kind === 'done') return reserved.outcome
    const { row, policy, executor, seq } = reserved
    const exec = this.rt.component(executor)!.adapter as unknown as ReconcilingAdapter
    let result: ReconcileResult
    try {
      result = await withTimeout(exec.reconcile!({ operation_id: opId, idempotency_key: opId, action_digest: row.action_digest, attempts: row.attempts }), policy.lookup_timeout_ms)
      if (!result || !(result.evidence instanceof Uint8Array) || !['provider_confirmed', 'absent', 'unknown'].includes(result.outcome)) {
        result = { outcome: 'unknown', authoritative: false, reason: 'adapter_protocol_violation', evidence: new Uint8Array() }
      }
    } catch (e) {
      result = { outcome: 'unknown', authoritative: false, reason: (e as Error).message.slice(0, 120), evidence: new Uint8Array() }
    }
    return this.store.tx(() => this.apply(opId, seq, result))
  }

  private reserve(opId: string):
    | { kind: 'done'; outcome: ReconcileOutcome }
    | { kind: 'lookup'; row: OperationRow; policy: ReconciliationPolicy; executor: string; seq: number } {
    const nowMs = this.clock().getTime()
    const at = new Date(nowMs).toISOString()
    const row = this.store.getOperation(opId)
    if (!row) return { kind: 'done', outcome: { operation_id: opId, state: 'not_admitted', status: 'not_applicable', looked_up: false } }
    const { policy, executor } = this.policyFor(row)
    let rec = this.reconciliation(opId)
    const resolvedAbsent = rec?.status === 'resolved_absent'
    // A late attempt confirmed an operation this reconciler had closed as absent: the confirmation
    // stands (v0 finishAttempt lets it), and the contradiction is recorded once.
    if (row.state === 'provider_confirmed' && resolvedAbsent) {
      this.event(opId, at, 'absence_contradicted', { source: 'attempt', provider_ref: row.provider_ref })
      this.setStatus(opId, 'resolved_confirmed', null, at)
      return { kind: 'done', outcome: { operation_id: opId, state: row.state, status: 'resolved_confirmed', looked_up: false } }
    }
    // Confirmed operations and closed failures need nothing; a closed absence is rechecked (read-only)
    // so that a contradicting confirmation is found and wins.
    if (row.state === 'provider_confirmed' || (row.state === 'failed' && !resolvedAbsent)) {
      return { kind: 'done', outcome: { operation_id: opId, state: row.state, status: rec?.status ?? 'not_applicable', looked_up: false } }
    }
    if (this.inFlight(row, nowMs)) {
      return { kind: 'done', outcome: { operation_id: opId, state: row.state, status: rec?.status ?? 'not_applicable', reason: 'attempt_in_flight', looked_up: false } }
    }
    if (!rec) {
      this.store.db.prepare('INSERT INTO reconciliation VALUES (?, ?, NULL, 0, ?, ?, ?)')
        .run(opId, 'pending', policy.lookup_budget, digestJson(policy), at)
      rec = this.reconciliation(opId)!
    }
    if (rec.status === 'operator_required' || rec.status === 'operator_resolved') {
      return { kind: 'done', outcome: { operation_id: opId, state: row.state, status: rec.status, reason: rec.status_reason ?? undefined, looked_up: false } }
    }
    const budget = lookupBudget(rec, policy)
    const required = (reason: string) => {
      if (!resolvedAbsent) { this.setStatus(opId, 'operator_required', reason, at); this.event(opId, at, 'operator_required', { reason }) }
      return { kind: 'done' as const, outcome: { operation_id: opId, state: row.state, status: resolvedAbsent ? 'resolved_absent' as const : 'operator_required' as const, reason, looked_up: false } }
    }
    const exec = this.rt.component(executor)!.adapter as unknown as ReconcilingAdapter
    if (typeof exec.reconcile !== 'function') return required('no_reconcile')
    const retention = this.retentionFor(executor, policy)
    if (!insideRetention(nowMs, this.firstDispatchMs(opId), retention, policy.lookup_timeout_ms, policy.max_skew_ms)) return required('retention_passed')
    if (rec.lookups >= budget) return required('budget_exhausted')
    const seq = rec.lookups
    this.store.db.prepare('UPDATE reconciliation SET lookups = lookups + 1, updated_at = ? WHERE operation_id = ?').run(at, opId)
    this.store.db.prepare('INSERT INTO reconciliation_lookups (operation_id, seq, started_at) VALUES (?, ?, ?)').run(opId, seq, at)
    return { kind: 'lookup', row, policy, executor, seq }
  }

  private apply(opId: string, seq: number, r: ReconcileResult): ReconcileOutcome {
    const nowMs = this.clock().getTime()
    const at = new Date(nowMs).toISOString()
    const row = this.store.getOperation(opId)!
    const { policy, executor } = this.policyFor(row)
    const rec = this.reconciliation(opId)!
    const retention = this.retentionFor(executor, policy)
    // The lookup started inside the window (reserve checked it); it has to have reached the provider
    // inside it as well, which T3 bounds by lookup_timeout_ms from the reservation.
    const started = Date.parse((this.store.db.prepare('SELECT started_at FROM reconciliation_lookups WHERE operation_id = ? AND seq = ?').get(opId, seq) as { started_at: string }).started_at)
    const lookupInsideRetention = insideRetention(started, this.firstDispatchMs(opId), retention, policy.lookup_timeout_ms, policy.max_skew_ms)
    const d = decide(r, { policy, lookupInsideRetention, attemptInFlight: this.inFlight(row, nowMs) })
    const evidenceDigest = sha256(r.evidence)
    this.store.db.prepare(`INSERT OR REPLACE INTO evidence VALUES (?, ?, ?, ?, ?)`).run(opId, executor, `reconcile:${seq}`, evidenceDigest, r.evidence)
    this.store.db.prepare(`UPDATE reconciliation_lookups SET ended_at = ?, outcome = ?, authoritative = ?, final = ?, decision = ?, reason = ?,
      provider_ref = ?, settled_at = ?, evidence_digest = ? WHERE operation_id = ? AND seq = ?`)
      .run(at, r.outcome, r.authoritative ? 1 : 0, r.final ? 1 : 0, d.kind, d.kind === 'stay_unknown' ? d.reason : null,
        r.provider_ref ?? null, r.settled_at ?? null, evidenceDigest, opId, seq)

    if (d.kind === 'confirm') {
      // A confirmation wins over every other state, including an absence this reconciler closed.
      if (row.state !== 'provider_confirmed') {
        if (rec.status === 'resolved_absent') this.event(opId, at, 'absence_contradicted', { source: 'lookup', lookup: seq, provider_ref: r.provider_ref ?? null })
        else if (row.state === 'failed') this.event(opId, at, 'failure_contradicted', { lookup: seq, provider_ref: r.provider_ref ?? null })
        this.store.db.prepare(`UPDATE operations SET state = 'provider_confirmed', retriable = 0, lease_until = 0, provider_ref = ?, updated_at = ? WHERE operation_id = ?`)
          .run(r.provider_ref ?? null, at, opId)
      }
      // Dispatch after expiry and an effect after expiry are different facts. The runtime prevents the
      // first; the second happens when a request sent before the deadline settles after it.
      const settledMs = r.settled_at !== undefined ? Date.parse(r.settled_at) : NaN
      if (row.valid_until_ms !== null && Number.isFinite(settledMs) && settledMs > row.valid_until_ms) {
        const lastDispatch = (this.store.attempts(opId) as { started_at: string }[]).map(x => Date.parse(x.started_at)).reduce((a, b) => Math.max(a, b), 0)
        this.event(opId, at, 'effect_after_expiry', {
          valid_until: new Date(row.valid_until_ms).toISOString(), settled_at: r.settled_at,
          last_dispatch_at: new Date(lastDispatch).toISOString(), dispatched_before_expiry: lastDispatch <= row.valid_until_ms,
        })
      }
      this.setStatus(opId, 'resolved_confirmed', null, at)
      return { operation_id: opId, state: 'provider_confirmed', status: 'resolved_confirmed', looked_up: true }
    }
    if (d.kind === 'close_absent' && rec.status !== 'resolved_absent') {
      // Only an operation the runtime itself holds as unknown closes. A dispatched row whose worker
      // died is left to the runtime's own transition first.
      if (row.state === 'unknown') {
        this.store.db.prepare(`UPDATE operations SET state = 'failed', retriable = 0, lease_until = 0, updated_at = ? WHERE operation_id = ?`).run(at, opId)
        this.event(opId, at, 'reconciled_absent', { lookup: seq, evidence: evidenceDigest })
        this.setStatus(opId, 'resolved_absent', null, at)
        return { operation_id: opId, state: 'failed', status: 'resolved_absent', reason: 'reconciled_absent', looked_up: true }
      }
    }
    const current = this.reconciliation(opId)!
    const reason = d.kind === 'stay_unknown' ? d.reason : undefined
    if (current.status === 'pending' && current.lookups >= lookupBudget(current, policy)) {
      this.setStatus(opId, 'operator_required', 'budget_exhausted', at)
      this.event(opId, at, 'operator_required', { reason: 'budget_exhausted' })
      return { operation_id: opId, state: row.state, status: 'operator_required', reason: 'budget_exhausted', looked_up: true }
    }
    return { operation_id: opId, state: this.store.getOperation(opId)!.state, status: current.status, ...(reason ? { reason } : {}), looked_up: true }
  }

  /**
   * One pass over every operation that is unknown, or was closed absent by this reconciler and is
   * still inside its retention window. This is the runtime-driven sweep: an operation reaches a
   * resolution or `operator_required` without a caller resubmitting it, provided the sweep runs (S1).
   */
  async sweep(): Promise<ReconcileOutcome[]> {
    const ids = (this.store.db.prepare(`SELECT o.operation_id FROM operations o LEFT JOIN reconciliation r ON r.operation_id = o.operation_id
      WHERE (o.state = 'unknown' OR (o.state = 'dispatched' AND o.lease_until <= ?) OR r.status = 'resolved_absent')
        AND COALESCE(r.status, 'pending') NOT IN ('operator_required', 'operator_resolved')
      ORDER BY o.operation_id`).all(this.clock().getTime()) as { operation_id: string }[]).map(r => r.operation_id)
    const out: ReconcileOutcome[] = []
    for (const id of ids) out.push(await this.reconcile(id))
    return out
  }

  /**
   * Record an operator's decision on an operation that needs one. It is its own provenance entry with
   * its evidence; the effect state and the attempt rows are not rewritten, because the operator's
   * conclusion is a separate fact from what the provider reported.
   */
  recordOperatorDecision(opId: string, d: { operator: string; conclusion: 'effect_exists' | 'no_effect'; note?: string; evidence: Uint8Array }): ReconciliationRow {
    return this.store.tx(() => {
      const at = this.clock().toISOString()
      const rec = this.reconciliation(opId)
      if (!rec || rec.status !== 'operator_required') throw new Error('operator_decision_not_required')
      const row = this.store.getOperation(opId)!
      const digest = sha256(d.evidence)
      this.store.db.prepare('INSERT OR REPLACE INTO evidence VALUES (?, ?, ?, ?, ?)').run(opId, `operator:${d.operator}`, `operator_decision:${rec.lookups}`, digest, d.evidence)
      this.event(opId, at, 'operator_decision', { operator: d.operator, conclusion: d.conclusion, note: (d.note ?? '').slice(0, 120), evidence: digest, effect_state: row.state })
      this.setStatus(opId, 'operator_resolved', d.conclusion, at)
      return this.reconciliation(opId)!
    })
  }

  provenance(opId: string): Record<string, unknown> {
    return {
      schema: RECONCILIATION_SCHEMA,
      operation: this.rt.provenance(opId),
      reconciliation: this.reconciliation(opId) ?? null,
      lookups: this.store.db.prepare('SELECT * FROM reconciliation_lookups WHERE operation_id = ? ORDER BY seq').all(opId),
      events: (this.store.db.prepare('SELECT seq, at, kind, detail FROM reconciliation_events WHERE operation_id = ? ORDER BY seq').all(opId) as { detail: string }[])
        .map(e => ({ ...e, detail: JSON.parse(e.detail) })),
    }
  }
}

/**
 * Stand-in for the v1 retry rule while it is not inside claimDispatch: a resubmission of an `unknown`
 * operation is dispatched only when `retryAllowed` holds; otherwise it is reconciled read-only.
 * Checked outside the claim's transaction, so it is a demonstration of the rule, not an enforcement of it.
 */
export async function submitWithReconciliation(rt: Runtime, rec: Reconciler, policies: Record<string, ReconciliationPolicy>, req: SubmitRequest, clock: () => Date):
  Promise<SubmitResult | (ReconcileOutcome & { status_kind: 'reconciled' })> {
  const row = rt.store.getOperation(req.operation_id)
  if (row && (row.state === 'unknown' || (row.state === 'dispatched' && row.lease_until <= clock().getTime()))) {
    const wf = rt.policy.workflows[row.workflow]
    const policy = policies[wf.executor]
    const manifest = rt.component(wf.executor)!.manifest as unknown as ReconciliationManifest
    const first = Date.parse((rt.store.attempts(row.operation_id)[0] as { started_at: string }).started_at)
    const ok = retryAllowed({ nowMs: clock().getTime(), validUntilMs: row.valid_until_ms, firstDispatchMs: first,
      retentionMs: effectiveRetentionMs(manifest, policy), executeTimeoutMs: wf.execute_timeout_ms, maxSkewMs: policy.max_skew_ms })
    if (!ok) return { ...(await rec.reconcile(row.operation_id)), status_kind: 'reconciled' }
  }
  return rt.submit(req)
}

import { DatabaseSync } from 'node:sqlite'
import { canonicalJson, digestJson, sha256 } from './canonical.ts'

// No separate `authorized` state: admission and the first dispatch claim commit in one transaction.
export type OperationState = 'dispatched' | 'provider_confirmed' | 'failed' | 'unknown'

/** Digests and identifiers only; see Runtime.executionContext. */
export interface ExecutionContext {
  policy_id: string
  workflow: string
  workflow_digest: string
  components: { id: string; version: string; manifest_digest: string; artifact_digest: string; config_digest: string }[]
}

export interface OperationRow {
  operation_id: string
  workflow: string
  tenant: string | null
  policy_id: string
  /** ExecutionContext as canonical JSON, and its digest. */
  context: string
  context_digest: string
  approval_id: string | null
  action_digest: string
  state: OperationState
  retriable: number
  attempts: number
  lease_until: number
  provider_ref: string | null
  /** Admission deadline in ms since epoch, or null when no component reported one. */
  valid_until_ms: number | null
}

export interface ClaimRecord {
  component: string
  claim: string
  requirement: 'required' | 'optional'
  status: string
  reason?: string
}

export interface AdmissionRecord {
  at: string
  decision: 'admitted' | 'refused'
  reasons: string[]
  components: { id: string; version: string; role: string; manifest_digest: string; artifact_digest: string }[]
  claims: ClaimRecord[]
  evidence: { component: string; digest: string }[]
}

export type DispatchClaim =
  | { kind: 'dispatch'; attempt: number; row: OperationRow }
  | { kind: 'confirmed'; row: OperationRow }
  | { kind: 'in_flight'; row: OperationRow }
  | { kind: 'terminal_failed'; row: OperationRow }
  | { kind: 'expired'; row: OperationRow }

/** Bumped whenever a table changes shape. Older store files are refused, not migrated. */
export const STORE_SCHEMA_VERSION = 3

/**
 * Durable state in one SQLite file. All state transitions run inside BEGIN IMMEDIATE.
 * Every recorded instant comes from `clock`, read inside the transaction that writes it.
 */
export class Store {
  readonly db: DatabaseSync
  private readonly clock: () => Date

  constructor(path: string, clock: () => Date = () => new Date()) {
    this.clock = clock
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 10000;')
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    const hasTables = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'operations'").get() !== undefined
    if (hasTables && version !== STORE_SCHEMA_VERSION) {
      this.db.close()
      throw new Error(`store_schema_unsupported:${version}`)
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        approval_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, consumed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (
        operation_id TEXT PRIMARY KEY, workflow TEXT NOT NULL, tenant TEXT, policy_id TEXT NOT NULL,
        context TEXT NOT NULL, context_digest TEXT NOT NULL, approval_id TEXT, action_digest TEXT NOT NULL,
        state TEXT NOT NULL, retriable INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
        lease_until INTEGER NOT NULL DEFAULT 0, provider_ref TEXT, valid_until_ms INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (
        operation_id TEXT NOT NULL, attempt INTEGER NOT NULL, component TEXT NOT NULL, started_at TEXT NOT NULL,
        ended_at TEXT, outcome TEXT, retriable INTEGER, provider_ref TEXT, reason TEXT,
        PRIMARY KEY (operation_id, attempt));
      CREATE TABLE IF NOT EXISTS admissions (
        operation_id TEXT NOT NULL, seq INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY (operation_id, seq));
      CREATE TABLE IF NOT EXISTS usage (
        operation_id TEXT NOT NULL, component TEXT NOT NULL, version TEXT NOT NULL, role TEXT NOT NULL,
        calls INTEGER NOT NULL, outcome TEXT NOT NULL, first_at TEXT NOT NULL, last_at TEXT NOT NULL,
        PRIMARY KEY (operation_id, component));
      CREATE TABLE IF NOT EXISTS evidence (
        operation_id TEXT NOT NULL, component TEXT NOT NULL, ref TEXT NOT NULL, digest TEXT NOT NULL, bytes BLOB NOT NULL,
        PRIMARY KEY (operation_id, component, ref));
      PRAGMA user_version = ${STORE_SCHEMA_VERSION};
    `)
  }

  close(): void { if (this.db.isOpen) this.db.close() }

  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  getOperation(id: string): OperationRow | undefined {
    return this.db.prepare('SELECT * FROM operations WHERE operation_id = ?').get(id) as unknown as OperationRow | undefined
  }

  approvalConsumedBy(approvalId: string): string | undefined {
    const r = this.db.prepare('SELECT operation_id FROM approvals WHERE approval_id = ?').get(approvalId) as { operation_id: string } | undefined
    return r?.operation_id
  }

  private nextSeq(opId: string): number {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM admissions WHERE operation_id = ?').get(opId) as { n: number }
    return r.n
  }

  private putEvidence(opId: string, component: string, ref: string, bytes: Uint8Array): string {
    const digest = sha256(bytes)
    this.db.prepare('INSERT OR REPLACE INTO evidence VALUES (?, ?, ?, ?, ?)').run(opId, component, ref, digest, bytes)
    return digest
  }

  bumpUsage(opId: string, component: string, version: string, role: string, outcome: string, at: string): void {
    this.db.prepare(`INSERT INTO usage VALUES (?, ?, ?, ?, 1, ?, ?, ?)
      ON CONFLICT (operation_id, component) DO UPDATE SET calls = calls + 1, outcome = excluded.outcome, last_at = excluded.last_at`)
      .run(opId, component, version, role, outcome, at, at)
  }

  /** Record a refused admission. Nothing is consumed and no operation row is created. */
  recordRefusal(opId: string, rec: Omit<AdmissionRecord, 'evidence'>, evidence: Map<string, Uint8Array>,
    checkers: { id: string; version: string; role: string }[]): AdmissionRecord {
    return this.tx(() => this.appendAdmission(opId, rec, evidence, checkers))
  }

  private appendAdmission(opId: string, rec: Omit<AdmissionRecord, 'evidence'>, evidence: Map<string, Uint8Array>,
    checkers: { id: string; version: string; role: string }[]): AdmissionRecord {
    const seq = this.nextSeq(opId)
    const ev = [...evidence].map(([component, bytes]) => ({ component, digest: this.putEvidence(opId, component, `check:${seq}`, bytes) }))
    const full: AdmissionRecord = { ...rec, evidence: ev }
    this.db.prepare('INSERT INTO admissions VALUES (?, ?, ?)').run(opId, seq, JSON.stringify(full))
    for (const c of checkers) this.bumpUsage(opId, c.id, c.version, c.role, 'evaluated', rec.at)
    return full
  }

  /**
   * Single transaction, entered before the clock is read: so a wait on another writer's lock
   * counts against the deadline. Checks `valid_until_ms` against that fresh instant (inclusive),
   * consumes the approval, creates the operation and claims attempt 1 for `executor`. Every time
   * it records is that instant. Returns a conflict instead of throwing.
   */
  admit(op: { operation_id: string; workflow: string; tenant: string | null; approval_id: string | null; action_digest: string;
    valid_until_ms: number | null; context: ExecutionContext },
    rec: Omit<AdmissionRecord, 'evidence'>, evidence: Map<string, Uint8Array>,
    checkers: { id: string; version: string; role: string }[], executor: string, leaseMs: number):
    { ok: true; attempt: 1; at: string } | { ok: false; conflict: 'approval_already_consumed' | 'operation_exists' | 'approval_expired_at_admission' } {
    return this.tx(() => {
      const nowMs = this.clock().getTime()
      const at = new Date(nowMs).toISOString()
      if (this.getOperation(op.operation_id)) return { ok: false as const, conflict: 'operation_exists' as const }
      const refuse = (conflict: 'approval_already_consumed' | 'approval_expired_at_admission') => {
        this.appendAdmission(op.operation_id, { ...rec, at, decision: 'refused', reasons: [conflict] }, evidence, checkers)
        return { ok: false as const, conflict }
      }
      if (op.valid_until_ms !== null && nowMs > op.valid_until_ms) return refuse('approval_expired_at_admission')
      if (op.approval_id !== null) {
        if (this.approvalConsumedBy(op.approval_id) !== undefined) return refuse('approval_already_consumed')
        this.db.prepare('INSERT INTO approvals VALUES (?, ?, ?)').run(op.approval_id, op.operation_id, at)
      }
      this.db.prepare(`INSERT INTO operations (operation_id, workflow, tenant, policy_id, context, context_digest, approval_id, action_digest,
        state, attempts, lease_until, valid_until_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'dispatched', 1, ?, ?, ?, ?)`)
        .run(op.operation_id, op.workflow, op.tenant, op.context.policy_id, canonicalJson(op.context), digestJson(op.context),
          op.approval_id, op.action_digest, nowMs + leaseMs, op.valid_until_ms, at, at)
      this.db.prepare('INSERT INTO attempts (operation_id, attempt, component, started_at) VALUES (?, 1, ?, ?)').run(op.operation_id, executor, at)
      this.appendAdmission(op.operation_id, { ...rec, at }, evidence, checkers)
      return { ok: true as const, attempt: 1 as const, at }
    })
  }

  /**
   * Decide, under lock and against a clock read inside the lock, whether this caller may dispatch
   * a retry now. Past the admission deadline, a retriable failure (the provider reported no side
   * effect) is closed instead of dispatched: that would be a first side effect after expiry.
   * An unknown outcome is still retried with the same idempotency key, to resolve it.
   */
  claimDispatch(opId: string, component: string, leaseMs: number): DispatchClaim {
    return this.tx(() => {
      const nowMs = this.clock().getTime()
      const row = this.getOperation(opId)
      if (!row) throw new Error(`operation_missing:${opId}`)
      if (row.state === 'provider_confirmed') return { kind: 'confirmed', row }
      if (row.state === 'failed' && !row.retriable) return { kind: 'terminal_failed', row }
      if (row.state === 'dispatched' && row.lease_until > nowMs) return { kind: 'in_flight', row }
      const at = new Date(nowMs).toISOString()
      if (row.state === 'failed' && row.valid_until_ms !== null && nowMs > row.valid_until_ms) {
        this.db.prepare('UPDATE operations SET retriable = 0, updated_at = ? WHERE operation_id = ?').run(at, opId)
        return { kind: 'expired', row: { ...row, retriable: 0 } }
      }
      // unknown, retriable failed before the deadline, or dispatched with an expired lease (crashed worker).
      const attempt = row.attempts + 1
      this.db.prepare(`UPDATE operations SET state = 'dispatched', attempts = ?, lease_until = ?, updated_at = ? WHERE operation_id = ?`)
        .run(attempt, nowMs + leaseMs, at, opId)
      this.db.prepare('INSERT INTO attempts (operation_id, attempt, component, started_at) VALUES (?, ?, ?, ?)')
        .run(opId, attempt, component, at)
      return { kind: 'dispatch', attempt, row: { ...row, state: 'dispatched', attempts: attempt } }
    })
  }

  finishAttempt(opId: string, attempt: number, r: { outcome: 'provider_confirmed' | 'failed' | 'unknown'; retriable: boolean;
    provider_ref?: string; reason?: string; evidence: Uint8Array }, executor: { id: string; version: string; role: string }): OperationRow {
    return this.tx(() => {
      const at = this.clock().toISOString()
      this.putEvidence(opId, executor.id, `execute:${attempt}`, r.evidence)
      this.db.prepare('UPDATE attempts SET ended_at = ?, outcome = ?, retriable = ?, provider_ref = ?, reason = ? WHERE operation_id = ? AND attempt = ?')
        .run(at, r.outcome, r.retriable ? 1 : 0, r.provider_ref ?? null, r.reason ?? null, opId, attempt)
      const row = this.getOperation(opId)!
      // A later attempt or a confirmation already recorded wins over a stale result.
      if (row.state !== 'provider_confirmed' && row.attempts === attempt) {
        this.db.prepare('UPDATE operations SET state = ?, retriable = ?, lease_until = 0, provider_ref = ?, updated_at = ? WHERE operation_id = ?')
          .run(r.outcome, r.retriable ? 1 : 0, r.provider_ref ?? null, at, opId)
      }
      const final = this.getOperation(opId)!
      // One usage row per component per logical operation; calls counts attempts, outcome is the operation state.
      this.bumpUsage(opId, executor.id, executor.version, executor.role, final.state, at)
      return final
    })
  }

  admissions(opId: string): AdmissionRecord[] {
    return (this.db.prepare('SELECT record FROM admissions WHERE operation_id = ? ORDER BY seq').all(opId) as { record: string }[])
      .map(r => JSON.parse(r.record))
  }

  attempts(opId: string): Record<string, unknown>[] {
    return this.db.prepare('SELECT attempt, component, started_at, ended_at, outcome, retriable, provider_ref, reason FROM attempts WHERE operation_id = ? ORDER BY attempt').all(opId) as Record<string, unknown>[]
  }

  usage(opId?: string): Record<string, unknown>[] {
    return (opId
      ? this.db.prepare('SELECT * FROM usage WHERE operation_id = ? ORDER BY component').all(opId)
      : this.db.prepare('SELECT * FROM usage ORDER BY operation_id, component').all()) as Record<string, unknown>[]
  }

  evidence(opId: string, component: string, ref: string): Uint8Array | undefined {
    const r = this.db.prepare('SELECT bytes FROM evidence WHERE operation_id = ? AND component = ? AND ref = ?').get(opId, component, ref) as { bytes: Uint8Array } | undefined
    return r?.bytes
  }

  countDispatches(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM attempts').get() as { n: number }).n
  }
}

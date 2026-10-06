// Local stateful execution endpoint for the refund-execution/0.1 envelope profile. Test-only.
// Field names follow a draft public contract text. Implementation-neutral: this is not any
// other project's execution service. Binds 127.0.0.1 on an ephemeral port.
//
// Semantics:
// - The first accepted presentation of an operation_id binds it durably (SQLite) to the canonical
//   handoff. A later presentation with different material is refused with 409 and no result.
// - The provider idempotency key is derived from operation_id. At most one effect per key.
// - A duplicate delivery after the effect returns observed_success with the same effect_ref.
// - Every delivery and reconciliation gets an operation-scoped attempt_id.
// - Faults: pre-dispatch failure (observed_failure, no effect), response lost after a committed
//   effect, unresolved after a committed effect, and two result corruptions used by the tests.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'

export const HANDOFF_SCHEMA = 'refund-execution/0.1'
export const RESULT_SCHEMA = 'refund-execution-result/0.1'

export type SimFault =
  | { mode: 'none' }
  | { mode: 'pre_dispatch_failure'; count: number }
  | { mode: 'drop_after_commit'; count: number }
  | { mode: 'unresolved_after_commit'; count: number }
  | { mode: 'wrong_arguments_digest'; count: number }
  | { mode: 'wrong_operation_id'; count: number }

export interface RefundArguments { payment_id: string; currency: string; amount_minor: number }
export interface Effect { effect_ref: string; operation_id: string; idempotency_key: string; payment_id: string; currency: string; amount_minor: number }

export interface ExecutionSimulator {
  url: string
  dbPath: string
  effects(): Effect[]
  /** Deliveries to /execute that reached the handler, including duplicates and refusals. */
  executeRequests: number
  reconcileRequests: number
  /** Deliveries that found an existing effect and created none. */
  duplicatesSuppressed: number
  /** Exact response bytes sent, in order, for results that were sent. */
  sent: { path: string; bytes: Uint8Array }[]
  setFault(f: SimFault): void
  close(): Promise<void>
}

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}'
}
const sha = (s: string) => 'sha256:' + createHash('sha256').update(s).digest('hex')
/** Digest of the admitted tuple: SHA-256 over sorted-key JSON of the three nested arguments. */
export const argumentsDigest = (a: RefundArguments) =>
  sha(canonical({ payment_id: a.payment_id, currency: a.currency, amount_minor: a.amount_minor }))
export const providerIdempotencyKey = (operationId: string) => 'idem_' + sha(`${HANDOFF_SCHEMA}\n${operationId}`).slice(7, 39)

const REF = /^[!-~]{1,256}$/

/** Returns the parsed handoff or an error code. Strict: exact keys, integer minor units. */
function parseHandoff(body: string): { ok: true; h: Record<string, unknown> & { operation_id: string; arguments: RefundArguments } } | { ok: false; error: string } {
  let h: any
  try { h = JSON.parse(body) } catch { return { ok: false, error: 'invalid_json' } }
  if (!h || typeof h !== 'object' || Array.isArray(h)) return { ok: false, error: 'handoff_not_object' }
  const keys = ['schema', 'operation_id', 'tool', 'arguments', 'approval_ref', 'pic_evidence_ref', 'aps_evidence_ref']
  if (Object.keys(h).sort().join() !== [...keys].sort().join()) return { ok: false, error: 'handoff_keys' }
  if (h.schema !== HANDOFF_SCHEMA) return { ok: false, error: 'handoff_schema' }
  if (h.tool !== 'refund') return { ok: false, error: 'handoff_tool' }
  for (const k of ['operation_id', 'approval_ref', 'pic_evidence_ref', 'aps_evidence_ref']) if (typeof h[k] !== 'string' || !REF.test(h[k])) return { ok: false, error: `handoff_${k}` }
  const a = h.arguments
  if (!a || typeof a !== 'object' || Object.keys(a).sort().join() !== 'amount_minor,currency,payment_id') return { ok: false, error: 'arguments_keys' }
  if (typeof a.payment_id !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(a.payment_id)) return { ok: false, error: 'arguments_payment_id' }
  if (typeof a.currency !== 'string' || !/^[A-Z]{3}$/.test(a.currency)) return { ok: false, error: 'arguments_currency' }
  if (!Number.isSafeInteger(a.amount_minor) || a.amount_minor < 1) return { ok: false, error: 'arguments_amount_minor' }
  return { ok: true, h }
}

export async function startExecutionSimulator(opts: { apiKey: string; dbPath: string; port?: number }): Promise<ExecutionSimulator> {
  const captured: Record<string, { captured_minor: number; currency: string }> = {
    pay_A: { captured_minor: 10000, currency: 'EUR' },
    pay_B: { captured_minor: 10000, currency: 'EUR' },
  }
  const db = new DatabaseSync(opts.dbPath)
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS bindings (operation_id TEXT PRIMARY KEY, binding_digest TEXT NOT NULL, arguments_digest TEXT NOT NULL,
      payment_id TEXT NOT NULL, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL, deliveries INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS effects (effect_ref TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, operation_id TEXT NOT NULL,
      payment_id TEXT NOT NULL, currency TEXT NOT NULL, amount_minor INTEGER NOT NULL);`)
  let fault: SimFault = { mode: 'none' }
  const state = { executeRequests: 0, reconcileRequests: 0, duplicatesSuppressed: 0, sent: [] as { path: string; bytes: Uint8Array }[] }

  const read = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
    let s = ''
    req.setEncoding('utf8').on('data', c => { s += c }).on('end', () => ok(s)).on('error', bad)
  })
  const sendJson = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const effectFor = (operationId: string) =>
    db.prepare('SELECT * FROM effects WHERE idempotency_key = ?').get(providerIdempotencyKey(operationId)) as unknown as Effect | undefined
  const nextAttempt = (operationId: string, kind: 'execute' | 'reconcile') => {
    db.prepare('UPDATE bindings SET deliveries = deliveries + 1 WHERE operation_id = ?').run(operationId)
    const n = (db.prepare('SELECT deliveries FROM bindings WHERE operation_id = ?').get(operationId) as { deliveries: number } | undefined)?.deliveries ?? 0
    return `${operationId}/${kind}/${n}`
  }
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE')
    try { const r = fn(); db.exec('COMMIT'); return r } catch (e) { db.exec('ROLLBACK'); throw e }
  }

  const server = createServer(async (req, res) => {
    const path = req.url ?? ''
    const isExec = path === '/refund-execution/0.1/execute'
    const isRec = path === '/refund-execution/0.1/reconcile'
    if (req.method !== 'POST' || (!isExec && !isRec)) return sendJson(res, 404, { error: 'not_found' })
    if (isExec) state.executeRequests++
    else state.reconcileRequests++
    const body = await read(req)
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) return sendJson(res, 401, { error: 'unauthorized' })
    const p = parseHandoff(body)
    if (!p.ok) return sendJson(res, 400, { error: p.error })
    const h = p.h
    const bindingDigest = sha(canonical(h))
    const argsDigest = argumentsDigest(h.arguments)

    const f = fault
    const take = () => { if (f.mode !== 'none' && --f.count <= 0) fault = { mode: 'none' } }

    // All state for one delivery is decided in one synchronous transaction.
    const outcome = tx(() => {
      const bound = db.prepare('SELECT * FROM bindings WHERE operation_id = ?').get(h.operation_id) as { binding_digest: string } | undefined
      if (bound && bound.binding_digest !== bindingDigest) return { conflict: true as const }
      if (isRec) {
        if (!bound) return { status: 'observed_failure' as const, effect: undefined, attempt_id: `${h.operation_id}/reconcile/0`, note: 'operation_never_presented' }
        const e = effectFor(h.operation_id)
        return { status: e ? 'observed_success' as const : 'observed_failure' as const, effect: e, attempt_id: nextAttempt(h.operation_id, 'reconcile'), note: e ? 'reconciled_existing_effect' : 'no_effect_recorded' }
      }
      if (!bound) {
        db.prepare('INSERT INTO bindings VALUES (?, ?, ?, ?, ?, ?, 0)')
          .run(h.operation_id, bindingDigest, argsDigest, h.arguments.payment_id, h.arguments.currency, h.arguments.amount_minor)
      }
      const attempt_id = nextAttempt(h.operation_id, 'execute')
      const prior = effectFor(h.operation_id)
      if (prior) { state.duplicatesSuppressed++; return { status: 'observed_success' as const, effect: prior, attempt_id, note: 'duplicate_delivery_suppressed' } }
      if (f.mode === 'pre_dispatch_failure') { take(); return { status: 'observed_failure' as const, effect: undefined, attempt_id, note: 'injected_pre_dispatch_failure' } }
      const pay = captured[h.arguments.payment_id]
      const already = (db.prepare('SELECT COALESCE(SUM(amount_minor), 0) AS s FROM effects WHERE payment_id = ?').get(h.arguments.payment_id) as { s: number }).s
      if (!pay || pay.currency !== h.arguments.currency || already + h.arguments.amount_minor > pay.captured_minor) {
        return { status: 'observed_failure' as const, effect: undefined, attempt_id, note: 'provider_rejected_before_effect' }
      }
      const effect: Effect = {
        effect_ref: 'eff_' + sha(`${providerIdempotencyKey(h.operation_id)}\n${argsDigest}`).slice(7, 31),
        operation_id: h.operation_id, idempotency_key: providerIdempotencyKey(h.operation_id), ...h.arguments,
      }
      db.prepare('INSERT INTO effects VALUES (?, ?, ?, ?, ?, ?)')
        .run(effect.effect_ref, effect.idempotency_key, effect.operation_id, effect.payment_id, effect.currency, effect.amount_minor)
      return { status: 'observed_success' as const, effect, attempt_id, note: 'effect_committed' }
    })
    if ('conflict' in outcome) return sendJson(res, 409, { error: 'operation_bound_to_different_material' })

    let status: 'observed_success' | 'observed_failure' | 'unresolved' = outcome.status
    let operation_id = h.operation_id
    let arguments_digest = argsDigest
    if (isExec && outcome.note === 'effect_committed') {
      if (f.mode === 'drop_after_commit') { take(); req.socket.destroy(); return }
      if (f.mode === 'unresolved_after_commit') { take(); status = 'unresolved' }
    }
    if (f.mode === 'wrong_arguments_digest') { take(); arguments_digest = sha('not-the-admitted-tuple') }
    if (f.mode === 'wrong_operation_id') { take(); operation_id = h.operation_id + '-other' }
    const result = {
      schema: RESULT_SCHEMA, operation_id, attempt_id: outcome.attempt_id, status,
      effect_ref: status === 'observed_failure' ? null : outcome.effect?.effect_ref ?? null,
      arguments_digest, observation_ref: `sim-observation:${outcome.attempt_id}:${outcome.note}`,
    }
    const bytes = Buffer.from(JSON.stringify(result))
    state.sent.push({ path, bytes: new Uint8Array(bytes) })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(bytes)
  })
  await new Promise<void>(ok => server.listen(opts.port ?? 0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    dbPath: opts.dbPath,
    effects: () => db.prepare('SELECT * FROM effects ORDER BY rowid').all() as unknown as Effect[],
    get executeRequests() { return state.executeRequests },
    get reconcileRequests() { return state.reconcileRequests },
    get duplicatesSuppressed() { return state.duplicatesSuppressed },
    get sent() { return state.sent },
    setFault(f) { fault = { ...f } },
    close: () => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => { db.close(); ok() }) }),
  }
}

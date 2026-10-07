import { CLAIM_STATUSES } from '../contract/types.ts'
import type { Action, CheckOutput, ClaimStatus, ExecuteOutput } from '../contract/types.ts'
import { canonicalJson, digestJson, sha256 } from './canonical.ts'
import { loadComponent, LoadError } from './loader.ts'
import type { LoadedComponent } from './loader.ts'
import type { ClaimRef, CustomerPolicy, WorkflowPolicy } from './policy.ts'
import { validate } from './schema.ts'
import { Store } from './store.ts'
import type { AdmissionRecord, ClaimRecord, ExecutionContext, OperationRow, OperationState } from './store.ts'

export interface SubmitRequest {
  workflow: string
  /** Logical operation id chosen by the caller. Reuse it to retry, with the same workflow, tenant, action and approval. */
  operation_id: string
  tenant?: string
  approval_id?: string
  action: Action
  /** Native evidence bytes, addressed by component id. Each component sees only its own entry. */
  evidence?: Record<string, Uint8Array>
}

export type SubmitResult =
  | { status: 'refused'; operation_id: string; reasons: string[]; claims: ClaimRecord[] }
  | { status: OperationState | 'in_flight'; operation_id: string; attempt?: number; provider_ref?: string | null; replayed?: boolean; reason?: string }

/** Runtime-side status. `unavailable` and `unevaluated` are assigned by the runtime, never by an adapter. */
export type RecordedStatus = ClaimStatus | 'unavailable' | 'unevaluated'

export interface RuntimeOptions {
  policy: CustomerPolicy
  dbPath: string
  /** Operator-provisioned secrets. Delivered only to components granted `secret:<name>`. */
  secrets?: Record<string, string>
  clock?: () => Date
}

const EXACT_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/** Milliseconds for an exact UTC millisecond instant, undefined for any other form (including impossible dates). */
export function parseExactInstant(v: unknown): number | undefined {
  if (typeof v !== 'string' || !EXACT_UTC_MS.test(v)) return undefined
  const ms = Date.parse(v)
  return Number.isFinite(ms) && new Date(ms).toISOString() === v ? ms : undefined
}

const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  let t: NodeJS.Timeout
  return Promise.race([p, new Promise<T>((_, rej) => { t = setTimeout(() => rej(new Error(`timeout:${label}`)), ms) })])
    .finally(() => clearTimeout(t))
}

// Byte arrays cannot be frozen; each adapter already receives its own copy of those.
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === 'object' && !ArrayBuffer.isView(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x) }
  return v
}

/**
 * Enforces the contract rule on one adapter's check output: native evidence must be bytes,
 * only claims declared in that component's manifest count, each with one of the four statuses.
 * A declared claim the adapter did not report becomes `unavailable`. Nothing here reads the
 * evidence bytes or copies a result from one component to another.
 */
export function normalizeCheckOutput(comp: LoadedComponent, out: unknown):
  { evidence?: Uint8Array; validUntilMs?: number; statuses: Map<string, { status: RecordedStatus; reason?: string }>; violations: string[] } {
  const declared = comp.manifest.claims.map(c => c.id)
  const statuses = new Map<string, { status: RecordedStatus; reason?: string }>()
  const violations: string[] = []
  const o = out as Partial<CheckOutput> | null
  if (!o || typeof o !== 'object' || !(o.evidence instanceof Uint8Array) || !Array.isArray(o.claims)) {
    for (const c of declared) statuses.set(c, { status: 'unavailable', reason: 'adapter_protocol_violation:shape' })
    return { statuses, violations: ['shape'] }
  }
  let validUntilMs: number | undefined
  if (o.valid_until !== undefined) {
    validUntilMs = parseExactInstant(o.valid_until)
    if (validUntilMs === undefined) {
      for (const c of declared) statuses.set(c, { status: 'unavailable', reason: 'adapter_protocol_violation:valid_until' })
      return { statuses, violations: ['valid_until'] }
    }
  }
  for (const r of o.claims) {
    if (!r || typeof r.claim !== 'string' || !declared.includes(r.claim)) { violations.push(`undeclared_claim:${String(r?.claim)}`); continue }
    if (!CLAIM_STATUSES.includes(r.status)) { violations.push(`invalid_status:${r.claim}`); statuses.set(r.claim, { status: 'unavailable', reason: 'adapter_protocol_violation:status' }); continue }
    if (statuses.has(r.claim)) { violations.push(`duplicate_claim:${r.claim}`); statuses.set(r.claim, { status: 'unavailable', reason: 'adapter_protocol_violation:duplicate' }); continue }
    statuses.set(r.claim, { status: r.status, ...(typeof r.reason === 'string' ? { reason: r.reason } : {}) })
  }
  for (const c of declared) if (!statuses.has(c)) statuses.set(c, { status: 'unavailable', reason: 'claim_not_reported' })
  return { evidence: o.evidence, ...(validUntilMs !== undefined ? { validUntilMs } : {}), statuses, violations }
}

export class Runtime {
  readonly store: Store
  private components = new Map<string, LoadedComponent>()
  private readonly clock: () => Date

  readonly policy: CustomerPolicy

  private constructor(policy: CustomerPolicy, dbPath: string, clock?: () => Date) {
    this.policy = policy
    this.clock = clock ?? (() => new Date())
    this.store = new Store(dbPath, this.clock)
  }

  /** Loads every pinned component. Any load refusal aborts startup. */
  static async create(opts: RuntimeOptions): Promise<Runtime> {
    const rt = new Runtime(opts.policy, opts.dbPath, opts.clock)
    try {
      for (const [id, pin] of Object.entries(opts.policy.components)) {
        rt.components.set(id, await loadComponent(id, pin, opts.secrets ?? {}))
      }
      for (const [name, wf] of Object.entries(opts.policy.workflows)) rt.validateWorkflow(name, wf)
    } catch (e) {
      rt.store.close()
      throw e
    }
    return rt
  }

  close(): void { this.store.close() }

  component(id: string): LoadedComponent | undefined { return this.components.get(id) }

  private validateWorkflow(name: string, wf: WorkflowPolicy): void {
    const exec = this.components.get(wf.executor)
    if (!exec || exec.manifest.role !== 'execution') throw new LoadError('workflow_executor_invalid', wf.executor, name)
    if (!exec.manifest.tools!.some(t => t.name === wf.tool)) throw new LoadError('workflow_tool_not_declared', wf.executor, wf.tool)
    for (const ref of [...wf.required_claims, ...wf.optional_claims]) {
      const c = this.components.get(ref.component)
      if (!c) throw new LoadError('workflow_component_not_trusted', ref.component, name)
      if (!c.manifest.claims.some(d => d.id === ref.claim)) throw new LoadError('workflow_claim_not_declared', ref.component, ref.claim)
    }
  }

  /** Re-reads describe() for the components a workflow uses and compares with the pinned manifest. */
  private integrity(ids: string[]): string[] {
    const reasons: string[] = []
    for (const id of ids) {
      const c = this.components.get(id)!
      let d: string
      try { d = digestJson(c.adapter.describe()) } catch { reasons.push(`describe_failed:${id}`); continue }
      if (d !== this.policy.components[id].manifest_digest) reasons.push(`manifest_changed_since_pin:${id}`)
    }
    return reasons
  }

  private componentsFor(wf: WorkflowPolicy): string[] {
    return [...new Set([...wf.required_claims, ...wf.optional_claims].map(r => r.component))]
  }

  private describeComponents(ids: string[]) {
    return ids.map(id => {
      const c = this.components.get(id)!
      return { id, version: c.manifest.artifact.version, role: c.manifest.role, manifest_digest: c.manifest_digest, artifact_digest: c.artifact_digest }
    })
  }

  /**
   * Everything an operation's dispatch depends on besides secrets: policy id, the workflow's
   * definition, and each component's pin and configuration (as digests). Stored at admission;
   * a retry under a different context is refused instead of being rerouted.
   */
  private executionContext(name: string, wf: WorkflowPolicy): ExecutionContext {
    return {
      policy_id: this.policy.policy_id,
      workflow: name,
      workflow_digest: digestJson(wf),
      components: [...this.componentsFor(wf), wf.executor].map(id => {
        const pin = this.policy.components[id]
        return { id, version: pin.version, manifest_digest: pin.manifest_digest, artifact_digest: pin.artifact_digest, config_digest: digestJson(pin.config ?? {}) }
      }),
    }
  }

  private contextChanges(stored: ExecutionContext, now: ExecutionContext): string[] {
    const out: string[] = []
    if (stored.policy_id !== now.policy_id) out.push('policy_id')
    if (stored.workflow_digest !== now.workflow_digest) out.push('workflow_definition')
    for (const c of stored.components) {
      const n = now.components.find(x => x.id === c.id)
      if (!n || n.version !== c.version || n.manifest_digest !== c.manifest_digest || n.artifact_digest !== c.artifact_digest) out.push(`component_pin:${c.id}`)
      else if (n.config_digest !== c.config_digest) out.push(`component_config:${c.id}`)
    }
    for (const n of now.components) if (!stored.components.some(c => c.id === n.id)) out.push(`component_pin:${n.id}`)
    return out.map(x => `operation_context_changed:${x}`)
  }

  async submit(req: SubmitRequest): Promise<SubmitResult> {
    const wf = this.policy.workflows[req.workflow]
    const opId = req.operation_id
    const refuseEarly = (reasons: string[]): SubmitResult => ({ status: 'refused', operation_id: opId, reasons, claims: [] })
    if (!wf) return refuseEarly(['unknown_workflow'])
    if (typeof opId !== 'string' || opId.length === 0 || opId.length > 200) return refuseEarly(['operation_id_invalid'])
    const tenant = req.tenant ?? null
    if (tenant !== null && (typeof tenant !== 'string' || tenant.length === 0 || tenant.length > 200)) return refuseEarly(['tenant_invalid'])
    if (req.action?.tool !== wf.tool) return refuseEarly(['tool_not_in_workflow'])

    let actionDigest: string
    let action: Action
    try {
      action = structuredClone({ tool: req.action.tool, args: req.action.args })
      actionDigest = digestJson(action)
    } catch { return refuseEarly(['action_not_canonicalizable']) }
    // The evidence submitted with a request is part of what was admitted. A retry with different
    // evidence is refused, as a retry with a different action or approval is.
    let evidenceDigest: string
    try {
      const ev = req.evidence ?? {}
      evidenceDigest = digestJson(Object.fromEntries(Object.keys(ev).sort().map(k => {
        if (!(ev[k] instanceof Uint8Array)) throw new Error('evidence_not_bytes')
        return [k, sha256(ev[k])]
      })))
    } catch { return refuseEarly(['evidence_not_bytes']) }
    const approvalId = req.approval_id ?? null

    // Retry path: same logical operation. Admission and consumption already happened once.
    const asked = { workflow: req.workflow, tenant, actionDigest, approvalId, evidenceDigest }
    const existing = this.store.getOperation(opId)
    if (existing) return this.retry(existing, asked, action)

    const checkerIds = this.componentsFor(wf)
    const components = this.describeComponents([...checkerIds, wf.executor])
    const at = this.clock().toISOString()
    const refuse = (reasons: string[], claims: ClaimRecord[] = [], evidence = new Map<string, Uint8Array>(), ran: string[] = []): SubmitResult => {
      this.store.recordRefusal(opId, { at, decision: 'refused', reasons, components, claims }, evidence,
        this.describeComponents(ran))
      return { status: 'refused', operation_id: opId, reasons, claims }
    }

    const integrity = this.integrity([...checkerIds, wf.executor])
    if (integrity.length) return refuse(integrity)
    const exec = this.components.get(wf.executor)!
    const tool = exec.manifest.tools!.find(t => t.name === wf.tool)!
    const schemaErrors = validate(tool.input_schema, action.args)
    if (schemaErrors.length) return refuse(schemaErrors.map(e => `args_schema:${e}`))
    if (wf.approval === 'required' && approvalId === null) return refuse(['approval_id_missing'])
    if (approvalId !== null) {
      const by = this.store.approvalConsumedBy(approvalId)
      if (by !== undefined) return refuse(['approval_already_consumed'])
    }

    const { claims, evidence, deadlines } = await this.evaluate(wf, checkerIds, { opId, workflow: req.workflow, tenant, approvalId, action, evidence: req.evidence ?? {} })
    const reasons = claims.filter(c => c.requirement === 'required' && c.status !== 'established')
      .map(c => `required_claim_${c.status}:${c.component}#${c.claim}${c.reason ? ':' + c.reason : ''}`)
    if (reasons.length) return refuse(reasons, claims, evidence, checkerIds)
    // The earliest deadline reported by a component that supplies a required claim binds admission.
    // Optional components cannot shorten it: their results never block.
    const requiredIds = new Set(wf.required_claims.map(r => r.component))
    const bound = [...deadlines].filter(([id]) => requiredIds.has(id)).map(([, ms]) => ms)
    const deadlineMs = bound.length ? Math.min(...bound) : null
    if (wf.approval === 'required' && deadlineMs === null) return refuse(['admission_deadline_missing'], claims, evidence, checkerIds)

    // One transaction re-reads the clock after taking the write lock, checks the deadline, consumes
    // the approval, creates the operation and claims its first dispatch. No await runs inside it.
    const admitted = this.store.admit({ operation_id: opId, workflow: req.workflow, tenant, approval_id: approvalId, action_digest: actionDigest, request_evidence_digest: evidenceDigest,
      valid_until_ms: deadlineMs, context: this.executionContext(req.workflow, wf) },
      { at, decision: 'admitted', reasons: [], components, claims }, evidence, this.describeComponents(checkerIds), exec.id, wf.execute_timeout_ms + 1000)
    if (!admitted.ok) {
      if (admitted.conflict === 'operation_exists') return this.retry(this.store.getOperation(opId)!, asked, action)
      return { status: 'refused', operation_id: opId, reasons: [admitted.conflict], claims }
    }
    return this.execute(opId, wf, action, admitted.attempt)
  }

  /** Retry of an admitted operation: only under the workflow, tenant, action, approval, submitted evidence and execution context it was admitted with. */
  private retry(row: OperationRow, asked: { workflow: string; tenant: string | null; actionDigest: string; approvalId: string | null; evidenceDigest: string }, action: Action): Promise<SubmitResult> | SubmitResult {
    const refuse = (reasons: string[]): SubmitResult => ({ status: 'refused', operation_id: row.operation_id, reasons, claims: [] })
    if (asked.workflow !== row.workflow) return refuse(['operation_workflow_mismatch'])
    if (asked.tenant !== row.tenant) return refuse(['operation_tenant_mismatch'])
    if (row.action_digest !== asked.actionDigest || row.approval_id !== asked.approvalId) return refuse(['operation_id_reused_for_different_action'])
    if (row.request_evidence_digest !== asked.evidenceDigest) return refuse(['operation_evidence_changed'])
    const wf = this.policy.workflows[row.workflow]
    const stored = JSON.parse(row.context) as ExecutionContext
    if (digestJson(stored) !== row.context_digest) return refuse(['operation_context_corrupt'])
    const changed = this.contextChanges(stored, this.executionContext(row.workflow, wf))
    if (changed.length) return refuse(changed)
    const integrity = this.integrity([wf.executor])
    if (integrity.length) return refuse(integrity)
    return this.dispatch(row.operation_id, wf, action)
  }

  private async evaluate(wf: WorkflowPolicy, ids: string[], s: { opId: string; workflow: string; tenant: string | null; approvalId: string | null; action: Action; evidence: Record<string, Uint8Array> }):
    Promise<{ claims: ClaimRecord[]; evidence: Map<string, Uint8Array>; deadlines: Map<string, number> }> {
    const now = this.clock().toISOString()
    const evidence = new Map<string, Uint8Array>()
    const deadlines = new Map<string, number>()
    const perComponent = new Map<string, Map<string, { status: RecordedStatus; reason?: string }>>()
    await Promise.all(ids.map(async id => {
      const c = this.components.get(id)!
      const own = s.evidence[id]
      const input = deepFreeze({
        operation_id: s.opId, workflow: s.workflow, ...(s.tenant !== null ? { tenant: s.tenant } : {}), ...(s.approvalId !== null ? { approval_id: s.approvalId } : {}),
        action: structuredClone(s.action), ...(own ? { evidence: new Uint8Array(own) } : {}), now,
      })
      try {
        const out = await withTimeout(c.adapter.check!(input), wf.check_timeout_ms, id)
        const n = normalizeCheckOutput(c, out)
        if (n.evidence) evidence.set(id, new Uint8Array(n.evidence))
        if (n.validUntilMs !== undefined) deadlines.set(id, n.validUntilMs)
        perComponent.set(id, n.statuses)
      } catch (e) {
        const reason = `component_unavailable:${(e as Error).message.slice(0, 120)}`
        perComponent.set(id, new Map(c.manifest.claims.map(cl => [cl.id, { status: 'unavailable' as const, reason }])))
      }
    }))
    const lookup = (ref: ClaimRef) => perComponent.get(ref.component)!.get(ref.claim)!
    const claims: ClaimRecord[] = [
      ...wf.required_claims.map(ref => ({ ...ref, requirement: 'required' as const, ...lookup(ref) })),
      ...wf.optional_claims.map(ref => {
        const r = lookup(ref)
        return r.status === 'unavailable'
          ? { ...ref, requirement: 'optional' as const, status: 'unevaluated', reason: r.reason }
          : { ...ref, requirement: 'optional' as const, ...r }
      }),
    ]
    return { claims, evidence, deadlines }
  }

  private dispatch(opId: string, wf: WorkflowPolicy, action: Action): Promise<SubmitResult> | SubmitResult {
    const exec = this.components.get(wf.executor)!
    const claim = this.store.claimDispatch(opId, exec.id, wf.execute_timeout_ms + 1000)
    if (claim.kind === 'confirmed') return { status: 'provider_confirmed', operation_id: opId, provider_ref: claim.row.provider_ref, replayed: true }
    if (claim.kind === 'in_flight') return { status: 'in_flight', operation_id: opId, attempt: claim.row.attempts }
    if (claim.kind === 'terminal_failed') return { status: 'failed', operation_id: opId, replayed: true }
    if (claim.kind === 'expired') return { status: 'failed', operation_id: opId, reason: 'approval_expired_before_retry' }
    return this.execute(opId, wf, action, claim.attempt)
  }

  /** Runs one claimed attempt. Called only right after the transaction that claimed it. */
  private async execute(opId: string, wf: WorkflowPolicy, action: Action, attempt: number): Promise<SubmitResult> {
    const exec = this.components.get(wf.executor)!
    const execInfo = { id: exec.id, version: exec.manifest.artifact.version, role: exec.manifest.role }
    const row = this.store.getOperation(opId)!
    let out: ExecuteOutput
    try {
      // The executor receives the action exactly as admitted (digest-bound to the operation row).
      if (digestJson(action) !== row.action_digest) throw new Error('action_digest_mismatch_at_dispatch')
      out = await withTimeout(exec.adapter.execute!({
        operation_id: opId, idempotency_key: opId, attempt, action: deepFreeze(structuredClone(action)),
      }), wf.execute_timeout_ms, exec.id)
      if (!out || !(out.evidence instanceof Uint8Array) || !['provider_confirmed', 'failed', 'unknown'].includes(out.outcome)) {
        out = { outcome: 'unknown', reason: 'adapter_protocol_violation', evidence: new Uint8Array() }
      }
    } catch (e) {
      // The side effect may or may not have happened. Never treated as failure or success.
      out = { outcome: 'unknown', reason: (e as Error).message.slice(0, 120), evidence: new Uint8Array() }
    }
    const retriable = out.outcome === 'unknown' || (out.outcome === 'failed' && out.retriable === true)
    const final = this.store.finishAttempt(opId, attempt,
      { outcome: out.outcome, retriable, provider_ref: out.provider_ref, reason: out.reason, evidence: out.evidence }, execInfo)
    return { status: final.state, operation_id: opId, attempt, provider_ref: final.provider_ref, ...(out.reason ? { reason: out.reason } : {}) }
  }

  /** Provenance for one logical operation. Digests and identifiers only, no payloads or secrets. */
  provenance(opId: string): Record<string, unknown> {
    const row = this.store.getOperation(opId)
    return {
      schema: 'federation-port/provenance/v0',
      operation_id: opId,
      policy_id: this.policy.policy_id,
      workflow: row?.workflow ?? null,
      tenant: row?.tenant ?? null,
      execution_context: row ? JSON.parse(row.context) : null,
      execution_context_digest: row?.context_digest ?? null,
      action_digest: row?.action_digest ?? null,
      approval_id: row?.approval_id ?? null,
      state: row?.state ?? 'not_admitted',
      admissions: this.store.admissions(opId),
      attempts: this.store.attempts(opId),
      usage: this.store.usage(opId),
    }
  }

}

export type { AdmissionRecord, ClaimRecord }
export { canonicalJson }

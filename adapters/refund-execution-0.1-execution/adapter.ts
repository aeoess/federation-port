// Execution component for the refund-execution/0.1 envelope profile.
// action.args is the complete handoff. It is sent unchanged to the configured execution endpoint.
// The native refund-execution-result/0.1 response is validated before it is mapped to a port
// outcome. Anything that does not validate is `unknown`, never `provider_confirmed` or `failed`.
// Field names follow a draft public contract text and may change.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Adapter, AdapterContext, ExecuteOp, ExecuteOutput, Manifest } from '../../src/contract/types.ts'

const manifest: Manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
const RESULT_SCHEMA = 'refund-execution-result/0.1'
const STATUSES = ['observed_success', 'observed_failure', 'unresolved']

const canonical = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']'
  const o = v as Record<string, unknown>
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + canonical(o[k])).join(',') + '}'
}

/** Digest of the admitted tuple: SHA-256 over sorted-key JSON of the three nested arguments. */
export function admittedArgumentsDigest(a: { payment_id: unknown; currency: unknown; amount_minor: unknown }): string {
  return 'sha256:' + createHash('sha256').update(canonical({ payment_id: a.payment_id, currency: a.currency, amount_minor: a.amount_minor })).digest('hex')
}

interface Result { schema: unknown; operation_id: unknown; attempt_id: unknown; status: unknown; effect_ref: unknown; arguments_digest: unknown; observation_ref: unknown }

/**
 * Checks one native result against the operation it answers. Returns the reason it is not
 * usable, or undefined. Only a result that passes every check is mapped to an outcome.
 */
export function resultProblem(r: Result, operationId: string, expectedDigest: string): string | undefined {
  if (r.schema !== RESULT_SCHEMA) return 'schema'
  if (r.operation_id !== operationId) return 'operation_id_differs'
  if (r.arguments_digest !== expectedDigest) return 'arguments_digest_differs'
  if (typeof r.attempt_id !== 'string' || r.attempt_id.length === 0) return 'attempt_id_missing'
  if (!STATUSES.includes(r.status as string)) return 'status'
  if (typeof r.observation_ref !== 'string' || r.observation_ref.length === 0) return 'observation_ref_missing'
  if (r.status === 'observed_success' && (typeof r.effect_ref !== 'string' || r.effect_ref.length === 0)) return 'effect_ref_missing_for_success'
  if (r.status === 'observed_failure' && r.effect_ref !== null) return 'effect_ref_present_for_failure'
  if (r.status === 'unresolved' && r.effect_ref !== null && typeof r.effect_ref !== 'string') return 'effect_ref_type'
  return undefined
}

export function createAdapter(ctx: AdapterContext): Adapter {
  const base = String(ctx.config.base_url)
  const key = ctx.secrets.execution_api_key

  const post = async (path: string, body: string): Promise<{ bytes: Uint8Array; status: number } | { lost: string }> => {
    let res: Response
    try {
      res = await ctx.fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body,
      })
    } catch (e) {
      // Even a refused connection is not trusted evidence that nothing was dispatched.
      return { lost: `transport:${(e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message}` }
    }
    try { return { bytes: new Uint8Array(await res.arrayBuffer()), status: res.status } } catch { return { lost: 'response_body_lost' } }
  }

  /** Maps one native response to a port outcome. */
  const map = (resp: { bytes: Uint8Array; status: number } | { lost: string }, opId: string, digest: string, phase: string): ExecuteOutput => {
    if ('lost' in resp) return { outcome: 'unknown', reason: `${phase}:${resp.lost}`, evidence: new Uint8Array() }
    const { bytes, status } = resp
    if (status !== 200) return { outcome: 'unknown', reason: `${phase}:no_result:http_${status}`, evidence: bytes }
    let r: Result
    try { r = JSON.parse(new TextDecoder().decode(bytes)) } catch { return { outcome: 'unknown', reason: `${phase}:result_not_json`, evidence: bytes } }
    if (!r || typeof r !== 'object') return { outcome: 'unknown', reason: `${phase}:result_not_object`, evidence: bytes }
    const problem = resultProblem(r, opId, digest)
    if (problem) return { outcome: 'unknown', reason: `${phase}:result_invalid:${problem}`, evidence: bytes }
    if (r.status === 'observed_success') return { outcome: 'provider_confirmed', provider_ref: r.effect_ref as string, evidence: bytes }
    if (r.status === 'observed_failure') return { outcome: 'failed', retriable: true, reason: `${phase}:observed_failure`, evidence: bytes }
    return { outcome: 'unknown', reason: `${phase}:unresolved`, ...(typeof r.effect_ref === 'string' ? { provider_ref: r.effect_ref } : {}), evidence: bytes }
  }

  return {
    describe: () => manifest,
    async execute(op: ExecuteOp): Promise<ExecuteOutput> {
      const h = op.action.args as { operation_id?: unknown; arguments?: { payment_id: unknown; currency: unknown; amount_minor: unknown } }
      // Nothing is sent when the handoff does not name this operation: no dispatch occurred.
      if (h.operation_id !== op.operation_id || !h.arguments) {
        return { outcome: 'failed', retriable: false, reason: 'handoff_operation_id_differs_from_port_operation', evidence: new Uint8Array() }
      }
      const digest = admittedArgumentsDigest(h.arguments)
      const body = JSON.stringify(op.action.args)
      // Later attempts reconcile first: an earlier attempt may have produced the effect.
      if (op.attempt > 1) {
        const rec = map(await post('/refund-execution/0.1/reconcile', body), op.operation_id, digest, 'reconcile')
        // Only a validated observed_failure (no effect recorded) lets the attempt dispatch.
        if (rec.outcome !== 'failed') return rec
      }
      return map(await post('/refund-execution/0.1/execute', body), op.operation_id, digest, 'execute')
    },
  }
}

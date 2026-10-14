// Execution component for the reconciliation candidate: the simulator executor plus a read-only
// reconcile(). Supplied with the candidate, not an evaluated adapter.
import { readFileSync } from 'node:fs'
import type { Adapter, AdapterContext, ExecuteOp, ExecuteOutput, Manifest } from '../../../src/contract/types.ts'
import type { ReconcileQuery, ReconcileResult } from '../reconcile.ts'

const manifest: Manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))

export function createAdapter(ctx: AdapterContext): Adapter & { reconcile(q: ReconcileQuery): Promise<ReconcileResult> } {
  const base = String(ctx.config.base_url)
  const key = ctx.secrets.provider_api_key
  const auth = { authorization: `Bearer ${key}` }
  return {
    describe: () => manifest,
    async execute(op: ExecuteOp): Promise<ExecuteOutput> {
      const { payment_id, amount_minor, currency } = op.action.args as { payment_id: string; amount_minor: number; currency: string }
      let res: Response
      try {
        res = await ctx.fetch(`${base}/v1/payments/${encodeURIComponent(payment_id)}/refunds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...auth, 'idempotency-key': op.idempotency_key },
          body: JSON.stringify({ amount_minor, currency }),
        })
      } catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code
        if (code === 'ECONNREFUSED') return { outcome: 'failed', retriable: true, reason: 'provider_unreachable', evidence: new Uint8Array() }
        return { outcome: 'unknown', reason: `transport:${code ?? (e as Error).message}`, evidence: new Uint8Array() }
      }
      let bytes: Uint8Array
      try { bytes = new Uint8Array(await res.arrayBuffer()) } catch {
        return { outcome: 'unknown', reason: 'response_body_lost', evidence: new Uint8Array() }
      }
      if (res.status === 200 || res.status === 201) {
        const body = JSON.parse(new TextDecoder().decode(bytes)) as { refund_id: string }
        return { outcome: 'provider_confirmed', provider_ref: body.refund_id, evidence: bytes }
      }
      if (res.status === 503) return { outcome: 'failed', retriable: true, reason: 'provider_503', evidence: bytes }
      return { outcome: 'failed', retriable: false, reason: `provider_${res.status}`, evidence: bytes }
    },
    // Read-only: a GET by idempotency key. Never creates, cancels or replays anything.
    async reconcile(q: ReconcileQuery): Promise<ReconcileResult> {
      let res: Response
      try {
        res = await ctx.fetch(`${base}/v1/refunds/by-key/${encodeURIComponent(q.idempotency_key)}`, { method: 'GET', headers: auth })
      } catch (e) {
        return { outcome: 'unknown', authoritative: false, reason: `transport:${(e as Error).message}`, evidence: new Uint8Array() }
      }
      const bytes = new Uint8Array(await res.arrayBuffer())
      let body: Record<string, unknown> = {}
      try { body = JSON.parse(new TextDecoder().decode(bytes)) } catch { /* not JSON: unknown below */ }
      const scope = { provider_account: String(body.account ?? ''), key_namespace: String(body.key_namespace ?? '') }
      if (res.status === 200 && body.status === 'succeeded') {
        return { outcome: 'provider_confirmed', authoritative: true, provider_ref: String(body.refund_id), settled_at: String(body.settled_at), scope, evidence: bytes }
      }
      if (res.status === 404 && body.status === 'not_found') {
        return { outcome: 'absent', authoritative: true, final: body.final === true,
          ...(body.final === true ? { final_scope: body.final_scope === 'key' ? 'key' as const : 'unspecified' as const } : {}), scope, evidence: bytes }
      }
      return { outcome: 'unknown', authoritative: false, reason: `lookup_${res.status}`, evidence: bytes }
    },
  }
}

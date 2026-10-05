// Execution component for the local refund simulator. Supplied with the simulator, not an evaluated adapter.
import { readFileSync } from 'node:fs'
import type { Adapter, AdapterContext, ExecuteOp, ExecuteOutput, Manifest } from '../../src/contract/types.ts'

const manifest: Manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))

export function createAdapter(ctx: AdapterContext): Adapter {
  const base = String(ctx.config.base_url)
  const key = ctx.secrets.provider_api_key
  return {
    describe: () => manifest,
    async execute(op: ExecuteOp): Promise<ExecuteOutput> {
      const { payment_id, amount_minor, currency } = op.action.args as { payment_id: string; amount_minor: number; currency: string }
      let res: Response
      try {
        res = await ctx.fetch(`${base}/v1/payments/${encodeURIComponent(payment_id)}/refunds`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'idempotency-key': op.idempotency_key },
          body: JSON.stringify({ amount_minor, currency }),
        })
      } catch (e) {
        const code = (e as { cause?: { code?: string } }).cause?.code
        // Connection refused: the request never reached the provider.
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
  }
}

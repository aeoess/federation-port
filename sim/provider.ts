// Local refund provider simulator. Binds 127.0.0.1 on an ephemeral port. Test-only.
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export type Fault =
  | { mode: 'none' }
  | { mode: 'outage'; count: number }              // 503 before any side effect
  | { mode: 'drop_after_commit'; count: number }   // refund committed, connection destroyed before response
  | { mode: 'slow'; count: number; delay_ms: number } // refund committed, response delayed

export interface Refund { refund_id: string; payment_id: string; amount_minor: number; currency: string; idempotency_key: string }

export const DEFAULT_TOOL_DEFINITION = {
  name: 'refund',
  description: 'Refund part or all of a captured payment.',
  input_schema: {
    type: 'object', additionalProperties: false, required: ['payment_id', 'amount_minor', 'currency'],
    properties: {
      payment_id: { type: 'string', pattern: '^pay_[A-Za-z0-9]+$' },
      amount_minor: { type: 'integer', minimum: 1 },
      currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    },
  },
}

export interface SimProvider {
  url: string
  refunds: Refund[]
  /** Refund POSTs that reached the handler, including replays and refusals. */
  requests: number
  setFault(f: Fault): void
  setToolFault(down: boolean): void
  setToolDefinition(def: unknown): void
  close(): Promise<void>
}

export async function startProvider(opts: { apiKey: string }): Promise<SimProvider> {
  const payments: Record<string, { captured_minor: number; currency: string }> = {
    pay_A: { captured_minor: 10000, currency: 'EUR' },
    pay_B: { captured_minor: 10000, currency: 'EUR' },
  }
  const byKey = new Map<string, { body_digest: string; refund: Refund }>()
  let fault: Fault = { mode: 'none' }
  let toolDown = false
  let toolBytes = Buffer.from(JSON.stringify(DEFAULT_TOOL_DEFINITION))

  const state = { refunds: [] as Refund[], requests: 0 }

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const read = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
    let s = ''
    req.setEncoding('utf8').on('data', c => { s += c }).on('end', () => ok(s)).on('error', bad)
  })

  const server = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/tool-definition') {
      if (toolDown) return send(res, 503, { error: 'unavailable' })
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(toolBytes)
    }
    const m = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) return send(res, 404, { error: 'not_found' })
    state.requests++
    const body = await read(req)
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) return send(res, 401, { error: 'unauthorized' })
    const key = req.headers['idempotency-key']
    if (typeof key !== 'string' || !key) return send(res, 400, { error: 'idempotency_key_required' })

    const f = fault
    const take = () => { if (f.mode !== 'none' && --f.count <= 0) fault = { mode: 'none' } }
    if (f.mode === 'outage') { take(); return send(res, 503, { error: 'provider_unavailable' }) }

    const paymentId = decodeURIComponent(m[1])
    const digest = createHash('sha256').update(paymentId + '\n' + body).digest('hex')
    const prior = byKey.get(key)
    let status = 201
    let refund: Refund
    if (prior) {
      if (prior.body_digest !== digest) return send(res, 409, { error: 'idempotency_key_reused_with_different_request' })
      refund = prior.refund
      status = 200
    } else {
      let parsed: { amount_minor?: unknown; currency?: unknown }
      try { parsed = JSON.parse(body) } catch { return send(res, 400, { error: 'invalid_json' }) }
      const p = payments[paymentId]
      if (!p) return send(res, 404, { error: 'payment_not_found' })
      if (parsed.currency !== p.currency) return send(res, 422, { error: 'currency_mismatch' })
      const already = state.refunds.filter(r => r.payment_id === paymentId).reduce((a, r) => a + r.amount_minor, 0)
      if (!Number.isInteger(parsed.amount_minor) || (parsed.amount_minor as number) < 1 || already + (parsed.amount_minor as number) > p.captured_minor) {
        return send(res, 422, { error: 'amount_invalid' })
      }
      refund = { refund_id: 're_' + randomUUID(), payment_id: paymentId, amount_minor: parsed.amount_minor as number, currency: p.currency, idempotency_key: key }
      state.refunds.push(refund)
      byKey.set(key, { body_digest: digest, refund })
    }
    if (f.mode === 'drop_after_commit') { take(); req.socket.destroy(); return }
    if (f.mode === 'slow') { take(); await new Promise(r => setTimeout(r, f.delay_ms)) }
    send(res, status, { ...refund, status: 'succeeded', idempotent_replay: status === 200 })
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    get refunds() { return state.refunds },
    get requests() { return state.requests },
    setFault(f) { fault = { ...f } },
    setToolFault(down) { toolDown = down },
    setToolDefinition(def) { toolBytes = Buffer.from(JSON.stringify(def)) },
    close: () => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()) }),
  }
}

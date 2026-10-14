// Refund provider simulator for the reconciliation candidate. Test-only, binds 127.0.0.1.
// It differs from sim/provider.ts in what reconciliation needs to exercise:
//  - a request can be held: accepted, its connection dropped, and settled later (or never);
//  - a read-only lookup by idempotency key, scoped to one provider account and key namespace;
//  - keys are forgotten `retention_ms` after the provider first saw them;
//  - a key can be cancelled out of band (a tombstone): no request with it can settle afterwards,
//    which is the only absence the lookup reports as final.
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createHash, randomUUID } from 'node:crypto'
import type { AddressInfo } from 'node:net'

export interface HeldRequest { key: string; payment_id: string; amount_minor: number; currency: string; received_at: number }
export interface Refund { refund_id: string; payment_id: string; amount_minor: number; currency: string; idempotency_key: string; settled_at: number }

export interface ReconcileProvider {
  url: string
  account: string
  keyNamespace: string
  refunds: Refund[]
  /** Refund POSTs that reached the handler, including replays and refusals. Lookups are not counted. */
  requests: number
  lookups: number
  /** The next `count` refund POSTs are held: accepted, connection dropped, not settled. */
  hold(count: number): void
  /** Settle a held request now (provider clock). Returns the refund, or undefined if nothing is held for the key. */
  settle(key: string): Refund | undefined
  /** Cancel a key: drops held requests and refuses any later one. */
  cancel(key: string): void
  /** Lookups answer 503 while down. */
  setLookupDown(down: boolean): void
  /** A faulty provider: lookups report a held request as final absence. Used to test contradiction. */
  setMisreportFinal(on: boolean): void
  /** Report a different account in lookups (scope mismatch). */
  setReportedAccount(account: string): void
  close(): Promise<void>
}

export async function startReconcileProvider(opts: { apiKey: string; clock: () => number; retentionMs: number;
  account?: string; keyNamespace?: string }): Promise<ReconcileProvider> {
  const account = opts.account ?? 'acct_sim_1'
  const keyNamespace = opts.keyNamespace ?? 'refunds'
  const payments: Record<string, { captured_minor: number; currency: string }> = {
    pay_A: { captured_minor: 10000, currency: 'EUR' },
    pay_B: { captured_minor: 10000, currency: 'EUR' },
  }
  const byKey = new Map<string, { body_digest: string; refund: Refund; first_seen: number }>()
  const held = new Map<string, HeldRequest>()
  const firstSeen = new Map<string, number>()
  const cancelled = new Set<string>()
  let holdCount = 0
  let lookupDown = false
  let misreportFinal = false
  let reportedAccount = account
  const state = { refunds: [] as Refund[], requests: 0, lookups: 0 }

  const send = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  }
  const read = (req: IncomingMessage) => new Promise<string>((ok, bad) => {
    let s = ''
    req.setEncoding('utf8').on('data', c => { s += c }).on('end', () => ok(s)).on('error', bad)
  })
  // A key the provider no longer remembers is indistinguishable from one it never saw.
  const remembered = (key: string) => {
    const t = firstSeen.get(key)
    return t !== undefined && opts.clock() <= t + opts.retentionMs
  }
  const commit = (h: HeldRequest): Refund => {
    const refund: Refund = { refund_id: 're_' + randomUUID(), payment_id: h.payment_id, amount_minor: h.amount_minor,
      currency: h.currency, idempotency_key: h.key, settled_at: opts.clock() }
    state.refunds.push(refund)
    byKey.set(h.key, { body_digest: '', refund, first_seen: firstSeen.get(h.key) ?? h.received_at })
    return refund
  }

  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) return send(res, 401, { error: 'unauthorized' })
    const look = /^\/v1\/refunds\/by-key\/([^/]+)$/.exec(req.url ?? '')
    if (req.method === 'GET' && look) {
      state.lookups++
      if (lookupDown) return send(res, 503, { error: 'lookup_unavailable' })
      const key = decodeURIComponent(look[1])
      const scope = { account: reportedAccount, key_namespace: keyNamespace }
      const found = byKey.get(key)
      if (found && remembered(key)) {
        return send(res, 200, { status: 'succeeded', refund_id: found.refund.refund_id, settled_at: new Date(found.refund.settled_at).toISOString(), ...scope })
      }
      if (cancelled.has(key) || (misreportFinal && held.has(key))) {
        return send(res, 404, { status: 'not_found', final: true, final_scope: 'key', ...scope })
      }
      // Held requests are not visible: the provider has not settled them and does not expose its queue.
      return send(res, 404, { status: 'not_found', final: false, ...scope })
    }
    const m = /^\/v1\/payments\/([^/]+)\/refunds$/.exec(req.url ?? '')
    if (req.method !== 'POST' || !m) return send(res, 404, { error: 'not_found' })
    state.requests++
    const body = await read(req)
    const key = req.headers['idempotency-key']
    if (typeof key !== 'string' || !key) return send(res, 400, { error: 'idempotency_key_required' })
    if (cancelled.has(key)) return send(res, 409, { error: 'idempotency_key_cancelled' })
    const paymentId = decodeURIComponent(m[1])
    const digest = createHash('sha256').update(paymentId + '\n' + body).digest('hex')
    if (!firstSeen.has(key) || !remembered(key)) firstSeen.set(key, opts.clock())
    const prior = byKey.get(key)
    if (prior && remembered(key)) {
      if (prior.body_digest && prior.body_digest !== digest) return send(res, 409, { error: 'idempotency_key_reused_with_different_request' })
      return send(res, 200, { ...prior.refund, settled_at: new Date(prior.refund.settled_at).toISOString(), status: 'succeeded', idempotent_replay: true })
    }
    let parsed: { amount_minor?: unknown; currency?: unknown }
    try { parsed = JSON.parse(body) } catch { return send(res, 400, { error: 'invalid_json' }) }
    const p = payments[paymentId]
    if (!p) return send(res, 404, { error: 'payment_not_found' })
    if (parsed.currency !== p.currency || !Number.isInteger(parsed.amount_minor) || (parsed.amount_minor as number) < 1) {
      return send(res, 422, { error: 'amount_invalid' })
    }
    const h: HeldRequest = { key, payment_id: paymentId, amount_minor: parsed.amount_minor as number, currency: p.currency, received_at: opts.clock() }
    if (holdCount > 0) {
      holdCount--
      if (!held.has(key)) held.set(key, h)
      req.socket.destroy()
      return
    }
    if (held.has(key)) { req.socket.destroy(); return } // still pending: the replay cannot be answered yet
    const refund = commit(h)
    byKey.get(key)!.body_digest = digest
    send(res, 201, { ...refund, settled_at: new Date(refund.settled_at).toISOString(), status: 'succeeded', idempotent_replay: false })
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    account, keyNamespace,
    get refunds() { return state.refunds },
    get requests() { return state.requests },
    get lookups() { return state.lookups },
    hold(count) { holdCount = count },
    settle(key) {
      const h = held.get(key)
      if (!h || cancelled.has(key)) return undefined
      held.delete(key)
      return commit(h)
    },
    cancel(key) { cancelled.add(key); held.delete(key) },
    setLookupDown(down) { lookupDown = down },
    setMisreportFinal(on) { misreportFinal = on },
    setReportedAccount(a) { reportedAccount = a },
    close: () => new Promise<void>(ok => { server.closeAllConnections(); server.close(() => ok()) }),
  }
}

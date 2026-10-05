// The same refund flow written directly against the simulator, no port.
// Good-faith single-file integration: APS approval check (same logic as the reference example),
// in-memory single use, idempotency key derived from the approval id, one internal retry.
import { computeActionRefV2, computePayloadRefV1, verifyReceiptV1 } from 'agent-passport-system'
import type { ActionReferenceInputV2, ReceiptV1 } from 'agent-passport-system'

export interface DirectConfig {
  providerUrl: string
  apiKey: string
  boundaryIdentity: string
  trustedKeys: Record<string, string>
  targetTemplate: string
}

export type DirectResult = { ok: true; refund_id: string } | { ok: false; reason: string }

export function createDirectRefunder(cfg: DirectConfig) {
  const used = new Set<string>()

  function admit(args: { payment_id: string; amount_minor: number; currency: string }, evidence: Uint8Array, now: Date): string | undefined {
    let ev: { input: ActionReferenceInputV2; approval: ReceiptV1 }
    try { ev = JSON.parse(new TextDecoder().decode(evidence)) } catch { return 'evidence_invalid' }
    if (!ev?.approval || !ev.input) return 'no_approval'
    const v = verifyReceiptV1(ev.approval, s => cfg.trustedKeys[s], { expectedReceiptType: 'aps:policy-decision:v1', boundaryIdentity: cfg.boundaryIdentity })
    if (v.status !== 'valid') return `approval_${v.status}`
    const out = ev.approval.result as { verdict: string; valid_until: string }
    if (out.verdict !== 'permit') return 'verdict_unsupported'
    try {
      if (computePayloadRefV1(args) !== ev.input.payload_ref) return 'payload_mismatch'
      if (ev.input.target !== cfg.targetTemplate.replace('{payment_id}', args.payment_id)) return 'target_mismatch'
      if (computeActionRefV2(ev.input) !== ev.approval.action_ref) return 'action_ref_mismatch'
    } catch { return 'action_ref_input_invalid' }
    if (now.toISOString() > out.valid_until) return 'approval_expired'
    if (used.has(ev.approval.receipt_id)) return 'approval_already_used'
    used.add(ev.approval.receipt_id)
    return undefined
  }

  async function post(args: { payment_id: string; amount_minor: number; currency: string }, key: string): Promise<Response> {
    return fetch(`${cfg.providerUrl}/v1/payments/${encodeURIComponent(args.payment_id)}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}`, 'idempotency-key': key },
      body: JSON.stringify({ amount_minor: args.amount_minor, currency: args.currency }),
      signal: AbortSignal.timeout(1000),
    })
  }

  return async function refund(args: { payment_id: string; amount_minor: number; currency: string }, evidence: Uint8Array | undefined): Promise<DirectResult> {
    if (!evidence) return { ok: false, reason: 'no_approval' }
    const refused = admit(args, evidence, new Date())
    if (refused) return { ok: false, reason: refused }
    const key = (JSON.parse(new TextDecoder().decode(evidence)) as { approval: ReceiptV1 }).approval.receipt_id
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await post(args, key)
        if (res.ok) return { ok: true, refund_id: ((await res.json()) as { refund_id: string }).refund_id }
        if (res.status !== 503) return { ok: false, reason: `provider_${res.status}` }
      } catch { /* timeout or lost response: retry with the same key */ }
    }
    return { ok: false, reason: 'provider_unavailable' }
  }
}

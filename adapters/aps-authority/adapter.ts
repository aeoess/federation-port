// Authority-evidence component built on agent-passport-system 7.2.1 primitives.
// The comparison logic follows examples/interop/refund-exact-approval (commit ff6d969) with one change:
// it does not consume the approval. Single-use consumption is the runtime's job.
import { readFileSync } from 'node:fs'
import { computeActionRefV2, computePayloadRefV1, verifyReceiptV1 } from 'agent-passport-system'
import type { ActionReferenceInputV2, ReceiptV1 } from 'agent-passport-system'
import type { Adapter, AdapterContext, CheckInput, CheckOutput, ClaimResult, ClaimStatus, Manifest } from '../../src/contract/types.ts'

const manifest: Manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
const CLAIMS = manifest.claims.map(c => c.id)

export function createAdapter(ctx: AdapterContext): Adapter {
  const cfg = ctx.config as { boundary_identity: string; trusted_keys: Record<string, string>; target_template: string; action_type: string }
  const resolveKey = (signer: string) => cfg.trusted_keys[signer]

  return {
    describe: () => manifest,
    async check(input: CheckInput): Promise<CheckOutput> {
      const evidence = input.evidence ?? new Uint8Array()
      const all = (status: ClaimStatus, reason: string): CheckOutput =>
        ({ evidence, claims: CLAIMS.map(claim => ({ claim, status, reason })) })
      if (evidence.byteLength === 0) return all('not_established', 'no_approval_evidence')
      let parsed: { input: ActionReferenceInputV2; approval: ReceiptV1 }
      try { parsed = JSON.parse(new TextDecoder().decode(evidence)) } catch { return all('failed', 'evidence_not_json') }
      const { input: ref, approval } = parsed
      if (!ref || !approval) return all('failed', 'evidence_missing_members')

      const out: Record<string, ClaimResult> = {}
      const set = (claim: string, status: ClaimStatus, reason?: string) => { out[claim] = { claim, status, ...(reason ? { reason } : {}) } }

      const v = verifyReceiptV1(approval, resolveKey, { expectedReceiptType: 'aps:policy-decision:v1', boundaryIdentity: cfg.boundary_identity })
      if (v.status !== 'valid') {
        const reason = `approval_${v.status}:${v.errors.join(',')}`.slice(0, 160)
        for (const c of CLAIMS) set(c, 'not_established', c === 'approval.signature_valid' ? reason : 'precondition:approval.signature_valid')
        return { evidence, claims: Object.values(out) }
      }
      set('approval.signature_valid', 'established')

      set('approval.id_matches_request', approval.receipt_id === input.approval_id ? 'established' : 'not_established',
        approval.receipt_id === input.approval_id ? undefined : 'approval_id_differs')

      const result = approval.result as { verdict?: string; valid_until?: string }
      if (result.verdict === 'permit') set('approval.permit_verdict', 'established')
      else set('approval.permit_verdict', 'unsupported', `verdict:${result.verdict}`)

      const payload = input.action.args
      let bound: string | undefined
      try {
        if (computePayloadRefV1(payload) !== ref.payload_ref) bound = 'payload_ref_mismatch'
        else if (input.action.tool !== cfg.action_type || ref.action_type !== cfg.action_type) bound = 'action_type_mismatch'
        else if (typeof payload.payment_id !== 'string' || ref.target !== cfg.target_template.replace('{payment_id}', payload.payment_id)) bound = 'target_mismatch'
        else if (computeActionRefV2(ref) !== approval.action_ref) bound = 'action_ref_mismatch'
      } catch { bound = 'action_ref_input_invalid' }
      set('approval.binds_exact_action', bound ? 'not_established' : 'established', bound)

      // Both sides are exact UTC milliseconds, so string order is instant order.
      if (typeof result.valid_until !== 'string') set('approval.unexpired', 'failed', 'valid_until_missing')
      else if (input.now > result.valid_until) set('approval.unexpired', 'not_established', 'approval_expired')
      else set('approval.unexpired', 'established')

      return { evidence, claims: CLAIMS.map(c => out[c]) }
    },
  }
}

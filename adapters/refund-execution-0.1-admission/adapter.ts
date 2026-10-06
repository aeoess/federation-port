// Admission component for the refund-execution/0.1 envelope profile.
// action.args is the complete handoff. This component checks its shape, its linkage to the port
// operation and approval, and APS authority over the nested `arguments` tuple only. The outer
// handoff fields are never hashed into the APS payload. PIC is not verified here: its claim is
// always not_established. aps_evidence_ref is checked as a reference (present, well formed), not
// resolved. Field names follow a draft public contract text and may change.
// The APS comparison follows the approach of adapters/aps-authority, written again here.
import { readFileSync } from 'node:fs'
import { computeActionRefV2, computePayloadRefV1, verifyReceiptV1 } from 'agent-passport-system'
import type { ActionReferenceInputV2, ReceiptV1 } from 'agent-passport-system'
import type { Adapter, AdapterContext, CheckInput, CheckOutput, ClaimResult, ClaimStatus, Manifest } from '../../src/contract/types.ts'

const manifest: Manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'))
const CLAIMS = manifest.claims.map(c => c.id)
const HANDOFF_KEYS = ['schema', 'operation_id', 'tool', 'arguments', 'approval_ref', 'pic_evidence_ref', 'aps_evidence_ref'].sort()
const REF = /^[!-~]{1,256}$/

type Tuple = { payment_id: string; currency: string; amount_minor: number }

/** The nested tuple if `args` is a well formed refund-execution/0.1 handoff, else the reason it is not. */
function handoffProblem(args: Record<string, unknown>, tool: string): string | undefined {
  if (Object.keys(args).sort().join() !== HANDOFF_KEYS.join()) return 'handoff_keys'
  if (args.schema !== 'refund-execution/0.1') return 'handoff_schema'
  if (args.tool !== tool) return 'handoff_tool'
  for (const k of ['operation_id', 'approval_ref', 'pic_evidence_ref']) if (typeof args[k] !== 'string' || !REF.test(args[k] as string)) return `handoff_${k}`
  const a = args.arguments as Record<string, unknown> | null
  if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).sort().join() !== 'amount_minor,currency,payment_id') return 'arguments_keys'
  if (typeof a.payment_id !== 'string' || !/^pay_[A-Za-z0-9]+$/.test(a.payment_id)) return 'arguments_payment_id'
  if (typeof a.currency !== 'string' || !/^[A-Z]{3}$/.test(a.currency)) return 'arguments_currency'
  if (!Number.isSafeInteger(a.amount_minor) || (a.amount_minor as number) < 1) return 'arguments_amount_minor_not_positive_integer'
  return undefined
}

export function createAdapter(ctx: AdapterContext): Adapter {
  const cfg = ctx.config as { boundary_identity: string; trusted_keys: Record<string, string>; target_template: string; action_type: string }
  const resolveKey = (signer: string) => cfg.trusted_keys[signer]

  return {
    describe: () => manifest,
    async check(input: CheckInput): Promise<CheckOutput> {
      const evidence = input.evidence ?? new Uint8Array()
      const out: Record<string, ClaimResult> = {}
      const set = (claim: string, status: ClaimStatus, reason?: string) => { out[claim] = { claim, status, ...(reason ? { reason } : {}) } }
      const result = (validUntil?: string): CheckOutput =>
        ({ evidence, claims: CLAIMS.map(c => out[c]), ...(validUntil !== undefined ? { valid_until: validUntil } : {}) })
      const args = input.action.args

      // Not implemented by this profile. Never reported as established.
      set('pic.verified', 'not_established', typeof args.pic_evidence_ref === 'string'
        ? 'pic_verification_not_implemented:reference_not_resolved' : 'pic_verification_not_implemented:reference_absent')

      const shape = input.action.tool !== cfg.action_type ? 'port_tool_differs' : handoffProblem(args, cfg.action_type)
      set('handoff.well_formed', shape ? 'not_established' : 'established', shape)
      set('handoff.operation_id_matches', args.operation_id === input.operation_id ? 'established' : 'not_established',
        args.operation_id === input.operation_id ? undefined : 'handoff_operation_id_differs')
      const approvalLinked = input.approval_id !== undefined && args.approval_ref === input.approval_id
      set('handoff.approval_ref_matches', approvalLinked ? 'established' : 'not_established', approvalLinked ? undefined : 'approval_ref_differs_from_approval_id')
      const apsRef = typeof args.aps_evidence_ref === 'string' && REF.test(args.aps_evidence_ref)
      set('aps_evidence_ref.well_formed', apsRef ? 'established' : 'not_established', apsRef ? undefined : 'aps_evidence_ref_missing_or_malformed')

      const aps = ['aps.signature_valid', 'aps.id_matches_request', 'aps.permit_verdict', 'aps.binds_nested_arguments', 'aps.unexpired']
      const allAps = (status: ClaimStatus, reason: string) => { for (const c of aps) set(c, status, reason) }
      if (shape) { allAps('not_established', `precondition:handoff.well_formed`); return result() }
      if (evidence.byteLength === 0) { allAps('not_established', 'no_approval_evidence'); return result() }
      let parsed: { input: ActionReferenceInputV2; approval: ReceiptV1 }
      try { parsed = JSON.parse(new TextDecoder().decode(evidence)) } catch { allAps('failed', 'evidence_not_json'); return result() }
      const { input: ref, approval } = parsed ?? {}
      if (!ref || !approval) { allAps('failed', 'evidence_missing_members'); return result() }

      const v = verifyReceiptV1(approval, resolveKey, { expectedReceiptType: 'aps:policy-decision:v1', boundaryIdentity: cfg.boundary_identity })
      if (v.status !== 'valid') {
        const reason = `approval_${v.status}:${v.errors.join(',')}`.slice(0, 160)
        for (const c of aps) set(c, 'not_established', c === 'aps.signature_valid' ? reason : 'precondition:aps.signature_valid')
        return result()
      }
      set('aps.signature_valid', 'established')
      set('aps.id_matches_request', approval.receipt_id === input.approval_id ? 'established' : 'not_established',
        approval.receipt_id === input.approval_id ? undefined : 'approval_id_differs')
      const decision = approval.result as { verdict?: string; valid_until?: string }
      if (decision.verdict === 'permit') set('aps.permit_verdict', 'established')
      else set('aps.permit_verdict', 'unsupported', `verdict:${decision.verdict}`)

      // The APS payload is the nested tuple only, never the outer handoff.
      const t = args.arguments as Tuple
      const tuple: Tuple = { payment_id: t.payment_id, currency: t.currency, amount_minor: t.amount_minor }
      let bound: string | undefined
      try {
        if (computePayloadRefV1(tuple) !== ref.payload_ref) bound = 'payload_ref_mismatch'
        else if (ref.action_type !== cfg.action_type) bound = 'action_type_mismatch'
        else if (ref.target !== cfg.target_template.replace('{payment_id}', tuple.payment_id)) bound = 'target_mismatch'
        else if (computeActionRefV2(ref) !== approval.action_ref) bound = 'action_ref_mismatch'
      } catch { bound = 'action_ref_input_invalid' }
      set('aps.binds_nested_arguments', bound ? 'not_established' : 'established', bound)

      // Both sides are exact UTC milliseconds, so string order is instant order.
      if (typeof decision.valid_until !== 'string') set('aps.unexpired', 'failed', 'valid_until_missing')
      else if (input.now > decision.valid_until) set('aps.unexpired', 'not_established', 'approval_expired')
      else set('aps.unexpired', 'established')
      return result(typeof decision.valid_until === 'string' ? decision.valid_until : undefined)
    },
  }
}

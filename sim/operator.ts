// Operator-side test fixture: issues a signed APS approval for one refund. Adapted from the
// case harness in agent-passport-system examples/interop/refund-exact-approval (commit ff6d969).
// This is test setup, not part of any component.
import { createHash, randomBytes } from 'node:crypto'
import {
  buildDecisionRefV1, computeActionRefV2, computePayloadRefV1,
  createActionReferenceInputV2, createReceiptV1, generateKeyPair,
} from 'agent-passport-system'
import { ACTION_TYPE, SCOPES, TARGET_TEMPLATE } from './profile.ts'

export const BOUNDARY = 'did:example:refund-approval-boundary'
export const WORKER = 'did:example:refund-worker'

const sha = (s: string) => createHash('sha256').update(s).digest('hex')
const DELEGATION_REF = 'sha256:' + sha('synthetic-delegation-leaf')
export const targetFor = (paymentId: string) => TARGET_TEMPLATE.replace('{payment_id}', paymentId)

export interface Operator {
  boundaryPublicKey: string
  workerPublicKey: string
  issue(payload: { payment_id: string; amount_minor: number; currency: string }, o?: {
    ttlMs?: number; forge?: boolean; verdict?: 'permit' | 'narrow'; constraints?: string[]; issuedAt?: Date
  }): { approval_id: string; valid_until: string; evidence: Uint8Array; input: unknown; approval: unknown }
}

export function createOperator(): Operator {
  const boundaryKeys = generateKeyPair()
  const workerKeys = generateKeyPair()
  return {
    boundaryPublicKey: boundaryKeys.publicKey,
    workerPublicKey: workerKeys.publicKey,
    issue(payload, o = {}) {
      const issued_at = (o.issuedAt ?? new Date()).toISOString()
      const input = createActionReferenceInputV2({
        agent_id: WORKER, action_type: ACTION_TYPE, target: targetFor(payload.payment_id),
        payload_ref: computePayloadRefV1(payload), scope_required: [...SCOPES], issued_at, nonce: randomBytes(16).toString('hex'),
      })
      const action_ref = computeActionRefV2(input)
      const intent = createReceiptV1({
        profile: 'aps-receipt-v1', receipt_type: 'aps:action-intent:v1', issuer: WORKER, subject_agent: WORKER,
        action_ref, delegation_ref: DELEGATION_REF, issued_at, evidence_refs: [],
        result: { profile: 'aps-action-intent-result-v1', status: 'declared' },
      }, [{ signer: WORKER, key_id: 'k1', private_key: workerKeys.privateKey }])
      const valid_until = new Date(Date.parse(issued_at) + (o.ttlMs ?? 60_000)).toISOString()
      const decision_output = {
        profile: 'aps-core-decision-output-v1' as const, verdict: o.verdict ?? 'permit',
        effective_authority_ref: sha('synthetic-effective-authority'), constraints: o.constraints ?? [], valid_until,
      }
      const { decision_ref } = buildDecisionRefV1({
        action_ref, authority_state: { synthetic: true }, policy_input: { operator_approved: payload },
        decision_context: { run: 'federation-port-v0' }, decision_output,
      })
      const signer = o.forge ? generateKeyPair().privateKey : boundaryKeys.privateKey
      const approval = createReceiptV1({
        profile: 'aps-receipt-v1', receipt_type: 'aps:policy-decision:v1', issuer: BOUNDARY, subject_agent: WORKER,
        action_ref, delegation_ref: DELEGATION_REF, decision_ref, issued_at, evidence_refs: [],
        result: decision_output as any, prev: intent.receipt_id,
      }, [{ signer: BOUNDARY, key_id: 'k1', private_key: signer }])
      const evidence = new TextEncoder().encode(JSON.stringify({ input, approval }))
      return { approval_id: approval.receipt_id, valid_until, evidence, input, approval }
    },
  }
}

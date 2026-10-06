// Customer policy for the refund-execution/0.1 envelope profile. Test and demonstration setup.
// The PIC claim is optional: this profile never establishes it, so it is recorded, not required.
import type { ClaimRef, ComponentPin, CustomerPolicy } from '../../src/runtime/index.ts'

export const ADMISSION = 'example.profile/refund-execution-0.1-admission'
export const EXECUTOR = 'example.profile/refund-execution-0.1-executor'
export const WORKFLOW = 'refund_execution_0_1'
export const REQUIRED_CLAIMS = [
  'handoff.well_formed', 'handoff.operation_id_matches', 'handoff.approval_ref_matches', 'aps_evidence_ref.well_formed',
  'aps.signature_valid', 'aps.id_matches_request', 'aps.permit_verdict', 'aps.binds_nested_arguments', 'aps.unexpired',
]
export const OPTIONAL_CLAIMS = ['pic.verified']

export function refundExecutionPolicy(o: {
  admissionPin: ComponentPin; executorPin: ComponentPin
  boundary: string; boundaryPublicKey: string; targetTemplate: string; executionUrl: string
}): CustomerPolicy {
  const ref = (claim: string): ClaimRef => ({ component: ADMISSION, claim })
  return {
    policy_id: 'customer-policy-refund-execution-0.1-test',
    components: {
      [ADMISSION]: { ...o.admissionPin, config: { boundary_identity: o.boundary, trusted_keys: { [o.boundary]: o.boundaryPublicKey }, target_template: o.targetTemplate, action_type: 'refund' } },
      [EXECUTOR]: { ...o.executorPin, config: { base_url: o.executionUrl } },
    },
    workflows: {
      [WORKFLOW]: {
        executor: EXECUTOR, tool: 'refund', approval: 'required',
        required_claims: REQUIRED_CLAIMS.map(ref), optional_claims: OPTIONAL_CLAIMS.map(ref),
        check_timeout_ms: 500, execute_timeout_ms: 1000,
      },
    },
  }
}

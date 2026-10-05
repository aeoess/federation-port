// The single workflow profile V0 exercises: one exact refund approval.
// Exact, not a ceiling: 3900 and 4100 are both outside it.
export const APPROVED_REFUND: Readonly<{ payment_id: string; amount_minor: number; currency: string }> =
  Object.freeze({ payment_id: 'pay_A', amount_minor: 4000, currency: 'EUR' })

// Candidate target construction, carried over from the APS example
// examples/interop/refund-exact-approval (agent-passport-system commit ff6d969). No published profile defines it.
export const TARGET_TEMPLATE = 'https://payments.operator.example/v1/payments/{payment_id}/refunds'
export const ACTION_TYPE = 'refund'
export const SCOPES = Object.freeze(['payments:refund'])

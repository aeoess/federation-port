// V0b, acceptance 4: approval consumption across OS processes and process restarts.
// C06 (6 competing OS processes) stays in core.test.ts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { APS, WORKER, child, opId, request, runWorker, setup, writeJob } from './helpers.ts'

// ---- Acceptance 4: consumption across OS processes and restarts ----

test('A4a consumption survives a process restart: a new OS process cannot reuse the approval, the same operation replays', async () => {
  const env = await setup()
  try {
    const { req } = request(env)
    assert.equal((await runWorker(env, writeJob(env, req))).status, 'provider_confirmed')
    const reuse = await runWorker(env, writeJob(env, { ...req, operation_id: opId() }))
    assert.deepEqual([reuse.status, reuse.reasons], ['refused', ['approval_already_consumed']])
    const replay = await runWorker(env, writeJob(env, req))
    assert.deepEqual([replay.status, replay.replayed], ['provider_confirmed', true])
    assert.equal(env.provider.requests, 1)
    assert.equal(env.provider.refunds.length, 1)
  } finally { await env.close() }
})

test('A4b process killed between check and consume: nothing consumed; the restarted process admits once, later uses refused', async () => {
  const env = await setup()
  try {
    const { a, req } = request(env)
    const first = child(WORKER, [writeJob(env, req, { checkDelayMs: 5000, delayComponent: APS })], { FP_PROVIDER_KEY: env.apiKey })
    await first.line('checked')
    first.proc.kill('SIGKILL')
    assert.equal((await first.done).signal, 'SIGKILL')
    assert.equal(env.rt.store.approvalConsumedBy(a.approval_id), undefined)
    assert.equal(env.rt.store.getOperation(req.operation_id), undefined)
    assert.equal(env.provider.requests, 0)

    assert.equal((await runWorker(env, writeJob(env, req))).status, 'provider_confirmed')
    const reuse = await runWorker(env, writeJob(env, { ...req, operation_id: opId() }))
    assert.deepEqual([reuse.status, reuse.reasons], ['refused', ['approval_already_consumed']])
    assert.equal(env.provider.requests, 1)
    assert.equal(env.provider.refunds.length, 1)
  } finally { await env.close() }
})

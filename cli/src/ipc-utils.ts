import { getIpcRequestById } from './database.js'

/**
 * Wait for an IPC request to reach "completed" status.
 * Used by both the CLI send flow and the task-runner.
 */
export async function waitForIpcRequestCompletion({
  requestId,
  timeoutMs = 4_000,
  pollMs = 100,
}: {
  requestId: string
  timeoutMs?: number
  pollMs?: number
}): Promise<true | Error> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const row = await getIpcRequestById({ id: requestId })
    if (row?.status === 'completed') {
      return true
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, pollMs)
    })
  }
  return new Error(
    `Timed out waiting for IPC request ${requestId} completion`,
  )
}

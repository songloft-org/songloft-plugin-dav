import { getConfigs } from './config'
import {
  advanceDavSyncTask,
  cancelDavSyncTask,
  getDavSyncTask,
  startDavSyncTask,
  type DavSyncCancelResult,
  type DavSyncTaskStatus,
  type DavSyncTaskView
} from './sync-task'

const RUNNER_STEP_DELAY_MS = 25
const RUNNER_RETRY_DELAY_MS = 1000

interface DavSyncRunner {
  taskId: string
  timer: ReturnType<typeof setTimeout>
}

const runners = new Map<string, DavSyncRunner>()
const inFlightSteps = new Map<string, Promise<DavSyncTaskView>>()
let operationTail: Promise<void> = Promise.resolve()
let stopped = false

function isActiveStatus(status: DavSyncTaskStatus): boolean {
  return status === 'queued' || status === 'scanning' || status === 'applying'
}

function runnerKey(configId: string, taskId: string): string {
  return `${configId}:${taskId}`
}

function isCurrentRunner(configId: string, taskId: string): boolean {
  return !stopped && runners.get(configId)?.taskId === taskId
}

function forgetRunner(configId: string, taskId: string): void {
  const current = runners.get(configId)
  if (current?.taskId === taskId) runners.delete(configId)
}

function scheduleRunner(configId: string, taskId: string, delayMs: number): void {
  if (!isCurrentRunner(configId, taskId)) return
  const timer = setTimeout(() => {
    void runDavSyncRunner(configId, taskId)
  }, delayMs)
  runners.set(configId, { taskId, timer })
}

function shouldStopAfterError(error: unknown): boolean {
  return /not found|superseded|generation changed|removed during sync/i.test(String(error))
}

function enqueueDavSyncOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation)
  operationTail = result.then(() => undefined, () => undefined)
  return result
}

async function runDavSyncRunner(configId: string, taskId: string): Promise<void> {
  if (!isCurrentRunner(configId, taskId)) return
  try {
    const task = await runDavSyncStep(configId, taskId)
    if (!isCurrentRunner(configId, taskId)) return
    if (!isActiveStatus(task.status)) {
      forgetRunner(configId, taskId)
      return
    }
    scheduleRunner(configId, taskId, RUNNER_STEP_DELAY_MS)
  } catch (error) {
    if (!isCurrentRunner(configId, taskId)) return
    if (shouldStopAfterError(error)) {
      forgetRunner(configId, taskId)
      return
    }
    console.error('[WebDAV Plugin] Background sync step failed; retrying', String(error))
    scheduleRunner(configId, taskId, RUNNER_RETRY_DELAY_MS)
  }
}

export async function runDavSyncStep(
  configId: string,
  taskId: string
): Promise<DavSyncTaskView> {
  const key = runnerKey(configId, taskId)
  const existing = inFlightSteps.get(key)
  if (existing) return await existing

  const step = enqueueDavSyncOperation(() => advanceDavSyncTask(configId, taskId))
  inFlightSteps.set(key, step)
  try {
    return await step
  } finally {
    if (inFlightSteps.get(key) === step) inFlightSteps.delete(key)
  }
}

export function ensureDavSyncRunner(configId: string, taskId: string): void {
  const current = runners.get(configId)
  if (!stopped && current?.taskId === taskId) return
  if (current) clearTimeout(current.timer)
  stopped = false
  const timer = setTimeout(() => {
    void runDavSyncRunner(configId, taskId)
  }, RUNNER_STEP_DELAY_MS)
  runners.set(configId, { taskId, timer })
}

export async function startDavSyncInBackground(identifier: string): Promise<DavSyncTaskView> {
  const task = await enqueueDavSyncOperation(() => startDavSyncTask(identifier))
  ensureDavSyncRunner(task.configId, task.taskId)
  return task
}

export async function cancelDavSyncInBackground(
  identifier: string,
  taskId: string
): Promise<DavSyncCancelResult> {
  const result = await enqueueDavSyncOperation(() => cancelDavSyncTask(identifier, taskId))
  if (isActiveStatus(result.task.status)) {
    ensureDavSyncRunner(result.task.configId, result.task.taskId)
  }
  return result
}

export async function resumeDavSyncRunners(): Promise<void> {
  stopped = false
  const configs = await getConfigs()
  for (const config of configs) {
    if (!config.id) continue
    try {
      const task = await getDavSyncTask(config.id)
      if (task && isActiveStatus(task.status)) {
        ensureDavSyncRunner(config.id, task.taskId)
      }
    } catch (error) {
      console.error('[WebDAV Plugin] Failed to resume background sync', String(error))
    }
  }
}

export function stopDavSyncRunners(): void {
  stopped = true
  for (const runner of runners.values()) clearTimeout(runner.timer)
  runners.clear()
}

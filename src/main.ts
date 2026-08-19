import type { HTTPRequest, HTTPResponse } from '@songloft/plugin-sdk'
import router from './router'
import { resumeDavSyncRunners, stopDavSyncRunners } from './sync-runner'

async function onInit(): Promise<void> {
  console.log('[WebDAV Plugin] Mounted')
  await resumeDavSyncRunners()
}

async function onDeinit(): Promise<void> {
  stopDavSyncRunners()
  console.log('[WebDAV Plugin] Unmounted')
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return await router.handle(req)
}

globalThis.onInit = onInit
globalThis.onDeinit = onDeinit
globalThis.onHTTPRequest = onHTTPRequest

import {
  beginDavSync,
  createEmptyDavSyncState,
  getConfigs,
  matchesDavConfigIdentifier,
  normalizeDavSyncState,
  saveConfigs,
  type DavConfig,
  type DavSyncState
} from './config'
import { normalizeDavScanRoot } from './client'

export interface DavSyncRootView {
  id: string
  configId: string
  configName: string
  path: string
  generation: number
  lastSuccessfulAt: string
  managedPlaylistCount: number
  managedSongCount: number
}

function syncState(config: DavConfig): DavSyncState {
  return config.sync ? normalizeDavSyncState(config.sync) : createEmptyDavSyncState()
}

function findConfigIndex(configs: DavConfig[], identifier: string): number {
  const exactId = configs.findIndex(config => config.id === identifier)
  return exactId >= 0
    ? exactId
    : configs.findIndex(config => matchesDavConfigIdentifier(config, identifier))
}

function totalManagedSongs(state: DavSyncState): number {
  if (!state.lastSuccessfulSnapshot) return 0
  return Object.values(state.lastSuccessfulSnapshot.directories)
    .reduce((total, directory) => total + directory.managedSongIds.length, 0)
}

export async function listDavSyncRoots(): Promise<DavSyncRootView[]> {
  const configs = await getConfigs()
  return configs.flatMap(config => {
    if (!config.id) return []
    const state = syncState(config)
    return [{
      id: config.id,
      configId: config.id,
      configName: config.name,
      path: state.scanRoot,
      generation: state.generation,
      lastSuccessfulAt: state.lastSuccessfulSnapshot?.completedAt || '',
      managedPlaylistCount: Object.keys(state.directoryPlaylists).length,
      managedSongCount: totalManagedSongs(state)
    }]
  })
}

export async function setDavSyncRoot(
  identifier: string,
  requestedPath: string
): Promise<DavSyncRootView> {
  const configs = await getConfigs()
  const index = findConfigIndex(configs, identifier)
  if (index < 0) throw new Error('WebDAV config not found')
  const config = configs[index]
  const currentState = syncState(config)
  const scanRoot = normalizeDavScanRoot(
    config,
    requestedPath || '/',
    { mountRelative: true }
  )
  const nextState = scanRoot === currentState.scanRoot
    ? currentState
    : { ...beginDavSync(currentState), scanRoot }
  configs[index] = { ...config, sync: nextState }
  await saveConfigs(configs)
  return {
    id: config.id!,
    configId: config.id!,
    configName: config.name,
    path: nextState.scanRoot,
    generation: nextState.generation,
    lastSuccessfulAt: nextState.lastSuccessfulSnapshot?.completedAt || '',
    managedPlaylistCount: Object.keys(nextState.directoryPlaylists).length,
    managedSongCount: totalManagedSongs(nextState)
  }
}

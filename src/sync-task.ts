import {
  beginDavSync,
  commitDavSyncSnapshot,
  createEmptyDavSyncState,
  getConfigs,
  getManagedSongRemovals,
  matchesDavConfigIdentifier,
  normalizeDavSyncState,
  saveConfigs,
  type DavConfig,
  type DavDirectoryPlaylistMapping,
  type DavManagedDirectorySnapshot,
  type DavPendingPlaylistCreation,
  type DavSyncState
} from './config'
import { buildDavResourceKey } from './client'
import {
  createDavScanCursor,
  scanDavDirectoryBatch,
  snapshotDirectoryFromScan,
  type DavScanCursor,
  type DavScanResult,
  type ScannedDavDirectory,
  type ScannedDavSong
} from './scanner'

const TASK_SCHEMA_VERSION = 1
const SONG_BATCH_SIZE = 100
const SONG_ADOPTION_PAGE_SIZE = 500
const MAX_ADOPTION_SONGS = 100000
const PLAYLIST_MEMBER_BATCH_SIZE = 200

export type DavSyncTaskStatus =
  | 'queued'
  | 'scanning'
  | 'applying'
  | 'succeeded'
  | 'failed'
  | 'failed_partial'
  | 'cancelled'

export type DavSyncApplyPhase =
  | 'validate-songs'
  | 'adopt-songs'
  | 'create-songs'
  | 'prepare-playlists'
  | 'add-members'
  | 'preflight-removals'
  | 'remove-members'
  | 'finalize'

export interface DavSyncTaskProgress {
  scannedDirectories: number
  pendingDirectories: number
  scannedEntries: number
  musicFiles: number
  songsReady: number
  playlistsPrepared: number
  playlistsTotal: number
  additionsCompleted: number
  removalsCompleted: number
}

interface PersistedDirectoryApplyPlan {
  directoryKey: string
  path: string
  playlistId: number
  previousManagedSongIds: number[]
  currentManagedSongIds: number[]
  currentResourceKeys: string[]
}

interface DavSyncApplyCursor {
  phase: DavSyncApplyPhase
  previousPairIndex: number
  adoptionOffset: number
  adoptionAnchorId: number
  createSongIndex: number
  pendingSongResourceKeys: string[]
  pendingSongNextIndex: number
  pendingSongAdoptionOffset: number
  pendingSongAdoptionAnchorId: number
  playlistIndex: number
  additionIndex: number
  preflightIndex: number
  removalIndex: number
  resourceSongIds: Record<string, number>
  directoryPlaylists: Record<string, DavDirectoryPlaylistMapping>
  relevantDirectoryKeys: string[]
  plans: PersistedDirectoryApplyPlan[]
  createdPlaylists: number
  addedMembers: number
  removedMembers: number
  reorderedPlaylists: number
  sideEffectsApplied: number
}

export interface DavSyncTaskResult {
  success: true
  generation: number
  scannedDirectories: number
  scannedEntries: number
  musicFiles: number
  createdPlaylists: number
  addedMembers: number
  removedMembers: number
  reorderedPlaylists: number
  completedAt: string
}

interface PersistedDavSyncTask {
  schemaVersion: typeof TASK_SCHEMA_VERSION
  checkpoint: number
  taskId: string
  configId: string
  rootPath: string
  generation: number
  status: DavSyncTaskStatus
  phase: 'queued' | 'scanning' | DavSyncApplyPhase | 'succeeded' | 'failed' | 'failed_partial' | 'cancelled'
  cancelRequested: boolean
  createdAt: string
  startedAt: string
  updatedAt: string
  completedAt: string
  error: string
  progress: DavSyncTaskProgress
  scan?: DavScanCursor
  scanResult?: DavScanResult
  apply?: DavSyncApplyCursor
  result?: DavSyncTaskResult
}

export interface DavSyncTaskView {
  taskId: string
  configId: string
  rootPath: string
  generation: number
  status: DavSyncTaskStatus
  phase: PersistedDavSyncTask['phase']
  cancelRequested: boolean
  createdAt: string
  startedAt: string
  updatedAt: string
  completedAt: string
  error: string
  progress: DavSyncTaskProgress
  result?: DavSyncTaskResult
}

export interface DavSyncCancelResult {
  task: DavSyncTaskView
  tooLate: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function isActiveStatus(status: DavSyncTaskStatus): boolean {
  return status === 'queued' || status === 'scanning' || status === 'applying'
}

function uniqueNumbers(values: number[]): number[] {
  return Array.from(new Set(values.filter(value => Number.isInteger(value) && value > 0)))
}

function arraysEqual(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function stableShortHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function createTaskId(configId: string, generation: number): string {
  const entropy = `${configId}\n${generation}\n${Date.now()}\n${Math.random()}`
  return `davsync_${generation}_${stableShortHash(entropy)}`
}

function emptyProgress(): DavSyncTaskProgress {
  return {
    scannedDirectories: 0,
    pendingDirectories: 0,
    scannedEntries: 0,
    musicFiles: 0,
    songsReady: 0,
    playlistsPrepared: 0,
    playlistsTotal: 0,
    additionsCompleted: 0,
    removalsCompleted: 0
  }
}

function taskView(task: PersistedDavSyncTask): DavSyncTaskView {
  return {
    taskId: task.taskId,
    configId: task.configId,
    rootPath: task.rootPath,
    generation: task.generation,
    status: task.status,
    phase: task.phase,
    cancelRequested: task.cancelRequested,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    error: task.error,
    progress: { ...task.progress },
    ...(task.result ? { result: { ...task.result } } : {})
  }
}

function normalizeTask(value: unknown): PersistedDavSyncTask | undefined {
  if (!isRecord(value) || value.schemaVersion !== TASK_SCHEMA_VERSION) return undefined
  if (typeof value.taskId !== 'string' || typeof value.configId !== 'string') return undefined
  if (typeof value.generation !== 'number' || !Number.isInteger(value.generation)) return undefined
  if (typeof value.status !== 'string' || typeof value.phase !== 'string') return undefined
  if (!isRecord(value.progress)) return undefined
  const task = value as unknown as PersistedDavSyncTask
  task.checkpoint = typeof value.checkpoint === 'number' && Number.isInteger(value.checkpoint)
    ? value.checkpoint
    : 0
  if (task.apply) {
    task.apply.adoptionAnchorId = task.apply.adoptionAnchorId || 0
    task.apply.pendingSongResourceKeys = Array.isArray(task.apply.pendingSongResourceKeys)
      ? task.apply.pendingSongResourceKeys.filter(key => typeof key === 'string')
      : []
    task.apply.pendingSongNextIndex = task.apply.pendingSongNextIndex || 0
    task.apply.pendingSongAdoptionOffset = task.apply.pendingSongAdoptionOffset || 0
    task.apply.pendingSongAdoptionAnchorId = task.apply.pendingSongAdoptionAnchorId || 0
    task.apply.sideEffectsApplied = task.apply.sideEffectsApplied || 0
  }
  return task
}

function taskStorageKey(configId: string, slot: 'a' | 'b'): string {
  return `dav_sync_task_${configId}_${slot}`
}

async function loadTaskSlot(configId: string, slot: 'a' | 'b'): Promise<PersistedDavSyncTask | undefined> {
  try {
    const raw = await songloft.storage.get(taskStorageKey(configId, slot))
    if (raw == null || typeof raw !== 'string') return undefined
    const task = normalizeTask(JSON.parse(raw))
    return task?.configId === configId ? task : undefined
  } catch (error) {
    songloft.log.warn(`Ignoring corrupt WebDAV sync checkpoint ${slot}: ${String(error)}`)
    return undefined
  }
}

async function loadTask(configId: string): Promise<PersistedDavSyncTask | undefined> {
  const [left, right] = await Promise.all([
    loadTaskSlot(configId, 'a'),
    loadTaskSlot(configId, 'b')
  ])
  if (!left) return right
  if (!right) return left
  return left.checkpoint >= right.checkpoint ? left : right
}

async function writeTaskCheckpoint(task: PersistedDavSyncTask): Promise<void> {
  task.checkpoint += 1
  const slot = task.checkpoint % 2 === 0 ? 'a' : 'b'
  await songloft.storage.set(taskStorageKey(task.configId, slot), JSON.stringify(task))
}

async function saveNewTask(task: PersistedDavSyncTask): Promise<void> {
  await writeTaskCheckpoint(task)
}

export async function deleteDavSyncTaskCheckpoints(configId: string): Promise<void> {
  await Promise.all([
    songloft.storage.delete(taskStorageKey(configId, 'a')),
    songloft.storage.delete(taskStorageKey(configId, 'b'))
  ])
}

async function loadFencedTask(configId: string, taskId: string): Promise<{
  task: PersistedDavSyncTask
  config: DavConfig
  configs: DavConfig[]
  configIndex: number
}> {
  const [task, configs] = await Promise.all([loadTask(configId), getConfigs()])
  if (!task || task.taskId !== taskId) {
    throw new Error('WebDAV sync task was superseded by a newer task')
  }
  const configIndex = configs.findIndex(config => config.id === configId)
  if (configIndex < 0) throw new Error('WebDAV config was removed during sync')
  const config = configs[configIndex]
  if (syncState(config).generation !== task.generation) {
    throw new Error('WebDAV sync task was superseded by a newer generation')
  }
  return { task, config, configs, configIndex }
}

async function persistFencedTask(task: PersistedDavSyncTask): Promise<void> {
  const fenced = await loadFencedTask(task.configId, task.taskId)
  if (fenced.task.generation !== task.generation) {
    throw new Error('WebDAV sync task generation changed')
  }
  const latest = await loadTask(task.configId)
  if (!latest || latest.taskId !== task.taskId) {
    throw new Error('WebDAV sync task was superseded by a newer task')
  }
  task.updatedAt = new Date().toISOString()
  await writeTaskCheckpoint(task)
}

async function persistSyncState(
  task: PersistedDavSyncTask,
  mutate: (state: DavSyncState) => DavSyncState
): Promise<DavSyncState> {
  const fenced = await loadFencedTask(task.configId, task.taskId)
  const state = syncState(fenced.config)
  const nextState = mutate(state)
  fenced.configs[fenced.configIndex] = {
    ...fenced.config,
    sync: nextState
  }
  await saveConfigs(fenced.configs)
  return nextState
}

async function persistDirectoryMappings(
  task: PersistedDavSyncTask,
  directoryPlaylists: Record<string, DavDirectoryPlaylistMapping>,
  resolvedDirectoryKey?: string
): Promise<void> {
  await persistSyncState(task, state => {
    const pendingPlaylistCreations = { ...state.pendingPlaylistCreations }
    if (resolvedDirectoryKey) delete pendingPlaylistCreations[resolvedDirectoryKey]
    return { ...state, directoryPlaylists, pendingPlaylistCreations }
  })
}

async function persistPlaylistCreationIntent(
  task: PersistedDavSyncTask,
  directoryKey: string,
  intent: DavPendingPlaylistCreation
): Promise<void> {
  await persistSyncState(task, state => ({
    ...state,
    pendingPlaylistCreations: {
      ...state.pendingPlaylistCreations,
      [directoryKey]: intent
    }
  }))
}

async function clearPlaylistCreationIntent(
  task: PersistedDavSyncTask,
  directoryKey: string
): Promise<void> {
  await persistSyncState(task, state => {
    const pendingPlaylistCreations = { ...state.pendingPlaylistCreations }
    delete pendingPlaylistCreations[directoryKey]
    return { ...state, pendingPlaylistCreations }
  })
}

async function journalManagedAdditions(
  task: PersistedDavSyncTask,
  directoryKey: string,
  songIds: number[]
): Promise<void> {
  await persistSyncState(task, state => ({
    ...state,
    provisionalManagedSongIds: {
      ...state.provisionalManagedSongIds,
      [directoryKey]: uniqueNumbers([
        ...(state.provisionalManagedSongIds[directoryKey] || []),
        ...songIds
      ])
    }
  }))
}

function isNotFoundError(error: unknown): boolean {
  return /(?:record\s+)?not\s+found|不存在/i.test(String(error))
}

function isPlaylistNameConflict(error: unknown): boolean {
  return /same name|already exists|name conflict|duplicate|unique|重名|已存在/i.test(String(error))
}

async function getPlaylistIfExists(playlistId: number) {
  try {
    return await songloft.playlists.getById(playlistId)
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

async function getSongIfExists(songId: number) {
  try {
    return await songloft.songs.getById(songId)
  } catch (error) {
    if (isNotFoundError(error)) return null
    throw error
  }
}

function parseSongSourceData(song: unknown): Record<string, unknown> | undefined {
  if (!isRecord(song)) return undefined
  const raw = song.source_data || song.sourceData
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function allScannedSongs(scan: DavScanResult): ScannedDavSong[] {
  return scan.directories.flatMap(directory => directory.songs)
}

function previousResourcePairs(state: DavSyncState): Array<{ resourceKey: string; songId: number }> {
  const pairs: Array<{ resourceKey: string; songId: number }> = []
  const seen = new Set<string>()
  for (const directory of Object.values(state.lastSuccessfulSnapshot?.directories || {})) {
    const count = Math.min(directory.resourceKeys.length, directory.managedSongIds.length)
    for (let index = 0; index < count; index += 1) {
      const resourceKey = directory.resourceKeys[index]
      const songId = directory.managedSongIds[index]
      if (!resourceKey || !Number.isInteger(songId) || songId <= 0 || seen.has(resourceKey)) continue
      seen.add(resourceKey)
      pairs.push({ resourceKey, songId })
    }
  }
  return pairs
}

function wantedResourceKeys(scan: DavScanResult, resourceSongIds: Record<string, number>): Set<string> {
  return new Set(allScannedSongs(scan)
    .map(song => song.resourceKey)
    .filter(resourceKey => !resourceSongIds[resourceKey]))
}

async function listStableSongPage(offset: number, anchorId: number) {
  const anchored = anchorId > 0 && offset > 0
  const options: { limit?: number; offset?: number } & Record<string, string | number> = {
    limit: SONG_ADOPTION_PAGE_SIZE + (anchored ? 1 : 0),
    offset: anchored ? offset - 1 : offset,
    orderBy: 'id',
    order: 'asc'
  }
  const rawPage = await songloft.songs.list(options)
  if (!Array.isArray(rawPage)) throw new Error('Songloft returned an invalid song list')
  if (anchored) {
    if (rawPage[0]?.id !== anchorId) return { drifted: true, songs: [] as typeof rawPage }
    rawPage.shift()
  }
  return { drifted: false, songs: rawPage }
}

function adoptSongsFromPage(
  page: Awaited<ReturnType<typeof songloft.songs.list>>,
  config: DavConfig,
  wanted: Set<string>,
  resourceSongIds: Record<string, number>
): void {
  for (const song of page) {
    if (song.plugin_entry_path !== 'dav' || !Number.isInteger(song.id) || song.id <= 0) continue
    const sourceData = parseSongSourceData(song)
    if (!sourceData) continue
    const configRef = typeof sourceData.configId === 'string'
      ? sourceData.configId
      : typeof sourceData.configName === 'string'
        ? sourceData.configName
        : ''
    const path = typeof sourceData.path === 'string' ? sourceData.path : ''
    if (!configRef || !path || !matchesDavConfigIdentifier(config, configRef)) continue
    try {
      const mountRelative = sourceData.pathMode === 'mount-relative'
      const resourceKey = buildDavResourceKey(config, path, {
        mountRelative,
        legacyEndpointAliases: !mountRelative
      })
      if (wanted.has(resourceKey) && !resourceSongIds[resourceKey]) {
        resourceSongIds[resourceKey] = song.id
        wanted.delete(resourceKey)
      }
    } catch {
      continue
    }
  }
}

async function ensurePlaylist(
  config: DavConfig,
  directory: ScannedDavDirectory,
  mapping: DavDirectoryPlaylistMapping | undefined,
  intent: DavPendingPlaylistCreation
): Promise<{ playlistId: number; created: boolean }> {
  if (mapping) {
    const existing = await getPlaylistIfExists(mapping.playlistId)
    if (existing) return { playlistId: mapping.playlistId, created: false }
  }

  const playlists = await songloft.playlists.list()
  const marker = `[songloft-dav:${intent.token}]`
  const recovered = playlists.find(playlist => playlist.description?.includes(marker))
  if (recovered && Number.isInteger(recovered.id) && recovered.id > 0) {
    return { playlistId: recovered.id, created: false }
  }
  const names = new Set(playlists.map(playlist => playlist.name))
  const label = (directory.name || config.name).slice(0, 80)
  const baseName = `${label} · WebDAV ${stableShortHash(directory.directoryKey)}`
  for (let attempt = 1; attempt <= 100; attempt += 1) {
    const name = attempt === 1 ? baseName : `${baseName} (${attempt})`
    if (names.has(name)) continue
    try {
      const playlist = await songloft.playlists.create({
        name,
        type: 'normal',
        description: `WebDAV 同步 · ${config.name} ${marker} · ${directory.path}`
      })
      if (!playlist || !Number.isInteger(playlist.id) || playlist.id <= 0) {
        throw new Error('Songloft returned an invalid playlist ID')
      }
      return { playlistId: playlist.id, created: true }
    } catch (error) {
      if (!isPlaylistNameConflict(error)) throw error
      names.add(name)
    }
  }
  throw new Error('Unable to allocate a unique WebDAV playlist name')
}

async function recoverPlaylistFromIntent(
  intent: DavPendingPlaylistCreation
): Promise<number | undefined> {
  const marker = `[songloft-dav:${intent.token}]`
  const recovered = (await songloft.playlists.list())
    .find(playlist => playlist.description?.includes(marker))
  return recovered && Number.isInteger(recovered.id) && recovered.id > 0
    ? recovered.id
    : undefined
}

function createApplyCursor(config: DavConfig, scan: DavScanResult): DavSyncApplyCursor {
  const state = syncState(config)
  const previousDirectories = state.lastSuccessfulSnapshot?.directories || {}
  const relevantDirectoryKeys = Array.from(new Set([
    ...Object.keys(previousDirectories),
    ...Object.keys(state.provisionalManagedSongIds),
    ...Object.keys(state.pendingPlaylistCreations),
    ...scan.directories
      .filter(directory => directory.songs.length > 0 || state.directoryPlaylists[directory.directoryKey])
      .map(directory => directory.directoryKey)
  ])).sort()
  return {
    phase: 'validate-songs',
    previousPairIndex: 0,
    adoptionOffset: 0,
    adoptionAnchorId: 0,
    createSongIndex: 0,
    pendingSongResourceKeys: [],
    pendingSongNextIndex: 0,
    pendingSongAdoptionOffset: 0,
    pendingSongAdoptionAnchorId: 0,
    playlistIndex: 0,
    additionIndex: 0,
    preflightIndex: 0,
    removalIndex: 0,
    resourceSongIds: {},
    directoryPlaylists: { ...state.directoryPlaylists },
    relevantDirectoryKeys,
    plans: [],
    createdPlaylists: 0,
    addedMembers: 0,
    removedMembers: 0,
    reorderedPlaylists: 0,
    sideEffectsApplied: 0
  }
}

function updateApplyProgress(task: PersistedDavSyncTask): void {
  const apply = task.apply
  if (!apply) return
  task.progress.songsReady = Object.keys(apply.resourceSongIds).length
  task.progress.playlistsPrepared = apply.plans.length
  task.progress.playlistsTotal = apply.relevantDirectoryKeys.length
  task.progress.additionsCompleted = apply.additionIndex
  task.progress.removalsCompleted = apply.removalIndex
  task.phase = apply.phase
}

async function advanceValidateSongs(
  task: PersistedDavSyncTask,
  config: DavConfig,
  state: DavSyncState
): Promise<void> {
  const apply = task.apply!
  const pairs = previousResourcePairs(state)
  const end = Math.min(pairs.length, apply.previousPairIndex + SONG_BATCH_SIZE)
  for (let index = apply.previousPairIndex; index < end; index += 1) {
    const pair = pairs[index]
    if (await getSongIfExists(pair.songId)) apply.resourceSongIds[pair.resourceKey] = pair.songId
  }
  apply.previousPairIndex = end
  if (end >= pairs.length) apply.phase = 'adopt-songs'
  await loadFencedTask(config.id!, task.taskId)
}

async function advanceAdoptSongs(
  task: PersistedDavSyncTask,
  config: DavConfig,
  scan: DavScanResult
): Promise<void> {
  const apply = task.apply!
  const wanted = wantedResourceKeys(scan, apply.resourceSongIds)
  if (wanted.size === 0) {
    apply.phase = 'create-songs'
    return
  }
  if (apply.adoptionOffset >= MAX_ADOPTION_SONGS) {
    throw new Error(`Songloft library exceeds DAV adoption limit ${MAX_ADOPTION_SONGS}`)
  }

  const listed = await listStableSongPage(apply.adoptionOffset, apply.adoptionAnchorId)
  if (listed.drifted) {
    apply.adoptionOffset = 0
    apply.adoptionAnchorId = 0
    return
  }
  const page = listed.songs
  adoptSongsFromPage(page, config, wanted, apply.resourceSongIds)
  apply.adoptionOffset += page.length
  if (page.length > 0) apply.adoptionAnchorId = page[page.length - 1].id
  if (wanted.size === 0 || page.length < SONG_ADOPTION_PAGE_SIZE) {
    apply.phase = 'create-songs'
  }
  await loadFencedTask(config.id!, task.taskId)
}

async function createDavSongs(config: DavConfig, songs: ScannedDavSong[]) {
  const created = await songloft.songs.create(songs.map(song => ({
    title: song.title,
    artist: '未知歌手',
    album: '',
    duration: 0,
    sourceData: JSON.stringify({
      configId: config.id,
      configName: config.name,
      path: song.path,
      pathMode: 'mount-relative'
    }),
    dedupKey: song.dedupKey
  })))
  if (!Array.isArray(created) || created.length !== songs.length) {
    throw new Error('Songloft returned an incomplete DAV song upsert result')
  }
  for (const song of created) {
    if (!Number.isInteger(song?.id) || song.id <= 0) {
      throw new Error('Songloft returned an invalid DAV song ID')
    }
  }
  return created
}

async function advanceCreateSongs(
  task: PersistedDavSyncTask,
  config: DavConfig,
  scan: DavScanResult
): Promise<void> {
  const apply = task.apply!
  const songs = allScannedSongs(scan)
  const byResourceKey = new Map(songs.map(song => [song.resourceKey, song]))

  if (apply.pendingSongResourceKeys.length > 0) {
    const wanted = new Set(apply.pendingSongResourceKeys
      .filter(resourceKey => !apply.resourceSongIds[resourceKey]))
    if (wanted.size > 0) {
      if (apply.pendingSongAdoptionOffset >= MAX_ADOPTION_SONGS) {
        throw new Error(`Songloft library exceeds DAV adoption limit ${MAX_ADOPTION_SONGS}`)
      }
      const listed = await listStableSongPage(
        apply.pendingSongAdoptionOffset,
        apply.pendingSongAdoptionAnchorId
      )
      if (listed.drifted) {
        apply.pendingSongAdoptionOffset = 0
        apply.pendingSongAdoptionAnchorId = 0
        return
      }
      adoptSongsFromPage(listed.songs, config, wanted, apply.resourceSongIds)
      apply.pendingSongAdoptionOffset += listed.songs.length
      if (listed.songs.length > 0) {
        apply.pendingSongAdoptionAnchorId = listed.songs[listed.songs.length - 1].id
      }
      if (wanted.size > 0 && listed.songs.length >= SONG_ADOPTION_PAGE_SIZE) return

      const missing = Array.from(wanted).map(resourceKey => byResourceKey.get(resourceKey))
      if (missing.some(song => !song)) {
        throw new Error('DAV song write-ahead intent no longer matches the scan checkpoint')
      }
      if (missing.length > 0) {
        const created = await createDavSongs(config, missing as ScannedDavSong[])
        apply.sideEffectsApplied += created.length
        for (let index = 0; index < missing.length; index += 1) {
          apply.resourceSongIds[missing[index]!.resourceKey] = created[index].id
        }
      }
    }
    apply.createSongIndex = apply.pendingSongNextIndex
    apply.pendingSongResourceKeys = []
    apply.pendingSongNextIndex = 0
    apply.pendingSongAdoptionOffset = 0
    apply.pendingSongAdoptionAnchorId = 0
  } else if (apply.createSongIndex < songs.length) {
    const nextIndex = Math.min(songs.length, apply.createSongIndex + SONG_BATCH_SIZE)
    const batch = songs.slice(apply.createSongIndex, nextIndex)
      .filter(song => !apply.resourceSongIds[song.resourceKey])
    if (batch.length === 0) {
      apply.createSongIndex = nextIndex
    } else {
      apply.pendingSongResourceKeys = batch.map(song => song.resourceKey)
      apply.pendingSongNextIndex = nextIndex
      apply.pendingSongAdoptionOffset = 0
      apply.pendingSongAdoptionAnchorId = 0
      await persistFencedTask(task)
      const created = await createDavSongs(config, batch)
      apply.sideEffectsApplied += created.length
      for (let index = 0; index < batch.length; index += 1) {
        apply.resourceSongIds[batch[index].resourceKey] = created[index].id
      }
      apply.createSongIndex = nextIndex
      apply.pendingSongResourceKeys = []
      apply.pendingSongNextIndex = 0
    }
  }
  if (apply.createSongIndex >= songs.length && apply.pendingSongResourceKeys.length === 0) {
    apply.phase = 'prepare-playlists'
  }
  await loadFencedTask(config.id!, task.taskId)
}

async function advancePreparePlaylists(
  task: PersistedDavSyncTask,
  config: DavConfig,
  state: DavSyncState,
  scan: DavScanResult
): Promise<void> {
  const apply = task.apply!
  if (apply.playlistIndex >= apply.relevantDirectoryKeys.length) {
    apply.phase = 'add-members'
    return
  }

  const directoryKey = apply.relevantDirectoryKeys[apply.playlistIndex]
  const directory = scan.directories.find(candidate => candidate.directoryKey === directoryKey)
  const previous = state.lastSuccessfulSnapshot?.directories[directoryKey]
  let mapping: DavDirectoryPlaylistMapping | undefined =
    apply.directoryPlaylists[directoryKey] || state.directoryPlaylists[directoryKey]
  let pendingIntent: DavPendingPlaylistCreation | undefined =
    state.pendingPlaylistCreations[directoryKey]
  if (mapping && !apply.directoryPlaylists[directoryKey]) {
    apply.directoryPlaylists[directoryKey] = mapping
  }
  if (mapping && !await getPlaylistIfExists(mapping.playlistId)) {
    delete apply.directoryPlaylists[directoryKey]
    mapping = undefined
    await persistDirectoryMappings(task, apply.directoryPlaylists)
  }
  if (!mapping && pendingIntent) {
    const recoveredPlaylistId = await recoverPlaylistFromIntent(pendingIntent)
    if (recoveredPlaylistId) {
      mapping = { path: pendingIntent.path, playlistId: recoveredPlaylistId }
      apply.directoryPlaylists[directoryKey] = mapping
      await persistDirectoryMappings(task, apply.directoryPlaylists, directoryKey)
      pendingIntent = undefined
    } else if (!directory?.songs.length) {
      await clearPlaylistCreationIntent(task, directoryKey)
      pendingIntent = undefined
    }
  }
  if (directory?.songs.length && !mapping) {
    if (!pendingIntent) {
      pendingIntent = {
        path: directory.path,
        token: `pl_${stableShortHash(`${task.taskId}\n${directoryKey}`)}${stableShortHash(`${directoryKey}\n${task.taskId}`)}`
      }
      await persistPlaylistCreationIntent(task, directoryKey, pendingIntent)
    }
    const ensured = await ensurePlaylist(config, directory, undefined, pendingIntent)
    if (ensured.created) {
      apply.createdPlaylists += 1
      apply.sideEffectsApplied += 1
    }
    mapping = { path: directory.path, playlistId: ensured.playlistId }
    apply.directoryPlaylists[directoryKey] = mapping
    await persistDirectoryMappings(task, apply.directoryPlaylists, directoryKey)
  }
  if (!mapping) {
    apply.playlistIndex += 1
    return
  }

  const playlist = await getPlaylistIfExists(mapping.playlistId)
  if (!playlist) {
    delete apply.directoryPlaylists[directoryKey]
    await persistDirectoryMappings(task, apply.directoryPlaylists)
    apply.playlistIndex += 1
    return
  }
  const currentManagedSongIds = directory
    ? directory.songs
        .map(song => apply.resourceSongIds[song.resourceKey])
        .filter((songId): songId is number => typeof songId === 'number')
    : []
  if (directory && currentManagedSongIds.length !== directory.songs.length) {
    throw new Error(`DAV song reconciliation is incomplete for ${directory.path}`)
  }
  apply.plans.push({
    directoryKey,
    path: directory?.path || previous?.path || mapping.path,
    playlistId: mapping.playlistId,
    previousManagedSongIds: uniqueNumbers([
      ...(previous?.managedSongIds || []),
      ...(state.provisionalManagedSongIds[directoryKey] || [])
    ]),
    currentManagedSongIds: uniqueNumbers(currentManagedSongIds),
    currentResourceKeys: directory?.songs.map(song => song.resourceKey) || []
  })
  apply.playlistIndex += 1
  if (apply.playlistIndex >= apply.relevantDirectoryKeys.length) apply.phase = 'add-members'
  await loadFencedTask(config.id!, task.taskId)
}

async function advanceAddMembers(task: PersistedDavSyncTask, config: DavConfig): Promise<void> {
  const apply = task.apply!
  if (apply.additionIndex >= apply.plans.length) {
    apply.phase = 'preflight-removals'
    return
  }
  const plan = apply.plans[apply.additionIndex]
  const actual = new Set(uniqueNumbers(
    (await songloft.playlists.getSongs(plan.playlistId)).map(song => song.id)
  ))
  const additions = plan.currentManagedSongIds
    .filter(songId => !actual.has(songId))
    .slice(0, PLAYLIST_MEMBER_BATCH_SIZE)
  if (additions.length > 0) {
    await journalManagedAdditions(task, plan.directoryKey, additions)
    const result = await songloft.playlists.addSongs(plan.playlistId, additions)
    if (result.skipped > 0) {
      throw new Error('Songloft skipped DAV playlist members during reconciliation')
    }
    apply.addedMembers += result.added
    apply.sideEffectsApplied += result.added
    await loadFencedTask(config.id!, task.taskId)
    return
  }
  apply.additionIndex += 1
  if (apply.additionIndex >= apply.plans.length) apply.phase = 'preflight-removals'
  await loadFencedTask(config.id!, task.taskId)
}

async function advancePreflight(task: PersistedDavSyncTask, config: DavConfig): Promise<void> {
  const apply = task.apply!
  if (apply.preflightIndex >= apply.plans.length) {
    apply.phase = 'remove-members'
    return
  }
  const plan = apply.plans[apply.preflightIndex]
  const currentMembers = new Set(uniqueNumbers(
    (await songloft.playlists.getSongs(plan.playlistId)).map(song => song.id)
  ))
  if (plan.currentManagedSongIds.some(songId => !currentMembers.has(songId))) {
    throw new Error(`DAV playlist reconciliation is incomplete for ${plan.path}`)
  }
  apply.preflightIndex += 1
  if (apply.preflightIndex >= apply.plans.length) apply.phase = 'remove-members'
  await loadFencedTask(config.id!, task.taskId)
}

async function advanceRemoveMembers(task: PersistedDavSyncTask, config: DavConfig): Promise<void> {
  const apply = task.apply!
  if (apply.removalIndex >= apply.plans.length) {
    apply.phase = 'finalize'
    return
  }
  const plan = apply.plans[apply.removalIndex]
  await loadFencedTask(config.id!, task.taskId)
  const removals = getManagedSongRemovals(
    plan.previousManagedSongIds,
    plan.currentManagedSongIds
  )
  const actualBefore = new Set(uniqueNumbers(
    (await songloft.playlists.getSongs(plan.playlistId)).map(song => song.id)
  ))
  const removalBatch = removals
    .filter(songId => actualBefore.has(songId))
    .slice(0, PLAYLIST_MEMBER_BATCH_SIZE)
  if (removalBatch.length > 0) {
    await songloft.playlists.removeSongs(plan.playlistId, removalBatch)
    apply.removedMembers += removalBatch.length
    apply.sideEffectsApplied += removalBatch.length
    await loadFencedTask(config.id!, task.taskId)
    return
  }

  const actualAfter = uniqueNumbers(
    (await songloft.playlists.getSongs(plan.playlistId)).map(song => song.id)
  )
  const actualSet = new Set(actualAfter)
  const managedOrder = plan.currentManagedSongIds.filter(songId => actualSet.has(songId))
  const managedSet = new Set(managedOrder)
  const userOrder = actualAfter.filter(songId => !managedSet.has(songId))
  const targetOrder = [...managedOrder, ...userOrder]
  if (!arraysEqual(actualAfter, targetOrder)) {
    await songloft.playlists.reorder(plan.playlistId, targetOrder)
    apply.reorderedPlaylists += 1
    apply.sideEffectsApplied += 1
  }
  apply.removalIndex += 1
  if (apply.removalIndex >= apply.plans.length) apply.phase = 'finalize'
  await loadFencedTask(config.id!, task.taskId)
}

async function finalizeTask(
  task: PersistedDavSyncTask,
  config: DavConfig,
  scan: DavScanResult
): Promise<void> {
  const apply = task.apply!
  const fenced = await loadFencedTask(config.id!, task.taskId)
  const state = syncState(fenced.config)
  const scannedByKey = new Map(scan.directories.map(directory => [directory.directoryKey, directory]))
  const directories: Record<string, DavManagedDirectorySnapshot> = {}
  for (const plan of apply.plans) {
    const directory = scannedByKey.get(plan.directoryKey)
    directories[plan.directoryKey] = directory
      ? snapshotDirectoryFromScan(directory, plan.currentManagedSongIds)
      : {
          path: plan.path,
          resourceKeys: plan.currentResourceKeys,
          managedSongIds: plan.currentManagedSongIds
        }
  }
  const completedAt = new Date().toISOString()
  fenced.configs[fenced.configIndex] = {
    ...fenced.config,
    sync: commitDavSyncSnapshot(
      { ...state, scanRoot: scan.scanRoot },
      task.generation,
      {
        complete: true,
        completedAt,
        directoryPlaylists: apply.directoryPlaylists,
        directories
      }
    )
  }
  await saveConfigs(fenced.configs)

  task.status = 'succeeded'
  task.phase = 'succeeded'
  task.completedAt = completedAt
  task.result = {
    success: true,
    generation: task.generation,
    scannedDirectories: scan.scannedDirectoryCount,
    scannedEntries: scan.scannedEntryCount,
    musicFiles: scan.musicFileCount,
    createdPlaylists: apply.createdPlaylists,
    addedMembers: apply.addedMembers,
    removedMembers: apply.removedMembers,
    reorderedPlaylists: apply.reorderedPlaylists,
    completedAt
  }
  task.progress.songsReady = scan.musicFileCount
  task.progress.playlistsPrepared = apply.plans.length
  task.progress.additionsCompleted = apply.plans.length
  task.progress.removalsCompleted = apply.plans.length
  delete task.scan
  delete task.scanResult
  delete task.apply
}

async function advanceApplying(task: PersistedDavSyncTask, config: DavConfig): Promise<void> {
  const scan = task.scanResult
  const apply = task.apply
  if (!scan || !apply) throw new Error('WebDAV sync task has no complete discovery checkpoint')
  const state = syncState(config)
  switch (apply.phase) {
    case 'validate-songs':
      await advanceValidateSongs(task, config, state)
      break
    case 'adopt-songs':
      await advanceAdoptSongs(task, config, scan)
      break
    case 'create-songs':
      await advanceCreateSongs(task, config, scan)
      break
    case 'prepare-playlists':
      await advancePreparePlaylists(task, config, state, scan)
      break
    case 'add-members':
      await advanceAddMembers(task, config)
      break
    case 'preflight-removals':
      await advancePreflight(task, config)
      break
    case 'remove-members':
      await advanceRemoveMembers(task, config)
      break
    case 'finalize':
      await finalizeTask(task, config, scan)
      break
  }
  updateApplyProgress(task)
}

async function markTaskFailed(task: PersistedDavSyncTask, error: unknown): Promise<DavSyncTaskView> {
  const partial = Boolean(task.apply && task.apply.sideEffectsApplied > 0)
  task.status = partial ? 'failed_partial' : 'failed'
  task.phase = partial ? 'failed_partial' : 'failed'
  task.error = String(error)
  task.completedAt = new Date().toISOString()
  try {
    await persistFencedTask(task)
  } catch (persistError) {
    if (/superseded|removed/i.test(String(persistError))) throw persistError
    throw new Error(`${task.error}; additionally failed to persist task error: ${String(persistError)}`)
  }
  return taskView(task)
}

export async function startDavSyncTask(identifier: string): Promise<DavSyncTaskView> {
  const configs = await getConfigs()
  const index = findConfigIndex(configs, identifier)
  if (index < 0) throw new Error('WebDAV config not found')
  const config = configs[index]
  if (!config.id) throw new Error('WebDAV config has no stable identity')
  const currentState = syncState(config)
  const existing = await loadTask(config.id)
  if (existing && isActiveStatus(existing.status) && existing.generation === currentState.generation) {
    return taskView(existing)
  }

  const runningState = beginDavSync(currentState)
  configs[index] = { ...config, sync: runningState }
  await saveConfigs(configs)
  const now = new Date().toISOString()
  const task: PersistedDavSyncTask = {
    schemaVersion: TASK_SCHEMA_VERSION,
    checkpoint: (existing?.checkpoint || 0) + 1,
    taskId: createTaskId(config.id, runningState.generation),
    configId: config.id,
    rootPath: runningState.scanRoot,
    generation: runningState.generation,
    status: 'queued',
    phase: 'queued',
    cancelRequested: false,
    createdAt: now,
    startedAt: '',
    updatedAt: now,
    completedAt: '',
    error: '',
    progress: emptyProgress()
  }
  await saveNewTask(task)
  return taskView(task)
}

export async function getDavSyncTask(identifier: string): Promise<DavSyncTaskView | null> {
  const configs = await getConfigs()
  const index = findConfigIndex(configs, identifier)
  if (index < 0) throw new Error('WebDAV config not found')
  const config = configs[index]
  if (!config.id) return null
  const task = await loadTask(config.id)
  if (!task) return null
  if (isActiveStatus(task.status) && syncState(config).generation !== task.generation) {
    return taskView({
      ...task,
      status: 'failed',
      phase: 'failed',
      error: 'WebDAV sync task was superseded by a newer generation',
      completedAt: task.completedAt || new Date().toISOString()
    })
  }
  return taskView(task)
}

export async function advanceDavSyncTask(
  identifier: string,
  taskId: string
): Promise<DavSyncTaskView> {
  const configs = await getConfigs()
  const index = findConfigIndex(configs, identifier)
  if (index < 0) throw new Error('WebDAV config not found')
  const configId = configs[index].id
  if (!configId) throw new Error('WebDAV config has no stable identity')
  const fenced = await loadFencedTask(configId, taskId)
  const task = fenced.task
  if (!isActiveStatus(task.status)) return taskView(task)

  const removalStarted = task.apply?.phase === 'remove-members' ||
    task.apply?.phase === 'finalize'
  if (task.cancelRequested && !removalStarted) {
    task.status = 'cancelled'
    task.phase = 'cancelled'
    task.completedAt = new Date().toISOString()
    await persistFencedTask(task)
    return taskView(task)
  }

  try {
    if (task.status === 'queued') {
      task.scan = createDavScanCursor(fenced.config, task.rootPath)
      task.status = 'scanning'
      task.phase = 'scanning'
      task.startedAt = new Date().toISOString()
      task.progress.pendingDirectories = 1
    } else if (task.status === 'scanning') {
      if (!task.scan) throw new Error('WebDAV sync task has no scan cursor')
      const batch = await scanDavDirectoryBatch(fenced.config, task.scan)
      await loadFencedTask(configId, taskId)
      task.scan = batch.cursor
      task.progress.scannedDirectories = batch.cursor.visitedPaths.length
      task.progress.pendingDirectories = batch.cursor.queue.length
      task.progress.scannedEntries = batch.cursor.scannedEntryCount
      task.progress.musicFiles = batch.cursor.musicFileCount
      if (batch.complete) {
        task.scanResult = batch.result
        delete task.scan
        task.apply = createApplyCursor(fenced.config, batch.result!)
        task.status = 'applying'
        task.phase = task.apply.phase
        task.progress.playlistsTotal = task.apply.relevantDirectoryKeys.length
      }
    } else if (task.status === 'applying') {
      await advanceApplying(task, fenced.config)
    }
    await persistFencedTask(task)
    return taskView(task)
  } catch (error) {
    if (/superseded|removed during sync/i.test(String(error))) throw error
    return markTaskFailed(task, error)
  }
}

export async function cancelDavSyncTask(
  identifier: string,
  taskId: string
): Promise<DavSyncCancelResult> {
  const configs = await getConfigs()
  const index = findConfigIndex(configs, identifier)
  if (index < 0) throw new Error('WebDAV config not found')
  const configId = configs[index].id
  if (!configId) throw new Error('WebDAV config has no stable identity')
  const fenced = await loadFencedTask(configId, taskId)
  const task = fenced.task
  if (!isActiveStatus(task.status)) return { task: taskView(task), tooLate: false }
  const tooLate = task.apply?.phase === 'remove-members' || task.apply?.phase === 'finalize'
  if (tooLate) return { task: taskView(task), tooLate: true }
  task.cancelRequested = true
  await persistFencedTask(task)
  return { task: taskView(task), tooLate: false }
}

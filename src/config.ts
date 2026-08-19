// No need to import songloft, it's globally provided by QuickJS env

export const DAV_CONFIG_SCHEMA_VERSION = 1
export const DAV_SYNC_SCHEMA_VERSION = 1

export interface DavDirectoryPlaylistMapping {
  path: string
  playlistId: number
}

export interface DavManagedDirectorySnapshot {
  path: string
  resourceKeys: string[]
  managedSongIds: number[]
}

export interface DavSuccessfulSyncSnapshot {
  generation: number
  completedAt: string
  directories: Record<string, DavManagedDirectorySnapshot>
}

export interface DavPendingPlaylistCreation {
  path: string
  token: string
}

export interface DavSyncState {
  schemaVersion: typeof DAV_SYNC_SCHEMA_VERSION
  scanRoot: string
  generation: number
  directoryPlaylists: Record<string, DavDirectoryPlaylistMapping>
  provisionalManagedSongIds: Record<string, number[]>
  pendingPlaylistCreations: Record<string, DavPendingPlaylistCreation>
  lastSuccessfulSnapshot?: DavSuccessfulSyncSnapshot
}

export interface DavSyncCandidate {
  complete: boolean
  completedAt: string
  directoryPlaylists: Record<string, DavDirectoryPlaylistMapping>
  directories: Record<string, DavManagedDirectorySnapshot>
}

export interface DavConfig {
  id?: string
  schemaVersion?: typeof DAV_CONFIG_SCHEMA_VERSION
  url: string
  username?: string
  password?: string
  name: string
  aliases?: string[]
  mountAliases?: string[]
  endpointAliases?: string[]
  sync?: DavSyncState
}

export interface NormalizedDavConfigs {
  configs: DavConfig[]
  migrated: boolean
}

const CONFIG_KEY = 'dav_configs'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function normalizeStoredPath(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') return '/'
  let path = value.trim()
  if (!path.startsWith('/')) path = '/' + path
  path = path.replace(/\/{2,}/g, '/')
  return path === '/' ? path : path.replace(/\/$/, '')
}

function uniqueStrings(value: unknown, excluded?: string): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || item === excluded || seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

function uniqueSongIds(value: unknown): number[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<number>()
  const result: number[] = []
  for (const item of value) {
    if (typeof item !== 'number' || !Number.isInteger(item) || item <= 0 || seen.has(item)) continue
    seen.add(item)
    result.push(item)
  }
  return result
}

function normalizeDirectoryPlaylists(value: unknown): Record<string, DavDirectoryPlaylistMapping> {
  const result: Record<string, DavDirectoryPlaylistMapping> = {}
  if (!isRecord(value)) return result
  for (const [directoryKey, rawMapping] of Object.entries(value)) {
    if (!directoryKey || !isRecord(rawMapping)) continue
    const playlistId = rawMapping.playlistId
    if (typeof playlistId !== 'number' || !Number.isInteger(playlistId) || playlistId <= 0) continue
    result[directoryKey] = {
      path: normalizeStoredPath(rawMapping.path),
      playlistId
    }
  }
  return result
}

function normalizeManagedSongJournal(value: unknown): Record<string, number[]> {
  const result: Record<string, number[]> = {}
  if (!isRecord(value)) return result
  for (const [directoryKey, rawSongIds] of Object.entries(value)) {
    if (!directoryKey) continue
    const songIds = uniqueSongIds(rawSongIds)
    if (songIds.length > 0) result[directoryKey] = songIds
  }
  return result
}

function normalizePendingPlaylistCreations(
  value: unknown
): Record<string, DavPendingPlaylistCreation> {
  const result: Record<string, DavPendingPlaylistCreation> = {}
  if (!isRecord(value)) return result
  for (const [directoryKey, rawIntent] of Object.entries(value)) {
    if (!directoryKey || !isRecord(rawIntent)) continue
    const token = rawIntent.token
    if (typeof token !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(token)) continue
    result[directoryKey] = {
      path: normalizeStoredPath(rawIntent.path),
      token
    }
  }
  return result
}

function normalizeSnapshotDirectories(value: unknown): Record<string, DavManagedDirectorySnapshot> {
  const result: Record<string, DavManagedDirectorySnapshot> = {}
  if (!isRecord(value)) return result
  for (const [directoryKey, rawDirectory] of Object.entries(value)) {
    if (!directoryKey || !isRecord(rawDirectory)) continue
    result[directoryKey] = {
      path: normalizeStoredPath(rawDirectory.path),
      resourceKeys: uniqueStrings(rawDirectory.resourceKeys),
      managedSongIds: uniqueSongIds(rawDirectory.managedSongIds)
    }
  }
  return result
}

function normalizeSuccessfulSnapshot(value: unknown): DavSuccessfulSyncSnapshot | undefined {
  if (!isRecord(value)) return undefined
  const generation = value.generation
  if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 0) return undefined
  return {
    generation,
    completedAt: typeof value.completedAt === 'string' ? value.completedAt : '',
    directories: normalizeSnapshotDirectories(value.directories)
  }
}

export function createEmptyDavSyncState(scanRoot = '/'): DavSyncState {
  return {
    schemaVersion: DAV_SYNC_SCHEMA_VERSION,
    scanRoot: normalizeStoredPath(scanRoot),
    generation: 0,
    directoryPlaylists: {},
    provisionalManagedSongIds: {},
    pendingPlaylistCreations: {}
  }
}

export function normalizeDavSyncState(value: unknown): DavSyncState {
  if (!isRecord(value)) return createEmptyDavSyncState()
  const generation = typeof value.generation === 'number' &&
    Number.isInteger(value.generation) && value.generation >= 0
    ? value.generation
    : 0
  const snapshot = normalizeSuccessfulSnapshot(
    value.lastSuccessfulSnapshot || value.snapshot
  )
  const state: DavSyncState = {
    schemaVersion: DAV_SYNC_SCHEMA_VERSION,
    scanRoot: normalizeStoredPath(value.scanRoot || value.rootPath),
    generation,
    directoryPlaylists: normalizeDirectoryPlaylists(
      value.directoryPlaylists || value.playlists
    ),
    provisionalManagedSongIds: normalizeManagedSongJournal(
      value.provisionalManagedSongIds
    ),
    pendingPlaylistCreations: normalizePendingPlaylistCreations(
      value.pendingPlaylistCreations
    )
  }
  if (snapshot) state.lastSuccessfulSnapshot = snapshot
  return state
}

function createConfigId(raw: Record<string, unknown>, index: number, usedIds: Set<string>): string {
  const seed = [raw.url, raw.username, raw.name, index].map(value => String(value || '')).join('\n')
  const base = `dav_${stableHash(seed)}`
  let candidate = base
  let suffix = 2
  while (usedIds.has(candidate)) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  return candidate
}

export function normalizeDavConfigs(value: unknown): NormalizedDavConfigs {
  if (!Array.isArray(value)) return { configs: [], migrated: value != null }
  const usedIds = new Set<string>()
  const configs: DavConfig[] = []
  let migrated = false

  for (let index = 0; index < value.length; index += 1) {
    const raw = value[index]
    if (!isRecord(raw)) {
      migrated = true
      continue
    }
    let id = typeof raw.id === 'string' && /^[a-zA-Z0-9_-]{1,96}$/.test(raw.id)
      ? raw.id
      : ''
    if (!id || usedIds.has(id)) {
      id = createConfigId(raw, index, usedIds)
      migrated = true
    }
    usedIds.add(id)

    const name = typeof raw.name === 'string' ? raw.name : ''
    const normalized: DavConfig = {
      ...(raw as unknown as DavConfig),
      id,
      schemaVersion: DAV_CONFIG_SCHEMA_VERSION,
      url: typeof raw.url === 'string' ? raw.url : '',
      username: typeof raw.username === 'string' ? raw.username : undefined,
      password: typeof raw.password === 'string' ? raw.password : undefined,
      name,
      aliases: uniqueStrings(raw.aliases, name),
      mountAliases: uniqueStrings(raw.mountAliases),
      endpointAliases: uniqueStrings(raw.endpointAliases),
      sync: normalizeDavSyncState(raw.sync)
    }
    if (JSON.stringify(normalized) !== JSON.stringify(raw)) migrated = true
    configs.push(normalized)
  }
  return { configs, migrated }
}

export function createDavConfig(
  input: Pick<DavConfig, 'name' | 'url' | 'username' | 'password'>,
  existingConfigs: DavConfig[]
): DavConfig {
  const usedIds = new Set(existingConfigs.flatMap(config => config.id ? [config.id] : []))
  const raw = input as unknown as Record<string, unknown>
  return {
    ...input,
    id: createConfigId(raw, existingConfigs.length, usedIds),
    schemaVersion: DAV_CONFIG_SCHEMA_VERSION,
    aliases: [],
    mountAliases: [],
    endpointAliases: [],
    sync: createEmptyDavSyncState()
  }
}

export function matchesDavConfigIdentifier(config: DavConfig, identifier: string): boolean {
  return config.id === identifier || config.name === identifier || Boolean(config.aliases?.includes(identifier))
}

export function beginDavSync(state: DavSyncState): DavSyncState {
  return {
    ...state,
    generation: state.generation >= Number.MAX_SAFE_INTEGER ? 1 : state.generation + 1
  }
}

export function commitDavSyncSnapshot(
  state: DavSyncState,
  generation: number,
  candidate: DavSyncCandidate
): DavSyncState {
  if (!candidate.complete || generation !== state.generation) return state
  return {
    ...state,
    directoryPlaylists: normalizeDirectoryPlaylists(candidate.directoryPlaylists),
    provisionalManagedSongIds: {},
    pendingPlaylistCreations: {},
    lastSuccessfulSnapshot: {
      generation,
      completedAt: candidate.completedAt,
      directories: normalizeSnapshotDirectories(candidate.directories)
    }
  }
}

export function getManagedSongRemovals(previousSongIds: number[], nextSongIds: number[]): number[] {
  const next = new Set(uniqueSongIds(nextSongIds))
  return uniqueSongIds(previousSongIds).filter(songId => !next.has(songId))
}

export async function getConfigs(): Promise<DavConfig[]> {
  try {
    const val = await songloft.storage.get(CONFIG_KEY)
    if (!val) return []
    if (typeof val !== 'string') throw new Error('Stored WebDAV configs are not valid JSON text')
    const normalized = normalizeDavConfigs(JSON.parse(val))
    if (normalized.migrated) {
      try {
        await saveConfigs(normalized.configs)
      } catch (err) {
        songloft.log.error(`Failed to persist migrated dav configs: ${String(err)}`)
      }
    }
    return normalized.configs
  } catch (err) {
    songloft.log.error(`Failed to get dav configs: ${String(err)}`)
    return []
  }
}

export async function saveConfigs(configs: DavConfig[]): Promise<void> {
  const normalized = normalizeDavConfigs(configs)
  await songloft.storage.set(CONFIG_KEY, JSON.stringify(normalized.configs))
}

export async function getConfig(identifier: string): Promise<DavConfig | undefined> {
  const configs = await getConfigs()
  return configs.find(config => config.id === identifier) ||
    configs.find(config => config.name === identifier) ||
    configs.find(config => config.aliases?.includes(identifier))
}

import type { DavConfig, DavManagedDirectorySnapshot } from './config'
import {
  buildDavDirectoryKey,
  buildDavResourceKey,
  buildDavSongDedupKey,
  isMusicFile,
  normalizeDavResourcePath,
  normalizeDavScanRoot,
  propfind,
  type DavItem
} from './client'

export interface DavScanLimits {
  maxDepth: number
  maxEntries: number
  maxDirectories: number
}

export interface ScannedDavSong {
  path: string
  canonicalPath: string
  resourceKey: string
  dedupKey: string
  name: string
  title: string
  size: number
}

export interface ScannedDavDirectory {
  path: string
  directoryKey: string
  name: string
  songs: ScannedDavSong[]
}

export interface DavScanResult {
  scanRoot: string
  directories: ScannedDavDirectory[]
  scannedDirectoryCount: number
  scannedEntryCount: number
  musicFileCount: number
}

export interface DavScanQueueItem {
  path: string
  depth: number
}

export interface DavScanCursor {
  scanRoot: string
  queue: DavScanQueueItem[]
  visitedPaths: string[]
  directories: ScannedDavDirectory[]
  scannedEntryCount: number
  musicFileCount: number
}

export interface DavScanBatchResult {
  cursor: DavScanCursor
  complete: boolean
  result?: DavScanResult
}

export const DEFAULT_DAV_SCAN_LIMITS: DavScanLimits = {
  maxDepth: 32,
  maxEntries: 20000,
  maxDirectories: 2000
}

const DAV_SYNC_PROPFIND_TIMEOUT_MS = 25000

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function joinDavPath(parent: string, child: string): string {
  const normalizedParent = parent === '/' ? '' : parent.replace(/\/$/, '')
  return `${normalizedParent}/${child}`
}

function parentDavPath(path: string): string {
  const normalized = path === '/' ? path : path.replace(/\/$/, '')
  const separator = normalized.lastIndexOf('/')
  return separator <= 0 ? '/' : normalized.substring(0, separator)
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() || ''
}

function resolveItemPath(currentPath: string, itemPath: string): string {
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(itemPath) || itemPath.startsWith('/')) return itemPath
  return joinDavPath(currentPath, itemPath)
}

function titleFromFilename(filename: string): string {
  return filename.replace(/\.[^.]+$/, '')
}

export function snapshotDirectoryFromScan(
  directory: ScannedDavDirectory,
  managedSongIds: number[]
): DavManagedDirectorySnapshot {
  return {
    path: directory.path,
    resourceKeys: directory.songs.map(song => song.resourceKey),
    managedSongIds
  }
}

export function createDavScanCursor(config: DavConfig, requestedRoot: string): DavScanCursor {
  const scanRoot = normalizeDavScanRoot(config, requestedRoot, { mountRelative: true })
  return {
    scanRoot,
    queue: [{ path: scanRoot, depth: 0 }],
    visitedPaths: [],
    directories: [],
    scannedEntryCount: 0,
    musicFileCount: 0
  }
}

export async function scanDavDirectoryBatch(
  config: DavConfig,
  sourceCursor: DavScanCursor,
  limits: DavScanLimits = DEFAULT_DAV_SCAN_LIMITS,
  maxDirectoriesPerBatch = 1
): Promise<DavScanBatchResult> {
  if (!config.id) throw new Error('WebDAV config has no stable identity')
  if (limits.maxDepth < 0 || limits.maxEntries <= 0 || limits.maxDirectories <= 0) {
    throw new Error('Invalid WebDAV scan limits')
  }
  if (!Number.isInteger(maxDirectoriesPerBatch) || maxDirectoriesPerBatch <= 0) {
    throw new Error('Invalid WebDAV scan batch size')
  }

  const cursor: DavScanCursor = {
    scanRoot: sourceCursor.scanRoot,
    queue: sourceCursor.queue.map(item => ({ ...item })),
    visitedPaths: [...sourceCursor.visitedPaths],
    directories: sourceCursor.directories.map(directory => ({
      ...directory,
      songs: directory.songs.map(song => ({ ...song }))
    })),
    scannedEntryCount: sourceCursor.scannedEntryCount,
    musicFileCount: sourceCursor.musicFileCount
  }
  const visited = new Set(cursor.visitedPaths)
  let processedDirectories = 0

  while (cursor.queue.length > 0 && processedDirectories < maxDirectoriesPerBatch) {
    const current = cursor.queue.shift()!
    if (visited.has(current.path)) continue
    if (current.depth > limits.maxDepth) {
      throw new Error(`WebDAV scan exceeded maximum depth ${limits.maxDepth}`)
    }
    if (visited.size >= limits.maxDirectories) {
      throw new Error(`WebDAV scan exceeded maximum directory count ${limits.maxDirectories}`)
    }
    visited.add(current.path)
    cursor.visitedPaths.push(current.path)

    let items: DavItem[]
    try {
      items = await propfind(config, current.path, {
        strictStatus: true,
        timeoutMs: DAV_SYNC_PROPFIND_TIMEOUT_MS
      })
    } catch (error) {
      throw new Error(`WebDAV scan failed for ${current.path}: ${String(error)}`)
    }
    const directory: ScannedDavDirectory = {
      path: current.path,
      directoryKey: buildDavDirectoryKey(config, current.path, { mountRelative: true }),
      name: basename(current.path) || config.name,
      songs: []
    }

    for (const item of items) {
      cursor.scannedEntryCount += 1
      if (cursor.scannedEntryCount > limits.maxEntries) {
        throw new Error(`WebDAV scan exceeded maximum entry count ${limits.maxEntries}`)
      }

      const resolvedPath = resolveItemPath(current.path, item.filename)
      const pathOptions = {
        mountRelative: !/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(item.filename) &&
          !item.filename.startsWith('/')
      }
      const childPath = normalizeDavScanRoot(config, resolvedPath, pathOptions)
      if (childPath === current.path) continue
      if (parentDavPath(childPath) !== current.path) {
        throw new Error(`WebDAV returned a non-child resource for ${current.path}`)
      }

      if (item.type === 'directory') {
        if (current.depth >= limits.maxDepth) {
          throw new Error(`WebDAV scan exceeded maximum depth ${limits.maxDepth}`)
        }
        cursor.queue.push({ path: childPath, depth: current.depth + 1 })
        continue
      }
      if (!isMusicFile(item)) continue

      const canonicalPath = normalizeDavResourcePath(config, resolvedPath, pathOptions)
      directory.songs.push({
        path: childPath,
        canonicalPath,
        resourceKey: buildDavResourceKey(config, resolvedPath, pathOptions),
        dedupKey: buildDavSongDedupKey(config, resolvedPath, pathOptions),
        name: item.basename || basename(childPath),
        title: titleFromFilename(item.basename || basename(childPath)),
        size: item.size
      })
      cursor.musicFileCount += 1
    }

    directory.songs.sort((left, right) => compareStrings(left.canonicalPath, right.canonicalPath))
    cursor.directories.push(directory)
    processedDirectories += 1
  }

  if (cursor.queue.length > 0) return { cursor, complete: false }

  const directories = [...cursor.directories]
    .sort((left, right) => compareStrings(left.path, right.path))
  return {
    cursor: { ...cursor, directories },
    complete: true,
    result: {
      scanRoot: cursor.scanRoot,
      directories,
      scannedDirectoryCount: cursor.visitedPaths.length,
      scannedEntryCount: cursor.scannedEntryCount,
      musicFileCount: cursor.musicFileCount
    }
  }
}

export async function scanDavDirectoryTree(
  config: DavConfig,
  requestedRoot: string,
  limits: DavScanLimits = DEFAULT_DAV_SCAN_LIMITS
): Promise<DavScanResult> {
  let cursor = createDavScanCursor(config, requestedRoot)
  while (true) {
    const batch = await scanDavDirectoryBatch(config, cursor, limits, limits.maxDirectories)
    if (batch.complete) return batch.result!
    cursor = batch.cursor
  }
}

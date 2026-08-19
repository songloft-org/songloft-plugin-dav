import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadExecutablePluginBundle } from './helpers/load-plugin-bundle.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginBundle = await loadExecutablePluginBundle(repoRoot)

function makeHarness() {
  const storage = new Map()
  storage.set('dav_configs', JSON.stringify([{
    id: 'dav_task',
    schemaVersion: 1,
    name: 'Task DAV',
    url: 'https://dav.example.test/dav',
    username: 'listener',
    password: 'secret',
    aliases: [],
    mountAliases: [],
    endpointAliases: [],
    sync: {
      schemaVersion: 1,
      scanRoot: '/Music',
      generation: 0,
      directoryPlaylists: {},
    },
  }]))

  const songsByDedup = new Map()
  const playlists = new Map()
  let nextSongId = 1
  let nextPlaylistId = 100
  let fetchCalls = 0
  let fixtureMode = 'healthy'
  let extraSong = false
  let omitSongs = false
  let directoryCount = 6
  let songsPerDirectory = 1
  let maxAddBatch = 0
  let songCreateCalls = 0
  let taskCheckpointFailures = 0
  let configWriteFailures = 0
  let failTaskCheckpointAfterSongCreate = false
  let failConfigWriteAfterPlaylistCreate = false
  let lastSongListOptions = null
  let removeCalls = 0
  let failRemoveCall = 0
  let minimumPropfindTimeoutMs = 0
  let lastPropfindTimeoutMs = 0

  function propfindResponse(entries) {
    return {
      ok: true,
      status: 207,
      statusText: 'Multi-Status',
      text: async () => `<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          ${entries.map(entry => `
            <d:response>
              <d:href>${entry.href}</d:href>
              <d:propstat><d:prop>
                <d:resourcetype>${entry.directory ? '<d:collection/>' : ''}</d:resourcetype>
                <d:getcontentlength>${entry.size || 0}</d:getcontentlength>
              </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
            </d:response>`).join('')}
        </d:multistatus>`,
    }
  }

  const songloft = {
    storage: {
      get: async key => storage.get(key) ?? null,
      set: async (key, value) => {
        if (key.startsWith('dav_sync_task_') && taskCheckpointFailures > 0) {
          taskCheckpointFailures -= 1
          throw new Error('injected task checkpoint failure')
        }
        if (key === 'dav_configs' && configWriteFailures > 0) {
          configWriteFailures -= 1
          throw new Error('injected config checkpoint failure')
        }
        storage.set(key, value)
      },
      delete: async key => storage.delete(key),
      keys: async () => Array.from(storage.keys()),
    },
    log: { info() {}, warn() {}, error() {} },
    songs: {
      list: async (options = {}) => {
        const { limit = 100, offset = 0, orderBy, order } = options
        lastSongListOptions = { ...options }
        const songs = Array.from(songsByDedup.values())
        if (orderBy === 'id') songs.sort((left, right) => left.id - right.id)
        if (order === 'desc') songs.reverse()
        return songs.slice(offset, offset + limit).map(song => ({ ...song }))
      },
      getById: async id => {
        const song = Array.from(songsByDedup.values()).find(candidate => candidate.id === id)
        if (!song) throw new Error('database: record not found')
        return { ...song }
      },
      create: async inputs => {
        songCreateCalls += 1
        const created = inputs.map(input => {
        let song = songsByDedup.get(input.dedupKey)
        if (!song) {
          song = {
            id: nextSongId++,
            type: 'remote',
            plugin_entry_path: 'dav',
            source_data: input.sourceData,
            ...input,
          }
          songsByDedup.set(input.dedupKey, song)
        } else {
          Object.assign(song, input, { source_data: input.sourceData })
        }
        return { ...song }
        })
        if (failTaskCheckpointAfterSongCreate) {
          failTaskCheckpointAfterSongCreate = false
          taskCheckpointFailures = 2
        }
        return created
      },
    },
    playlists: {
      list: async () => Array.from(playlists.values()).map(playlist => ({ ...playlist })),
      create: async input => {
        if (Array.from(playlists.values()).some(playlist => playlist.name === input.name)) {
          throw new Error('playlist with the same name already exists')
        }
        const playlist = { id: nextPlaylistId++, ...input, songIds: [] }
        playlists.set(playlist.id, playlist)
        if (failConfigWriteAfterPlaylistCreate) {
          failConfigWriteAfterPlaylistCreate = false
          configWriteFailures = 1
        }
        return { ...playlist }
      },
      getById: async id => {
        const playlist = playlists.get(id)
        if (!playlist) throw new Error('database: record not found')
        return { ...playlist }
      },
      getSongs: async id => {
        const playlist = playlists.get(id)
        if (!playlist) throw new Error('playlist not found')
        return playlist.songIds.map(songId => ({ id: songId }))
      },
      addSongs: async (id, songIds) => {
        maxAddBatch = Math.max(maxAddBatch, songIds.length)
        const playlist = playlists.get(id)
        if (!playlist) throw new Error('playlist not found')
        let added = 0
        let skipped = 0
        for (const songId of songIds) {
          const exists = Array.from(songsByDedup.values()).some(song => song.id === songId)
          if (!exists || playlist.songIds.includes(songId)) skipped += 1
          else {
            playlist.songIds.push(songId)
            added += 1
          }
        }
        return { added, skipped }
      },
      removeSongs: async (id, songIds) => {
        removeCalls += 1
        if (removeCalls === failRemoveCall) throw new Error('injected remove failure')
        const playlist = playlists.get(id)
        if (!playlist) throw new Error('playlist not found')
        const removing = new Set(songIds)
        playlist.songIds = playlist.songIds.filter(songId => !removing.has(songId))
      },
      reorder: async (id, songIds) => {
        const playlist = playlists.get(id)
        if (!playlist) throw new Error('playlist not found')
        playlist.songIds = [...songIds]
      },
    },
  }

  async function fetchImpl(url, options = {}) {
    fetchCalls += 1
    lastPropfindTimeoutMs = Number(options.headers?.['X-Fetch-Timeout-Ms'] || 0)
    if (lastPropfindTimeoutMs < minimumPropfindTimeoutMs) {
      throw new Error('context deadline exceeded')
    }
    const pathname = new URL(String(url)).pathname.replace(/\/$/, '')
    if (fixtureMode === 'failure' && pathname === '/dav/Music/D3') {
      return {
        ok: false,
        status: 503,
        statusText: 'Unavailable',
        text: async () => '',
      }
    }
    if (pathname === '/dav/Music') {
      return propfindResponse([
        { href: '/dav/Music/', directory: true },
        ...Array.from({ length: directoryCount }, (_, index) => ({
          href: `/dav/Music/D${index + 1}/`,
          directory: true,
        })),
      ])
    }
    const match = pathname.match(/^\/dav\/Music\/(D\d+)$/)
    if (match) {
      const prefix = match[1].toLowerCase()
      return propfindResponse([
        { href: `${pathname}/`, directory: true },
        ...(!omitSongs ? Array.from({ length: songsPerDirectory }, (_, index) => ({
          href: `${pathname}/${prefix}${index === 0 ? '' : `-${index + 1}`}.mp3`,
          size: 1000,
        })) : []),
        ...(extraSong && match[1] === 'D1'
          ? [{ href: `${pathname}/extra.mp3`, size: 2000 }]
          : []),
      ])
    }
    throw new Error(`Unexpected PROPFIND URL: ${url}`)
  }

  function createContext() {
    const context = vm.createContext({
      URL,
      URLSearchParams,
      TextDecoder,
      TextEncoder,
      Uint8Array,
      ArrayBuffer,
      console,
      fetch: fetchImpl,
      songloft,
    })
    vm.runInContext(pluginBundle, context, { filename: 'dav-main.js' })
    return context
  }

  async function request(context, method, path, body) {
    return context.onHTTPRequest({
      method,
      path,
      headers: {},
      body: body == null ? undefined : JSON.stringify(body),
    })
  }

  async function driveToTerminal(context, task, progress = []) {
    for (let step = 0; step < 500 && ['queued', 'scanning', 'applying'].includes(task.status); step += 1) {
      const response = await request(
        context,
        'POST',
        '/sync-roots/dav_task/advance',
        { taskId: task.taskId },
      )
      assert.equal(response.statusCode, 200, response.body)
      task = JSON.parse(response.body)
      progress.push({ ...task.progress })
    }
    assert.equal(['succeeded', 'failed', 'failed_partial', 'cancelled'].includes(task.status), true)
    return task
  }

  return {
    storage,
    songsByDedup,
    playlists,
    createContext,
    request,
    driveToTerminal,
    seedSong(song) {
      const seeded = { id: nextSongId++, type: 'remote', ...song }
      songsByDedup.set(song.dedupKey, seeded)
      return seeded
    },
    deleteSongById(id) {
      for (const [key, song] of songsByDedup) {
        if (song.id === id) songsByDedup.delete(key)
      }
    },
    get fetchCalls() { return fetchCalls },
    get maxAddBatch() { return maxAddBatch },
    get songCreateCalls() { return songCreateCalls },
    get lastSongListOptions() { return lastSongListOptions },
    get lastPropfindTimeoutMs() { return lastPropfindTimeoutMs },
    set fixtureMode(value) { fixtureMode = value },
    set extraSong(value) { extraSong = value },
    set omitSongs(value) { omitSongs = value },
    set directoryCount(value) { directoryCount = value },
    set songsPerDirectory(value) { songsPerDirectory = value },
    set minimumPropfindTimeoutMs(value) { minimumPropfindTimeoutMs = value },
    failNextSongCheckpoint() { failTaskCheckpointAfterSongCreate = true },
    failNextPlaylistMapping() { failConfigWriteAfterPlaylistCreate = true },
    failRemoveOnCall(value) { failRemoveCall = value },
  }
}

test('sync scanning allows a slow but valid WebDAV directory to finish before its request deadline', async () => {
  const harness = makeHarness()
  harness.directoryCount = 1
  harness.minimumPropfindTimeoutMs = 20000
  const context = harness.createContext()
  let task = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)

  task = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/advance',
    { taskId: task.taskId },
  )).body)
  assert.equal(task.status, 'scanning')

  task = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/advance',
    { taskId: task.taskId },
  )).body)
  assert.equal(task.status, 'scanning', task.error)
  assert.equal(harness.lastPropfindTimeoutMs >= 20000, true)
})

test('sync task returns immediately, checkpoints across VM reload, exposes progress, and fences retries', async () => {
  const harness = makeHarness()
  let context = harness.createContext()

  const startResponse = await harness.request(context, 'POST', '/sync-roots/dav_task/run')
  assert.equal(startResponse.statusCode, 202)
  let task = JSON.parse(startResponse.body)
  assert.equal(task.status, 'queued')
  assert.equal(harness.fetchCalls, 0, 'starting a task must not wait for the first PROPFIND')

  const duplicateStart = await harness.request(context, 'POST', '/sync-roots/dav_task/run')
  assert.equal(duplicateStart.statusCode, 202)
  assert.equal(JSON.parse(duplicateStart.body).taskId, task.taskId)

  let response = await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/advance',
    { taskId: task.taskId },
  )
  task = JSON.parse(response.body)
  assert.equal(task.status, 'scanning')
  assert.equal(harness.fetchCalls, 0)

  response = await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/advance',
    { taskId: task.taskId },
  )
  task = JSON.parse(response.body)
  assert.equal(task.status, 'scanning')
  assert.equal(task.progress.scannedDirectories, 1)
  assert.equal(task.progress.pendingDirectories > 0, true)
  const checkpoint = structuredClone(task.progress)

  context = harness.createContext()
  const resumedStatus = await harness.request(context, 'GET', '/sync-roots/dav_task/status')
  const resumedTask = JSON.parse(resumedStatus.body).task
  assert.equal(resumedTask.taskId, task.taskId)
  assert.deepEqual(resumedTask.progress, checkpoint)

  const progress = [checkpoint]
  task = await harness.driveToTerminal(context, resumedTask, progress)
  assert.equal(task.status, 'succeeded')
  assert.equal(task.result.musicFiles, 6)
  assert.equal(task.result.createdPlaylists, 6)
  assert.equal(harness.songsByDedup.size, 6)
  assert.equal(harness.playlists.size, 6)
  for (let index = 1; index < progress.length; index += 1) {
    assert.equal(
      progress[index].scannedDirectories >= progress[index - 1].scannedDirectories,
      true,
    )
    assert.equal(progress[index].songsReady >= progress[index - 1].songsReady, true)
    assert.equal(
      progress[index].playlistsPrepared >= progress[index - 1].playlistsPrepared,
      true,
    )
  }

  const firstSuccessfulSnapshot = JSON.parse(harness.storage.get('dav_configs'))[0]
    .sync.lastSuccessfulSnapshot
  harness.extraSong = true
  const cancelStart = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)
  let cancellable = cancelStart
  for (let step = 0; step < 200 && cancellable.phase !== 'add-members'; step += 1) {
    const advance = await harness.request(
      context,
      'POST',
      '/sync-roots/dav_task/advance',
      { taskId: cancellable.taskId },
    )
    assert.equal(advance.statusCode, 200, advance.body)
    cancellable = JSON.parse(advance.body)
  }
  assert.equal(cancellable.phase, 'add-members')
  const partialAdd = await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/advance',
    { taskId: cancellable.taskId },
  )
  assert.equal(partialAdd.statusCode, 200, partialAdd.body)
  cancellable = JSON.parse(partialAdd.body)
  assert.equal(cancellable.phase, 'add-members')
  const extra = Array.from(harness.songsByDedup.values()).find(song =>
    JSON.parse(song.source_data).path.endsWith('/extra.mp3'))
  const d1Playlist = Array.from(harness.playlists.values())
    .find(playlist => playlist.description.endsWith(' · /Music/D1'))
  assert.equal(d1Playlist.songIds.includes(extra.id), true)
  const journalled = JSON.parse(harness.storage.get('dav_configs'))[0]
    .sync.provisionalManagedSongIds
  assert.equal(Object.values(journalled).some(songIds => songIds.includes(extra.id)), true)
  const cancelResponse = await harness.request(
    context,
    'DELETE',
    '/sync-roots/dav_task/run',
    { taskId: cancellable.taskId },
  )
  assert.equal(cancelResponse.statusCode, 202)
  assert.equal(JSON.parse(cancelResponse.body).task.cancelRequested, true)
  const cancelled = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/advance',
    { taskId: cancellable.taskId },
  )).body)
  assert.equal(cancelled.status, 'cancelled')
  assert.deepEqual(
    JSON.parse(harness.storage.get('dav_configs'))[0].sync.lastSuccessfulSnapshot,
    firstSuccessfulSnapshot,
  )

  harness.extraSong = false
  const cleanupRetry = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/retry',
  )).body)
  const cleanedUp = await harness.driveToTerminal(context, cleanupRetry)
  assert.equal(cleanedUp.status, 'succeeded')
  assert.equal(d1Playlist.songIds.includes(extra.id), false)
  assert.deepEqual(
    JSON.parse(harness.storage.get('dav_configs'))[0].sync.provisionalManagedSongIds,
    {},
  )
  const cleanupSnapshot = JSON.parse(harness.storage.get('dav_configs'))[0]
    .sync.lastSuccessfulSnapshot

  harness.fixtureMode = 'failure'
  let failed = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/retry',
  )).body)
  failed = await harness.driveToTerminal(context, failed)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /503/)
  const failedStatus = JSON.parse((await harness.request(
    context,
    'GET',
    '/sync-roots/dav_task/status',
  )).body).task
  assert.equal(failedStatus.error, failed.error)
  assert.deepEqual(
    JSON.parse(harness.storage.get('dav_configs'))[0].sync.lastSuccessfulSnapshot,
    cleanupSnapshot,
  )

  harness.fixtureMode = 'healthy'
  const retryResponse = await harness.request(context, 'POST', '/sync-roots/dav_task/retry')
  assert.equal(retryResponse.statusCode, 202)
  const retry = JSON.parse(retryResponse.body)
  assert.notEqual(retry.taskId, failed.taskId)
  assert.equal(retry.generation > failed.generation, true)
  const recovered = await harness.driveToTerminal(context, retry)
  assert.equal(recovered.status, 'succeeded')

  let staleStart = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)
  for (let step = 0; step < 200 && staleStart.phase !== 'add-members'; step += 1) {
    staleStart = JSON.parse((await harness.request(
      context,
      'POST',
      '/sync-roots/dav_task/advance',
      { taskId: staleStart.taskId },
    )).body)
  }
  assert.equal(staleStart.phase, 'add-members')
  const updateResponse = await harness.request(context, 'POST', '/lists', {
    id: 'dav_task',
    name: 'Task DAV',
    url: 'https://dav.example.test/dav',
    username: 'listener',
    password: 'changed-secret',
  })
  assert.equal(updateResponse.statusCode, 200)
  const staleAdvance = await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/advance',
    { taskId: staleStart.taskId },
  )
  assert.equal(staleAdvance.statusCode, 409)
  assert.match(JSON.parse(staleAdvance.body).error, /superseded/)
})

test('write-ahead checkpoints recover song and playlist mutations without replay damage', async () => {
  const songHarness = makeHarness()
  songHarness.directoryCount = 1
  songHarness.failNextSongCheckpoint()
  let context = songHarness.createContext()
  let task = JSON.parse((await songHarness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)
  let interrupted = false
  for (let step = 0; step < 100 && ['queued', 'scanning', 'applying'].includes(task.status); step += 1) {
    const response = await songHarness.request(
      context,
      'POST',
      '/sync-roots/dav_task/advance',
      { taskId: task.taskId },
    )
    if (response.statusCode === 500) {
      assert.match(JSON.parse(response.body).error, /checkpoint failure/)
      interrupted = true
      break
    }
    assert.equal(response.statusCode, 200, response.body)
    task = JSON.parse(response.body)
  }
  assert.equal(interrupted, true)
  assert.equal(songHarness.songsByDedup.size, 1)
  const createdSong = Array.from(songHarness.songsByDedup.values())[0]
  createdSong.title = '用户整理后的标题'
  const createCallsBeforeResume = songHarness.songCreateCalls

  context = songHarness.createContext()
  const recoveredStatus = JSON.parse((await songHarness.request(
    context,
    'GET',
    '/sync-roots/dav_task/status',
  )).body).task
  assert.equal(recoveredStatus.status, 'applying')
  const recovered = await songHarness.driveToTerminal(context, recoveredStatus)
  assert.equal(recovered.status, 'succeeded')
  assert.equal(songHarness.songCreateCalls, createCallsBeforeResume)
  assert.equal(createdSong.title, '用户整理后的标题')

  const playlistHarness = makeHarness()
  playlistHarness.directoryCount = 1
  playlistHarness.failNextPlaylistMapping()
  context = playlistHarness.createContext()
  task = JSON.parse((await playlistHarness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)
  const failed = await playlistHarness.driveToTerminal(context, task)
  assert.equal(failed.status, 'failed_partial')
  assert.match(failed.error, /config checkpoint failure/)
  assert.equal(playlistHarness.playlists.size, 1)
  assert.equal(
    Object.keys(JSON.parse(playlistHarness.storage.get('dav_configs'))[0]
      .sync.pendingPlaylistCreations).length,
    1,
  )

  const retry = JSON.parse((await playlistHarness.request(
    context,
    'POST',
    '/sync-roots/dav_task/retry',
  )).body)
  const converged = await playlistHarness.driveToTerminal(context, retry)
  assert.equal(converged.status, 'succeeded')
  assert.equal(playlistHarness.playlists.size, 1, 'intent token must recover the created playlist')
  assert.deepEqual(
    JSON.parse(playlistHarness.storage.get('dav_configs'))[0].sync.pendingPlaylistCreations,
    {},
  )
})

test('partial removal is reported honestly, cannot be cancelled too late, and retry converges', async () => {
  const harness = makeHarness()
  harness.directoryCount = 2
  const context = harness.createContext()
  let task = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)
  task = await harness.driveToTerminal(context, task)
  assert.equal(task.status, 'succeeded')
  const successfulSnapshot = structuredClone(
    JSON.parse(harness.storage.get('dav_configs'))[0].sync.lastSuccessfulSnapshot,
  )

  harness.omitSongs = true
  task = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)
  for (let step = 0; step < 100 && task.phase !== 'remove-members'; step += 1) {
    task = JSON.parse((await harness.request(
      context,
      'POST',
      '/sync-roots/dav_task/advance',
      { taskId: task.taskId },
    )).body)
  }
  assert.equal(task.phase, 'remove-members')
  const tooLate = await harness.request(
    context,
    'DELETE',
    '/sync-roots/dav_task/run',
    { taskId: task.taskId },
  )
  assert.equal(tooLate.statusCode, 409)
  assert.equal(JSON.parse(tooLate.body).tooLate, true)

  harness.failRemoveOnCall(2)
  task = await harness.driveToTerminal(context, task)
  assert.equal(task.status, 'failed_partial')
  assert.match(task.error, /injected remove failure/)
  assert.deepEqual(
    JSON.parse(harness.storage.get('dav_configs'))[0].sync.lastSuccessfulSnapshot,
    successfulSnapshot,
  )
  assert.deepEqual(
    Array.from(harness.playlists.values()).map(playlist => playlist.songIds.length).sort(),
    [0, 1],
  )

  const retry = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/retry',
  )).body)
  const converged = await harness.driveToTerminal(context, retry)
  assert.equal(converged.status, 'succeeded')
  assert.deepEqual(
    Array.from(harness.playlists.values()).map(playlist => playlist.songIds.length),
    [0, 0],
  )
})

test('advance calls are bounded and deleting a config removes task checkpoints', async () => {
  const harness = makeHarness()
  harness.directoryCount = 1
  harness.songsPerDirectory = 450
  const context = harness.createContext()
  let task = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)
  task = await harness.driveToTerminal(context, task)
  assert.equal(task.status, 'succeeded')
  assert.equal(task.result.musicFiles, 450)
  assert.equal(harness.maxAddBatch, 200)
  assert.equal(
    Array.from(harness.storage.keys()).some(key => key.startsWith('dav_sync_task_dav_task_')),
    true,
  )

  const deleted = await harness.request(context, 'DELETE', '/lists/dav_task')
  assert.equal(deleted.statusCode, 200, deleted.body)
  assert.equal(
    Array.from(harness.storage.keys()).some(key => key.startsWith('dav_sync_task_dav_task_')),
    false,
  )
  assert.deepEqual(JSON.parse(harness.storage.get('dav_configs')), [])
})

test('legacy-song adoption restarts a stable id-ordered page after library drift', async () => {
  const harness = makeHarness()
  harness.directoryCount = 1
  for (let index = 0; index < 500; index += 1) {
    harness.seedSong({
      plugin_entry_path: 'other',
      source_data: '{}',
      title: `unrelated-${index}`,
      dedupKey: `unrelated-${index}`,
    })
  }
  const legacy = harness.seedSong({
    plugin_entry_path: 'dav',
    source_data: JSON.stringify({
      configName: 'Task DAV',
      path: '/Music/D1/d1.mp3',
      pathMode: 'mount-relative',
    }),
    title: '用户维护的旧标题',
    dedupKey: 'legacy-dav-d1',
  })
  const context = harness.createContext()
  let task = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/run',
  )).body)
  for (let step = 0; step < 100 && task.phase !== 'adopt-songs'; step += 1) {
    task = JSON.parse((await harness.request(
      context,
      'POST',
      '/sync-roots/dav_task/advance',
      { taskId: task.taskId },
    )).body)
  }
  assert.equal(task.phase, 'adopt-songs')
  task = JSON.parse((await harness.request(
    context,
    'POST',
    '/sync-roots/dav_task/advance',
    { taskId: task.taskId },
  )).body)
  assert.equal(task.phase, 'adopt-songs')
  harness.deleteSongById(1)

  task = await harness.driveToTerminal(context, task)
  assert.equal(task.status, 'succeeded')
  assert.equal(harness.songCreateCalls, 0)
  assert.equal(legacy.title, '用户维护的旧标题')
  assert.equal(harness.lastSongListOptions.orderBy, 'id')
  assert.equal(harness.lastSongListOptions.order, 'asc')
  assert.equal(
    Array.from(harness.playlists.values())[0].songIds.includes(legacy.id),
    true,
  )
})

test('sync UI drives bounded tasks and renders task errors as text', () => {
  const app = readFileSync(join(repoRoot, 'static/js/app.js'), 'utf8')
  const html = readFileSync(join(repoRoot, 'static/index.html'), 'utf8')
  assert.match(app, /fetchSyncTaskStatus/)
  assert.match(app, /\/advance/)
  assert.match(app, /'X-Plugin-Timeout-Ms':\s*'60000'/)
  assert.match(app, /headers:\s*getSyncAdvanceHeaders\(\)/)
  assert.match(app, /method:\s*'DELETE'/)
  assert.match(app, /error\.textContent\s*=\s*task\.error/)
  assert.match(app, /ensureSyncDriver\(root\.configId, task\.taskId\)/)
  assert.match(html, /id="cancelSyncBtn"/)
  assert.match(html, /id="retrySyncBtn"/)
  assert.doesNotMatch(html, /当前请求内运行/)
})

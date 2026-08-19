import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadExecutablePluginBundle } from './helpers/load-plugin-bundle.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginBundle = await loadExecutablePluginBundle(repoRoot)

let storedConfigs = JSON.stringify([{
  id: 'dav_primary',
  schemaVersion: 1,
  name: 'Primary NAS',
  url: 'https://dav.example.test/dav',
  username: 'listener',
  password: 'secret',
  aliases: [],
  sync: {
    schemaVersion: 1,
    scanRoot: '/',
    generation: 0,
    directoryPlaylists: {},
  },
}])
const storageValues = new Map([['dav_configs', storedConfigs]])

const songsByDedup = new Map()
const playlists = new Map()
let nextSongId = 1
let nextPlaylistId = 100
let songCreateCalls = 0
let fixtureMode = 'initial'

globalThis.songloft = {
  storage: {
    get: async key => storageValues.get(key) ?? null,
    set: async (key, value) => {
      storageValues.set(key, value)
      if (key === 'dav_configs') storedConfigs = value
    },
  },
  log: {
    error() {},
  },
  songs: {
    list: async ({ limit = 100, offset = 0 } = {}) =>
      Array.from(songsByDedup.values()).slice(offset, offset + limit).map(song => ({ ...song })),
    getById: async id => {
      const song = Array.from(songsByDedup.values()).find(candidate => candidate.id === id)
      if (!song) throw new Error('database: record not found')
      return { ...song }
    },
    create: async inputs => {
      songCreateCalls += 1
      return inputs.map(input => {
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
          Object.assign(song, input)
        }
        return { ...song }
      })
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
      const playlist = playlists.get(id)
      if (!playlist) throw new Error('playlist not found')
      let added = 0
      let skipped = 0
      for (const songId of songIds) {
        const songExists = Array.from(songsByDedup.values()).some(song => song.id === songId)
        if (!songExists || playlist.songIds.includes(songId)) skipped += 1
        else {
          playlist.songIds.push(songId)
          added += 1
        }
      }
      return { added, skipped }
    },
    removeSongs: async (id, songIds) => {
      const playlist = playlists.get(id)
      if (!playlist) throw new Error('playlist not found')
      const removing = new Set(songIds)
      playlist.songIds = playlist.songIds.filter(songId => !removing.has(songId))
    },
    reorder: async (id, songIds) => {
      const playlist = playlists.get(id)
      if (!playlist) throw new Error('playlist not found')
      assert.deepEqual([...songIds].sort((a, b) => a - b), [...playlist.songIds].sort((a, b) => a - b))
      playlist.songIds = [...songIds]
    },
  },
}

const userRockPlaylist = {
  id: 90,
  name: 'Rock',
  type: 'normal',
  description: '用户歌单',
  songIds: [],
}
playlists.set(userRockPlaylist.id, userRockPlaylist)

const legacyRootSong = {
  id: nextSongId++,
  type: 'remote',
  title: 'root',
  artist: '旧手工导入',
  album: '',
  plugin_entry_path: 'dav',
  source_data: JSON.stringify({
    configName: 'Primary NAS',
    path: '/dav/Music/root.mp3',
  }),
  dedupKey: 'dav_Primary NAS_/dav/Music/root.mp3',
}
songsByDedup.set(legacyRootSong.dedupKey, legacyRootSong)

vm.runInThisContext(pluginBundle, { filename: 'dav-main.js' })

function request(method, path, body) {
  return globalThis.onHTTPRequest({
    method,
    path,
    headers: {},
    body: body == null ? undefined : JSON.stringify(body),
  })
}

async function runSyncToTerminal(configId = 'dav_primary') {
  const startResponse = await request('POST', `/sync-roots/${configId}/run`)
  assert.equal(startResponse.statusCode, 202)
  let task = JSON.parse(startResponse.body)
  for (let step = 0; step < 500 && ['queued', 'scanning', 'applying'].includes(task.status); step += 1) {
    const advanceResponse = await request(
      'POST',
      `/sync-roots/${configId}/advance`,
      { taskId: task.taskId },
    )
    assert.equal(advanceResponse.statusCode, 200, advanceResponse.body)
    task = JSON.parse(advanceResponse.body)
  }
  assert.equal(['succeeded', 'failed', 'cancelled'].includes(task.status), true)
  return task.status === 'succeeded'
    ? { statusCode: 200, body: JSON.stringify(task.result) }
    : { statusCode: 500, body: JSON.stringify({ error: task.error }) }
}

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
            </d:prop>${entry.omitStatus
              ? ''
              : `<d:status>${entry.malformedStatus
                ? 'not-an-http-status'
                : `HTTP/1.1 ${entry.propertyStatus || 200} ${entry.propertyStatus && entry.propertyStatus >= 400 ? 'Forbidden' : 'OK'}`}</d:status>`}</d:propstat>
          </d:response>`).join('')}
      </d:multistatus>`,
  }
}

globalThis.fetch = async url => {
  const pathname = new URL(String(url)).pathname.replace(/\/$/, '')
  if (pathname === '/dav/Music') {
    if (fixtureMode === 'html-200') {
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '<html>login required</html>',
      }
    }
    if (fixtureMode === 'truncated') {
      return {
        ok: true,
        status: 207,
        statusText: 'Multi-Status',
        text: async () => '<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/Music/</d:href>',
      }
    }
    if (fixtureMode === 'missing-status' || fixtureMode === 'malformed-status') {
      return propfindResponse([
        {
          href: '/dav/Music/',
          directory: true,
          omitStatus: fixtureMode === 'missing-status',
          malformedStatus: fixtureMode === 'malformed-status',
        },
      ])
    }
    if (fixtureMode === 'cross-origin') {
      return propfindResponse([
        { href: '/dav/Music/', directory: true },
        { href: 'https://evil.example.test/stolen.mp3', size: 1024 },
      ])
    }
    return propfindResponse([
      { href: '/dav/Music/', directory: true },
      { href: '/dav/Music/Rock/', directory: true },
      { href: '/dav/Music/A/', directory: true },
      { href: '/dav/Music/B/', directory: true },
      ...(fixtureMode === 'initial'
        ? [
            { href: '/dav/Music/root.mp3', size: 1000 },
            { href: '/dav/Music/cover.jpg', size: 500 },
          ]
        : []),
    ])
  }
  if (pathname === '/dav/Music/Rock') {
    if (fixtureMode === 'failure') {
      return {
        ok: false,
        status: 503,
        statusText: 'Unavailable',
        text: async () => '',
      }
    }
    if (fixtureMode === 'propstat-failure') {
      return propfindResponse([
        { href: '/dav/Music/Rock/', directory: true },
        { href: '/dav/Music/Rock/rock-b.flac', size: 2100, propertyStatus: 403 },
      ])
    }
    return propfindResponse([
      { href: '/dav/Music/Rock/', directory: true },
      ...(fixtureMode === 'initial'
        ? [
            { href: '/dav/Music/Rock/rock-a.flac', size: 2000 },
            { href: '/dav/Music/Rock/rock-b.flac', size: 2100 },
          ]
        : [
            { href: '/dav/Music/Rock/rock-b.flac', size: 2100 },
            { href: '/dav/Music/Rock/rock-c.mp3', size: 2200 },
            { href: '/dav/Music/Rock/root.mp3', size: 1000 },
          ]),
    ])
  }
  if (pathname === '/dav/Music/A' || pathname === '/dav/Music/B') {
    return propfindResponse([
      { href: `${pathname}/`, directory: true },
      { href: `${pathname}/Live/`, directory: true },
    ])
  }
  if (pathname === '/dav/Music/A/Live' || pathname === '/dav/Music/B/Live') {
    const prefix = pathname.endsWith('/A/Live') ? 'a' : 'b'
    return propfindResponse([
      { href: `${pathname}/`, directory: true },
      { href: `${pathname}/${prefix}-live.mp3`, size: 2300 },
    ])
  }
  throw new Error(`Unexpected PROPFIND URL: ${url}`)
}

function playlistByPath(path) {
  return Array.from(playlists.values()).find(playlist => playlist.description?.endsWith(` · ${path}`))
}

test('recursively creates directory playlists and converges after add, remove, and move', async () => {
  const setRootResponse = await request('POST', '/sync-roots/dav_primary', { path: '/Music' })
  assert.equal(setRootResponse.statusCode, 200)

  const firstResponse = await runSyncToTerminal()
  const first = JSON.parse(firstResponse.body)
  assert.equal(firstResponse.statusCode, 200)
  assert.deepEqual({
    musicFiles: first.musicFiles,
    createdPlaylists: first.createdPlaylists,
    addedMembers: first.addedMembers,
    removedMembers: first.removedMembers,
  }, {
    musicFiles: 5,
    createdPlaylists: 4,
    addedMembers: 5,
    removedMembers: 0,
  })
  assert.equal(playlists.size, 5)
  assert.equal(songsByDedup.size, 5)
  assert.equal(
    JSON.parse(Array.from(songsByDedup.values()).find(song => song.sourceData).sourceData).pathMode,
    'mount-relative',
  )

  const musicPlaylist = playlistByPath('/Music')
  const rockPlaylist = playlistByPath('/Music/Rock')
  assert.equal(musicPlaylist.songIds.length, 1)
  assert.equal(rockPlaylist.songIds.length, 2)
  const livePlaylists = Array.from(playlists.values())
    .filter(playlist => playlist.description?.endsWith('/Live'))
  assert.equal(livePlaylists.length, 2)
  assert.notEqual(livePlaylists[0].name, livePlaylists[1].name)
  assert.equal(playlists.get(userRockPlaylist.id), userRockPlaylist)
  assert.equal(musicPlaylist.songIds.includes(legacyRootSong.id), true)
  assert.equal(songsByDedup.has('dav:dav_primary:/Music/root.mp3'), false)

  rockPlaylist.songIds.push(999)
  fixtureMode = 'updated'
  const secondResponse = await runSyncToTerminal()
  const second = JSON.parse(secondResponse.body)
  assert.equal(secondResponse.statusCode, 200)
  assert.deepEqual({
    musicFiles: second.musicFiles,
    createdPlaylists: second.createdPlaylists,
    addedMembers: second.addedMembers,
    removedMembers: second.removedMembers,
  }, {
    musicFiles: 5,
    createdPlaylists: 0,
    addedMembers: 2,
    removedMembers: 2,
  })
  assert.deepEqual(musicPlaylist.songIds, [])
  assert.equal(rockPlaylist.songIds.includes(999), true)
  assert.equal(rockPlaylist.songIds.at(-1), 999)
  assert.equal(rockPlaylist.songIds.length, 4)
  assert.equal(songsByDedup.size, 7)

  const curatedSong = Array.from(songsByDedup.values()).find(song => song.title === 'rock-b')
  curatedSong.title = '手工整理标题'
  curatedSong.artist = '手工整理歌手'
  const secondOrder = [...rockPlaylist.songIds]
  const beforeThirdCreateCalls = songCreateCalls
  const thirdResponse = await runSyncToTerminal()
  const third = JSON.parse(thirdResponse.body)
  assert.equal(thirdResponse.statusCode, 200)
  assert.equal(third.createdPlaylists, 0)
  assert.equal(third.addedMembers, 0)
  assert.equal(third.removedMembers, 0)
  assert.deepEqual(rockPlaylist.songIds, secondOrder)
  assert.equal(songCreateCalls, beforeThirdCreateCalls)
  assert.equal(curatedSong.title, '手工整理标题')
  assert.equal(curatedSong.artist, '手工整理歌手')

  const deletedSongEntry = Array.from(songsByDedup.entries())
    .find(([, song]) => song.title === 'a-live')
  const [deletedDedupKey, deletedSong] = deletedSongEntry
  songsByDedup.delete(deletedDedupKey)
  for (const playlist of playlists.values()) {
    playlist.songIds = playlist.songIds.filter(songId => songId !== deletedSong.id)
  }
  const songRecoveryResponse = await runSyncToTerminal()
  const songRecovery = JSON.parse(songRecoveryResponse.body)
  assert.equal(songRecoveryResponse.statusCode, 200)
  assert.equal(songRecovery.addedMembers, 1)
  const recoveredSong = songsByDedup.get(deletedDedupKey)
  assert.notEqual(recoveredSong.id, deletedSong.id)
  assert.equal(
    Array.from(playlists.values()).some(playlist => playlist.songIds.includes(recoveredSong.id)),
    true,
  )

  const deletedPlaylist = livePlaylists[0]
  const deletedPath = deletedPlaylist.description.split(' · ').at(-1)
  playlists.delete(deletedPlaylist.id)
  const recoveryResponse = await runSyncToTerminal()
  assert.equal(recoveryResponse.statusCode, 200)
  assert.equal(JSON.parse(recoveryResponse.body).createdPlaylists, 1)
  const recoveredConfig = JSON.parse(storedConfigs)[0]
  assert.notEqual(
    Object.values(recoveredConfig.sync.directoryPlaylists).find(mapping => mapping.path === deletedPath).playlistId,
    deletedPlaylist.id,
  )

  const persisted = JSON.parse(storedConfigs)[0]
  assert.equal(persisted.sync.lastSuccessfulSnapshot.directories != null, true)
  assert.equal(persisted.sync.lastSuccessfulSnapshot.completedAt.length > 0, true)
})

test('a partial or unsafe discovery preserves the last successful snapshot and playlist members', async () => {
  const beforeSnapshot = JSON.parse(storedConfigs)[0].sync.lastSuccessfulSnapshot
  const beforePlaylists = Array.from(playlists.values()).map(playlist => ({
    id: playlist.id,
    songIds: [...playlist.songIds],
  }))
  const beforeSongCreateCalls = songCreateCalls

  fixtureMode = 'failure'
  const failureResponse = await runSyncToTerminal()
  assert.equal(failureResponse.statusCode, 500)
  assert.match(JSON.parse(failureResponse.body).error, /503/)
  assert.deepEqual(JSON.parse(storedConfigs)[0].sync.lastSuccessfulSnapshot, beforeSnapshot)
  assert.deepEqual(
    Array.from(playlists.values()).map(playlist => ({ id: playlist.id, songIds: [...playlist.songIds] })),
    beforePlaylists,
  )
  assert.equal(songCreateCalls, beforeSongCreateCalls)

  for (const mode of ['html-200', 'truncated', 'missing-status', 'malformed-status']) {
    fixtureMode = mode
    const malformedResponse = await runSyncToTerminal()
    assert.equal(malformedResponse.statusCode, 500)
    assert.deepEqual(JSON.parse(storedConfigs)[0].sync.lastSuccessfulSnapshot, beforeSnapshot)
    assert.deepEqual(
      Array.from(playlists.values()).map(playlist => ({ id: playlist.id, songIds: [...playlist.songIds] })),
      beforePlaylists,
    )
    assert.equal(songCreateCalls, beforeSongCreateCalls)
  }

  fixtureMode = 'propstat-failure'
  const propstatFailureResponse = await runSyncToTerminal()
  assert.equal(propstatFailureResponse.statusCode, 500)
  assert.match(JSON.parse(propstatFailureResponse.body).error, /403/)
  assert.deepEqual(JSON.parse(storedConfigs)[0].sync.lastSuccessfulSnapshot, beforeSnapshot)
  assert.deepEqual(
    Array.from(playlists.values()).map(playlist => ({ id: playlist.id, songIds: [...playlist.songIds] })),
    beforePlaylists,
  )
  assert.equal(songCreateCalls, beforeSongCreateCalls)

  fixtureMode = 'cross-origin'
  const unsafeResponse = await runSyncToTerminal()
  assert.equal(unsafeResponse.statusCode, 500)
  assert.match(JSON.parse(unsafeResponse.body).error, /Cross-origin/)
  assert.deepEqual(JSON.parse(storedConfigs)[0].sync.lastSuccessfulSnapshot, beforeSnapshot)
  assert.equal(songCreateCalls, beforeSongCreateCalls)
})

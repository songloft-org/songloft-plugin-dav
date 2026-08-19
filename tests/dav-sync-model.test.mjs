import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { build } from 'esbuild'
import { loadExecutablePluginBundle } from './helpers/load-plugin-bundle.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

async function loadSourceModule(relativePath) {
  const result = await build({
    entryPoints: [join(repoRoot, relativePath)],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    write: false,
  })
  const source = result.outputFiles[0].text
  return import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`)
}

const configModel = await loadSourceModule('src/config.ts')
const clientModel = await loadSourceModule('src/client.ts')

test('migrates legacy configs and partial snapshots once without changing the stable ID', () => {
  const legacy = [{
    name: 'Legacy NAS',
    url: 'https://dav.example.test/dav',
    username: 'listener',
    password: 'secret',
    sync: {
      rootPath: 'Music/',
      generation: 4,
      playlists: {
        'legacy-directory': { path: 'Music/Album/', playlistId: 18 },
      },
      snapshot: {
        generation: 3,
        directories: {
          'legacy-directory': {
            path: 'Music/Album/',
            resourceKeys: ['song-a', 'song-a', 'song-b'],
            managedSongIds: [11, 11, -1, 12],
          },
        },
      },
    },
  }]

  const first = configModel.normalizeDavConfigs(legacy)
  assert.equal(first.migrated, true)
  assert.match(first.configs[0].id, /^dav_[a-f0-9]{8}/)
  assert.equal(first.configs[0].sync.scanRoot, '/Music')
  assert.equal(first.configs[0].sync.schemaVersion, 1)
  assert.deepEqual(first.configs[0].sync.lastSuccessfulSnapshot.directories['legacy-directory'], {
    path: '/Music/Album',
    resourceKeys: ['song-a', 'song-b'],
    managedSongIds: [11, 12],
  })

  const persisted = JSON.parse(JSON.stringify(first.configs))
  const second = configModel.normalizeDavConfigs(persisted)
  assert.equal(second.migrated, false)
  assert.equal(second.configs[0].id, first.configs[0].id)
})

test('normalizes equivalent DAV hrefs and isolates identical directories by config ID', () => {
  const firstConfig = {
    id: 'dav_first',
    name: 'First',
    url: 'https://dav.example.test/webdav',
  }
  const secondConfig = {
    ...firstConfig,
    id: 'dav_second',
    name: 'Second',
  }
  const relative = '/Music/Café/song one.mp3'
  const absolute = 'https://dav.example.test/webdav/Music/Caf%C3%A9/song one.mp3'

  assert.equal(
    clientModel.normalizeDavResourcePath(firstConfig, relative),
    clientModel.normalizeDavResourcePath(firstConfig, absolute),
  )
  assert.equal(
    clientModel.buildDavSongDedupKey(firstConfig, relative),
    clientModel.buildDavSongDedupKey(firstConfig, absolute),
  )
  assert.notEqual(
    clientModel.buildDavDirectoryKey(firstConfig, '/Music/Album/'),
    clientModel.buildDavDirectoryKey(secondConfig, '/Music/Album/'),
  )
  const encodedSeparators = 'https://dav.example.test/webdav/Music/track%23one%3Fmix.mp3'
  assert.equal(
    clientModel.normalizeDavResourcePath(firstConfig, encodedSeparators),
    '/Music/track%23one%3Fmix.mp3',
  )
  assert.equal(clientModel.buildStreamUrl(firstConfig, encodedSeparators), encodedSeparators)
  assert.equal(
    clientModel.buildStreamUrl(
      firstConfig,
      '/webdav/song.mp3',
      { mountRelative: true },
    ),
    'https://dav.example.test/webdav/webdav/song.mp3',
  )
  assert.throws(
    () => clientModel.buildDavResourceKey(firstConfig, 'https://evil.example.test/song.mp3'),
    /Cross-origin/,
  )
})

test('only a complete current generation can commit and removals stay inside managed members', () => {
  const running = configModel.beginDavSync(configModel.createEmptyDavSyncState('/Music'))
  const candidate = {
    complete: true,
    completedAt: '2026-08-19T08:00:00Z',
    directoryPlaylists: {
      'dir-a': { path: '/Music/A', playlistId: 21 },
    },
    directories: {
      'dir-a': {
        path: '/Music/A',
        resourceKeys: ['song-a', 'song-b'],
        managedSongIds: [11, 12],
      },
    },
  }

  const stale = configModel.commitDavSyncSnapshot(running, running.generation - 1, candidate)
  assert.strictEqual(stale, running)
  const incomplete = configModel.commitDavSyncSnapshot(running, running.generation, {
    ...candidate,
    complete: false,
  })
  assert.strictEqual(incomplete, running)

  const committed = configModel.commitDavSyncSnapshot(running, running.generation, candidate)
  assert.equal(committed.lastSuccessfulSnapshot.generation, running.generation)
  assert.equal(committed.directoryPlaylists['dir-a'].playlistId, 21)

  const actualPlaylistMembers = [11, 12, 99]
  const removals = configModel.getManagedSongRemovals([11, 12], [12])
  assert.deepEqual(removals, [11])
  assert.equal(actualPlaylistMembers.includes(99), true)
  assert.equal(removals.includes(99), false)
})

const pluginBundle = await loadExecutablePluginBundle(repoRoot)
let storedConfigs = JSON.stringify([{
  name: 'Legacy NAS',
  url: 'https://dav.example.test/dav',
  username: 'listener',
  password: 'secret',
  sync: {
    scanRoot: '/Music',
    generation: 7,
    directoryPlaylists: {
      'dir-a': { path: '/Music/A', playlistId: 31 },
    },
  },
}])
const storageWrites = []

globalThis.songloft = {
  storage: {
    get: async key => key === 'dav_configs' ? storedConfigs : null,
    set: async (key, value) => {
      if (key === 'dav_configs') storedConfigs = value
      storageWrites.push({ key, value })
    },
  },
  log: {
    error() {},
  },
}

vm.runInThisContext(pluginBundle, { filename: 'dav-main.js' })

function request(method, path, body, query) {
  return globalThis.onHTTPRequest({
    method,
    path,
    headers: {},
    body: body == null ? undefined : JSON.stringify(body),
    query,
  })
}

function propfindResponse() {
  return {
    ok: true,
    status: 207,
    statusText: 'Multi-Status',
    text: async () => `<?xml version="1.0"?>
      <d:multistatus xmlns:d="DAV:">
        <d:response>
          <d:href>/dav/</d:href>
          <d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat>
        </d:response>
        <d:response>
          <d:href>/dav/Album/song.mp3</d:href>
          <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>1024</d:getcontentlength></d:prop></d:propstat>
        </d:response>
      </d:multistatus>`,
  }
}

test('persists migration, preserves sync state on rename, and keeps old source_data playable', async () => {
  globalThis.fetch = async () => propfindResponse()

  const initialList = await request('GET', '/lists')
  const initialServers = JSON.parse(initialList.body)
  const configId = initialServers[0].id
  assert.match(configId, /^dav_[a-f0-9]{8}/)
  assert.equal(storageWrites.length > 0, true)

  const beforeItems = await request(
    'GET',
    `/lists/${configId}/items`,
    undefined,
    `path=${encodeURIComponent('/')}`,
  )
  const beforeDedupKey = JSON.parse(beforeItems.body)[0].dedupKey

  const renameResponse = await request('POST', '/lists', {
    id: configId,
    name: 'Renamed NAS',
    url: 'https://dav.example.test/dav',
    username: 'listener',
    password: 'secret',
    sync: {
      generation: 999,
      directoryPlaylists: {},
    },
  })
  assert.equal(renameResponse.statusCode, 200)

  const persisted = JSON.parse(storedConfigs)[0]
  assert.equal(persisted.id, configId)
  assert.equal(persisted.name, 'Renamed NAS')
  assert.deepEqual(persisted.aliases, ['Legacy NAS'])
  assert.equal(persisted.sync.generation, 7)
  assert.equal(persisted.sync.directoryPlaylists['dir-a'].playlistId, 31)

  const afterItems = await request(
    'GET',
    `/lists/${configId}/items`,
    undefined,
    `path=${encodeURIComponent('/')}`,
  )
  assert.equal(JSON.parse(afterItems.body)[0].dedupKey, beforeDedupKey)

  for (const sourceData of [
    { configId, path: '/dav/Album/song.mp3' },
    { configName: 'Legacy NAS', path: '/dav/Album/song.mp3' },
  ]) {
    const response = await request('POST', '/api/music/url', { source_data: sourceData })
    assert.equal(response.statusCode, 200)
    assert.equal(JSON.parse(response.body).url, 'https://dav.example.test/dav/Album/song.mp3')
  }

  const connectionUpdate = await request('POST', '/lists', {
    id: configId,
    name: 'Renamed NAS',
    url: 'https://new-dav.example.test/library',
    username: 'listener',
    password: 'new-secret',
  })
  assert.equal(connectionUpdate.statusCode, 200)
  const movedConfig = JSON.parse(storedConfigs)[0]
  assert.equal(movedConfig.id, configId)
  assert.equal(movedConfig.sync.generation, 8)
  assert.deepEqual(movedConfig.mountAliases, ['/dav'])
  assert.deepEqual(movedConfig.endpointAliases, ['https://dav.example.test/dav'])

  const movedResponse = await request('POST', '/api/music/url', {
    source_data: { configId, path: '/dav/Album/song.mp3' },
  })
  assert.equal(movedResponse.statusCode, 200)
  assert.equal(JSON.parse(movedResponse.body).url, 'https://new-dav.example.test/library/Album/song.mp3')

  const movedAbsoluteResponse = await request('POST', '/api/music/url', {
    source_data: {
      configId,
      path: 'https://dav.example.test/dav/Album/song.mp3',
    },
  })
  assert.equal(movedAbsoluteResponse.statusCode, 200)
  assert.equal(
    JSON.parse(movedAbsoluteResponse.body).url,
    'https://new-dav.example.test/library/Album/song.mp3',
  )

  const explicitRelativeResponse = await request('POST', '/api/music/url', {
    source_data: {
      configId,
      path: '/dav/Album/song.mp3',
      pathMode: 'mount-relative',
    },
  })
  assert.equal(explicitRelativeResponse.statusCode, 200)
  assert.equal(
    JSON.parse(explicitRelativeResponse.body).url,
    'https://new-dav.example.test/library/dav/Album/song.mp3',
  )
})

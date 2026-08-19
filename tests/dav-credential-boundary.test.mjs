import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { loadExecutablePluginBundle } from './helpers/load-plugin-bundle.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pluginBundle = await loadExecutablePluginBundle(repoRoot)

const config = {
  name: 'primary',
  url: 'https://dav.example.test/dav',
  username: '用户',
  password: 'pässword',
}

globalThis.songloft = {
  storage: {
    get: async key => key === 'dav_configs' ? JSON.stringify([config]) : null,
    set: async () => {},
  },
  log: {
    error() {},
  },
}

vm.runInThisContext(pluginBundle, { filename: 'dav-main.js' })

function musicUrlRequest(path) {
  return {
    method: 'POST',
    path: '/api/music/url',
    headers: {},
    body: JSON.stringify({
      source_data: {
        configName: config.name,
        path,
      },
    }),
  }
}

function coverRequest(path) {
  return {
    method: 'GET',
    path: '/api/cover',
    headers: {},
    query: `configName=${config.name}&path=${encodeURIComponent(path)}`,
  }
}

function listItemsRequest(path = '/') {
  return {
    method: 'GET',
    path: `/lists/${config.name}/items`,
    headers: {},
    query: `path=${encodeURIComponent(path)}`,
  }
}

test('rejects a cross-origin absolute WebDAV href without exposing credentials', async () => {
  const response = await globalThis.onHTTPRequest(
    musicUrlRequest('https://evil.example.test/stolen.mp3'),
  )

  assert.equal(response.statusCode, 404)
  assert.equal(response.body.includes(config.username), false)
  assert.equal(response.body.includes(config.password), false)
})

test('returns same-origin media URL without userinfo and carries UTF-8 Basic auth in headers', async () => {
  const response = await globalThis.onHTTPRequest(
    musicUrlRequest('https://dav.example.test/dav/音乐/song.mp3'),
  )
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 200, response.body)
  assert.equal(body.url, 'https://dav.example.test/dav/%E9%9F%B3%E4%B9%90/song.mp3')
  assert.equal(body.url.includes('@'), false)
  assert.equal(
    body.headers.Authorization,
    `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`,
  )
})

test('keeps mounted relative hrefs on the configured origin', async () => {
  const response = await globalThis.onHTTPRequest(
    musicUrlRequest('/dav/album/song.mp3'),
  )
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 200)
  assert.equal(body.url, 'https://dav.example.test/dav/album/song.mp3')
  assert.equal(new URL(body.url).origin, new URL(config.url).origin)
})

test('cover proxy rejects a cross-origin href before fetch', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }

  const response = await globalThis.onHTTPRequest(
    coverRequest('https://evil.example.test/cover.jpg'),
  )

  assert.equal(response.statusCode, 502)
  assert.deepEqual(fetchCalls, [])
})

test('cover proxy sends Basic auth only to the configured origin', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'image/jpeg' }),
      arrayBuffer: async () => Uint8Array.from([1, 2]).buffer,
    }
  }

  const response = await globalThis.onHTTPRequest(
    coverRequest('/dav/covers/front.jpg'),
  )

  assert.equal(response.statusCode, 200)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, 'https://dav.example.test/dav/covers/front.jpg')
  assert.equal(
    fetchCalls[0].init.headers.Authorization,
    `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`,
  )
  assert.equal(fetchCalls[0].init.headers['X-Fetch-No-Redirect'], '1')
})

test('cover proxy does not follow WebDAV redirects with credentials', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return {
      ok: false,
      status: 302,
      headers: new Headers({ location: 'https://evil.example.test/cover.jpg' }),
      arrayBuffer: async () => new ArrayBuffer(0),
    }
  }

  const response = await globalThis.onHTTPRequest(
    coverRequest('/dav/covers/redirect.jpg'),
  )

  assert.equal(response.statusCode, 502)
  assert.equal(response.headers.Location, undefined)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].init.headers['X-Fetch-No-Redirect'], '1')
})

test('directory listing drops cross-origin file hrefs', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return {
      ok: true,
      status: 207,
      statusText: 'Multi-Status',
      text: async () => `<?xml version="1.0"?>
        <d:multistatus xmlns:d="DAV:">
          <d:response>
            <d:href>https://evil.example.test/stolen.mp3</d:href>
            <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>7</d:getcontentlength></d:prop></d:propstat>
          </d:response>
          <d:response>
            <d:href>https://dav.example.test/dav/local.mp3</d:href>
            <d:propstat><d:prop><d:resourcetype/><d:getcontentlength>9</d:getcontentlength></d:prop></d:propstat>
          </d:response>
        </d:multistatus>`,
    }
  }

  const response = await globalThis.onHTTPRequest(listItemsRequest())
  const body = JSON.parse(response.body)

  assert.equal(response.statusCode, 200, response.body)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].url, 'https://dav.example.test/dav/')
  assert.equal(fetchCalls[0].init.headers['X-Fetch-No-Redirect'], '1')
  assert.equal(body.length, 1)
  assert.equal(body[0].id, '/local.mp3')
  assert.equal(body[0].streamUrl, 'https://dav.example.test/dav/local.mp3')
})

test('PROPFIND does not follow redirects with credentials', async () => {
  const fetchCalls = []
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init })
    return {
      ok: false,
      status: 302,
      statusText: 'Found',
      text: async () => '',
    }
  }

  const response = await globalThis.onHTTPRequest(listItemsRequest())

  assert.equal(response.statusCode, 500)
  assert.equal(fetchCalls.length, 1)
  assert.equal(fetchCalls[0].init.headers['X-Fetch-No-Redirect'], '1')
  assert.equal(response.body.includes('evil.example.test'), false)
})

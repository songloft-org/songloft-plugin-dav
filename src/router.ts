import { createRouter, jsonResponse, createSearchHandler, createMusicUrlHandler } from '@songloft/plugin-sdk'
import type { HTTPRequest } from '@songloft/plugin-sdk'
import {
  beginDavSync,
  createDavConfig,
  getConfigs,
  saveConfigs,
  getConfig,
  matchesDavConfigIdentifier,
  DavConfig
} from './config'
import {
  propfind,
  buildDavDirectoryKey,
  buildDavResourceKey,
  buildDavSongDedupKey,
  buildStreamRequest,
  buildStreamUrl,
  normalizeDavScanRoot,
  testDavConnection
} from './client'
import { listDavSyncRoots, setDavSyncRoot } from './sync'
import {
  deleteDavSyncTaskCheckpoints,
  getDavSyncTask
} from './sync-task'
import {
  cancelDavSyncInBackground,
  runDavSyncStep,
  startDavSyncInBackground
} from './sync-runner'

function parseBody(req: HTTPRequest): any {
  if (!req.body) return {}
  try {
    const str = typeof req.body === 'string'
      ? req.body
      : String.fromCharCode.apply(null, Array.from(req.body as Uint8Array))
    return JSON.parse(str)
  } catch {
    return {}
  }
}

function urlMountPath(url: string): string | undefined {
  try {
    return new URL(url).pathname.replace(/\/$/, '') || '/'
  } catch {
    return undefined
  }
}

function urlEndpoint(url: string): string | undefined {
  try {
    const endpoint = new URL(url)
    if (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') return undefined
    endpoint.username = ''
    endpoint.password = ''
    endpoint.search = ''
    endpoint.hash = ''
    return endpoint.toString().replace(/\/$/, '')
  } catch {
    return undefined
  }
}

const router = createRouter()

// 列出所有配置的 WebDAV
router.get('/lists', async (req: HTTPRequest) => {
  const configs = await getConfigs()
  return jsonResponse(configs.map(c => ({
    id: c.id,
    name: c.name,
    url: c.url
  })))
})

// 添加/更新 WebDAV 配置
router.post('/lists', async (req: HTTPRequest) => {
  const data = parseBody(req)
  const configs = await getConfigs()
  const name = typeof data.name === 'string' ? data.name.trim() : ''
  const url = typeof data.url === 'string' ? data.url.trim().replace(/\/$/, '') : ''
  if (!name || !url) {
    return jsonResponse({ error: 'Name and URL are required' }, 400)
  }

  const requestedId = typeof data.id === 'string' ? data.id : ''
  const existing = requestedId
    ? configs.findIndex(config => config.id === requestedId)
    : configs.findIndex(config => config.name === name)
  if (requestedId && existing < 0) {
    return jsonResponse({ error: 'Config not found' }, 404)
  }
  const conflicting = configs.findIndex((config, index) =>
    index !== existing && matchesDavConfigIdentifier(config, name)
  )
  if (conflicting >= 0) {
    return jsonResponse({ error: 'Config name conflicts with an existing identity' }, 409)
  }

  const input = {
    name,
    url,
    username: typeof data.username === 'string' ? data.username : undefined,
    password: typeof data.password === 'string' ? data.password : undefined
  }
  if (existing >= 0) {
    const previous = configs[existing]
    const connectionChanged = previous.url !== input.url ||
      previous.username !== input.username ||
      previous.password !== input.password
    const aliases = previous.name !== name
      ? Array.from(new Set([...(previous.aliases || []), previous.name])).filter(alias => alias !== name)
      : previous.aliases
    const previousMount = urlMountPath(previous.url)
    const currentMount = urlMountPath(input.url)
    const previousEndpoint = urlEndpoint(previous.url)
    const currentEndpoint = urlEndpoint(input.url)
    const mountAliases = Array.from(new Set([
      ...(previous.mountAliases || []),
      ...(previousMount && previousMount !== '/' ? [previousMount] : [])
    ])).filter(mount => mount !== currentMount)
    const endpointAliases = Array.from(new Set([
      ...(previous.endpointAliases || []),
      ...(previousEndpoint ? [previousEndpoint] : [])
    ])).filter(endpoint => endpoint !== currentEndpoint)
    configs[existing] = {
      ...previous,
      ...input,
      aliases,
      mountAliases,
      endpointAliases,
      sync: connectionChanged && previous.sync ? beginDavSync(previous.sync) : previous.sync
    }
  } else {
    configs.push(createDavConfig(input, configs))
  }
  await saveConfigs(configs)
  const saved = existing >= 0 ? configs[existing] : configs[configs.length - 1]
  return jsonResponse({ success: true, id: saved.id })
})

// 删除配置
router.delete('/lists/:id', async (req: HTTPRequest, params) => {
  const configs = await getConfigs()
  const deletedConfigIds = configs
    .filter(config => matchesDavConfigIdentifier(config, params.id))
    .flatMap(config => config.id ? [config.id] : [])
  const filtered = configs.filter(config => !matchesDavConfigIdentifier(config, params.id))
  await saveConfigs(filtered)
  await Promise.all(deletedConfigIds.map(deleteDavSyncTaskCheckpoints))
  return jsonResponse({ success: true })
})

// 测试连接
router.post('/test', async (req: HTTPRequest) => {
  const data = parseBody(req)
  return jsonResponse(await testDavConnection(data as DavConfig))
})

// 获取特定配置下的文件/目录
router.get('/lists/:id/items', async (req: HTTPRequest, params) => {
  const config = await getConfig(params.id)
  if (!config) {
    return jsonResponse({ error: 'Config not found' }, 404)
  }
  
  let dirPath = '/'
  if (req.query) {
    const match = req.query.match(/(?:^|&)path=([^&]*)/)
    if (match) dirPath = decodeURIComponent(match[1])
  }
  
  try {
    const items = await propfind(config, dirPath)
    
    // 过滤掉当前目录本身
    const configUrlObj = new URL(config.url)
    const configUrlPath = decodeURIComponent(configUrlObj.pathname).replace(/\/$/, '')
    const reqPath = dirPath === '/' ? '' : dirPath.replace(/\/$/, '')
    const expectedPathname = configUrlPath + reqPath

    const filteredItems = items.filter(i => {
      let itemPathname = i.filename
      if (itemPathname.startsWith('http')) {
        try {
          itemPathname = new URL(itemPathname).pathname
        } catch {}
      }
      itemPathname = decodeURIComponent(itemPathname).replace(/\/$/, '')
      return itemPathname !== expectedPathname
    })
    
    return jsonResponse(filteredItems.flatMap(item => {
      let streamUrl = ''
      try {
        const resourceKey = buildDavResourceKey(config, item.filename)
        if (item.type === 'file') {
          streamUrl = buildStreamUrl(config, item.filename)
        }
        return [{
          id: normalizeDavScanRoot(config, item.filename),
          name: item.basename,
          type: item.type,
          size: item.size,
          streamUrl,
          resourceKey,
          directoryKey: item.type === 'directory' ? buildDavDirectoryKey(config, item.filename) : '',
          dedupKey: item.type === 'file' ? buildDavSongDedupKey(config, item.filename) : ''
        }]
      } catch {
        return []
      }
    }))
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

// 封面代理 — 后端 GetSongCover 通过 InternalURLResolver 解析相对 URL 后请求此端点
router.get('/api/cover', async (req: HTTPRequest) => {
  let configId = ''
  let configName = ''
  let path = ''
  if (req.query) {
    const ci = req.query.match(/(?:^|&)configId=([^&]*)/)
    if (ci) configId = decodeURIComponent(ci[1])
    const cm = req.query.match(/(?:^|&)configName=([^&]*)/)
    if (cm) configName = decodeURIComponent(cm[1])
    const pm = req.query.match(/(?:^|&)path=([^&]*)/)
    if (pm) path = decodeURIComponent(pm[1])
  }
  const configRef = configId || configName
  if (!configRef || !path) {
    return jsonResponse({ error: 'Missing configId/configName or path' }, 400)
  }
  const config = await getConfig(configRef)
  if (!config) {
    return jsonResponse({ error: 'Config not found' }, 404)
  }
  try {
    const request = buildStreamRequest(config, path, { legacyEndpointAliases: true })
    const resp = await fetch(request.url, {
      headers: { ...request.headers, 'X-Fetch-No-Redirect': '1' }
    })
    if (resp.status >= 300 && resp.status < 400) {
      return { statusCode: 502, headers: {}, body: 'Cross-origin cover redirect rejected' }
    }
    if (!resp.ok) {
      return { statusCode: resp.status, headers: {}, body: `Cover fetch failed: ${resp.status}` }
    }
    const ct = resp.headers.get('content-type') || 'image/jpeg'
    const buf = await resp.arrayBuffer()
    return { statusCode: 200, headers: { 'Content-Type': ct }, body: new Uint8Array(buf) }
  } catch (e) {
    return jsonResponse({ error: String(e) }, 502)
  }
})

// 歌词代理 — 后端 LyricFetcher 通过 InternalURLResolver 解析相对 URL 后请求此端点
// 返回格式须符合 LyricFetcher 期望: {"code":0,"data":{"lyric":"...","tlyric":"","rlyric":"","lxlyric":""}}
router.get('/api/lyric', async (req: HTTPRequest) => {
  let configId = ''
  let configName = ''
  let path = ''
  if (req.query) {
    const ci = req.query.match(/(?:^|&)configId=([^&]*)/)
    if (ci) configId = decodeURIComponent(ci[1])
    const cm = req.query.match(/(?:^|&)configName=([^&]*)/)
    if (cm) configName = decodeURIComponent(cm[1])
    const pm = req.query.match(/(?:^|&)path=([^&]*)/)
    if (pm) path = decodeURIComponent(pm[1])
  }
  const configRef = configId || configName
  if (!configRef || !path) {
    return jsonResponse({ code: -1, data: {}, message: 'Missing configId/configName or path' })
  }
  const config = await getConfig(configRef)
  if (!config) {
    return jsonResponse({ code: -1, data: {}, message: 'Config not found' })
  }
  try {
    const request = buildStreamRequest(config, path, { legacyEndpointAliases: true })
    const resp = await fetch(request.url, {
      headers: { ...request.headers, 'X-Fetch-No-Redirect': '1' }
    })
    if (resp.status >= 300 && resp.status < 400) {
      return jsonResponse({ code: -1, data: {}, message: 'WebDAV lyric redirect rejected' })
    }
    if (!resp.ok) {
      return jsonResponse({ code: -1, data: {}, message: `Lyric fetch failed: ${resp.status}` })
    }
    const text = await resp.text()
    return jsonResponse({ code: 0, data: { lyric: text, tlyric: '', rlyric: '', lxlyric: '' } })
  } catch (e) {
    return jsonResponse({ code: -1, data: {}, message: String(e) })
  }
})

// 全局搜索 - WebDAV 无法提供全局检索，返回空
router.post('/api/search', createSearchHandler({
  search: async () => {
    return []
  }
}))

// 播放链接解析
router.post('/api/music/url', createMusicUrlHandler({
  resolveUrl: async (sourceData: Record<string, unknown>) => {
    const configId = sourceData.configId as string
    const configName = sourceData.configName as string
    const path = sourceData.path as string
    const pathMode = sourceData.pathMode as string
    const configRef = configId || configName
    if (!configRef || !path) throw new Error('Invalid source_data')
    
    const config = await getConfig(configRef)
    if (!config) throw new Error('WebDAV config not found: ' + configRef)
    
    return buildStreamRequest(config, path, {
      mountRelative: pathMode === 'mount-relative',
      legacyEndpointAliases: pathMode !== 'mount-relative'
    })
  }
}))

// WebDAV 目录同步：插件后台运行器用有界步骤推进持久任务，页面只读取状态。
router.get('/sync-roots', async () => {
  return jsonResponse(await listDavSyncRoots())
})

router.post('/sync-roots/:id', async (req: HTTPRequest, params) => {
  const data = parseBody(req)
  try {
    return jsonResponse(await setDavSyncRoot(
      params.id,
      typeof data.path === 'string' ? data.path : '/'
    ))
  } catch (e) {
    const message = String(e)
    return jsonResponse({ error: message }, message.includes('not found') ? 404 : 400)
  }
})

router.post('/sync-roots/:id/run', async (_req: HTTPRequest, params) => {
  try {
    return jsonResponse(await startDavSyncInBackground(params.id), 202)
  } catch (e) {
    const message = String(e)
    return jsonResponse({ error: message }, message.includes('not found') ? 404 : 500)
  }
})

router.get('/sync-roots/:id/status', async (_req: HTTPRequest, params) => {
  try {
    return jsonResponse({ task: await getDavSyncTask(params.id) })
  } catch (e) {
    const message = String(e)
    return jsonResponse({ error: message }, message.includes('not found') ? 404 : 500)
  }
})

router.post('/sync-roots/:id/advance', async (req: HTTPRequest, params) => {
  const data = parseBody(req)
  const taskId = typeof data.taskId === 'string' ? data.taskId : ''
  if (!taskId) return jsonResponse({ error: 'taskId is required' }, 400)
  try {
    const current = await getDavSyncTask(params.id)
    return jsonResponse(await runDavSyncStep(current?.configId || params.id, taskId))
  } catch (e) {
    const message = String(e)
    const status = message.includes('not found')
      ? 404
      : message.includes('superseded') || message.includes('generation changed')
        ? 409
        : 500
    return jsonResponse({ error: message }, status)
  }
})

router.delete('/sync-roots/:id/run', async (req: HTTPRequest, params) => {
  const data = parseBody(req)
  const taskId = typeof data.taskId === 'string' ? data.taskId : ''
  if (!taskId) return jsonResponse({ error: 'taskId is required' }, 400)
  try {
    const result = await cancelDavSyncInBackground(params.id, taskId)
    return jsonResponse(result, result.tooLate ? 409 : 202)
  } catch (e) {
    const message = String(e)
    const status = message.includes('not found')
      ? 404
      : message.includes('superseded')
        ? 409
        : 500
    return jsonResponse({ error: message }, status)
  }
})

router.post('/sync-roots/:id/retry', async (_req: HTTPRequest, params) => {
  try {
    return jsonResponse(await startDavSyncInBackground(params.id), 202)
  } catch (e) {
    const message = String(e)
    return jsonResponse({ error: message }, message.includes('not found') ? 404 : 500)
  }
})

// 新增前端 API - 扁平化搜索 (WebDAV 不支持)
router.get('/lists/:id/search', async () => {
  return jsonResponse([])
})

// 新增前端 API - 我的收藏 (WebDAV 无此概念)
router.get('/lists/:id/starred', async () => {
  return jsonResponse([])
})

// 新增前端 API - 随机听听 (WebDAV 不支持)
router.get('/lists/:id/random', async () => {
  return jsonResponse([])
})

export default router

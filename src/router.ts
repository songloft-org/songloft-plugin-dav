import { createRouter, jsonResponse, createSearchHandler, createMusicUrlHandler } from '@songloft/plugin-sdk'
import type { HTTPRequest } from '@songloft/plugin-sdk'
import { getConfigs, saveConfigs, getConfig, DavConfig } from './config'
import { propfind, buildStreamUrl } from './client'

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

const router = createRouter()

// 列出所有配置的 WebDAV
router.get('/lists', async (req: HTTPRequest) => {
  const configs = await getConfigs()
  return jsonResponse(configs.map(c => ({
    id: c.name,
    name: c.name,
    url: c.url
  })))
})

// 添加/更新 WebDAV 配置
router.post('/lists', async (req: HTTPRequest) => {
  const data = parseBody(req)
  const configs = await getConfigs()
  const existing = configs.findIndex(c => c.name === data.name)
  if (existing >= 0) {
    configs[existing] = data
  } else {
    configs.push(data)
  }
  await saveConfigs(configs)
  return jsonResponse({ success: true })
})

// 删除配置
router.delete('/lists/:id', async (req: HTTPRequest, params) => {
  const configs = await getConfigs()
  const filtered = configs.filter(c => c.name !== params.id)
  await saveConfigs(filtered)
  return jsonResponse({ success: true })
})

// 测试连接
router.post('/test', async (req: HTTPRequest) => {
  const data = parseBody(req)
  try {
    const items = await propfind(data as DavConfig, '/')
    return jsonResponse({ success: true, count: items.length })
  } catch (e) {
    return jsonResponse({ success: false, error: String(e) })
  }
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
    
    return jsonResponse(filteredItems.map(item => ({
      id: item.filename,
      name: item.basename,
      type: item.type,
      size: item.size,
      streamUrl: item.type === 'file' ? buildStreamUrl(config, item.filename) : ''
    })))
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

// 封面代理 — 后端 GetSongCover 通过 InternalURLResolver 解析相对 URL 后请求此端点
router.get('/api/cover', async (req: HTTPRequest) => {
  let configName = ''
  let path = ''
  if (req.query) {
    const cm = req.query.match(/(?:^|&)configName=([^&]*)/)
    if (cm) configName = decodeURIComponent(cm[1])
    const pm = req.query.match(/(?:^|&)path=([^&]*)/)
    if (pm) path = decodeURIComponent(pm[1])
  }
  if (!configName || !path) {
    return jsonResponse({ error: 'Missing configName or path' }, 400)
  }
  const config = await getConfig(configName)
  if (!config) {
    return jsonResponse({ error: 'Config not found' }, 404)
  }
  const streamUrl = buildStreamUrl(config, path)
  try {
    const resp = await fetch(streamUrl)
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
  let configName = ''
  let path = ''
  if (req.query) {
    const cm = req.query.match(/(?:^|&)configName=([^&]*)/)
    if (cm) configName = decodeURIComponent(cm[1])
    const pm = req.query.match(/(?:^|&)path=([^&]*)/)
    if (pm) path = decodeURIComponent(pm[1])
  }
  if (!configName || !path) {
    return jsonResponse({ code: -1, data: {}, message: 'Missing configName or path' })
  }
  const config = await getConfig(configName)
  if (!config) {
    return jsonResponse({ code: -1, data: {}, message: 'Config not found' })
  }
  const streamUrl = buildStreamUrl(config, path)
  try {
    const resp = await fetch(streamUrl)
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
    const configName = sourceData.configName as string
    const path = sourceData.path as string
    if (!configName || !path) throw new Error('Invalid source_data')
    
    const config = await getConfig(configName)
    if (!config) throw new Error('WebDAV config not found: ' + configName)
    
    return buildStreamUrl(config, path)
  }
}))

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

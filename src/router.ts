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

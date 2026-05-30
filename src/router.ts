import { createRouter, jsonResponse, createSearchHandler, createMusicUrlHandler } from '@songloft/plugin-sdk'
import type { HTTPRequest } from '@songloft/plugin-sdk'
import { getConfigs, saveConfigs, getConfig, DavConfig } from './config'
import { propfind } from './client'

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
    
    // 过滤掉当前目录 (.)
    const filteredItems = items.filter(i => {
      // PROPFIND 会返回自身目录，需要将其排除
      const reqPath = dirPath === '/' ? '/' : dirPath.replace(/\/$/, '')
      const itemPath = i.filename.replace(/\/$/, '')
      return itemPath !== reqPath && !itemPath.endsWith(reqPath)
    })
    
    return jsonResponse(filteredItems.map(item => ({
      basename: item.basename,
      type: item.type,
      size: item.size,
      lastmod: item.lastmod
    })))
  } catch (e) {
    return jsonResponse({ error: String(e) }, 500)
  }
})

// 全局搜索 - WebDAV 无法提供全局检索，返回空
router.post('/search', createSearchHandler({
  search: async () => {
    return []
  }
}))

// 播放链接解析
router.post('/music/url', createMusicUrlHandler({
  resolveUrl: async (sourceData: Record<string, unknown>) => {
    const configName = sourceData.configName as string
    const path = sourceData.path as string
    if (!configName || !path) throw new Error('Invalid source_data')
    
    const config = await getConfig(configName)
    if (!config) throw new Error('WebDAV config not found: ' + configName)
    
    // 构建直链，将账号密码放入 url 以供前端播放
    const urlObj = new URL(config.url)
    if (config.username && config.password) {
      urlObj.username = config.username
      urlObj.password = config.password
    }
    const fullPath = urlObj.toString().replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path)
    return fullPath
  }
}))

export default router

// No need to import songloft, it's globally provided by QuickJS env

export interface DavConfig {
  url: string
  username?: string
  password?: string
  name: string
}

const CONFIG_KEY = 'dav_configs'

export async function getConfigs(): Promise<DavConfig[]> {
  try {
    const val = await songloft.storage.get(CONFIG_KEY)
    if (val) {
      return JSON.parse(val) as DavConfig[]
    }
  } catch (err) {
    songloft.logger.error('Failed to get dav configs', String(err))
  }
  return []
}

export async function saveConfigs(configs: DavConfig[]): Promise<void> {
  await songloft.storage.set(CONFIG_KEY, JSON.stringify(configs))
}

export async function getConfig(name: string): Promise<DavConfig | undefined> {
  const configs = await getConfigs()
  return configs.find(c => c.name === name)
}

let currentServers = []
let currentPath = '/'
let isSelectMode = false
let selectedItems = new Map()
let currentListItems = []
const NEW_PLAYLIST_VALUE = '__new__'

// UI 工具函数
function showSnackbar(message) {
    const snackbar = document.getElementById('snackbar');
    snackbar.textContent = message;
    snackbar.classList.add('show');
    setTimeout(() => {
        snackbar.classList.remove('show');
    }, 3000);
}

function showProgress(show, title = '正在处理', text = '请稍候...') {
    const dlg = document.getElementById('progressDialog')
    if (!dlg) return
    if (show) {
        document.getElementById('progressTitle').textContent = title
        document.getElementById('progressText').textContent = text
        dlg.classList.add('show')
    } else {
        dlg.classList.remove('show')
    }
}

function renderMessage(container, message, isError = false) {
    const state = document.createElement('div')
    state.className = 'empty-state'
    if (isError) state.style.color = 'var(--md-error)'
    state.textContent = message
    container.replaceChildren(state)
}

function createIcon(name, color) {
    const icon = document.createElement('span')
    icon.className = 'material-symbols-outlined'
    if (color) icon.style.color = color
    icon.textContent = name
    return icon
}

function switchTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'))
    document.querySelectorAll('.tab-item').forEach(el => el.classList.remove('active'))
    
    document.getElementById(`tab-${tabId}`).classList.add('active')
    document.querySelector(`.tab-item[data-tab="${tabId}"]`).classList.add('active')
}

// API 调用
function getAuthHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = SongloftPlugin.getAuthToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
}

async function fetchServers() {
    try {
        const res = await fetch('./lists', { headers: getAuthHeaders() })
        const data = await res.json()
        currentServers = data
        renderServerList()
        renderBrowserSelect()
    } catch (e) {
        showSnackbar('获取服务器失败: ' + e)
    }
}

async function addServer() {
    const name = document.getElementById('davName').value.trim()
    const url = document.getElementById('davUrl').value.trim()
    const username = document.getElementById('davUsername').value.trim()
    const password = document.getElementById('davPassword').value.trim()

    if (!name || !url) {
        showSnackbar('名称和地址不能为空')
        return
    }

    try {
        const cleanUrl = url.replace(/\/$/, '')
        const res = await fetch('./lists', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ name, url: cleanUrl, username, password })
        })
        if (res.ok) {
            showSnackbar('保存成功')
            document.getElementById('davName').value = ''
            document.getElementById('davUrl').value = ''
            document.getElementById('davUsername').value = ''
            document.getElementById('davPassword').value = ''
            fetchServers()
        }
    } catch (e) {
        showSnackbar('保存失败: ' + e)
    }
}

async function testServer() {
    const name = document.getElementById('davName').value.trim()
    const url = document.getElementById('davUrl').value.trim()
    const username = document.getElementById('davUsername').value.trim()
    const password = document.getElementById('davPassword').value.trim()

    if (!url) {
        showSnackbar('测试失败：服务器地址不能为空')
        return
    }

    const testBtn = document.getElementById('testServerBtn')
    const originalText = testBtn.innerHTML
    testBtn.innerHTML = '<span class="material-symbols-outlined">hourglass_empty</span> 测试中...'
    testBtn.style.opacity = '0.7'

    try {
        const cleanUrl = url.replace(/\/$/, '')
        const res = await fetch('./test', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ name: name || 'Test', url: cleanUrl, username, password })
        })
        const data = await res.json()
        if (data.success) {
            if (data.readChecked) {
                showSnackbar('测试成功：已验证一个音乐文件可读取')
                testBtn.innerHTML = '<span class="material-symbols-outlined" style="color:green">check_circle</span> 测试通过'
            } else {
                showSnackbar(data.warning || '目录连接正常，但未验证文件读取')
                testBtn.innerHTML = '<span class="material-symbols-outlined" style="color:#f59e0b">warning</span> 部分通过'
            }
        } else {
            showSnackbar('测试失败: ' + (data.error || '未知错误'))
            testBtn.innerHTML = '<span class="material-symbols-outlined" style="color:red">error</span> 测试失败'
        }
    } catch (e) {
        showSnackbar('测试异常: ' + e)
        testBtn.innerHTML = '<span class="material-symbols-outlined" style="color:red">error</span> 测试异常'
    } finally {
        setTimeout(() => {
            testBtn.innerHTML = originalText
            testBtn.style.opacity = '1'
        }, 3000)
    }
}

async function deleteServer(name) {
    if (!confirm(`确定删除 ${name} 吗？`)) return
    try {
        const res = await fetch(`./lists/${encodeURIComponent(name)}`, { 
            method: 'DELETE',
            headers: getAuthHeaders()
        })
        if (res.ok) {
            showSnackbar('删除成功')
            fetchServers()
        }
    } catch (e) {
        showSnackbar('删除失败: ' + e)
    }
}

// 渲染视图
function renderServerList() {
    const container = document.getElementById('serverList')
    if (currentServers.length === 0) {
        renderMessage(container, '暂无服务器，请先添加')
        return
    }

    container.replaceChildren()
    currentServers.forEach(server => {
        const item = document.createElement('div')
        item.style.cssText = 'display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--md-outline-variant)'

        const details = document.createElement('div')
        details.style.flex = '1'
        const name = document.createElement('div')
        name.style.cssText = 'font-size:16px;color:var(--md-on-surface);font-weight:500'
        name.textContent = server.name
        const url = document.createElement('div')
        url.style.cssText = 'font-size:13px;color:var(--md-on-surface-variant);margin-top:4px'
        url.textContent = server.url
        details.append(name, url)

        const deleteButton = document.createElement('button')
        deleteButton.className = 'btn-icon'
        deleteButton.style.color = 'var(--md-error)'
        deleteButton.title = '删除'
        deleteButton.appendChild(createIcon('delete'))
        deleteButton.addEventListener('click', () => deleteServer(server.name))

        item.append(details, deleteButton)
        container.appendChild(item)
    })
}

function renderBrowserSelect() {
    const select = document.getElementById('browserServerSelect')
    const currentVal = select.value
    
    select.innerHTML = '<option value="">请选择服务器...</option>'
    currentServers.forEach(server => {
        const opt = document.createElement('option')
        opt.value = server.name
        opt.textContent = server.name
        select.appendChild(opt)
    })
    
    if (currentServers.some(s => s.name === currentVal)) {
        select.value = currentVal
        const toggleBtn = document.getElementById('toggleSelectModeBtn')
        if (toggleBtn) toggleBtn.style.display = 'block'
    } else {
        document.getElementById('browserList').innerHTML = '<div class="empty-state">请选择服务器进行浏览</div>'
        currentPath = '/'
        const toggleBtn = document.getElementById('toggleSelectModeBtn')
        if (toggleBtn) toggleBtn.style.display = 'none'
        if (isSelectMode) toggleSelectMode()
    }
}

function renderItems(items, path) {
    currentListItems = items
    const container = document.getElementById('browserList')
    document.getElementById('browserPathDisplay').textContent = path
    
    if (items.length === 0) {
        renderMessage(container, '空目录')
        return
    }
    
    container.replaceChildren()
    
    if (isSelectMode) {
        const selectAllDiv = document.createElement('div')
        selectAllDiv.style.cssText = 'display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--md-outline-variant);cursor:pointer;gap:12px;'
        const allSelected = items.every(item => item.type !== 'directory' && selectedItems.has(item.id))
        const checkbox = document.createElement('input')
        checkbox.type = 'checkbox'
        checkbox.className = 'checkbox-custom'
        checkbox.checked = allSelected
        checkbox.style.pointerEvents = 'none'
        const label = document.createElement('span')
        label.style.cssText = 'font-weight:500;font-size:14px;color:var(--md-primary)'
        label.textContent = '全选本页歌曲'
        selectAllDiv.append(checkbox, label)
        selectAllDiv.addEventListener('click', () => {
            const willSelect = !allSelected
            items.forEach(item => {
                if (item.type !== 'directory') {
                    if (willSelect) selectedItems.set(item.id, item)
                    else selectedItems.delete(item.id)
                }
            })
            renderItems(items, path)
            updateFAB()
        })
        container.appendChild(selectAllDiv)
    }

    items.forEach(item => {
        const el = document.createElement('div')
        el.style.cssText = 'display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--md-outline-variant);cursor:pointer;'
        el.classList.add('browser-item')
        
        const isSelected = selectedItems.has(item.id)
        const icon = item.type === 'directory' ? 'folder' : 'audio_file'
        const color = item.type === 'directory' ? 'var(--md-primary)' : 'var(--md-on-surface)'

        if (isSelectMode && item.type !== 'directory') {
            const checkbox = document.createElement('input')
            checkbox.type = 'checkbox'
            checkbox.className = 'checkbox-custom'
            checkbox.checked = isSelected
            checkbox.style.cssText = 'pointer-events:none;margin-right:12px'
            el.appendChild(checkbox)
        } else {
            const leadingIcon = createIcon(icon, color)
            leadingIcon.style.marginRight = '12px'
            el.appendChild(leadingIcon)
        }

        const details = document.createElement('div')
        details.style.cssText = 'flex:1;overflow:hidden'
        const name = document.createElement('div')
        name.style.cssText = 'font-size:14px;color:var(--md-on-surface);white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
        name.textContent = item.name
        const subtitle = document.createElement('div')
        subtitle.style.cssText = 'font-size:12px;color:var(--md-on-surface-variant);margin-top:2px'
        subtitle.textContent = item.type === 'directory' ? '目录' : (item.size / 1024 / 1024).toFixed(2) + ' MB'
        details.append(name, subtitle)
        el.appendChild(details)

        if (item.type !== 'directory') {
            const importButton = document.createElement('button')
            importButton.className = 'btn-icon'
            importButton.title = '导入此曲'
            importButton.style.color = 'var(--md-primary)'
            importButton.appendChild(createIcon('add_circle'))
            importButton.addEventListener('click', event => {
                event.stopPropagation()
                window._importSingle(item.id)
            })
            el.appendChild(importButton)
        }

        el.addEventListener('click', () => {
            if (item.type === 'directory') {
                const serverName = document.getElementById('browserServerSelect').value
                const newPath = path.endsWith('/') ? path + item.name : path + '/' + item.name
                loadDirectory(serverName, newPath)
            } else {
                if (isSelectMode) {
                    if (isSelected) selectedItems.delete(item.id)
                    else selectedItems.set(item.id, item)
                    renderItems(items, path)
                    updateFAB()
                } else {
                    showSnackbar('可以直接播放：' + item.name)
                }
            }
        })
        
        el.onmouseenter = () => el.style.backgroundColor = 'var(--md-surface-container-high)'
        el.onmouseleave = () => el.style.backgroundColor = 'transparent'
        
        container.appendChild(el)
    })
}

function updateFAB() {
    const fab = document.getElementById('fabContainer')
    if (!fab) return
    if (isSelectMode && selectedItems.size > 0) {
        fab.classList.add('show')
        document.getElementById('fabSelectionCount').textContent = `已选 ${selectedItems.size} 项`
    } else {
        fab.classList.remove('show')
    }
}

function toggleSelectMode() {
    isSelectMode = !isSelectMode
    selectedItems.clear()
    const btn = document.getElementById('toggleSelectModeBtn')
    if (btn) {
        if (isSelectMode) {
            btn.innerHTML = '<span class="material-symbols-outlined">close</span> 取消选择'
            btn.style.color = 'var(--md-error)'
        } else {
            btn.innerHTML = '<span class="material-symbols-outlined">checklist</span> 多选'
            btn.style.color = 'var(--md-on-surface)'
        }
    }
    updateFAB()
    const title = document.getElementById('browserPathDisplay').textContent
    renderItems(currentListItems, title)
}

async function loadDirectory(serverName, path) {
    const container = document.getElementById('browserList')
    container.innerHTML = '<div class="empty-state">加载中...</div>'
    document.getElementById('browserPathDisplay').textContent = path
    
    try {
        const res = await fetch(`./lists/${encodeURIComponent(serverName)}/items?path=${encodeURIComponent(path)}`, {
            headers: getAuthHeaders()
        })
        if (!res.ok) throw new Error(await res.text())
        const items = await res.json()
        
        currentPath = path
        renderItems(items, path)
    } catch (e) {
        renderMessage(container, '加载失败: ' + e, true)
    }
}

async function submitImport(itemsToImport) {
    const serverName = document.getElementById('browserServerSelect').value
    if (!serverName) return null
    
    const reqs = itemsToImport.map(item => ({
        title: item.name.replace(/\.[^.]+$/, ''),
        artist: '未知歌手',
        album: '',
        cover_url: '',
        duration: 0,
        plugin_entry_path: 'dav',
        source_data: JSON.stringify({ configName: serverName, path: item.id }),
        dedup_key: `dav_${serverName}_${item.id}`
    }))
    
    try {
        const coreApiUrl = window.location.origin + '/api/v1/songs/remote'
        const res = await fetch(coreApiUrl, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify(reqs)
        })
        if (!res.ok) throw new Error(await res.text())
        const data = await res.json()
        return data.songs || []
    } catch (e) {
        console.error('Import failed', e)
        throw e
    }
}

function updatePlaylistTargetState() {
    const target = document.getElementById('playlistTarget')
    const nameGroup = document.getElementById('playlistNameGroup')
    const nameInput = document.getElementById('playlistName')
    const isNewPlaylist = !target || target.value === NEW_PLAYLIST_VALUE
    nameGroup.style.display = isNewPlaylist ? '' : 'none'
    nameInput.disabled = !isNewPlaylist
}

async function loadPlaylistTargets() {
    const target = document.getElementById('playlistTarget')
    target.disabled = true
    target.innerHTML = '<option value="__new__">正在加载已有歌单...</option>'

    try {
        const playlists = []
        const limit = 100
        let offset = 0
        let total = 0

        do {
            const res = await fetch(window.location.origin + `/api/v1/playlists?type=normal&limit=${limit}&offset=${offset}`, {
                headers: getAuthHeaders()
            })
            if (!res.ok) throw new Error(await res.text())
            const data = await res.json()
            const page = Array.isArray(data.playlists) ? data.playlists : []
            playlists.push(...page)
            total = Number(data.total) || 0
            offset += page.length
            if (page.length === 0) break
        } while (offset < total)

        target.innerHTML = ''
        const newOption = document.createElement('option')
        newOption.value = NEW_PLAYLIST_VALUE
        newOption.textContent = '新建歌单'
        target.appendChild(newOption)
        playlists.forEach(playlist => {
            const option = document.createElement('option')
            option.value = String(playlist.id)
            option.textContent = `${playlist.name} (${playlist.song_count || 0} 首歌曲)`
            target.appendChild(option)
        })
    } catch (e) {
        target.innerHTML = `<option value="${NEW_PLAYLIST_VALUE}">新建歌单</option>`
        showSnackbar('获取已有歌单失败: ' + e.message)
    } finally {
        target.disabled = false
        target.value = NEW_PLAYLIST_VALUE
        updatePlaylistTargetState()
    }
}

window._importSingle = async function(id) {
    const item = currentListItems.find(i => i.id === id)
    if (!item) return
    showProgress(true, '导入中', '正在将歌曲存入曲库...')
    try {
        await submitImport([item])
        showProgress(false)
        showSnackbar('单曲导入成功！')
    } catch (e) {
        showProgress(false)
        showSnackbar('导入失败: ' + e.message)
    }
}

// 初始化绑定
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tab-item').forEach(btn => {
        btn.onclick = () => switchTab(btn.dataset.tab)
    })
    
    document.getElementById('refreshBtn').onclick = fetchServers
    document.getElementById('addServerBtn').onclick = addServer
    document.getElementById('testServerBtn').onclick = testServer
    
    document.getElementById('browserServerSelect').onchange = (e) => {
        const val = e.target.value
        if (val) {
            const toggleBtn = document.getElementById('toggleSelectModeBtn')
            if (toggleBtn) toggleBtn.style.display = 'block'
            loadDirectory(val, '/')
        } else {
            document.getElementById('browserList').innerHTML = '<div class="empty-state">请选择服务器进行浏览</div>'
            const toggleBtn = document.getElementById('toggleSelectModeBtn')
            if (toggleBtn) toggleBtn.style.display = 'none'
            if(isSelectMode) toggleSelectMode()
        }
    }
    
    document.getElementById('browserUpBtn').onclick = () => {
        const server = document.getElementById('browserServerSelect').value
        if (!server || currentPath === '/') return
        const parts = currentPath.replace(/\/$/, '').split('/')
        parts.pop()
        const newPath = parts.join('/') || '/'
        loadDirectory(server, newPath)
    }

    const toggleBtn = document.getElementById('toggleSelectModeBtn')
    if (toggleBtn) toggleBtn.onclick = toggleSelectMode
    
    const fabCancelBtn = document.getElementById('fabCancelBtn')
    if (fabCancelBtn) fabCancelBtn.onclick = toggleSelectMode
    
    const fabImportBtn = document.getElementById('fabImportBtn')
    if (fabImportBtn) {
        fabImportBtn.onclick = async () => {
            if (selectedItems.size === 0) return
            showProgress(true, '批量导入', `正在导入 ${selectedItems.size} 首歌曲...`)
            try {
                await submitImport(Array.from(selectedItems.values()))
                showProgress(false)
                showSnackbar(`成功导入 ${selectedItems.size} 首歌曲`)
                toggleSelectMode()
            } catch (e) {
                showProgress(false)
                showSnackbar('导入失败: ' + e.message)
            }
        }
    }

    const fabPlaylistBtn = document.getElementById('fabPlaylistBtn')
    if (fabPlaylistBtn) {
        fabPlaylistBtn.onclick = async () => {
            if (selectedItems.size === 0) return
            document.getElementById('playlistName').value = ''
            document.getElementById('playlistDialog').classList.add('show')
            await loadPlaylistTargets()
        }
    }

    const cancelPlaylistBtn = document.getElementById('cancelPlaylistBtn')
    if (cancelPlaylistBtn) cancelPlaylistBtn.onclick = () => document.getElementById('playlistDialog').classList.remove('show')
    
    const confirmPlaylistBtn = document.getElementById('confirmPlaylistBtn')
    if (confirmPlaylistBtn) {
        confirmPlaylistBtn.onclick = async () => {
            const target = document.getElementById('playlistTarget')
            const name = document.getElementById('playlistName').value.trim()
            const isNewPlaylist = target.value === NEW_PLAYLIST_VALUE
            if (isNewPlaylist && !name) { showSnackbar('请输入歌单名称'); return }
            document.getElementById('playlistDialog').classList.remove('show')
            
            showProgress(true, isNewPlaylist ? '创建歌单' : '添加到歌单', isNewPlaylist ? '正在导入歌曲并创建歌单...' : '正在导入歌曲并添加到歌单...')
            try {
                const songs = await submitImport(Array.from(selectedItems.values()))
                const songIds = songs.map(s => s.id)
                let playlistId = target.value

                if (isNewPlaylist) {
                    const playlistRes = await fetch(window.location.origin + '/api/v1/playlists', {
                        method: 'POST',
                        headers: getAuthHeaders(),
                        body: JSON.stringify({ name: name, description: 'Imported from WebDAV', type: 'normal' })
                    })
                    if (!playlistRes.ok) throw new Error('创建歌单失败')
                    const playlist = await playlistRes.json()
                    playlistId = playlist.id
                }
                
                if (songIds.length > 0) {
                    const addRes = await fetch(window.location.origin + `/api/v1/playlists/${playlistId}/songs`, {
                        method: 'POST',
                        headers: getAuthHeaders(),
                        body: JSON.stringify({ song_ids: songIds })
                    })
                    if (!addRes.ok) throw new Error('添加歌曲到歌单失败')
                }
                
                showProgress(false)
                showSnackbar(isNewPlaylist ? `成功创建歌单并导入 ${songIds.length} 首歌曲` : `成功添加 ${songIds.length} 首歌曲到已有歌单`)
                toggleSelectMode()
            } catch (e) {
                showProgress(false)
                showSnackbar('操作失败: ' + e.message)
            }
        }
    }

    const playlistTarget = document.getElementById('playlistTarget')
    if (playlistTarget) playlistTarget.onchange = updatePlaylistTargetState

    fetchServers()
})

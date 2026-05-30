let currentServers = []
let currentPath = '/'

// UI 工具函数
function showSnackbar(message) {
    const snackbar = document.getElementById('snackbar');
    snackbar.textContent = message;
    snackbar.classList.add('show');
    setTimeout(() => {
        snackbar.classList.remove('show');
    }, 3000);
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
    try {
        const authData = localStorage.getItem('songloft-auth');
        if (authData) {
            const auth = JSON.parse(authData);
            if (auth.accessToken) {
                headers['Authorization'] = 'Bearer ' + auth.accessToken;
            }
        }
    } catch (e) {}
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
        const res = await fetch('./lists', {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ name, url, username, password })
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
        container.innerHTML = '<div class="empty-state">暂无服务器，请先添加</div>'
        return
    }

    container.innerHTML = ''
    currentServers.forEach(server => {
        const item = document.createElement('div')
        item.style.cssText = 'display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--md-outline-variant)'
        
        item.innerHTML = `
            <div style="flex:1">
                <div style="font-size:16px;color:var(--md-on-surface);font-weight:500">${server.name}</div>
                <div style="font-size:13px;color:var(--md-on-surface-variant);margin-top:4px">${server.url}</div>
            </div>
            <button class="btn-icon" style="color:var(--md-error)" title="删除">
                <span class="material-symbols-outlined">delete</span>
            </button>
        `
        item.querySelector('button').onclick = () => deleteServer(server.name)
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
    } else {
        document.getElementById('browserList').innerHTML = '<div class="empty-state">请选择服务器进行浏览</div>'
        currentPath = '/'
    }
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
        
        if (items.length === 0) {
            container.innerHTML = '<div class="empty-state">空目录</div>'
            return
        }
        
        container.innerHTML = ''
        items.forEach(item => {
            const el = document.createElement('div')
            el.style.cssText = 'display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--md-outline-variant);cursor:pointer;'
            el.classList.add('browser-item')
            
            const icon = item.type === 'directory' ? 'folder' : 'audio_file'
            const color = item.type === 'directory' ? 'var(--md-primary)' : 'var(--md-on-surface)'
            
            el.innerHTML = `
                <span class="material-symbols-outlined" style="color:${color};margin-right:12px">${icon}</span>
                <div style="flex:1;overflow:hidden">
                    <div style="font-size:14px;color:var(--md-on-surface);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${item.basename}</div>
                    <div style="font-size:12px;color:var(--md-on-surface-variant);margin-top:2px">${item.type === 'directory' ? '目录' : (item.size/1024/1024).toFixed(2)+' MB'}</div>
                </div>
            `
            
            el.onclick = () => {
                if (item.type === 'directory') {
                    const newPath = path.endsWith('/') ? path + item.basename : path + '/' + item.basename
                    loadDirectory(serverName, newPath)
                } else {
                    showSnackbar('可以直接播放：' + item.basename)
                }
            }
            
            // Add hover effect via JS or assume class handles it
            el.onmouseenter = () => el.style.backgroundColor = 'var(--md-surface-container-high)'
            el.onmouseleave = () => el.style.backgroundColor = 'transparent'
            
            container.appendChild(el)
        })
    } catch (e) {
        container.innerHTML = `<div class="empty-state" style="color:var(--md-error)">加载失败: ${e}</div>`
    }
}

// 初始化绑定
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.tab-item').forEach(btn => {
        btn.onclick = () => switchTab(btn.dataset.tab)
    })
    
    document.getElementById('refreshBtn').onclick = fetchServers
    document.getElementById('addServerBtn').onclick = addServer
    
    document.getElementById('browserServerSelect').onchange = (e) => {
        const val = e.target.value
        if (val) {
            loadDirectory(val, '/')
        } else {
            document.getElementById('browserList').innerHTML = '<div class="empty-state">请选择服务器进行浏览</div>'
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

    fetchServers()
})

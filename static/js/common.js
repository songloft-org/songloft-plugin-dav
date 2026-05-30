/**
 * 公共 API 工具模块
 */

const API_BASE = '.';

/**
 * 从 localStorage 获取认证 Token
 */
function getAuthToken() {
    try {
        const authData = localStorage.getItem('songloft-auth');
        if (authData) {
            const auth = JSON.parse(authData);
            return auth.accessToken || '';
        }
    } catch (error) {
        console.error('获取 Token 失败:', error);
    }
    return '';
}

/**
 * 构建请求头（含可选的 Authorization）
 */
function buildHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    const token = getAuthToken();
    if (token) {
        headers['Authorization'] = 'Bearer ' + token;
    }
    return headers;
}

/**
 * 解析响应：非 2xx 时读取 JSON 错误体的 message 字段并抛出。
 * 配合后端 writePluginUnavailable 返回的 {error, message} 结构，
 * 让插件未启用等场景在 snackbar 上显示友好中文，而非 JSON 解析错误。
 */
async function parseResponse(response) {
    if (!response.ok) {
        let msg = response.statusText || `HTTP ${response.status}`;
        try {
            const body = await response.json();
            if (body && body.message) msg = body.message;
        } catch (_) { /* 非 JSON body 时保留 statusText */ }
        throw new Error(msg);
    }
    return response.json();
}

/**
 * 发送 GET 请求并返回 JSON
 */
export function apiGet(path) {
    return fetch(API_BASE + path, {
        method: 'GET',
        headers: buildHeaders()
    }).then(parseResponse);
}

/**
 * 发送 POST 请求并返回 JSON
 */
export function apiPost(path, body) {
    return fetch(API_BASE + path, {
        method: 'POST',
        headers: buildHeaders(),
        body: JSON.stringify(body)
    }).then(parseResponse);
}

/**
 * 发送 DELETE 请求并返回 JSON
 */
export function apiDelete(path) {
    return fetch(API_BASE + path, {
        method: 'DELETE',
        headers: buildHeaders()
    }).then(parseResponse);
}
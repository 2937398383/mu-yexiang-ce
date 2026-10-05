// js/api.js — API 调用封装 + token 管理 + Turnstile（人机验证）助手
// 从 app.js 抽出（S5 拆分），函数体与原实现保持一致

// P3：Worker 列表接口带 max-age=30 私有缓存。任何写操作成功后 35s 内的 GET 用
// cache:'reload' 强制回源（新鲜结果会写回缓存），避免变更后短时间内看到旧列表
let apiDirtyUntil = 0;

// ==================== token 管理 ====================

export const ADMIN_KEY = 'album_admin_token';

export function saveToken(store, key, token, expiresIn) {
  store.setItem(key, JSON.stringify({ token, exp: Date.now() + expiresIn * 1000 - 30000 }));
}

function getToken(store, key) {
  try {
    const o = JSON.parse(store.getItem(key));
    if (o && o.token && o.exp > Date.now()) return o.token;
    store.removeItem(key);
  } catch { store.removeItem(key); }
  return null;
}

export const getAdminToken = () => getToken(localStorage, ADMIN_KEY);
export const getUnlockToken = (albumId) => getToken(sessionStorage, 'unlock_' + albumId);
export const isAdmin = () => !!getAdminToken();

export async function api(method, path, body, albumIdForUnlock) {
  const headers = {};
  const admin = getAdminToken();
  const unlock = albumIdForUnlock ? getUnlockToken(albumIdForUnlock) : null;
  if (admin) headers.Authorization = 'Bearer ' + admin;
  else if (unlock) headers.Authorization = 'Bearer ' + unlock;
  if (body != null) headers['Content-Type'] = 'application/json';

  // 普通请求 30s 超时（AbortController）：卡死的请求不再无限挂起；
  // 照片直传 R2 走独立 fetch，不受此限制
  const doFetch = (opts = {}) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    return fetch(window.API_BASE + path, {
      method, headers, signal: ctrl.signal,
      body: body != null ? JSON.stringify(body) : undefined,
      ...opts,
    }).finally(() => clearTimeout(timer));
  };

  let resp;
  try {
    resp = await doFetch(method === 'GET' && Date.now() < apiDirtyUntil ? { cache: 'reload' } : {});
  } catch (e) {
    throw { status: 0, message: e?.name === 'AbortError'
      ? '请求超时（30 秒），请检查网络后重试'
      : '网络错误：请检查 config.js 里的 Worker 地址' };
  }
  let data = await resp.json().catch(() => ({}));
  // 服务冷启动迁移中的 503：等一小会儿自动重试一次（Worker 并发迁移失败会很快自愈）
  if (resp.status === 503 && data.retryable) {
    await new Promise((r) => setTimeout(r, 900));
    try {
      resp = await doFetch();
    } catch (e) {
      throw { status: 0, message: e?.name === 'AbortError' ? '请求超时（30 秒）' : '网络错误' };
    }
    data = await resp.json().catch(() => ({}));
  }
  if (!resp.ok || data.ok === false) {
    // 错误对象附带完整响应体（如还原接口 409 时的可选相册列表）
    throw { status: resp.status, message: data.error || '请求失败(' + resp.status + ')', data };
  }
  if (method !== 'GET') apiDirtyUntil = Date.now() + 35000;
  return data;
}

// ==================== Turnstile（人机验证，防密码爆破） ====================

// 是否启用人机验证：需站点密钥已配置且 SDK 已加载（未配置则整体降级，不影响登录/解锁）
export function turnstileEnabled() {
  return !!(window.TURNSTILE_SITE_KEY && window.turnstile);
}

// 在弹窗打开后手动渲染 widget（render=explicit）
export function renderTurnstileInto(containerId) {
  if (!turnstileEnabled()) return;
  const el = document.getElementById(containerId);
  if (el && !el.dataset.rendered) {
    window.turnstile.render('#' + containerId, {
      sitekey: window.TURNSTILE_SITE_KEY,
      theme: 'auto',
    });
    el.dataset.rendered = '1';
  }
}

// 提交时取 token；未启用验证码则返回 undefined（后端同样降级放行）
export function turnstileToken(containerId) {
  if (!turnstileEnabled()) return undefined;
  const el = document.getElementById(containerId);
  if (el) {
    const t = window.turnstile.getResponse(el);
    if (t) return t;
  }
  throw { status: 400, message: '请先完成人机验证' };
}

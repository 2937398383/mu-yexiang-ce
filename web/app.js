/* 牧野云相册 前端逻辑（纯原生 JS，hash 路由）
 * token 策略：
 *   管理员 token → localStorage（关浏览器仍保留）
 *   相册解锁 token → sessionStorage（关标签页即失效，30 分钟后端也过期）
 */
'use strict';

// ==================== 基础工具 ====================

const $view = document.getElementById('view');
const $authArea = document.getElementById('auth-area');
const $modalRoot = document.getElementById('modal-root');
const $toastRoot = document.getElementById('toast-root');

function toast(msg, isErr = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isErr ? ' err' : '');
  el.textContent = msg;
  $toastRoot.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function fmtSize(n) {
  if (!n) return '';
  if (n > 1 << 30) return (n / (1 << 30)).toFixed(1) + ' GB';
  if (n > 1 << 20) return (n / (1 << 20)).toFixed(1) + ' MB';
  return Math.max(1, Math.round(n / 1024)) + ' KB';
}

// AI 批量任务进度展示：文本 + 进度条
function renderAiProgress(tipEl, { action, total, done, failed, remaining, quotaLeft, failReasons }) {
  const processed = done + failed;
  const pct = total ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const text = `${action} ${done} 张${failed ? ` · ${failed} 张失败` : ''} · 剩余 ${remaining} 张 · 今日额度剩 ${quotaLeft}`;
  const reasonsHtml = (failReasons?.length ? `<div class="ai-progress-reasons">失败原因：${esc(failReasons.join(' · '))}</div>` : '');
  tipEl.innerHTML = `
    <div class="ai-progress-text">${esc(text)}</div>
    <div class="ai-progress-bar"><div class="ai-progress-fill" style="width:${pct}%"></div></div>
    <div class="ai-progress-pct">${processed}/${total}（${pct}%）</div>
    ${reasonsHtml}`;
}

// 视频时长：125 → "2:05"
function fmtDuration(s) {
  s = Math.max(0, Math.round(Number(s) || 0));
  const m = Math.floor(s / 60), sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

// ==================== 主题（白色 / 黑色） ====================

const THEME_KEY = 'album_theme';

function applyTheme(dark) {
  document.body.classList.toggle('dark', dark);
  const btn = document.getElementById('theme-btn');
  if (btn) btn.textContent = dark ? '浅色' : '深色';
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const dark = saved ? saved === 'dark'
    : window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(dark);
  document.getElementById('theme-btn')?.addEventListener('click', () => {
    const dark = !document.body.classList.contains('dark');
    localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light');
    applyTheme(dark);
  });
}

// ==================== token 管理 ====================

const ADMIN_KEY = 'album_admin_token';

function saveToken(store, key, token, expiresIn) {
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

const getAdminToken = () => getToken(localStorage, ADMIN_KEY);
const getUnlockToken = (albumId) => getToken(sessionStorage, 'unlock_' + albumId);
const isAdmin = () => !!getAdminToken();

// 计算 Blob 的 SHA-256（64 位十六进制），用于同相册重复文件检测
async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
// 当前相册是否可上传/打包/补打：管理员，或已用密码解锁当前相册的游客
// （分享只读页不算；公开相册无解锁 token，访客维持只读）
function canEditAlbum() {
  if (isAdmin()) return true;
  // 求照片页允许上传；普通分享只读页不允许
  return !!currentAlbumId && (collectMode || (!shareMode && !!getUnlockToken(currentAlbumId)));
}
function logout() { localStorage.removeItem(ADMIN_KEY); renderAuthArea(); render(); }
function renderAuthArea() {
  $authArea.innerHTML = isAdmin()
    ? `<span class="admin-tag">管理员</span><button class="btn small" id="btn-logout">退出</button>`
    : `<button class="btn small" id="btn-login">管理员登录</button>`;
  document.getElementById('btn-login')?.addEventListener('click', showLoginModal);
  document.getElementById('btn-logout')?.addEventListener('click', logout);
}

// ==================== Turnstile（人机验证，防密码爆破） ====================

// 在弹窗打开后手动渲染 widget（render=explicit）
function renderTurnstileInto(containerId) {
  const el = document.getElementById(containerId);
  if (window.turnstile && el && !el.dataset.rendered) {
    window.turnstile.render('#' + containerId, {
      sitekey: window.TURNSTILE_SITE_KEY,
      theme: 'auto',
    });
    el.dataset.rendered = '1';
  }
}

// 提交时取 token，未通过则拦截
function turnstileToken(containerId) {
  const el = document.getElementById(containerId);
  if (window.turnstile && el) {
    const t = window.turnstile.getResponse(el);
    if (t) return t;
  }
  throw { status: 400, message: '请先完成人机验证' };
}

// ==================== 加密相册（端到端，明文只在浏览器） ====================

const ENC_ALBUM_KEY_PREFIX = 'albumkey_';
const encAlbumKeyCache = new Map(); // albumId -> CryptoKey

// 相册主密钥会话缓存：解锁/创建后以 raw base64 存 sessionStorage（与解锁 token 同生命周期）
async function encGetAlbumKey(albumId) {
  if (!albumId) return null;
  if (encAlbumKeyCache.has(albumId)) return encAlbumKeyCache.get(albumId);
  const b64 = sessionStorage.getItem(ENC_ALBUM_KEY_PREFIX + albumId);
  if (!b64) return null;
  try {
    const key = await enc_importKey(enc_b64urlDecode(b64));
    encAlbumKeyCache.set(albumId, key);
    return key;
  } catch {
    sessionStorage.removeItem(ENC_ALBUM_KEY_PREFIX + albumId);
    return null;
  }
}

async function encSetAlbumKey(albumId, albumKey) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', albumKey));
  sessionStorage.setItem(ENC_ALBUM_KEY_PREFIX + albumId, enc_b64url(raw));
  encAlbumKeyCache.set(albumId, albumKey);
}

function hasEncAlbumKey(albumId) {
  return !!sessionStorage.getItem(ENC_ALBUM_KEY_PREFIX + albumId);
}

// 解锁加密相册：服务端只返回被 KEK 包裹的相册主密钥 + 派生参数，口令校验在本地完成
async function encUnlockAndStore(albumId, password, ttoken) {
  const body = ttoken ? { turnstileToken: ttoken } : {};
  const r = await api('POST', `/albums/${albumId}/unlock`, body, albumId);
  if (!r.encrypted) throw { message: '该相册不是加密相册' };
  const salt = enc_b64urlDecode(r.kekSalt);
  const kek = await enc_deriveKEK(password, salt, r.kekIters);
  let albumKey;
  try {
    const wrapped = JSON.parse(r.encKey);
    albumKey = await enc_unwrapAlbumKey(wrapped.wrapped, wrapped.iv, kek);
  } catch {
    throw { message: '口令错误，无法解锁' };
  }
  saveToken(sessionStorage, 'unlock_' + albumId, r.token, r.expiresIn);
  await encSetAlbumKey(albumId, albumKey);
}

// 每张照片的文件密钥（albumKey 加密后存 D1）：解出并缓存 CryptoKey
function encGetFileKeyCached(p, albumKey) {
  if (!p._fileKey) {
    p._fileKey = (async () => {
      const enc = typeof p.encKey === 'string' ? JSON.parse(p.encKey) : p.encKey;
      const bytes = await enc_decryptFileKey(enc.enc, enc.iv, albumKey);
      return enc_importKey(bytes);
    })();
  }
  return p._fileKey;
}

// 解密元数据（文件名/机型/GPS/EXIF/分块数等），缓存 { meta, nonceBase }
function encGetMetaCached(p, fileKey) {
  if (!p._meta) p._meta = enc_decryptMeta(fileKey, p.encMeta);
  return p._meta;
}

// 把解密后的元数据合并进照片对象，供信息栏/网格显示
async function encHydratePhoto(p, albumId) {
  const albumKey = await encGetAlbumKey(albumId);
  if (!albumKey) return p;
  try {
    const fileKey = await encGetFileKeyCached(p, albumKey);
    const { meta } = await encGetMetaCached(p, fileKey);
    if (meta.filename) p.filename = meta.filename;
    if (meta.camera) p.camera = meta.camera;
    if (meta.exif) p.exif = meta.exif;
    p._encMeta = meta;
  } catch { /* 元数据解密失败不影响密文主体 */ }
  return p;
}

// 解密原图/原视频 → 内存 Blob URL
async function encLoadOriginal(p, albumId) {
  const albumKey = await encGetAlbumKey(albumId);
  if (!albumKey) throw { message: '相册未解锁' };
  const fileKey = await encGetFileKeyCached(p, albumKey);
  const { meta, nonceBase } = await encGetMetaCached(p, fileKey);
  const url = p.url || await freshPhotoUrl(p);
  const resp = await fetch(url);
  if (!resp.ok) throw { message: '下载密文失败' };
  const ct = new Uint8Array(await resp.arrayBuffer());
  const pt = await enc_decryptStream(fileKey, nonceBase, ct, meta.chunks);
  return { blobUrl: URL.createObjectURL(new Blob([pt], { type: meta.contentType })), meta };
}

// 解密缩略图 → 设置 img.src（grid 用）
async function encLoadThumb(p, imgEl, albumId) {
  try {
    const albumKey = await encGetAlbumKey(albumId);
    if (!albumKey) return;
    const fileKey = await encGetFileKeyCached(p, albumKey);
    const { meta } = await encGetMetaCached(p, fileKey);
    const resp = await fetch(p.thumbUrl);
    if (!resp.ok) return;
    const ct = new Uint8Array(await resp.arrayBuffer());
    const pt = await enc_decryptBlob(fileKey, ct);
    const type = meta.thumbs?.small || (p.kind === 'video' ? 'image/jpeg' : 'image/webp');
    imgEl.src = URL.createObjectURL(new Blob([pt], { type }));
  } catch { /* 解密失败保持占位 */ }
}

// 构建加密元数据（全部明文信息随照片一起加密）
function encBuildMeta(file, uploadBlob, exif, thumbs, isVideo, duration, chunks) {
  const meta = {
    v: 1,
    filename: file.name,
    contentType: uploadBlob.type || file.type,
    size: uploadBlob.size,
    kind: isVideo ? 'video' : 'image',
    chunks,
  };
  if (isVideo) {
    if (duration != null) meta.duration = duration;
  } else {
    if (exif.takenAt) meta.takenAt = exif.takenAt;
    if (exif.camera) meta.camera = exif.camera;
    if (exif.gpsLat != null) { meta.gpsLat = exif.gpsLat; meta.gpsLng = exif.gpsLng; }
    if (exif.exif) meta.exif = exif.exif;
  }
  const t = {};
  if (thumbs.small) t.small = thumbs.small.type;
  if (thumbs.large) t.large = thumbs.large.type;
  if (thumbs.smallAvif) t.smallAvif = 'image/avif';
  if (Object.keys(t).length) meta.thumbs = t;
  return meta;
}

// ==================== API 调用 ====================

// P3：Worker 列表接口带 max-age=30 私有缓存。任何写操作成功后 35s 内的 GET 用
// cache:'reload' 强制回源（新鲜结果会写回缓存），避免变更后短时间内看到旧列表
let apiDirtyUntil = 0;

async function api(method, path, body, albumIdForUnlock) {
  const headers = {};
  const admin = getAdminToken();
  const unlock = albumIdForUnlock ? getUnlockToken(albumIdForUnlock) : null;
  if (admin) headers.Authorization = 'Bearer ' + admin;
  else if (unlock) headers.Authorization = 'Bearer ' + unlock;
  if (body != null) headers['Content-Type'] = 'application/json';

  let resp;
  try {
    resp = await fetch(window.API_BASE + path, {
      method, headers, body: body != null ? JSON.stringify(body) : undefined,
      ...(method === 'GET' && Date.now() < apiDirtyUntil ? { cache: 'reload' } : {}),
    });
  } catch {
    throw { status: 0, message: '网络错误：请检查 config.js 里的 Worker 地址' };
  }
  let data = await resp.json().catch(() => ({}));
  // 服务冷启动迁移中的 503：等一小会儿自动重试一次（Worker 并发迁移失败会很快自愈）
  if (resp.status === 503 && data.retryable) {
    await new Promise((r) => setTimeout(r, 900));
    resp = await fetch(window.API_BASE + path, {
      method, headers, body: body != null ? JSON.stringify(body) : undefined,
    });
    data = await resp.json().catch(() => ({}));
  }
  if (!resp.ok || data.ok === false) {
    // 错误对象附带完整响应体（如还原接口 409 时的可选相册列表）
    throw { status: resp.status, message: data.error || '请求失败(' + resp.status + ')', data };
  }
  if (method !== 'GET') apiDirtyUntil = Date.now() + 35000;
  return data;
}

// ==================== 模态框 ====================

function closeModal() { $modalRoot.innerHTML = ''; }
function openModal(html) {
  $modalRoot.innerHTML = `<div class="modal-mask"><div class="modal">${html}</div></div>`;
  $modalRoot.querySelector('.modal-mask').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) closeModal();
  });
  return $modalRoot.querySelector('.modal');
}

function confirmModal(title, text, okLabel = '确定', danger = false) {
  return new Promise((resolve) => {
    const m = openModal(`
      <h2>${esc(title)}</h2>
      ${text ? `<div class="warn">${esc(text)}</div>` : ''}
      <div class="actions">
        <button class="btn" data-r="0">取消</button>
        <button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okLabel)}</button>
      </div>`);
    m.querySelectorAll('[data-r]').forEach((b) =>
      b.addEventListener('click', () => { closeModal(); resolve(b.dataset.r === '1'); }));
  });
}

function promptModal(title, fieldsHtml, onOk, okLabel = '确定') {
  const m = openModal(`
    <h2>${esc(title)}</h2>
    ${fieldsHtml}
    <div class="form-err" hidden></div>
    <div class="actions">
      <button class="btn" data-r="cancel">取消</button>
      <button class="btn primary" data-r="ok">${esc(okLabel)}</button>
    </div>`);
  m.querySelector('[data-r="cancel"]').addEventListener('click', closeModal);
  const okBtn = m.querySelector('[data-r="ok"]');
  const errEl = m.querySelector('.form-err');
  okBtn.addEventListener('click', async () => {
    try {
      errEl.hidden = true;
      okBtn.disabled = true;
      await onOk(m);
      closeModal();
    } catch (err) {
      okBtn.disabled = false;
      errEl.textContent = err.message || '操作失败';
      errEl.hidden = false;
      // 429 失败锁定：按钮倒计时禁用（弹框关闭后定时器自动清理）
      if (err.status === 429 && err.data?.retryAfterMinutes) {
        let left = Math.max(1, err.data.retryAfterMinutes) * 60;
        okBtn.disabled = true;
        const timer = setInterval(() => {
          if (!okBtn.isConnected) { clearInterval(timer); return; }
          left -= 1;
          const mm = Math.floor(left / 60);
          const ss = String(left % 60).padStart(2, '0');
          okBtn.textContent = `已锁定 ${mm}:${ss}`;
          if (left <= 0) {
            clearInterval(timer);
            okBtn.disabled = false;
            okBtn.textContent = okLabel;
          }
        }, 1000);
      }
    }
  });
  return m;
}

const pwField = (id, label = '6位数字密码') => `
  <div class="field">
    <label>${label}</label>
    <input class="pw" id="${id}" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
    <div class="hint">留空表示不设密码（公开相册）</div>
  </div>`;

function showLoginModal() {
  const m = promptModal('管理员登录', `
    <div class="field">
      <label>管理密码</label>
      <input id="f-pw" type="password" autocomplete="current-password">
    </div>
    <div id="turnstile-login"></div>`, async (m) => {
    const pw = m.querySelector('#f-pw').value;
    const ttoken = turnstileToken('turnstile-login');
    const r = await api('POST', '/login', { password: pw, turnstileToken: ttoken });
    saveToken(localStorage, ADMIN_KEY, r.token, r.expiresIn);
    renderAuthArea(); render();
    toast('已登录');
  }, '登录');
  m.querySelector('#f-pw').focus();
  renderTurnstileInto('turnstile-login');
}

function showUnlockModal(albumId, albumName, isEnc = false) {
  const fieldHtml = isEnc
    ? `<div class="field">
         <label>加密口令（解密相册内容）</label>
         <input id="f-pw" type="password" autocomplete="current-password" placeholder="输入创建时设置的口令">
         <div class="hint">口令错误无法解密；口令丢失将永久无法恢复。</div>
       </div>`
    : `<div class="field">
         <input class="pw" id="f-pw" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
       </div>`;
  const m = promptModal(`输入「${albumName}」的${isEnc ? '口令' : '密码'}`, fieldHtml + `
    <div id="turnstile-unlock"></div>`, async (m) => {
    const pw = m.querySelector('#f-pw').value;
    const ttoken = turnstileToken('turnstile-unlock');
    if (isEnc) {
      if (!pw) throw { message: '请输入口令' };
      await encUnlockAndStore(albumId, pw, ttoken);
    } else {
      if (!/^\d{6}$/.test(pw)) throw { message: '请输入6位数字密码' };
      const r = await api('POST', `/albums/${albumId}/unlock`, { password: pw, turnstileToken: ttoken });
      saveToken(sessionStorage, 'unlock_' + albumId, r.token, r.expiresIn);
    }
    location.hash = '#/album/' + albumId;
    render();
  }, '解锁');
  m.querySelector('#f-pw').focus();
  renderTurnstileInto('turnstile-unlock');
}

// 工具页（证件照 / 换风格）使用的相册解锁：弹密码框，成功后只存 token 并 resolve(true)，不跳转；取消返回 false
function promptAlbumPassword(albumId, albumName) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const m = promptModal(`输入「${albumName}」的密码`, `
      <div class="field">
        <input class="pw" id="f-pw" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
      </div>
      <div id="turnstile-unlock"></div>`, async (mm) => {
      const pw = mm.querySelector('#f-pw').value;
      if (!/^\d{6}$/.test(pw)) throw { message: '请输入6位数字密码' };
      const ttoken = turnstileToken('turnstile-unlock');
      const r = await api('POST', `/albums/${albumId}/unlock`, { password: pw, turnstileToken: ttoken });
      saveToken(sessionStorage, 'unlock_' + albumId, r.token, r.expiresIn);
      finish(true);
    }, '解锁');
    m.querySelector('[data-r="cancel"]').addEventListener('click', () => finish(false));
    $modalRoot.querySelector('.modal-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) finish(false);
    });
    m.querySelector('#f-pw').focus();
    renderTurnstileInto('turnstile-unlock');
  });
}

// ==================== 视图：相册列表 ====================

let albumsCache = [];

async function renderAlbums() {
  $view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api('GET', '/albums');
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  albumsCache = data.albums;
  const admin = data.isAdmin;

  $view.innerHTML = `
    <div class="page-head">
      <h1>相册</h1>
      <div class="page-actions">
        ${admin ? `
          <button class="btn" id="btn-batch-pw">批量设密码</button>
          <button class="btn danger" id="btn-batch-clear">一键清除所有密码</button>
          <a class="btn" href="#/trash">♻ 回收站</a>
          <a class="btn" href="#/on-this-day">📅 往年今日</a>
          <a class="btn" href="#/map">🗺️ 地图</a>
          <a class="btn" href="#/smart">✨ 智能相册</a>
          <a class="btn" href="#/duplicates">🔁 重复照片</a>
          <a class="btn" href="#/stats">📊 用量统计</a>
          <a class="btn" href="#/idphoto">证件照工具</a>
          <a class="btn" href="#/style-transfer">🎨 照片换风格</a>
          <a class="btn" href="#/bg-replace">🖼️ 更换背景</a>
          <button class="btn primary" id="btn-new-album">+ 新建相册</button>` : `
          <a class="btn" href="#/on-this-day">📅 往年今日</a>
          <a class="btn" href="#/map">🗺️ 地图</a>
          <a class="btn" href="#/smart">✨ 智能相册</a>
          <a class="btn" href="#/idphoto">证件照工具</a>
          <a class="btn" href="#/style-transfer">🎨 照片换风格</a>
          <a class="btn" href="#/bg-replace">🖼️ 更换背景</a>`}
      </div>
    </div>
    ${data.albums.length ? `<div class="album-grid" id="album-grid"></div>`
      : `<div class="empty">还没有相册${admin ? '，点右上角「新建相册」开始' : ''}</div>`}`;

  const grid = document.getElementById('album-grid');
  if (grid) {
    for (const a of data.albums) {
      const card = document.createElement('div');
      card.className = 'album-card';
      // 封面：有真实 URL 显示图片；加密相册访客显示锁形占位
      const coverHtml = a.coverUrl
        ? `<img class="album-cover" src="${esc(a.coverUrl)}" loading="lazy" decoding="async" alt="">`
        : `<div class="album-cover placeholder">${a.lockedCover ? '🔒' : '🖼'}</div>`;
      card.innerHTML = `
        <div class="album-cover-wrap">${coverHtml}
          ${a.locked ? '<span class="lock">已上锁</span>' : ''}
        </div>
        <div class="album-info">
          <h3>${esc(a.name)}</h3>
          <p class="desc">${esc(a.description)}</p>
          <div class="meta">${a.photoCount} 张照片</div>
          ${admin ? `
            <div class="ops">
              <button class="btn small" data-op="edit">编辑</button>
              <button class="btn small" data-op="pw">${a.locked ? '改密码' : '设密码'}</button>
              ${a.locked ? '<button class="btn small" data-op="clear-pw">清密码</button>' : ''}
              <button class="btn small danger" data-op="del">删除</button>
            </div>` : ''}
        </div>`;
      card.addEventListener('click', (e) => {
        if (e.target.closest('.ops')) return;
        openAlbum(a);
      });
      grid.appendChild(card);
      if (admin) bindAlbumOps(card, a);
    }
  }

  if (admin) {
    document.getElementById('btn-new-album')?.addEventListener('click', () => showAlbumForm());
    document.getElementById('btn-batch-pw')?.addEventListener('click', showBatchPwModal);
    document.getElementById('btn-batch-clear')?.addEventListener('click', async () => {
      const n = albumsCache.filter((a) => a.locked).length;
      if (!n) return toast('当前没有已上锁的相册');
      if (!await confirmModal('一键清除所有相册密码',
        `将解锁 ${n} 个相册，所有访客可直接查看，不可撤销。`, '确认清除', true)) return;
      const r = await api('DELETE', '/albums/passwords');
      toast(`已清除 ${r.updated} 个相册的密码`);
      render();
    });
  }
}

function openAlbum(a) {
  // 加密相册（端到端）：无论管理员还是访客都需本会话解锁（服务端无口令，管理员也无法解密）
  if (a.encrypted && !hasEncAlbumKey(a.id)) showUnlockModal(a.id, a.name, true);
  else if (a.locked && !isAdmin() && !getUnlockToken(a.id)) showUnlockModal(a.id, a.name);
  else location.hash = '#/album/' + a.id + '?name=' + encodeURIComponent(a.name);
}

function bindAlbumOps(card, a) {
  card.querySelectorAll('[data-op]').forEach((btn) =>
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const op = btn.dataset.op;
      if (op === 'edit') showAlbumForm(a);
      if (op === 'pw') showAlbumPwModal(a);
      if (op === 'clear-pw') {
        if (!await confirmModal('清除相册密码', `「${a.name}」将变成公开相册。`, '清除', true)) return;
        await api('DELETE', `/albums/${a.id}/password`);
        toast('密码已清除'); render();
      }
      if (op === 'del') {
        if (!await confirmModal('删除相册', `「${a.name}」及其中 ${a.photoCount} 张照片将移入回收站，10 天内可在回收站还原。`, '移入回收站', true)) return;
        await api('DELETE', `/albums/${a.id}`);
        toast('相册已移入回收站'); render();
      }
    }));
}

function showAlbumForm(album) {
  const isNew = !album;
  const encFields = isNew ? `
    <div class="field">
      <label class="chk"><input type="checkbox" id="f-enc"> 加密相册（端到端加密，服务器无法读取内容）</label>
      <div class="hint">加密相册不支持 AI 打标 / 语义搜索 / 证件照 / 换风格 / 视频转码；口令丢失将永久无法恢复。</div>
    </div>
    <div id="enc-pw-wrap" style="display:none">
      <div class="field">
        <label>加密口令（至少6位，请务必牢记）</label>
        <input id="f-enc-pw" type="password" autocomplete="new-password">
      </div>
      <div class="field">
        <label>确认口令</label>
        <input id="f-enc-pw2" type="password" autocomplete="new-password">
      </div>
    </div>` : '';
  const m = promptModal(album ? '编辑相册' : '新建相册', `
    <div class="field">
      <label>相册名（事件/主题）</label>
      <input id="f-name" maxlength="100" placeholder="例：2026 婺源春游" value="${esc(album?.name ?? '')}">
    </div>
    <div class="field">
      <label>描述（可选）</label>
      <textarea id="f-desc" rows="2" maxlength="500" placeholder="一句话介绍">${esc(album?.description ?? '')}</textarea>
    </div>
    ${encFields}`, async (m) => {
    const name = m.querySelector('#f-name').value.trim();
    const desc = m.querySelector('#f-desc').value.trim();
    if (!name) throw { message: '请填写相册名' };
    if (album) {
      await api('PATCH', `/albums/${album.id}`, { name, description: desc });
      toast('已保存');
    } else if (m.querySelector('#f-enc')?.checked) {
      const pw1 = m.querySelector('#f-enc-pw').value;
      const pw2 = m.querySelector('#f-enc-pw2').value;
      if (pw1.length < 6) throw { message: '加密口令至少6位' };
      if (pw1 !== pw2) throw { message: '两次输入的口令不一致' };
      const albumKey = await enc_generateAlbumKey();
      const salt = enc_randomBytes(16);
      const kek = await enc_deriveKEK(pw1, salt, ENC_PBKDF2_ITERS);
      const wrapped = await enc_wrapAlbumKey(albumKey, kek);
      const r = await api('POST', '/albums', {
        name, description: desc, encrypted: true,
        encKey: JSON.stringify(wrapped), kekSalt: enc_b64url(salt), kekIters: ENC_PBKDF2_ITERS,
      });
      await encSetAlbumKey(r.album.id, albumKey);
      toast('加密相册已创建');
    } else {
      await api('POST', '/albums', { name, description: desc });
      toast('相册已创建');
    }
    render();
  }, album ? '保存' : '创建');
  m.querySelector('#f-name').focus();
  const chk = m.querySelector('#f-enc');
  if (chk) {
    chk.addEventListener('change', () => {
      document.getElementById('enc-pw-wrap').style.display = chk.checked ? '' : 'none';
    });
  }
}

function showAlbumPwModal(a) {
  promptModal(`设置「${a.name}」的密码`, pwField('f-pw'), async (m) => {
    const pw = m.querySelector('#f-pw').value;
    if (pw && !/^\d{6}$/.test(pw)) throw { message: '密码必须是6位数字' };
    if (pw) {
      await api('PATCH', `/albums/${a.id}/password`, { password: pw });
      toast('密码已设置');
    } else {
      await api('DELETE', `/albums/${a.id}/password`);
      toast('密码已清除');
    }
    render();
  }, '保存');
}

function showBatchPwModal() {
  promptModal('统一设置所有相册密码', `
    <div class="warn">将把全部 ${albumsCache.length} 个相册的密码改成同一个。</div>
    ${pwField('f-pw', '新的6位数字密码')}`, async (m) => {
    const pw = m.querySelector('#f-pw').value;
    if (!/^\d{6}$/.test(pw)) throw { message: '密码必须是6位数字' };
    const r = await api('PATCH', '/albums/passwords', { password: pw });
    toast(`已为 ${r.updated} 个相册统一设置密码`);
    render();
  }, '应用');
}

// ==================== 视图：相册详情 ====================

let currentPhotos = [];
let currentAlbumId = null;
let currentCoverPhotoId = null;
let shareMode = false; // 分享链接只读模式（隐藏管理/工具按钮）
let collectMode = false; // 求照片页：访客可匿名上传，不展示任何照片
let selectMode = false;  // 多选批量模式（管理员）
const selectedIds = new Set();
// 服务端搜索状态（active 时照片区显示搜索/收藏结果，无限滚动已断开）
let searchState = { active: false, favoriteOnly: false, semantic: false };
const ALBUM_PAGE_SIZE = 60;
let pageState = { cursor: null, loading: false, hasMore: false };
let infiniteObserver = null;
let albumGroupMode = localStorage.getItem('album_group_mode') === 'date' ? 'date' : 'flat';

function fmtDateHeader(day) {
  const d = new Date(day + 'T00:00:00');
  if (isNaN(d.getTime())) return day;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}年${p(d.getMonth() + 1)}月${p(d.getDate())}日`;
}

// 构建照片容器（平铺为单个网格；按日期为多个分组）
function buildPhotoArea() {
  // 容器即将 innerHTML 重建，先断开旧观察目标（IO 强引用目标节点，不断开会泄漏）
  disconnectRecycleObserver();
  const wrap = document.getElementById('photo-area');
  if (!wrap) return;
  if (albumGroupMode === 'date') {
    wrap.innerHTML = `<div id="photo-groups"></div>`;
  } else {
    wrap.innerHTML = `<div class="photo-grid" id="photo-grid"></div>`;
  }
}

// ThumbHash base64 → Uint8Array
function thumbHashToBytes(thumbHash) {
  const bin = atob(thumbHash);
  const hash = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) hash[i] = bin.charCodeAt(i);
  return hash;
}

// ThumbHash → 占位 canvas（base64 解码 + 32px RGBA 铺满，浏览器缩放自带柔化）
function makeThumbPlaceholder(thumbHash) {
  try {
    const img = window.ThumbHash.thumbHashToRGBA(thumbHashToBytes(thumbHash));
    const cv = document.createElement('canvas');
    cv.className = 'thumb-ph';
    cv.width = img.w; cv.height = img.h;
    cv.getContext('2d').putImageData(
      new ImageData(new Uint8ClampedArray(img.rgba), img.w, img.h), 0, 0);
    return cv;
  } catch { return null; }
}

// 是否启用 SW 缩略图缓存所需的 CORS 模式（与 index.html 中 SW 注册排除条件一致：
// localhost 与 Pages 预览子域不注册 SW，且 R2 CORS 白名单不含预览子域，
// 这些环境加 crossorigin 反而会因 CORS 校验失败导致图片不显示）
const SW_IMG_CACHE_ENABLED = (() => {
  const h = location.hostname;
  if (h.includes('localhost')) return false;
  return !(h.endsWith('.album-web.pages.dev') && h !== 'album-web.pages.dev');
})();
const IMG_CORS_ATTR = SW_IMG_CACHE_ENABLED ? ' crossorigin="anonymous"' : '';

// P2 离屏图片回收：滚出视口约 1.5 屏后释放缩略图 src（元素尺寸由 aspect-ratio 保持，无 CLS），
// 回屏时恢复——SW 缩略图缓存 / 浏览器 HTTP 缓存使命中近乎即时；首屏 eager 图不回收
let recycleObserver = null;
function getRecycleObserver() {
  if (!recycleObserver) {
    recycleObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const img = en.target.querySelector('img');
        const srcEl = en.target.querySelector('picture source');
        if (en.isIntersecting) {
          if (img?.dataset.rcSrc) {
            img.src = img.dataset.rcSrc;
            if (img.dataset.rcSrcset) img.srcset = img.dataset.rcSrcset;
            delete img.dataset.rcSrc;
            delete img.dataset.rcSrcset;
          }
          if (srcEl?.dataset.rcSrcset) {
            srcEl.srcset = srcEl.dataset.rcSrcset;
            delete srcEl.dataset.rcSrcset;
          }
        } else {
          if (img && img.loading === 'lazy' && img.src && !img.dataset.rcSrc) {
            img.dataset.rcSrc = img.src;
            if (img.srcset) img.dataset.rcSrcset = img.srcset;
            img.removeAttribute('src');
            img.removeAttribute('srcset');
          }
          if (srcEl && srcEl.srcset && !srcEl.dataset.rcSrcset) {
            srcEl.dataset.rcSrcset = srcEl.srcset;
            srcEl.removeAttribute('srcset');
          }
        }
      }
    }, { rootMargin: '150% 0px' });
  }
  return recycleObserver;
}
function disconnectRecycleObserver() {
  if (recycleObserver) { recycleObserver.disconnect(); recycleObserver = null; }
}

// 单个照片元素（平铺与分组共用，保证行为一致）
// eager=true：首屏前几张高优先级加载（fetchpriority=high 且不走懒加载）
function createPhotoItem(p, admin, eager = false) {
  const item = document.createElement('div');
  item.className = 'photo-item' + (p.kind === 'video' ? ' is-video' : '')
    + (selectMode ? ' selecting' : '');
  item.dataset.photoId = p.id;
  // 加密相册：缩略图为密文，先占位再由 encLoadThumb 异步解密填入 blob URL
  const altText = p.encrypted ? '加密照片' : esc(p.filename);
  let mediaHtml;
  if (p.encrypted) {
    mediaHtml = `<img class="enc-thumb" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async" alt="${altText}">`;
  } else {
    const srcset = p.largeUrl
      ? `${esc(p.thumbUrl)} 1x, ${esc(p.largeUrl)} 2x`
      : '';
    const imgTag = `<img src="${esc(p.thumbUrl)}" ${srcset ? `srcset="${srcset}" sizes="(max-width:600px) 46vw, 220px"` : ''} ${eager ? 'fetchpriority="high"' : 'loading="lazy"'} decoding="async"${IMG_CORS_ATTR} alt="${altText}">`;
    // AVIF 网格缩略图：Chrome/Edge 走 source 加载更小的 AVIF，Safari 回退 WebP/JPEG
    mediaHtml = p.thumbAvifUrl
      ? `<picture><source type="image/avif" srcset="${esc(p.thumbAvifUrl)}">${imgTag}</picture>`
      : imgTag;
  }
  item.innerHTML = `
    ${mediaHtml}
    ${selectMode ? '<span class="pick-check"></span>' : ''}
    ${p.isFavorite ? '<span class="fav-badge" title="已收藏">★</span>' : ''}
    ${p.kind === 'video' ? `<span class="video-badge">▶${p.duration ? '<i>' + esc(fmtDuration(p.duration)) + '</i>' : ''}</span>` : ''}
    ${admin ? '<button class="del" title="删除">×</button>' : ''}`;
  // 模糊占位：先铺 thumbhash，缩略图加载完成后淡入并移除占位；加密相册无 thumbhash，改为解密缩略图
  const imgEl = item.querySelector('img');
  if (p.encrypted) {
    encLoadThumb(p, imgEl, p.albumId || currentAlbumId);
  } else if (p.thumbHash && window.ThumbHash) {
    const ph = makeThumbPlaceholder(p.thumbHash);
    if (ph) {
      item.insertBefore(ph, imgEl);
      imgEl.classList.add('thumb-loading');
      imgEl.addEventListener('load', () => {
        imgEl.classList.remove('thumb-loading');
        ph.remove();
      }, { once: true });
    }
  }
  if (selectMode && selectedIds.has(p.id)) item.classList.add('selected');
  item.querySelector('img').addEventListener('click', () => {
    if (selectMode) {
      toggleSelect(p, item);
    } else {
      openViewer(currentPhotos.indexOf(p));
    }
  });
  item.querySelector('.del')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!await confirmModal('删除照片', `「${p.filename || '加密照片'}」将移入回收站，10 天内可还原。`, '移入回收站', true)) return;
    try {
      await api('DELETE', `/photos/${p.id}`);
      recycleObserver?.unobserve(item);
      item.remove();
      currentPhotos = currentPhotos.filter((x) => x.id !== p.id);
      toast('已移入回收站');
    } catch (err) { toast(err.message, true); }
  });
  getRecycleObserver().observe(item);
  return item;
}

// 追加照片：平铺直接入网格；按日期找/建对应日期分组（列表为时间倒序，新日期组在底部）
// eagerFirst：前 N 张用高优先级加载（仅首屏/搜索结果首屏传 8，无限滚动批次不传）
function addPhotoItems(photos, admin, eagerFirst = 0) {
  if (albumGroupMode === 'flat') {
    const grid = document.getElementById('photo-grid');
    if (!grid) return;
    photos.forEach((p, i) => grid.appendChild(createPhotoItem(p, admin, i < eagerFirst)));
    return;
  }
  const groups = document.getElementById('photo-groups');
  if (!groups) return;
  photos.forEach((p, i) => {
    const day = String(p.createdAt ?? '').slice(0, 10) || '未知日期';
    let group = groups.querySelector(`[data-day="${day}"]`);
    if (!group) {
      group = document.createElement('div');
      group.className = 'photo-day';
      group.dataset.day = day;
      group.innerHTML = `<h4 class="photo-day-head">${fmtDateHeader(day)}</h4>
        <div class="photo-grid"></div>`;
      groups.appendChild(group);
    }
    group.querySelector('.photo-grid').appendChild(createPhotoItem(p, admin, i < eagerFirst));
  });
}

// ==================== 多选批量模式（管理员） ====================

function enterSelectMode() {
  selectMode = true;
  selectedIds.clear();
  // 已有元素就地切换，保留滚动位置
  document.querySelectorAll('.photo-item').forEach((el) => {
    el.classList.add('selecting');
    if (!el.querySelector('.pick-check')) {
      el.insertAdjacentHTML('afterbegin', '<span class="pick-check"></span>');
    }
  });
  showSelectBar();
}

function exitSelectMode() {
  selectMode = false;
  selectedIds.clear();
  document.querySelectorAll('.photo-item').forEach((el) => {
    el.classList.remove('selecting', 'selected');
    el.querySelector('.pick-check')?.remove();
  });
  document.getElementById('select-bar')?.remove();
}

function toggleSelect(p, itemEl) {
  if (selectedIds.has(p.id)) {
    selectedIds.delete(p.id);
    itemEl.classList.remove('selected');
  } else {
    selectedIds.add(p.id);
    itemEl.classList.add('selected');
  }
  updateSelectBarCount();
}

function showSelectBar() {
  document.getElementById('select-bar')?.remove();
  const bar = document.createElement('div');
  bar.id = 'select-bar';
  bar.className = 'select-bar';
  bar.innerHTML = `
    <span class="select-count" id="select-count">已选 0 张</span>
    <button class="btn small primary" data-b="rename">重命名</button>
    <button class="btn small" data-b="move">移动到…</button>
    <button class="btn small danger" data-b="delete">删除</button>
    <button class="btn small" data-b="cancel">退出多选</button>`;
  document.body.appendChild(bar);
  bar.querySelector('[data-b="cancel"]').addEventListener('click', exitSelectMode);
  bar.querySelector('[data-b="delete"]').addEventListener('click', batchDelete);
  bar.querySelector('[data-b="move"]').addEventListener('click', batchMove);
  bar.querySelector('[data-b="rename"]').addEventListener('click', batchRename);
  updateSelectBarCount();
}

function updateSelectBarCount() {
  const el = document.getElementById('select-count');
  if (el) el.textContent = `已选 ${selectedIds.size} 张`;
}

function requireSelection() {
  if (!selectedIds.size) { toast('请先勾选照片', true); return null; }
  return [...selectedIds];
}

// 批量操作成功后：退出多选 UI 再整体刷新
function finishBatch() {
  selectMode = false;
  selectedIds.clear();
  document.getElementById('select-bar')?.remove();
  render();
}

async function batchDelete() {
  const ids = requireSelection(); if (!ids) return;
  if (!await confirmModal('批量删除',
    `选中的 ${ids.length} 张照片将移入回收站，可在回收站还原。`, '移入回收站', true)) return;
  try {
    const r = await api('POST', '/photos/batch', { action: 'delete', ids });
    toast(`已移入回收站 ${r.deleted} 张`);
    finishBatch();
  } catch (err) { toast(err.message, true); }
}

async function batchMove() {
  const ids = requireSelection(); if (!ids) return;
  if (ids.length > 30) { toast('单次移动最多 30 张，请减少勾选', true); return; }
  let albums;
  try {
    albums = (await api('GET', '/albums')).albums;
  } catch (err) { toast(err.message, true); return; }
  const others = albums.filter((a) => a.id !== currentAlbumId);
  if (!others.length) { toast('没有其他相册，先去创建一个', true); return; }

  const m = openModal(`
    <h2>移动到相册</h2>
    <div class="warn">将移动已选的 ${ids.length} 张照片（R2 对象一并迁移）</div>
    <div class="field">
      <select id="f-target-album">
        ${others.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}
      </select>
    </div>
    <div class="actions">
      <button class="btn" data-r="cancel">取消</button>
      <button class="btn primary" data-r="ok">开始移动</button>
    </div>`);
  m.querySelector('[data-r="cancel"]').addEventListener('click', closeModal);
  m.querySelector('[data-r="ok"]').addEventListener('click', async (e) => {
    const targetAlbumId = m.querySelector('#f-target-album').value;
    e.target.disabled = true;
    try {
      const r = await api('POST', '/photos/batch',
        { action: 'move', ids, targetAlbumId });
      closeModal();
      toast(`移动完成 ${r.moved} 张${r.failed ? `，失败 ${r.failed} 张` : ''}`);
      finishBatch();
    } catch (err) {
      e.target.disabled = false;
      toast(err.message, true);
    }
  });
}

async function batchRename() {
  const ids = requireSelection(); if (!ids) return;
  const m = openModal(`
    <h2>批量重命名</h2>
    <div class="warn">照片将按「前缀-序号.原扩展名」重命名，例如：旅行-01.jpg</div>
    <div class="field">
      <input id="f-rename-prefix" type="text" maxlength="60"
        placeholder="文件名前缀，如：2026三亚行">
    </div>
    <div class="actions">
      <button class="btn" data-r="cancel">取消</button>
      <button class="btn primary" data-r="ok">开始重命名</button>
    </div>`);
  const input = m.querySelector('#f-rename-prefix');
  input.focus();
  m.querySelector('[data-r="cancel"]').addEventListener('click', closeModal);
  m.querySelector('[data-r="ok"]').addEventListener('click', async (e) => {
    const prefix = input.value.trim();
    if (!prefix) { toast('请填写文件名前缀', true); return; }
    if (/[\\/:*?"<>|]/.test(prefix)) {
      toast('前缀不能包含 \\ / : * ? " < > | 等字符', true);
      return;
    }
    const names = {};
    ids.forEach((id, i) => {
      const p = currentPhotos.find((x) => x.id === id);
      if (!p) return;
      const dot = p.filename.lastIndexOf('.');
      const ext = dot > 0 ? p.filename.slice(dot) : '';
      names[id] = `${prefix}-${String(i + 1).padStart(2, '0')}${ext}`;
    });
    e.target.disabled = true;
    try {
      const r = await api('POST', '/photos/batch',
        { action: 'rename', ids, names });
      closeModal();
      toast(`已重命名 ${r.renamed} 张`);
      finishBatch();
    } catch (err) {
      e.target.disabled = false;
      toast(err.message, true);
    }
  });
}

// 重建照片容器并渲染 currentPhotos（时间线 / 搜索结果共用）
function rerenderPhotoArea() {
  buildPhotoArea();
  addPhotoItems(currentPhotos, isAdmin(), 8);
}

// 搜索区 HTML（相册页 / 分享只读页共用）
function albumSearchHtml() {
  return `
    <div class="search-row">
      <input id="f-search" type="search" placeholder="搜索标签 / 文件名（全相册，含未加载）…" autocomplete="off">
      <button id="btn-semantic" class="btn" type="button" title="切换语义搜索（按内容含义匹配，需 AI 标签）">🔍 语义</button>
      <span id="search-note" class="search-note"></span>
    </div>
    <div id="tag-chips" class="tag-chips" hidden></div>`;
}

// 标签云 + 搜索框防抖绑定（api 第 4 参带当前相册解锁/分享 token）
function bindAlbumSearch(albumId) {
  const input = document.getElementById('f-search');
  const chipsBox = document.getElementById('tag-chips');
  const semBtn = document.getElementById('btn-semantic');
  if (!input) return;

  // 语义搜索切换
  if (semBtn) {
    semBtn.addEventListener('click', () => {
      searchState.semantic = !searchState.semantic;
      semBtn.classList.toggle('primary', searchState.semantic);
      semBtn.textContent = searchState.semantic ? '🔍 语义：开' : '🔍 语义';
      const note = document.getElementById('search-note');
      if (note) note.textContent = searchState.semantic ? '语义搜索模式：按内容含义匹配（仅当前相册）' : '';
      input.placeholder = searchState.semantic
        ? '语义搜索当前相册：输入描述（如「海边日落」「一家人合影」）…'
        : '搜索标签 / 文件名（全相册，含未加载）…';
      const term = input.value.trim();
      if (term) doServerSearch(albumId, { q: term });
    });
  }

  // 语义归组标签云：同义标签已合并为一组，点代表词搜整组（组内任一标签命中即返回）
  api('GET', `/tag-groups?albumId=${encodeURIComponent(albumId)}`, null, albumId)
    .then((d) => {
      if (!chipsBox || !d.groups?.length) return;
      chipsBox.hidden = false;
      chipsBox.innerHTML = d.groups.map((g) =>
        `<button type="button" class="tag-chip" data-tags="${esc(g.tags.join(','))}" data-rep="${esc(g.rep)}" title="包含相近标签：${esc(g.tags.join('、'))}">${esc(g.rep)}<i>${g.n}</i></button>`
      ).join('');
      chipsBox.querySelectorAll('.tag-chip').forEach((b) =>
        b.addEventListener('click', () => {
          input.value = b.dataset.rep;
          doServerSearch(albumId, { q: b.dataset.rep, tags: b.dataset.tags });
        }));
    })
    .catch(() => {});

  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    const term = input.value.trim();
    timer = setTimeout(() => {
      if (term) doServerSearch(albumId, { q: term });
      else if (searchState.active) restoreAlbumGrid(albumId);
    }, 350);
  });
}

// ⭐只看收藏 按钮（再点一次返回时间线）
function bindFavOnlyBtn(albumId) {
  document.getElementById('btn-fav-only')?.addEventListener('click', (e) => {
    if (searchState.favoriteOnly) restoreAlbumGrid(albumId);
    else {
      e.currentTarget.textContent = '← 返回相册';
      doServerSearch(albumId, { favorite: true });
    }
  });
}

// 服务端搜索 / 收藏筛选 / 标签组搜索：断开无限滚动，结果直接替换照片区（上限 100 张）
async function doServerSearch(albumId, { q = '', favorite = false, tags = '' } = {}) {
  if (infiniteObserver) { infiniteObserver.disconnect(); infiniteObserver = null; }
  searchState.active = true;
  searchState.favoriteOnly = favorite;
  const note = document.getElementById('search-note');
  if (note) note.textContent = '搜索中…';
  try {
    let d;
    if (searchState.semantic && q) {
      // 语义搜索：只在当前相册内，按向量相似度排序
      d = await api('GET', `/search/semantic?q=${encodeURIComponent(q)}&albumId=${encodeURIComponent(albumId)}`, null, albumId);
    } else {
      const qs = new URLSearchParams({ albumId, limit: '100' });
      if (q) qs.set('q', q);
      if (tags) qs.set('tags', tags);
      if (favorite) qs.set('favorite', '1');
      d = await api('GET', `/search?${qs.toString()}`, null, albumId);
    }
    currentPhotos = d.photos;
    buildPhotoArea();
    addPhotoItems(d.photos, isAdmin(), 8);
    const statusEl = document.getElementById('page-status');
    if (statusEl) statusEl.textContent = '';
    if (note) {
      if (favorite) note.textContent = `⭐ 收藏的照片 · 共 ${d.photos.length} 张`;
      else if (tags) note.textContent = `标签组「${q}」匹配 ${d.photos.length} 张（${tags.split(',').filter(Boolean).length} 个相近标签）`;
      else if (searchState.semantic) note.textContent = `语义「${q}」在本相册匹配 ${d.photos.length} 张（按相似度排序）`;
      else note.textContent = `「${q}」匹配 ${d.photos.length} 张${d.photos.length >= 100 ? '（仅显示前 100 张，请细化关键词）' : ''}`;
    }
  } catch (err) {
    if (note) note.textContent = '搜索失败：' + (err.message || err);
  }
}

// 退出搜索/收藏视图：重新拉取相册首屏并恢复无限滚动（不整页重渲染）
async function restoreAlbumGrid(albumId) {
  searchState = { active: false, favoriteOnly: false, semantic: false };
  const note = document.getElementById('search-note');
  if (note) note.textContent = '';
  const input = document.getElementById('f-search');
  if (input) input.value = '';
  const favBtn = document.getElementById('btn-fav-only');
  if (favBtn) favBtn.textContent = '⭐ 只看收藏';
  try {
    const d = await api('GET', `/albums/${albumId}/photos?limit=${ALBUM_PAGE_SIZE}`, null, albumId);
    currentPhotos = [...d.photos];
    prefetchedPage = null;
    pageState = { cursor: d.nextCursor, loading: false, hasMore: !!d.nextCursor };
    buildPhotoArea();
    addPhotoItems(d.photos, isAdmin(), 8);
    if (pageState.hasMore) setupInfiniteLoad();
  } catch (err) {
    toast(err.message || '加载失败', true);
  }
}

async function renderAlbum(albumId) {
  if (infiniteObserver) { infiniteObserver.disconnect(); infiniteObserver = null; }
  $view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api('GET', `/albums/${albumId}/photos?limit=${ALBUM_PAGE_SIZE}`, null, albumId);
  } catch (err) {
    if (err.status === 403) {
      // 解锁 token 缺失/过期 → 重新输入口令（加密相册走口令，普通相册走数字密码）
      sessionStorage.removeItem('unlock_' + albumId);
      const nameMatch = location.hash.match(/[?&]name=([^&]*)/);
      const name = nameMatch ? decodeURIComponent(nameMatch[1]) : '该相册';
      showUnlockModal(albumId, name, !!err.data?.encrypted);
      $view.innerHTML = `<div class="empty">此相册已上锁</div>`;
      return;
    }
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  // 加密相册（端到端）：即便管理员，本会话未解锁也无法解密，强制先输口令
  if (data.album.encrypted && !hasEncAlbumKey(albumId)) {
    showUnlockModal(albumId, data.album.name, true);
    $view.innerHTML = `<div class="empty">此相册为端到端加密，需输入口令解锁</div>`;
    return;
  }
  currentAlbumId = albumId;
  currentPhotos = [];
  currentCoverPhotoId = data.album.coverPhotoId ?? null;
  searchState = { active: false, favoriteOnly: false, semantic: false };
  prefetchedPage = null;
  pageState = { cursor: data.nextCursor, loading: false, hasMore: !!data.nextCursor };
  const admin = isAdmin();
  const canEdit = canEditAlbum();
  const isEncAlbum = !!data.album.encrypted;

  $view.innerHTML = `
    <div class="page-head">
      <h1>${esc(data.album.name)}${data.album.encrypted ? ' <span class="lock" style="vertical-align:3px">🔒 端到端加密</span>' : (data.album.locked ? ' <span class="lock" style="vertical-align:3px">已上锁</span>' : '')}</h1>
      <div class="page-actions">
        <a class="btn" href="#/albums">← 返回</a>
        ${data.photos.length ? '<button class="btn" id="btn-fav-only">⭐ 只看收藏</button>' : ''}
        ${admin && !isEncAlbum ? `<button class="btn" id="btn-share">🔗 分享</button>` : ''}
        ${admin && data.photos.length ? `<button class="btn" id="btn-select-mode">☑ 多选</button>` : ''}
        ${canEdit && data.photos.length && !isEncAlbum ? `<button class="btn" id="btn-zip">⬇ 打包下载</button>` : ''}
        ${admin && data.album.coverPhotoId ? `
          <button class="btn" id="btn-clear-cover">取消自定义封面</button>` : ''}
        ${admin && data.missingThumbs > 0 && !isEncAlbum ? `
          <button class="btn" id="btn-backfill">回填历史缩略图（${data.missingThumbs}张）</button>` : ''}
        ${canEdit && data.untaggedCount > 0 && !isEncAlbum ? `
          <button class="btn" id="btn-backfill-tags">🏷 补打标签（${data.untaggedCount}张）</button>` : ''}
        ${admin && data.photos.length && !isEncAlbum ? `
          <button class="btn" id="btn-retag-tags" title="用新 AI 模型重新生成已有标签，覆盖旧标签">🔄 重打标签</button>` : ''}
        ${canEdit ? `
          <label class="btn primary" style="cursor:pointer">
            上传照片<input id="f-upload" type="file" accept="image/*,video/mp4,video/webm,video/quicktime,video/x-m4v" multiple hidden>
          </label>` : ''}
      </div>
    </div>
    <div class="view-toggle">
      <span class="view-toggle-label">查看方式</span>
      <button class="btn small ${albumGroupMode === 'flat' ? 'primary' : ''}" id="btn-mode-flat">平铺</button>
      <button class="btn small ${albumGroupMode === 'date' ? 'primary' : ''}" id="btn-mode-date">按上传时间</button>
    </div>
    ${albumSearchHtml()}
    <div id="backfill-tip" class="backfill-tip" style="display:none"></div>
    ${data.album.description ? `<p style="color:var(--muted);font-size:14px;margin-bottom:14px">${esc(data.album.description)}</p>` : ''}
    <div id="upload-progress"></div>
    ${data.photos.length ? `
      <div id="photo-area"></div>
      <div id="page-sentinel" class="page-sentinel"></div>
      <div id="page-status" class="page-status"></div>`
      : `<div class="empty">还没有照片${canEdit ? '，点「上传照片」开始（手机会打开相册选择器）' : ''}</div>`}`;

  bindAlbumSearch(albumId);
  bindFavOnlyBtn(albumId);
  if (data.photos.length) {
    currentPhotos.push(...data.photos);
    rerenderPhotoArea();
    bindGroupModeToggle();
    bindBackfillButton();
    if (pageState.hasMore) setupInfiniteLoad();
  }
  // 补打 AI 标签：循环按批调用，直到剩余 0 或当日额度用尽
  document.getElementById('btn-backfill-tags')?.addEventListener('click', async (e) => {
    const btn = e.target;
    const tip = document.getElementById('backfill-tip');
    btn.disabled = true;
    tip.style.display = '';
    let done = 0, failed = 0, total = 0;
    try {
      for (;;) {
        const r = await api('POST', '/admin/backfill-tags', { albumId, limit: 20 }, albumId);
        done += r.done; failed += r.failed || 0;
        total = Math.max(total, done + failed + r.remaining);
        renderAiProgress(tip, { action: '本批打标', total, done, failed, remaining: r.remaining, quotaLeft: r.quotaLeft, failReasons: r.failReasons });
        if (!r.remaining || !r.quotaLeft || r.done === 0) break;
      }
      toast(`补打完成，共 ${done} 张${failed ? `，${failed} 张失败` : ''}`);
      render();
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  });
  // 重打标签（管理员）：用新模型覆盖本相册已有标签，每批 20 张，受每日额度限制
  document.getElementById('btn-retag-tags')?.addEventListener('click', async (e) => {
    const btn = e.target;
    const ok = await confirmModal(
      '重打本相册标签',
      '将用新的 AI 模型重新生成本相册所有已有标签，旧标签会被覆盖；每张消耗今日 AI 额度（每天最多 200 张，可分多天完成）。确定继续？',
      '开始重打', true
    );
    if (!ok) return;
    const tip = document.getElementById('backfill-tip');
    btn.disabled = true;
    tip.style.display = '';
    let done = 0, failed = 0, total = 0;
    try {
      const since = new Date().toISOString(); // 整轮活动游标：只重打游标之前的照片
      let batches = 0;
      for (;;) {
        const r = await api('POST', '/admin/backfill-tags', { albumId, limit: 20, mode: 'retag', since }, albumId);
        batches++;
        done += r.done; failed += r.failed || 0;
        total = Math.max(total, done + failed + r.remaining);
        renderAiProgress(tip, { action: '本批重打', total, done, failed, remaining: r.remaining, quotaLeft: r.quotaLeft, failReasons: r.failReasons });
        if (!r.remaining || !r.quotaLeft || r.done === 0) {
          if (!r.quotaLeft) toast('今日 AI 额度已用完，明天可继续', true);
          else if (r.failed && !r.done) toast('本批全部失败，已自动退还额度，请稍后再试', true);
          break;
        }
        if (batches >= 10) { toast('已连续重打 200 张，今天先到这，明天可继续'); break; }
      }
      toast(`重打完成，共 ${done} 张${failed ? `，${failed} 张失败` : ''}`);
      render();
    } catch (err) {
      btn.disabled = false;
      toast(err.message, true);
    }
  });
  if (canEdit) document.getElementById('f-upload')?.addEventListener('change', onUploadSelected);
  document.getElementById('btn-share')?.addEventListener('click', () => showShareModal(albumId));
  document.getElementById('btn-select-mode')?.addEventListener('click', enterSelectMode);
  document.getElementById('btn-zip')?.addEventListener('click', (e) =>
    zipDownload(data.album.name, e.target));
  // 取消自定义封面：恢复自动取最新照片
  document.getElementById('btn-clear-cover')?.addEventListener('click', async () => {
    try {
      await api('PATCH', `/albums/${albumId}`, { coverPhotoId: null });
      toast('已恢复自动封面');
      render();
    } catch (err) { toast(err.message, true); }
  });

  function onUploadSelected(e) {
    const files = [...e.target.files]
      .filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    e.target.value = '';
    if (files.length) uploadFiles(albumId, files);
  }
}

// 切换平铺/按上传时间分组：重建容器（已加载照片无需重新请求）
function bindGroupModeToggle() {
  const switchMode = (mode) => {
    if (albumGroupMode === mode) return;
    albumGroupMode = mode;
    localStorage.setItem('album_group_mode', mode);
    document.getElementById('btn-mode-flat').classList.toggle('primary', mode === 'flat');
    document.getElementById('btn-mode-date').classList.toggle('primary', mode === 'date');
    rerenderPhotoArea();
  };
  document.getElementById('btn-mode-flat')?.addEventListener('click', () => switchMode('flat'));
  document.getElementById('btn-mode-date')?.addEventListener('click', () => switchMode('date'));
}

// 闲时预取：加载完一页后，网络空闲时预取下一页数据 + 预加载其缩略图
let prefetchedPage = null; // { cursor, data }

function prefetchNextPage() {
  if (!pageState.hasMore || pageState.loading || !currentAlbumId) return;
  if (prefetchedPage && prefetchedPage.cursor === pageState.cursor) return;
  const cursor = pageState.cursor, albumId = currentAlbumId;
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 300));
  idle(async () => {
    try {
      const data = await api('GET',
        `/albums/${albumId}/photos?limit=${ALBUM_PAGE_SIZE}&cursor=${encodeURIComponent(cursor)}`,
        null, albumId);
      // 预取回来时游标已被搜索/换相册改变则丢弃
      if (currentAlbumId !== albumId || pageState.cursor !== cursor) return;
      prefetchedPage = { cursor, data };
      // 预加载缩略图进浏览器/SW 缓存（前 30 张即可）
      for (const p of data.photos.slice(0, 30)) {
        const im = new Image();
        if (SW_IMG_CACHE_ENABLED) im.crossOrigin = 'anonymous';
        im.src = p.thumbUrl;
      }
    } catch { /* 预取失败无妨，滚动到底会正常加载 */ }
  });
}

// 无限滚动：哨兵进入视口（提前 600px）就拉下一页
function setupInfiniteLoad() {
  const sentinel = document.getElementById('page-sentinel');
  const status = document.getElementById('page-status');
  if (!sentinel) return;
  infiniteObserver = new IntersectionObserver(async (entries) => {
    if (!entries[0].isIntersecting || !pageState.hasMore || pageState.loading) return;
    pageState.loading = true;
    status.textContent = '正在加载更多…';
    try {
      // 优先使用闲时预取的结果
      const data = (prefetchedPage && prefetchedPage.cursor === pageState.cursor)
        ? prefetchedPage.data
        : await api('GET',
          `/albums/${currentAlbumId}/photos?limit=${ALBUM_PAGE_SIZE}&cursor=${encodeURIComponent(pageState.cursor)}`,
          null, currentAlbumId);
      prefetchedPage = null;
      currentPhotos.push(...data.photos);
      rerenderPhotoArea();
      pageState.cursor = data.nextCursor;
      pageState.hasMore = !!data.nextCursor;
      if (!pageState.hasMore) {
        status.textContent = '— 已经到底了 —';
        infiniteObserver.disconnect();
      } else {
        status.textContent = '';
        prefetchNextPage();
      }
    } catch (err) {
      status.textContent = '';
      toast(err.message || '加载失败', true);
    } finally {
      pageState.loading = false;
    }
  }, { rootMargin: '600px 0px' });
  infiniteObserver.observe(sentinel);
  prefetchNextPage();
}

// 历史缩略图回填：循环按批调用，直到剩余 0 或月度 Images 额度用尽
function bindBackfillButton() {
  const btn = document.getElementById('btn-backfill');
  btn?.addEventListener('click', openBackfillModal);
}

// 回填选择面板：按上传时间范围 或 勾选指定照片
function openBackfillModal() {
  let busy = false;
  let pickLoaded = false;
  const m = openModal(`
    <h2>回填历史缩略图</h2>
    <div class="bf-tabs">
      <button class="btn small primary" data-bfm="range">按上传时间</button>
      <button class="btn small" data-bfm="photos">指定照片</button>
    </div>

    <div id="bf-panel-range" class="bf-panel">
      <p style="color:var(--muted);font-size:13px;margin:0 0 10px">
        按照片的<strong>上传日期</strong>范围回填，日期留空表示不限。
      </p>
      <div class="bf-date-row">
        <label>从 <input type="date" id="bf-from"></label>
        <label>到 <input type="date" id="bf-to"></label>
      </div>
      <button class="btn primary" id="bf-start-range">开始回填</button>
    </div>

    <div id="bf-panel-photos" class="bf-panel" style="display:none">
      <label class="bf-all"><input type="checkbox" id="bf-select-all"> 全选</label>
      <div id="bf-pick-grid" class="bf-pick-grid">
        <p style="color:var(--muted);text-align:center;padding:24px 0;grid-column:1/-1">
          点下方按钮加载本相册待回填的照片
        </p>
      </div>
      <div class="bf-pick-actions">
        <button class="btn" id="bf-load-pick">加载待回填照片</button>
        <button class="btn primary" id="bf-start-pick" disabled>回填选中（0）</button>
      </div>
    </div>

    <p id="bf-status" class="bf-status"></p>
    <div class="actions"><button class="btn" id="bf-done">关闭并刷新</button></div>
  `);

  const $status = m.querySelector('#bf-status');
  const setStatus = (t) => { $status.textContent = t; };
  const refreshPickCount = () => {
    const n = m.querySelectorAll('#bf-pick-grid input[type=checkbox]:checked').length;
    const btn = m.querySelector('#bf-start-pick');
    btn.textContent = `回填选中（${n}）`;
    btn.disabled = n === 0 || busy;
  };

  // 标签页切换
  m.querySelectorAll('[data-bfm]').forEach((b) => {
    b.addEventListener('click', () => {
      m.querySelectorAll('[data-bfm]').forEach((x) =>
        x.classList.toggle('primary', x === b));
      const mode = b.dataset.bfm;
      m.querySelector('#bf-panel-range').style.display = mode === 'range' ? '' : 'none';
      m.querySelector('#bf-panel-photos').style.display = mode === 'photos' ? '' : 'none';
    });
  });

  m.querySelector('#bf-done').addEventListener('click', () => { closeModal(); render(); });

  // —— 模式一：按上传时间范围循环回填 ——
  m.querySelector('#bf-start-range').addEventListener('click', async () => {
    if (busy) return;
    const dateFrom = m.querySelector('#bf-from').value || undefined;
    const dateTo = m.querySelector('#bf-to').value || undefined;
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setStatus('起始日期不能晚于截止日期'); return;
    }
    busy = true;
    m.querySelector('#bf-start-range').disabled = true;
    setStatus('开始回填…');
    try {
      for (;;) {
        const r = await api('POST', '/admin/backfill-thumbs',
          { albumId: currentAlbumId, dateFrom, dateTo });
        setStatus(`本批 ${r.processed} 张，范围内剩余 ${r.remaining} 张…`);
        if (r.quotaExhausted) {
          setStatus('本月 Cloudflare Images 额度已用尽，下月可继续');
          toast('额度已用尽', true);
          break;
        }
        if (r.remaining === 0) { setStatus('✅ 范围内缩略图已全部生成'); toast('回填完成'); break; }
      }
    } catch (e) {
      setStatus('回填失败：' + (e.message || e));
    } finally {
      busy = false;
      m.querySelector('#bf-start-range').disabled = false;
    }
  });

  // —— 模式二：加载待回填照片网格（游标拉全量，增量渲染） ——
  m.querySelector('#bf-load-pick').addEventListener('click', async () => {
    if (busy || pickLoaded) return;
    busy = true;
    const grid = m.querySelector('#bf-pick-grid');
    grid.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px 0;grid-column:1/-1">加载中…</p>';
    let cursor = null;
    let total = 0;
    try {
      grid.innerHTML = '';
      do {
        const q = `/albums/${currentAlbumId}/photos?missing=1&limit=100`
          + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
        const d = await api('GET', q, null, currentAlbumId);
        for (const p of d.photos) {
          total++;
          const lab = document.createElement('label');
          lab.className = 'bf-pick';
          lab.innerHTML = `
            <input type="checkbox" data-id="${esc(p.id)}">
            <img src="${esc(p.thumbUrl)}" loading="lazy" decoding="async" alt="${esc(p.filename)}">
            <span class="bf-pick-date">${esc(String(p.createdAt ?? '').slice(0, 10))}</span>
            <span class="bf-pick-done">✓ 已生成</span>`;
          lab.querySelector('input').addEventListener('change', refreshPickCount);
          grid.appendChild(lab);
        }
        cursor = d.nextCursor;
      } while (cursor);
      if (!total) {
        grid.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px 0;grid-column:1/-1">没有待回填的照片</p>';
      }
      pickLoaded = true;
    } catch (e) {
      grid.innerHTML = `<p style="color:var(--muted);text-align:center;padding:24px 0;grid-column:1/-1">加载失败：${esc(e.message || e)}</p>`;
    } finally {
      busy = false;
    }
  });

  // 全选/取消全选（仅未完成项）
  m.querySelector('#bf-select-all').addEventListener('change', (e) => {
    m.querySelectorAll('#bf-pick-grid input[type=checkbox]:not(:disabled)')
      .forEach((cb) => { cb.checked = e.target.checked; });
    refreshPickCount();
  });

  // —— 模式二：按选中照片分批（每批 5 张）回填 ——
  m.querySelector('#bf-start-pick').addEventListener('click', async () => {
    if (busy) return;
    const ids = [...m.querySelectorAll('#bf-pick-grid input[type=checkbox]:checked')]
      .map((cb) => cb.dataset.id);
    if (!ids.length) return;
    busy = true;
    m.querySelector('#bf-start-pick').disabled = true;
    m.querySelector('#bf-load-pick').disabled = true;
    let doneTotal = 0;
    try {
      for (let i = 0; i < ids.length; i += 5) {
        const chunk = ids.slice(i, i + 5);
        setStatus(`正在回填 ${i + 1}~${Math.min(i + 5, ids.length)} / ${ids.length} 张…`);
        const r = await api('POST', '/admin/backfill-thumbs',
          { albumId: currentAlbumId, ids: chunk });
        doneTotal += r.doneIds.length;
        for (const id of r.doneIds) {
          const cb = m.querySelector(`#bf-pick-grid input[data-id="${id}"]`);
          if (cb) {
            cb.checked = false;
            cb.disabled = true;
            cb.closest('.bf-pick').classList.add('done');
          }
        }
        if (r.quotaExhausted) {
          setStatus('本月 Cloudflare Images 额度已用尽，下月可继续');
          toast('额度已用尽', true);
          break;
        }
      }
      if (!$status.textContent.includes('额度')) {
        setStatus(`✅ 完成，成功生成 ${doneTotal} 张${doneTotal < ids.length ? `，${ids.length - doneTotal} 张被跳过（原图过大或不存在）` : ''}`);
        toast('回填完成');
      }
    } catch (e) {
      setStatus('回填失败：' + (e.message || e));
    } finally {
      busy = false;
      m.querySelector('#bf-select-all').checked = false;
      refreshPickCount();
    }
  });
}

// 大图压缩阈值：超过 1.5MB 才压（小图压缩得不偿失）
const COMPRESS_THRESHOLD = 1.5 * 1024 * 1024;

// 浏览器端压缩（browser-image-compression，本地 vendor，UMD 全局 imageCompression）
// GIF/SVG 跳过（保动画/矢量）；失败（如 HEIC 无法解码）降级原图
async function maybeCompress(file) {
  if (file.size <= COMPRESS_THRESHOLD) return file;
  if (/image\/(gif|svg)/i.test(file.type)) return file;
  if (typeof imageCompression !== 'function') return file;
  try {
    const out = await imageCompression(file, {
      maxSizeMB: 1.5,
      maxWidthOrHeight: 2048,
      useWebWorker: true,
    });
    return out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

// 大视频分段上传：S3 Multipart，3 路并发、单段失败重试 3 次、整体失败 abort 清理
// 数据面每段走预签名 PUT 直传 R2，控制面（分段签名/合并/放弃）经 Worker
async function uploadMultipart(blob, r, albumId, thumbs) {
  const PART_SIZE = 16 * 1024 * 1024; // 16MB/段（S3 最小 5MB），上限 500MB≈32 段
  const CONCURRENCY = 3;
  const RETRIES = 3;
  const totalParts = Math.ceil(blob.size / PART_SIZE);
  let nextPart = 1;
  const parts = [];

  async function uploadOne(partNumber) {
    const start = (partNumber - 1) * PART_SIZE;
    const end = Math.min(start + PART_SIZE, blob.size);
    const chunk = blob.slice(start, end);
    let lastErr;
    for (let attempt = 1; attempt <= RETRIES; attempt++) {
      try {
        const su = await api('POST', `/photos/${r.photoId}/upload-part`,
          { uploadId: r.uploadId, partNumber }, albumId);
        const resp = await fetch(su.url, {
          method: 'PUT', body: chunk, headers: { 'Content-Type': blob.type || 'application/octet-stream' },
        });
        if (!resp.ok) throw { message: `分段 ${partNumber} 直传失败` };
        const etag = resp.headers.get('etag');
        if (!etag) throw { message: `分段 ${partNumber} 缺少 ETag` };
        return { partNumber, etag };
      } catch (e) {
        lastErr = e;
        if (attempt < RETRIES) await new Promise((res) => setTimeout(res, 500 * attempt));
      }
    }
    throw lastErr || { message: `分段 ${partNumber} 上传失败` };
  }

  async function pool() {
    for (;;) {
      const n = nextPart++;
      if (n > totalParts) return;
      parts.push(await uploadOne(n));
    }
  }

  try {
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, totalParts) }, () => pool()));
    parts.sort((a, b) => a.partNumber - b.partNumber);
    // 视频用封面帧计算 dHash + thumbHash（与单 PUT confirm 同口径）
    const completeBody = { uploadId: r.uploadId, parts };
    const phash = thumbs.small ? await computeDHash(thumbs.small) : null;
    if (phash) completeBody.phash = phash;
    if (thumbs.thumbHash) completeBody.thumbHash = thumbs.thumbHash;
    await api('POST', `/photos/${r.photoId}/complete-multipart`, completeBody, albumId);
  } catch (e) {
    // 失败清理未完成分段，避免 R2 残留计费
    try {
      await api('POST', `/photos/${r.photoId}/abort-multipart`, { uploadId: r.uploadId }, albumId);
    } catch { /* 忽略清理失败 */ }
    throw e;
  }
}

// 上传：浏览器端先解析 EXIF + 生成缩略图 → 拿预签名 URL → PUT 直传 R2 → confirm
// 文件间串行（避免手机端内存过大），单文件内缩略图/分段并发
async function uploadFiles(albumId, files) {
  // 加密相册：本会话解锁后拿到相册主密钥，全链路加密上传
  const albumKey = await encGetAlbumKey(albumId);
  const isEnc = !!albumKey;
  // 疑似重复（同名同大小，仅对照已加载照片）：取消则跳过这些
  const dups = files.filter((f) =>
    currentPhotos.some((p) => p.filename === f.name && p.size === f.size));
  if (dups.length) {
    const names = dups.slice(0, 3).map((f) => f.name).join('、')
      + (dups.length > 3 ? ` 等 ${dups.length} 张` : '');
    const ok = await confirmModal('疑似重复照片',
      `${names} 与已加载照片同名同大小，仍要上传吗？（取消将跳过这些照片）`, '仍要上传');
    if (!ok) files = files.filter((f) => !dups.includes(f));
    if (!files.length) return;
  }
  const box = document.getElementById('upload-progress');
  const bar = document.createElement('div');
  bar.className = 'upload-panel';
  box.appendChild(bar);
  const total = files.length;
  let started = 0, done = 0, failed = 0, skipped = 0;
  const activeNames = new Set();

  const renderProgress = () => {
    const finished = done + failed + skipped;
    const names = [...activeNames].slice(0, 3).map(esc).join('、');
    const more = activeNames.size > 3 ? ` 等 ${activeNames.size} 个` : '';
    bar.innerHTML = `<span>处理 ${finished + activeNames.size}/${total}${names ? '：' + names + more : ''}</span>
      <div class="bar"><i style="width:${(finished / total) * 100}%"></i></div>`;
  };

  // 单文件完整处理（处理 → 申请 → 直传 → 确认），自计结果
  async function processOne(file) {
    try {
      const isVideo = /^video\//.test(file.type);
      let exif = null, thumbs = { small: null, large: null, thumbHash: null }, uploadBlob = file, duration = null;
      if (isVideo) {
        if (file.size > 500 * 1024 * 1024) throw { message: '视频超过 500MB 建议上限，已跳过' };
        // 抽帧 best-effort：失败则无缩略图上传，由后端 MEDIA 绑定补帧
        try {
          const vf = await captureVideoFrame(file);
          thumbs.small = vf.small;
          thumbs.large = vf.large;
          thumbs.thumbHash = vf.thumbHash;
          duration = vf.duration;
        } catch { /* 无法解码（如 HEVC），无缩略图 */ }
      } else {
        // HEIC/HEIF（iPhone 默认格式）先转 JPEG；EXIF 必须用原文件解析（转码后会丢失）
        uploadBlob = await ensureJpeg(file);
        // 缩略图用（可能已转换的）解码结果；上传体超阈值再压缩
        [exif, thumbs] = await Promise.all([
          extractExif(file), makeThumbnails(uploadBlob),
        ]);
        if (uploadBlob.size > COMPRESS_THRESHOLD) uploadBlob = await maybeCompress(uploadBlob);
      }
      // 加密相册：原图/缩略图/元数据全部加密，服务端只存密文（明文只在浏览器）
      let upBlob = uploadBlob;
      const upThumbs = { small: thumbs.small, large: thumbs.large, smallAvif: thumbs.smallAvif };
      let encKeyPayload = null, encMetaB64 = null;
      if (isEnc) {
        const fileKeyBytes = enc_generateFileKeyBytes();
        const fileKey = await enc_importKey(fileKeyBytes);
        encKeyPayload = JSON.stringify(await enc_encryptFileKey(fileKeyBytes, albumKey));
        const nonceBase = enc_randomBytes(8);
        const plainBuf = new Uint8Array(await uploadBlob.arrayBuffer());
        const chunks = Math.max(1, Math.ceil(plainBuf.length / ENC_CHUNK));
        upBlob = new Blob([await enc_encryptStream(fileKey, nonceBase, plainBuf)], { type: 'application/octet-stream' });
        if (thumbs.small) upThumbs.small = new Blob([await enc_encryptBlob(fileKey, new Uint8Array(await thumbs.small.arrayBuffer()))], { type: 'application/octet-stream' });
        if (thumbs.large) upThumbs.large = new Blob([await enc_encryptBlob(fileKey, new Uint8Array(await thumbs.large.arrayBuffer()))], { type: 'application/octet-stream' });
        if (thumbs.smallAvif) upThumbs.smallAvif = new Blob([await enc_encryptBlob(fileKey, new Uint8Array(await thumbs.smallAvif.arrayBuffer()))], { type: 'application/octet-stream' });
        encMetaB64 = await enc_encryptMeta(fileKey, encBuildMeta(file, uploadBlob, exif, thumbs, isVideo, duration, chunks), nonceBase);
      }
      const createBody = {
        filename: isEnc ? 'encrypted' : uploadBlob.name,
        contentType: isEnc ? (isVideo ? 'video/mp4' : 'image/jpeg') : uploadBlob.type || file.type,
        thumbContentType: thumbs.small ? thumbs.small.type : null,
        thumbAvifContentType: thumbs.smallAvif ? 'image/avif' : null,
      };
      if (isEnc) {
        createBody.encKey = encKeyPayload;
        createBody.encMeta = encMetaB64;
      }
      if (isVideo) {
        createBody.duration = duration;
        // >100MB 大视频走分段上传（断点续传）；加密相册密文整体在内存，直接单 PUT
        if (uploadBlob.size > 100 * 1024 * 1024 && !isEnc) createBody.multipart = true;
      } else {
        createBody.takenAt = exif.takenAt; // 拍摄时间保留明文（时间线需要）；其余元数据进加密 meta
        if (!isEnc) {
          createBody.camera = exif.camera;
          createBody.gpsLat = exif.gpsLat;
          createBody.gpsLng = exif.gpsLng;
          if (exif.exif) createBody.exif = exif.exif;
        }
      }
      // 上传体 ≤50MB 才算哈希，做同相册重复检测；>50MB 跳过；加密相册不算（会泄露明文哈希）
      if (!isEnc && uploadBlob.size > 0 && uploadBlob.size <= 50 * 1024 * 1024) {
        try { createBody.sha256 = await sha256Hex(uploadBlob); } catch { /* 忽略 */ }
      }
      let r;
      try {
        r = await api('POST', `/albums/${albumId}/photos`, createBody, albumId);
      } catch (err) {
        if (err.status === 409 && err.data?.duplicate) {
          skipped++;
          toast(`已存在相同照片「${err.data.existingFilename}」，跳过`);
          return;
        }
        throw err;
      }
      // 缩略图/封面帧（小文件，先于主文件完成——confirm/complete 会校验其存在）
      const thumbPuts = [];
      if (r.thumbUploadUrl) {
        thumbPuts.push(fetch(r.thumbUploadUrl, {
          method: 'PUT', body: upThumbs.small, headers: { 'Content-Type': isEnc ? 'application/octet-stream' : upThumbs.small.type },
        }));
        thumbPuts.push(fetch(r.largeUploadUrl, {
          method: 'PUT', body: upThumbs.large, headers: { 'Content-Type': isEnc ? 'application/octet-stream' : upThumbs.large.type },
        }));
      }
      if (r.thumbAvifUploadUrl && upThumbs.smallAvif) {
        thumbPuts.push(fetch(r.thumbAvifUploadUrl, {
          method: 'PUT', body: upThumbs.smallAvif, headers: { 'Content-Type': isEnc ? 'application/octet-stream' : 'image/avif' },
        }));
      }
      if (thumbPuts.length) {
        const thumbResps = await Promise.all(thumbPuts);
        if (thumbResps.some((x) => !x.ok)) throw { message: '缩略图直传失败' };
      }
      // 主文件：大视频走分段续传（仅非加密），其余单 PUT
      if (r.multipart) {
        await uploadMultipart(uploadBlob, r, albumId, thumbs);
      } else {
        const resp = await fetch(r.uploadUrl, {
          method: 'PUT', body: upBlob, headers: { 'Content-Type': isEnc ? 'application/octet-stream' : upBlob.type || file.type },
        });
        if (!resp.ok) throw { message: '直传 R2 失败' };
        // 加密相册不算 dHash/thumbHash（会泄露明文内容）
        if (isEnc) {
          await api('POST', `/photos/${r.photoId}/confirm`, null, albumId);
        } else {
          // 图片计算 dHash 用于重复检测；视频用封面帧（若有）
          const phashBlob = isVideo ? thumbs.small : uploadBlob;
          const phash = phashBlob ? await computeDHash(phashBlob) : null;
          const confirmBody = {};
          if (phash) confirmBody.phash = phash;
          if (thumbs.thumbHash) confirmBody.thumbHash = thumbs.thumbHash;
          await api('POST', `/photos/${r.photoId}/confirm`,
            Object.keys(confirmBody).length ? confirmBody : null, albumId);
        }
      }
      done++;
    } catch (err) {
      failed++;
      toast(`${file.name} 上传失败：${err.message}`, true);
    }
  }

  // 文件级并发池：CPU ≤4 核 2 路，否则 3 路
  const concurrency = Math.min(
    (navigator.hardwareConcurrency || 4) <= 4 ? 2 : 3, total);

  async function worker() {
    for (;;) {
      const i = started++;
      if (i >= total) return;
      activeNames.add(files[i].name);
      renderProgress();
      try {
        await processOne(files[i]);
      } finally {
        activeNames.delete(files[i].name);
        renderProgress();
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  bar.innerHTML = `<span>完成：成功 ${done} 张${skipped ? `，跳过 ${skipped} 张` : ''}${failed ? `，失败 ${failed} 张` : ''}</span>`;
  setTimeout(() => bar.remove(), 3000);
  if (done) render();
}

// ==================== 大图查看器 ====================

let viewerIdx = -1;
let viewerCrossAlbum = false; // 跨相册页（往年今日）打开的查看器：隐藏相册级操作按钮

function fmtDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function viewerInfoHtml(p) {
  const parts = [];
  if (p.kind === 'video') parts.push(`🎬 视频${p.duration ? ' · ' + esc(fmtDuration(p.duration)) : ''}`);
  if (p.albumName) parts.push('📁 ' + esc(p.albumName));
  if (p.takenAt) parts.push(fmtDateTime(p.takenAt));
  if (p.camera) parts.push(esc(p.camera));
  // EXIF 曝光参数：快门 / 光圈 / ISO / 焦距 / 镜头
  if (p.exif && typeof p.exif === 'object') {
    const e = p.exif;
    const chips = [];
    if (e.aperture) chips.push(`f/${e.aperture}`);
    if (e.exposureTime) {
      chips.push(e.exposureTime < 1
        ? `1/${Math.max(1, Math.round(1 / e.exposureTime))}s`
        : `${e.exposureTime}s`);
    }
    if (e.iso) chips.push(`ISO ${e.iso}`);
    if (e.focalLength) chips.push(`${Math.round(e.focalLength * 10) / 10}mm`);
    if (chips.length) parts.push(chips.join(' · '));
    if (e.lensModel) parts.push(esc(e.lensModel));
  }
  if (Array.isArray(p.tags) && p.tags.length) {
    parts.push(p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(''));
  }
  const captionHtml = p.caption ? `<div class="v-caption">📝 ${esc(p.caption)}</div>` : '';
  const aiDescHtml = p.aiDesc ? `<div class="v-caption">🤖 ${esc(p.aiDesc)}</div>` : '';
  return captionHtml + aiDescHtml + parts.join(' · ');
}

// 取新鲜原图 URL（成功后缓存到条目；失败降级缩略图）
// 跨相册页（往年今日）按照片所属相册取 token 槽位
async function freshPhotoUrl(p) {
  try {
    const r = await api('GET', `/photos/${p.id}/url`, null, p.albumId || currentAlbumId);
    p.url = r.url;
    if (r.proxyUrl) p.proxyUrl = r.proxyUrl;
    return r.url;
  } catch {
    return p.thumbUrl;
  }
}

// 预载查看器相邻图片（prev / next / next2）：freshPhotoUrl 会把新鲜 URL 存到 p.url，
// 翻页时 showAt 直接命中缓存，无需再等换 URL 接口；new Image() 预热浏览器 HTTP 缓存
function prefetchViewerNeighbors(idx) {
  const n = currentPhotos.length;
  if (n < 2) return;
  for (const d of [-1, 1, 2]) {
    const q = currentPhotos[(idx + d + n) % n];
    if (!q || q.kind !== 'image') continue;
    (q.url ? Promise.resolve(q.url) : freshPhotoUrl(q))
      .then((u) => { if (u) { const im = new Image(); im.src = u; } })
      .catch(() => {});
  }
}

// 加密照片/视频：拉取密文 → 本地解密 → Blob URL 展示（服务器全程看不到明文）
async function showEncryptedMedia(q, mediaBox) {
  try {
    const { blobUrl, meta } = await encLoadOriginal(q, q.albumId || currentAlbumId);
    q.filename = meta.filename || q.filename;
    q.camera = meta.camera ?? null;
    q.exif = meta.exif ?? null;
    if (meta.kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.className = 'v-video';
      video.src = blobUrl;
      mediaBox.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.className = 'loading';
      img.alt = meta.filename || '';
      img.addEventListener('load', () => img.classList.remove('loading'));
      img.addEventListener('error', () => img.classList.remove('loading'));
      img.src = blobUrl;
      mediaBox.appendChild(img);
    }
  } catch (err) {
    mediaBox.innerHTML = `<div class="empty">解密失败：${esc(err.message || '无法加载')}</div>`;
  }
}

function openViewer(i) {
  viewerIdx = i;
  const p = currentPhotos[i];
  const isEncPhoto = !!p.encrypted;
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `
    <div class="v-name">${esc(p.filename)} · ${fmtSize(p.size)}</div>
    <div class="v-info" id="v-info">${viewerInfoHtml(p)}</div>
    <div class="v-media" id="v-media"></div>
    ${currentPhotos.length > 1 ? '<button class="v-btn v-prev">‹</button><button class="v-btn v-next">›</button>' : ''}
    <div class="v-bar">
      ${currentPhotos.length > 1 ? '<button class="v-btn" data-a="slideshow">▶ 幻灯片</button>' : ''}
      ${isAdmin() && !shareMode && !viewerCrossAlbum ? '<button class="v-btn" data-a="cover">📌 设为封面</button>' : ''}
      ${isAdmin() && !shareMode && !viewerCrossAlbum && !isEncPhoto ? '<button class="v-btn" data-a="share-one">分享这张</button>' : ''}
      ${isAdmin() && !shareMode && !viewerCrossAlbum && !isEncPhoto ? '<button class="v-btn" data-a="retag">🔄 重打标签</button>' : ''}
      ${isAdmin() && !shareMode && !viewerCrossAlbum ? '<button class="v-btn v-del" data-a="delete">🗑 删除</button>' : ''}
      ${canEditAlbum() && !viewerCrossAlbum ? '<button class="v-btn" data-a="fav"></button>' : ''}
      ${canEditAlbum() && !viewerCrossAlbum && !isEncPhoto ? '<button class="v-btn" data-a="caption">✏️ 备注</button>' : ''}
      ${shareMode || p.kind === 'video' || viewerCrossAlbum || isEncPhoto ? '' : `
      <button class="v-btn" data-a="idphoto">制作证件照</button>
      <button class="v-btn" data-a="style">换风格</button>
      <button class="v-btn" data-a="bg">更换背景</button>`}
      <button class="v-btn" data-a="download">下载${p.kind === 'video' ? '视频' : '原图'}</button>
      <button class="v-btn" data-a="close">关闭</button>
    </div>
    <button class="v-btn v-close">✕</button>`;
  document.body.appendChild(el);

  const mediaBox = el.querySelector('#v-media');

  // 显示指定位置媒体：图片用 <img>，视频用 <video> 原生播放；先换新鲜 URL
  let activeHls = null;
  const showAt = async (idx) => {
    const q = currentPhotos[idx];
    if (activeHls) { try { activeHls.destroy(); } catch { /* ignore */ } activeHls = null; }
    if (q.encrypted) await encHydratePhoto(q, q.albumId || currentAlbumId);
    el.querySelector('.v-name').textContent = `${q.filename || '加密照片'} · ${fmtSize(q.size)}`;
    el.querySelector('#v-info').innerHTML = viewerInfoHtml(q);
    mediaBox.innerHTML = '';
    if (q.encrypted) {
      await showEncryptedMedia(q, mediaBox);
      syncFavBtn();
      return;
    }
    if (q.kind === 'video') {
      const wrap = document.createElement('div');
      wrap.className = 'v-video-wrap';
      const video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.className = 'v-video loading';
      if (q.thumbUrl) video.poster = q.thumbUrl;

      // 播放失败遮罩：区分 HEVC 不支持 / 网络或链接问题，均提供下载与重试
      const fail = document.createElement('div');
      fail.className = 'v-videofail';
      fail.style.display = 'none';
      fail.innerHTML = `
        <div class="v-videofail-title">⚠️ 视频无法播放</div>
        <div class="v-videofail-msg"></div>
        <div class="v-videofail-actions">
          <a class="btn" target="_blank" rel="noopener">⬇️ 下载原片观看</a>
          <button class="btn" type="button">🔄 重试（刷新链接）</button>
        </div>`;
      const failMsg = fail.querySelector('.v-videofail-msg');
      const failDl = fail.querySelector('a');
      const failRetry = fail.querySelector('button');
      const showFail = (hevcSuspect) => {
        video.classList.remove('loading');
        video.style.visibility = 'hidden';
        fail.style.display = 'flex';
        failMsg.textContent = hevcSuspect
          ? '该视频很可能采用 H.265/HEVC 编码（iPhone 默认格式），当前浏览器无法解码。可下载到本地后用系统播放器观看。'
          : '视频加载失败，可能是网络问题或播放链接已过期（链接 15 分钟有效）。可重试或下载原片。';
      };
      video.addEventListener('loadeddata', () => { video.classList.remove('loading'); video.style.visibility = ''; });
      video.addEventListener('error', () => {
        // 仅在媒体源出错时弹遮罩（poster 加载失败不会设置 video.error）
        if (!video.error || !video.currentSrc) return;
        const hevcSuspect = video.error.code === 4 /* MEDIA_ERR_SRC_NOT_SUPPORTED */
          && !hevcPlayable()
          && /\.(mov|mp4|m4v)(\?|$)/i.test(video.currentSrc + ' ' + q.filename);
        showFail(hevcSuspect);
      });

      const rawUrl = q.url || await freshPhotoUrl(q);
      // 视频优先 H.264 代理（跨浏览器可播，解决 iPhone H.265/HEVC 黑屏）；无代理回退原片
      const src = (q.kind === 'video' && q.proxyUrl) ? q.proxyUrl : rawUrl;
      failDl.href = rawUrl;
      failDl.setAttribute('download', q.filename || 'video');
      failRetry.addEventListener('click', async () => {
        try {
          fail.style.display = 'none';
          video.style.visibility = '';
          video.classList.add('loading');
          delete q.url; delete q.proxyUrl;
          const fresh = await freshPhotoUrl(q);
          failDl.href = fresh;
          if (activeHls) { try { activeHls.destroy(); } catch { /* ignore */ } activeHls = null; }
          video.src = q.proxyUrl || fresh;
          video.load();
        } catch { showFail(false); }
      });

      // HLS 源（.m3u8）用 hls.js 播放，其余原生播放
      if (/\.m3u8(\?|$)/i.test(src)) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = src; // Safari 原生支持 HLS
        } else {
          try {
            const hls = await loadHlsJs();
            activeHls = hls;
            hls.loadSource(src);
            hls.attachMedia(video);
          } catch { video.src = src; }
        }
      } else {
        video.src = src;
      }

      // .mov / QuickTime 且本机不支持 HEVC：先给非阻断提示（已有 H.264 代理则无需提示）
      const isQuickTime = (q.contentType || '').includes('quicktime')
        || /\.mov$/i.test(q.filename || '');
      if (isQuickTime && !hevcPlayable() && !q.proxyUrl) {
        const hint = document.createElement('div');
        hint.className = 'v-videohint';
        hint.innerHTML = `iPhone 视频（H.265/HEVC）可能无法在此浏览器播放，若黑屏请 <a target="_blank" rel="noopener">下载原片</a> 观看`;
        hint.querySelector('a').href = src;
        hint.querySelector('a').setAttribute('download', q.filename || 'video.mov');
        wrap.appendChild(hint);
      }

      wrap.appendChild(video);
      wrap.appendChild(fail);
      mediaBox.appendChild(wrap);
    } else {
      // 大图加载期间用 ThumbHash 模糊占位铺底，加载完成后撤掉
      mediaBox.style.backgroundImage = '';
      mediaBox.style.minWidth = '';
      mediaBox.style.minHeight = '';
      if (q.thumbHash && window.ThumbHash) {
        try {
          const phUrl = window.ThumbHash.thumbHashToDataURL(thumbHashToBytes(q.thumbHash));
          mediaBox.style.backgroundImage = `url("${phUrl}")`;
          mediaBox.style.backgroundRepeat = 'no-repeat';
          mediaBox.style.backgroundPosition = 'center';
          mediaBox.style.backgroundSize = 'contain';
          // img 元数据到达前容器可能塌缩为 0，占位期间给个最小可视区
          mediaBox.style.minWidth = 'min(60vw, 480px)';
          mediaBox.style.minHeight = '40vh';
        } catch { /* 占位失败不影响原图 */ }
      }
      const img = document.createElement('img');
      img.className = 'loading';
      img.alt = '';
      img.fetchPriority = 'high';
      const clearPh = () => {
        mediaBox.style.backgroundImage = '';
        mediaBox.style.minWidth = '';
        mediaBox.style.minHeight = '';
      };
      img.addEventListener('load', () => { img.classList.remove('loading'); clearPh(); });
      img.addEventListener('error', () => { img.classList.remove('loading'); clearPh(); });
      img.src = q.url || await freshPhotoUrl(q);
      mediaBox.appendChild(img);
      prefetchViewerNeighbors(idx);
    }
    syncFavBtn();
  };

  // 同步网格中的收藏角标（时间线/搜索结果两处 DOM 都更新）
  const syncFavBadge = (q) => {
    document.querySelectorAll(`.photo-item[data-photo-id="${q.id}"]`).forEach((item) => {
      const exists = item.querySelector('.fav-badge');
      if (q.isFavorite && !exists) {
        const badge = document.createElement('span');
        badge.className = 'fav-badge';
        badge.title = '已收藏';
        badge.textContent = '★';
        item.appendChild(badge);
      } else if (!q.isFavorite && exists) {
        exists.remove();
      }
    });
  };

  let slideTimer = null;
  const stopSlideshow = () => {
    if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
    const btn = el.querySelector('[data-a="slideshow"]');
    if (btn) btn.textContent = '▶ 幻灯片';
  };
  const startSlideshow = () => {
    stopSlideshow();
    const btn = el.querySelector('[data-a="slideshow"]');
    if (btn) btn.textContent = '⏸ 暂停';
    slideTimer = setInterval(() => nav(1), 3500);
  };
  const toggleSlideshow = () => { slideTimer ? stopSlideshow() : startSlideshow(); };

  const close = () => {
    stopSlideshow();
    if (activeHls) { try { activeHls.destroy(); } catch { /* ignore */ } activeHls = null; }
    document.removeEventListener('keydown', onKey); el.remove();
  };
  const nav = (d) => {
    viewerIdx = (viewerIdx + d + currentPhotos.length) % currentPhotos.length;
    showAt(viewerIdx);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') nav(-1);
    if (e.key === 'ArrowRight') nav(1);
    if (e.key === ' ') { e.preventDefault(); toggleSlideshow(); }
  };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  el.querySelector('.v-close').addEventListener('click', close);
  el.querySelector('[data-a="close"]').addEventListener('click', close);
  el.querySelector('.v-prev')?.addEventListener('click', () => nav(-1));
  el.querySelector('.v-next')?.addEventListener('click', () => nav(1));
  el.querySelector('[data-a="slideshow"]')?.addEventListener('click', toggleSlideshow);
  el.querySelector('[data-a="cover"]')?.addEventListener('click', async (e) => {
    const q = currentPhotos[viewerIdx];
    const btn = e.target;
    try {
      btn.disabled = true;
      await api('PATCH', `/albums/${currentAlbumId}`, { coverPhotoId: q.id });
      currentCoverPhotoId = q.id;
      toast('已设为相册封面');
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
  });
  el.querySelector('[data-a="share-one"]')?.addEventListener('click', () => {
    const q = currentPhotos[viewerIdx];
    close();
    showShareModal(currentAlbumId, q.id);
  });
  el.querySelector('[data-a="retag"]')?.addEventListener('click', async (e) => {
    const q = currentPhotos[viewerIdx];
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = '重打中…';
    try {
      const r = await api('POST', '/admin/backfill-tags', { photoId: q.id }, q.albumId || currentAlbumId);
      if (r.done && r.tags) {
        q.tags = r.tags;
        el.querySelector('#v-info').innerHTML = viewerInfoHtml(q);
        toast(`已重打（今日额度剩 ${r.quotaLeft}）`);
      } else if (r.quotaExhausted || !r.quotaLeft) {
        toast('今日 AI 额度已用完，明天再试', true);
      } else {
        toast('重打失败，旧标签已保留（额度已退还）' + (r.reason ? '：' + r.reason : ''), true);
      }
    } catch (err) { toast(err.message, true); }
    btn.disabled = false;
    btn.textContent = '🔄 重打标签';
  });
  el.querySelector('[data-a="delete"]')?.addEventListener('click', async () => {
    const q = currentPhotos[viewerIdx];
    if (!await confirmModal('删除照片', `「${q.filename}」将移入回收站，10 天内可还原。`, '移入回收站', true)) return;
    try {
      await api('DELETE', `/photos/${q.id}`);
      document.querySelector(`.photo-item[data-photo-id="${q.id}"]`)?.remove();
      currentPhotos = currentPhotos.filter((x) => x.id !== q.id);
      selectedIds?.delete?.(q.id);
      toast('已移入回收站');
      if (!currentPhotos.length) { close(); render(); return; }
      if (viewerIdx >= currentPhotos.length) viewerIdx = currentPhotos.length - 1;
      nav(0); // 重新渲染当前位置（nav 会取模并刷新信息栏）
    } catch (err) { toast(err.message, true); }
  });
  el.querySelector('[data-a="idphoto"]')?.addEventListener('click', () => {
    const pid = currentPhotos[viewerIdx].id;
    close();
    location.hash = `#/idphoto?photo=${encodeURIComponent(pid)}&album=${currentAlbumId}`;
  });
  el.querySelector('[data-a="style"]')?.addEventListener('click', () => {
    const pid = currentPhotos[viewerIdx].id;
    close();
    location.hash = `#/style-transfer?photo=${encodeURIComponent(pid)}&album=${currentAlbumId}`;
  });
  el.querySelector('[data-a="bg"]')?.addEventListener('click', () => {
    const pid = currentPhotos[viewerIdx].id;
    close();
    location.hash = `#/bg-replace?photo=${encodeURIComponent(pid)}&album=${currentAlbumId}`;
  });
  el.querySelector('[data-a="download"]').addEventListener('click', async () => {
    // 桶配置 CORS 后，取 blob 触发真实下载；否则浏览器会直接打开原图
    const q = currentPhotos[viewerIdx];
    try {
      toast('开始下载…');
      // 加密照片：先本地解密再下载明文
      if (q.encrypted) {
        const { blobUrl, meta } = await encLoadOriginal(q, q.albumId || currentAlbumId);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = meta.filename || (q.kind === 'video' ? 'video' : 'photo');
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        return;
      }
      let url = q.url;
      if (!url) url = await freshPhotoUrl(q);
      const resp = await fetch(url);
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = q.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch { if (q.url) window.open(q.url, '_blank'); }
  });

  // 收藏切换（管理员或相册解锁游客；写入后同步按钮文案与网格角标）
  const favBtn = el.querySelector('[data-a="fav"]');
  function syncFavBtn() {
    if (!favBtn) return;
    favBtn.textContent = currentPhotos[viewerIdx]?.isFavorite ? '⭐ 已收藏' : '☆ 收藏';
  }
  favBtn?.addEventListener('click', async () => {
    const q = currentPhotos[viewerIdx];
    favBtn.disabled = true;
    try {
      const r = await api('POST', `/photos/${q.id}/favorite`,
        { value: !q.isFavorite }, q.albumId || currentAlbumId);
      q.isFavorite = r.isFavorite;
      syncFavBtn();
      syncFavBadge(q);
      toast(q.isFavorite ? '已加入收藏' : '已取消收藏');
    } catch (err) { toast(err.message, true); }
    favBtn.disabled = false;
  });

  // 照片备注（≤500 字，保存后即时刷新信息区）
  el.querySelector('[data-a="caption"]')?.addEventListener('click', () => {
    const q = currentPhotos[viewerIdx];
    promptModal('照片备注',
      `<div class="field"><label>给这张照片写一句故事</label>
       <textarea id="f-caption" rows="4" maxlength="500"
         placeholder="例如：这是爷爷 80 岁生日那天">${esc(q.caption || '')}</textarea></div>`,
      async (m) => {
        const caption = m.querySelector('#f-caption').value.trim();
        const r = await api('PATCH', `/photos/${q.id}`,
          { caption }, q.albumId || currentAlbumId);
        q.caption = r.caption;
        el.querySelector('#v-info').innerHTML = viewerInfoHtml(q);
        toast('备注已保存');
      }, '保存');
  });

  showAt(i);
}

// ==================== 视图：回收站（管理员） ====================

// 还原照片；原相册已删时弹出目标相册选择（后端返回 409 + albums）
async function restoreTrashPhoto(p) {
  let targetAlbumId = null;
  for (;;) {
    try {
      await api('POST', `/photos/${p.id}/restore`,
        targetAlbumId ? { targetAlbumId } : {});
      return true;
    } catch (err) {
      if (err.status !== 409 || !err.data?.albums?.length) throw err;
      // 原相册已删除：选择还原到哪个相册
      targetAlbumId = await pickRestoreAlbum(err.data.albums, p.filename);
      if (!targetAlbumId) return false; // 用户取消
    }
  }
}

function pickRestoreAlbum(albums, filename) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => { if (!settled) { settled = true; resolve(v); } };
    const m = openModal(`
      <h2>选择还原到的相册</h2>
      <div class="warn">「${esc(filename)}」原所在相册已被删除，请选择一个相册：</div>
      <div class="field">
        <select id="f-target">
          ${albums.map((a) => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}
        </select>
      </div>
      <div class="actions">
        <button class="btn" data-r="cancel">取消</button>
        <button class="btn primary" data-r="ok">还原到这里</button>
      </div>`);
    m.querySelector('[data-r="cancel"]').addEventListener('click', () => { closeModal(); finish(null); });
    m.querySelector('[data-r="ok"]').addEventListener('click', () => {
      const id = m.querySelector('#f-target').value;
      closeModal(); finish(id);
    });
    $modalRoot.querySelector('.modal-mask')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) finish(null);
    });
  });
}

async function renderTrash() {
  if (!isAdmin()) { location.hash = '#/albums'; return; }
  $view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api('GET', '/admin/trash');
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const { photos, count, totalSize, rules } = data;

  $view.innerHTML = `
    <div class="page-head">
      <h1>回收站</h1>
      <div class="page-actions">
        <a class="btn" href="#/albums">← 返回</a>
        ${count ? `<button class="btn danger" id="btn-empty-trash">清空回收站</button>` : ''}
      </div>
    </div>
    <div class="trash-summary">共 ${count} 张 · ${fmtSize(totalSize)}</div>
    <p class="trash-tip">自动清理规则：删除超过 ${rules.ageDays} 天，或回收站原图总量超过
      ${Math.round(rules.sizeLimit / 1024 / 1024)}MB 时，每天自动彻底清理。</p>
    ${count ? `<div class="photo-grid" id="trash-grid"></div>`
      : `<div class="empty">回收站是空的</div>`}`;

  document.getElementById('btn-empty-trash')?.addEventListener('click', async (e) => {
    if (!await confirmModal('清空回收站',
      `将彻底删除回收站内全部 ${count} 张照片（${fmtSize(totalSize)}），不可恢复！`, '全部彻底删除', true)) return;
    e.target.disabled = true;
    try {
      for (;;) {
        const r = await api('POST', '/admin/trash/empty');
        if (!r.remaining) break;
      }
      toast('回收站已清空');
      render();
    } catch (err) {
      e.target.disabled = false;
      toast(err.message, true);
    }
  });

  const grid = document.getElementById('trash-grid');
  if (!grid) return;
  for (const p of photos) {
    const item = document.createElement('div');
    item.className = 'photo-item trash-item';
    item.innerHTML = `
      <img src="${esc(p.thumbUrl)}" loading="lazy" decoding="async" alt="${esc(p.filename)}">
      <div class="trash-meta">
        <div class="trash-name" title="${esc(p.filename)}">${esc(p.filename)}</div>
        <div class="trash-sub">
          ${p.albumName ? esc(p.albumName) : '<span class="trash-deleted-tag">原相册已删除</span>'}
          · ${fmtSize(p.size)}<br>${esc(String(p.trashedAt ?? '').slice(0, 10))} 删除
        </div>
        <div class="trash-ops">
          <button class="btn small" data-op="restore">还原</button>
          <button class="btn small danger" data-op="purge">彻底删除</button>
        </div>
      </div>`;
    item.querySelector('[data-op="restore"]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        if (await restoreTrashPhoto(p)) {
          item.remove();
          toast('已还原');
        } else {
          e.target.disabled = false;
        }
      } catch (err) {
        e.target.disabled = false;
        toast(err.message, true);
      }
    });
    item.querySelector('[data-op="purge"]').addEventListener('click', async (e) => {
      if (!await confirmModal('彻底删除', `「${p.filename}」将从云端永久删除，不可恢复！`, '彻底删除', true)) return;
      e.target.disabled = true;
      try {
        await api('DELETE', `/photos/${p.id}`);
        item.remove();
        toast('已彻底删除');
      } catch (err) {
        e.target.disabled = false;
        toast(err.message, true);
      }
    });
    grid.appendChild(item);
  }
}

// ==================== 分享链接 ====================

function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  ta.remove();
  return Promise.resolve();
}

// 分享管理弹框：生成新链接（1/7/30 天）+ 已有链接列表（复制/撤销）
const SHARE_KIND_META = {
  album:   { icon: '🔗', label: '整相册' },
  photo:   { icon: '🖼', label: '单张' },
  collect: { icon: '📥', label: '求照片' },
};

// ---------- 分享二维码（qrcode-generator 按需加载，约 20KB） ----------

let qrLoading = null;
function loadQrCode() {
  if (window.qrcode) return Promise.resolve();
  if (!qrLoading) {
    qrLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/qrcode/qrcode.min.js';
      s.onload = () => (window.qrcode ? resolve() : reject(new Error('二维码组件初始化失败')));
      s.onerror = () => reject(new Error('二维码组件加载失败'));
      document.head.appendChild(s);
    });
  }
  return qrLoading;
}

async function showQrModal(url, label = '分享链接') {
  try {
    await loadQrCode();
  } catch (err) { toast(err.message, true); return; }
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  const m = openModal(`
    <h2>扫码打开 · ${esc(label)}</h2>
    <div class="qr-box">${qr.createSvgTag(6, 2)}</div>
    <div class="share-url qr-url">${esc(url)}</div>
    <p class="f-hint">用微信或手机相机扫码即可打开；求照片链接可投屏到现场屏幕，宾客扫码即传</p>
    <div class="actions">
      <button class="btn primary" data-r="ok">关闭</button>
    </div>`);
  m.querySelector('[data-r="ok"]').addEventListener('click', closeModal);
}

async function showShareModal(albumId, initialPhotoId = null) {
  const m = openModal(`
    <h2>分享</h2>
    <div class="field">
      <label>分享类型</label>
      <select id="f-kind">
        <option value="album">🔗 整相册：访客可浏览全部照片</option>
        <option value="photo">🖼 单张照片：只分享指定的一张</option>
        <option value="collect">📥 求照片：访客可匿名上传，不能浏览</option>
      </select>
    </div>
    <div class="field" id="photo-pick-field" hidden>
      <label>选择照片</label>
      <select id="f-photo"></select>
      <div class="f-hint">列出最近 100 张；更早的照片可在大图查看器点「分享这张」</div>
    </div>
    <div class="field">
      <label>有效期</label>
      <select id="f-days">
        <option value="1">1 天</option>
        <option value="7" selected>7 天</option>
        <option value="30">30 天</option>
      </select>
    </div>
    <div class="field">
      <label>访问密码（可选）</label>
      <input id="f-password" type="text" maxlength="64" placeholder="不填则拿到链接即可访问">
    </div>
    <div class="actions">
      <button class="btn" data-r="cancel">关闭</button>
      <button class="btn primary" id="btn-gen-share">生成链接</button>
    </div>
    <div id="share-list" class="share-list">加载中…</div>`);
  m.querySelector('[data-r="cancel"]').addEventListener('click', closeModal);

  const kindSel = m.querySelector('#f-kind');
  const photoField = m.querySelector('#photo-pick-field');
  const photoSel = m.querySelector('#f-photo');
  const daysSel = m.querySelector('#f-days');
  const pwInput = m.querySelector('#f-password');
  const listEl = m.querySelector('#share-list');

  let photoOptionsLoaded = false;

  if (initialPhotoId) {
    kindSel.value = 'photo';
    photoField.hidden = false;
  }

  kindSel.addEventListener('change', async () => {
    photoField.hidden = kindSel.value !== 'photo';
    if (kindSel.value === 'photo' && !photoOptionsLoaded) {
      photoSel.innerHTML = '<option>加载中…</option>';
      try {
        const d = await api('GET',
          `/albums/${albumId}/photos?limit=100`, null, albumId);
        photoSel.innerHTML = d.photos
          .map((p) => `<option value="${esc(p.id)}">${esc(p.filename)}</option>`).join('');
        photoOptionsLoaded = true;
        if (initialPhotoId) photoSel.value = initialPhotoId;
      } catch (err) {
        photoSel.innerHTML = `<option>${esc('加载失败：' + err.message)}</option>`;
      }
    }
  });
  if (initialPhotoId) kindSel.dispatchEvent(new Event('change'));

  function shareRow(s) {
    const meta = SHARE_KIND_META[s.kind] ?? SHARE_KIND_META.album;
    const row = document.createElement('div');
    row.className = 'share-row';
    row.innerHTML = `
      <div class="share-info">
        <div class="share-head">
          <span class="share-kind">${meta.icon} ${meta.label}</span>
          ${s.hasPassword ? '<span class="share-locked">🔒 需密码</span>' : ''}
        </div>
        ${s.kind === 'photo' && s.photoFilename
          ? `<div class="share-photo-name">${esc(s.photoFilename)}</div>` : ''}
        <div class="share-url" title="${esc(s.url)}">${esc(s.url)}</div>
        <div class="share-exp">${esc(String(s.expiresAt).slice(0, 10))} 到期</div>
      </div>
      <button class="btn small" data-op="qr">📱 二维码</button>
      <button class="btn small" data-op="copy">复制</button>
      <button class="btn small danger" data-op="revoke">撤销</button>`;
    row.querySelector('[data-op="qr"]').addEventListener('click', () => showQrModal(s.url, meta.label));
    row.querySelector('[data-op="copy"]').addEventListener('click', async (e) => {
      await copyText(s.url);
      e.target.textContent = '已复制';
      setTimeout(() => { e.target.textContent = '复制'; }, 1500);
    });
    row.querySelector('[data-op="revoke"]').addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        await api('DELETE', `/admin/shares/${s.id}`);
        row.remove();
        if (!listEl.querySelector('.share-row')) listEl.textContent = '暂无有效分享';
        toast('已撤销');
      } catch (err) {
        e.target.disabled = false;
        toast(err.message, true);
      }
    });
    return row;
  }

  async function reload() {
    try {
      const r = await api('GET', `/admin/shares?albumId=${encodeURIComponent(albumId)}`);
      listEl.innerHTML = '';
      if (!r.shares.length) {
        listEl.textContent = '暂无有效分享';
        return;
      }
      for (const s of r.shares) listEl.appendChild(shareRow(s));
    } catch (err) {
      listEl.textContent = err.message;
    }
  }

  m.querySelector('#btn-gen-share').addEventListener('click', async (e) => {
    const kind = kindSel.value;
    if (kind === 'photo' && (!photoSel.value || photoOptionsLoaded === false)) {
      toast('请先选择要分享的照片', true);
      return;
    }
    const payload = { albumId, kind, days: Number(daysSel.value) };
    if (kind === 'photo') payload.photoId = photoSel.value;
    const pw = pwInput.value.trim();
    if (pw) payload.password = pw;
    e.target.disabled = true;
    try {
      const r = await api('POST', '/admin/shares', payload);
      await copyText(r.url);
      toast('链接已生成并复制');
      await reload();
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });

  await reload();
}

// ==================== 视图：分享页（整相册 / 单张 / 求照片） ====================

async function renderShare(shareId) {
  if (infiniteObserver) { infiniteObserver.disconnect(); infiniteObserver = null; }
  shareMode = true;
  collectMode = false;
  $view.innerHTML = `<div class="empty">加载中…</div>`;

  let data;
  try {
    data = await api('GET', `/share/${encodeURIComponent(shareId)}`);
  } catch (err) {
    if (err.status === 401 && err.data?.needsPassword) {
      renderSharePassword(shareId, err.data.kind, null);
      return;
    }
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  await bootShare(data);
}

// 需要访问密码的分享：密码输入页
function renderSharePassword(shareId, kind, lastError) {
  const title = kind === 'collect' ? '求照片' : '分享相册';
  $view.innerHTML = `
    <div class="page-head"><h1>🔒 ${esc(title)}</h1></div>
    <form id="share-pw-form" class="share-pw-form">
      <p style="color:var(--muted)">请输入访问密码：</p>
      ${lastError ? `<p class="form-err">${esc(lastError)}</p>` : ''}
      <input id="share-pw" type="password" maxlength="64" autocomplete="off" required autofocus>
      <button class="btn primary" type="submit">进入</button>
    </form>`;
  $view.querySelector('#share-pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = $view.querySelector('#share-pw').value;
    try {
      const data = await api('POST', `/share/${encodeURIComponent(shareId)}`, { password });
      await bootShare(data);
    } catch (err) {
      if (err.status === 401 && err.data?.needsPassword) {
        renderSharePassword(shareId, err.data.kind, err.message);
      } else {
        toast(err.message, true);
      }
    }
  });
}

// 已拿到有效分享数据：token 落槽，按 kind 分流渲染
async function bootShare(data) {
  // 分享 token 存入 unlock 槽位：api() 会自动以 Bearer 携带
  saveToken(sessionStorage, 'unlock_' + data.album.id, data.token, data.expiresIn);
  currentAlbumId = data.album.id;
  currentPhotos = [];
  currentCoverPhotoId = null;

  if (data.kind === 'collect') {
    renderCollectPage(data);
    return;
  }

  // album / photo 复用同一套网格（photo 时后端只返回被分享的一张）
  let list;
  try {
    list = await api('GET',
      `/albums/${data.album.id}/photos?limit=${ALBUM_PAGE_SIZE}`, null, data.album.id);
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  pageState = { cursor: list.nextCursor, loading: false, hasMore: !!list.nextCursor };

  $view.innerHTML = `
    <div class="page-head">
      <h1>${esc(data.album.name)}
        <span class="lock" style="vertical-align:3px">${data.kind === 'photo' ? '分享照片' : '分享链接'}</span>
      </h1>
      ${data.kind === 'album' && list.photos.length
        ? '<div class="page-actions"><button class="btn" id="btn-fav-only">⭐ 只看收藏</button></div>' : ''}
    </div>
    ${data.album.description ? `<p style="color:var(--muted);font-size:14px;margin-bottom:14px">${esc(data.album.description)}</p>` : ''}
    ${data.kind === 'album' ? albumSearchHtml() : ''}
    ${list.photos.length ? `
      <div id="photo-area"></div>
      <div id="page-sentinel" class="page-sentinel"></div>
      <div id="page-status" class="page-status"></div>`
      : `<div class="empty">这个相册还没有照片</div>`}`;

  if (list.photos.length) {
    currentPhotos.push(...list.photos);
    buildPhotoArea();
    addPhotoItems(list.photos, false, 8); // 只读：无删除按钮
    if (pageState.hasMore) setupInfiniteLoad();
  }
  if (data.kind === 'album') {
    bindAlbumSearch(data.album.id);
    bindFavOnlyBtn(data.album.id);
  }
}

// 求照片页：只提供上传，不展示任何已有照片
function renderCollectPage(data) {
  collectMode = true;
  shareMode = false;
  $view.innerHTML = `
    <div class="page-head">
      <h1>📥 ${esc(data.album.name)}</h1>
    </div>
    <p class="collect-sub">${data.album.description
      ? esc(data.album.description) : '主人邀请你向这个相册上传照片'}</p>
    <div class="collect-drop" id="collect-drop">
      <label class="btn primary" style="cursor:pointer">
        选择照片或视频
        <input id="collect-input" type="file"
          accept="image/*,video/mp4,video/webm,video/quicktime,video/x-m4v" multiple hidden>
      </label>
      <div class="collect-hint">也可以把文件拖到页面任意位置；视频单文件建议 ≤500MB</div>
    </div>
    <div id="upload-progress"></div>`;
  const input = $view.querySelector('#collect-input');
  input.addEventListener('change', () => {
    const files = [...input.files];
    if (files.length) uploadFiles(data.album.id, files);
    input.value = '';
  });
}

// ==================== 视图：往年今日 ====================

async function renderOnThisDay() {
  $view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api('GET', '/on-this-day');
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  // 跨相册页：currentAlbumId 置空，照片带各自 albumId
  currentAlbumId = null;
  currentPhotos = data.photos;
  currentCoverPhotoId = null;
  viewerCrossAlbum = true;

  $view.innerHTML = `
    <div class="page-head">
      <h1>📅 往年今日</h1>
      <div class="page-actions"><a class="btn" href="#/albums">← 返回</a></div>
    </div>
    ${data.photos.length ? `
      <p class="collect-sub">历史上的 ${esc(data.todayMmDd)} · ${data.photos.length} 张照片</p>
      <div class="photo-grid" id="photo-grid"></div>`
      : `<div class="empty">往年今日没有照片——有照片后这里会自动出现</div>`}`;

  const grid = document.getElementById('photo-grid');
  if (grid) {
    data.photos.forEach((p, i) => grid.appendChild(createPhotoItem(p, isAdmin(), i < 8)));
  }
}

// 动态加载 hls.js（仅播放 .m3u8 时按需加载）
let _hlsPromise = null;
function loadHlsJs() {
  if (_hlsPromise) return _hlsPromise.then((Hls) => new Hls());
  _hlsPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://unpkg.com/hls.js@1.5.13/dist/hls.min.js';
    s.onload = () => (window.Hls ? resolve(window.Hls) : reject(new Error('hls.js 加载失败')));
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return _hlsPromise.then((Hls) => new Hls());
}

// 探测当前浏览器是否能硬解 HEVC/H.265（iPhone 默认视频编码）
let _hevc = null;
function hevcPlayable() {
  if (_hevc !== null) return _hevc;
  const v = document.createElement('video');
  _hevc = ['hvc1.1.6.L93.B0', 'hvc1.2.4.L153.B0', 'hev1.1.6.L93.B0']
    .some((c) => {
      const r = v.canPlayType(`video/mp4; codecs="${c}"`);
      return r === 'probably' || r === 'maybe';
    });
  return _hevc;
}

// ==================== 视图：智能相册（旅行/事件聚类） ====================

// 事件列表：按拍摄时间自动聚类（后端 12 小时间隔切分）
async function renderSmart() {
  $view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api('GET', '/smart/events');
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const events = data.events || [];
  $view.innerHTML = `
    <div class="page-head">
      <h1>✨ 智能相册</h1>
      <div class="page-actions"><a class="btn" href="#/albums">← 返回相册</a></div>
    </div>
    <p class="collect-sub">按拍摄时间自动聚类的「旅行 / 事件」：相邻照片间隔超过 12 小时即分段</p>
    ${events.length
      ? `<div class="album-grid" id="smart-grid"></div>`
      : `<div class="empty">暂无可聚类的事件（需同一时间段内至少 2 张照片）</div>`}`;

  const grid = document.getElementById('smart-grid');
  if (!grid) return;
  for (const e of events) {
    const card = document.createElement('div');
    card.className = 'album-card';
    const coverHtml = e.thumbUrl
      ? `${e.thumbAvifUrl
          ? `<picture><source type="image/avif" srcset="${esc(e.thumbAvifUrl)}">`
          : ''}<img class="album-cover" src="${esc(e.thumbUrl)}" loading="lazy" decoding="async" alt="">${e.thumbAvifUrl ? '</picture>' : ''}`
      : `<div class="album-cover placeholder">📷</div>`;
    const startDay = fmtDateHeader(e.start.slice(0, 10));
    const endDay = e.end.slice(0, 10);
    const range = endDay !== e.start.slice(0, 10)
      ? `${startDay} 至 ${fmtDateHeader(endDay)}` : startDay;
    card.innerHTML = `
      <div class="album-cover-wrap">${coverHtml}</div>
      <div class="album-info">
        <h3>${esc(range)}</h3>
        <div class="meta">${e.count} 张照片${e.centerLat ? ' · 📍 含地点' : ''}</div>
      </div>`;
    card.addEventListener('click', () => {
      location.hash = `#/smart?start=${encodeURIComponent(e.start)}&end=${encodeURIComponent(e.end)}`;
    });
    grid.appendChild(card);
  }
}

// 事件内照片网格（复用 createPhotoItem / 查看器，跨相册只读）
async function renderSmartPhotos(start, end, albumId) {
  viewerCrossAlbum = true;
  $view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api('GET', `/smart/photos?start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&albumId=${encodeURIComponent(albumId)}`);
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const photos = data.photos || [];
  $view.innerHTML = `
    <div class="page-head">
      <h1>✨ 事件照片</h1>
      <div class="page-actions"><a class="btn" href="#/smart">← 智能相册</a></div>
    </div>
    <div id="photo-area"><div class="photo-grid" id="photo-grid"></div></div>`;
  currentPhotos = photos;
  const grid = document.getElementById('photo-grid');
  if (grid) photos.forEach((p, i) => grid.appendChild(createPhotoItem(p, isAdmin(), i < 8)));
}

// ==================== 视图：地图 ====================
let _mapLoaded = false;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (_mapLoaded) return _mapLoaded;
  _mapLoaded = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet';
    css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
    document.head.appendChild(css);
    const js = document.createElement('script');
    js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
    js.onload = () => resolve();
    js.onerror = reject;
    document.head.appendChild(js);
  });
  return _mapLoaded;
}

async function renderMap() {
  $view.innerHTML = `
    <div class="page-head">
      <h1>🗺️ 地图</h1>
      <div class="page-actions"><a class="btn" href="#/albums">← 返回</a></div>
    </div>
    <div id="map" style="height: calc(100vh - 140px); min-height: 400px; border-radius: 12px; z-index: 0;"></div>`;
  currentAlbumId = null;
  let data;
  try {
    data = await api('GET', '/photos/geo');
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const photos = data.photos || [];
  currentPhotos = photos;
  viewerCrossAlbum = true;

  if (!photos.length) {
    $view.innerHTML += `<div class="empty" style="margin-top:1rem">没有带 GPS 坐标的照片</div>`;
    return;
  }
  try {
    await loadLeaflet();
  } catch {
    $view.innerHTML = `<div class="empty">地图库加载失败，请检查网络</div>`;
    return;
  }

  const map = L.map('map');
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© OpenStreetMap',
    maxZoom: 19,
  }).addTo(map);

  const bounds = [];
  photos.forEach((p, i) => {
    const marker = L.marker([p.lat, p.lng]).addTo(map);
    bounds.push([p.lat, p.lng]);
    const thumb = p.thumbUrl
      ? `<img src="${esc(p.thumbUrl)}" style="width:120px;height:120px;object-fit:cover;border-radius:6px;cursor:pointer" data-idx="${i}">`
      : '';
    marker.bindPopup(`
      <div style="text-align:center;min-width:130px">
        ${thumb}
        <div style="margin-top:6px;font-size:12px;color:#555">${esc(p.albumName || '')}</div>
        ${p.takenAt ? `<div style="font-size:11px;color:#888">${esc(p.takenAt.slice(0, 10))}</div>` : ''}
      </div>`);
    marker.on('popupopen', () => {
      const img = marker.getPopup().getElement()?.querySelector('img');
      if (img) img.onclick = () => openViewer(parseInt(img.dataset.idx, 10));
    });
  });
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40] });
}

// ==================== 视图：重复照片检测（管理员） ====================
async function renderDuplicates() {
  if (!isAdmin()) {
    $view.innerHTML = `<div class="empty">需要管理员登录</div>`;
    return;
  }
  $view.innerHTML = `
    <div class="page-head">
      <h1>🔁 重复照片</h1>
      <div class="page-actions"><a class="btn" href="#/albums">← 返回</a></div>
    </div>
    <div class="empty">分析中…（仅检查已上传并带有 dHash 的照片）</div>`;
  currentAlbumId = null;
  let data;
  try {
    data = await api('GET', '/duplicates');
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  const groups = data.groups || [];
  if (!groups.length) {
    $view.innerHTML = `
      <div class="page-head">
        <h1>🔁 重复照片</h1>
        <div class="page-actions"><a class="btn" href="#/albums">← 返回</a></div>
      </div>
      <div class="empty">没有发现相似照片 ✨</div>`;
    return;
  }
  // 收集所有照片供查看器使用
  const all = groups.flat();
  currentPhotos = all;
  viewerCrossAlbum = true;

  let html = `
    <div class="page-head">
      <h1>🔁 重复照片</h1>
      <div class="page-actions"><a class="btn" href="#/albums">← 返回</a></div>
    </div>
    <p class="collect-sub">共 ${groups.length} 组相似照片（dHash 汉明距离 < 8）</p>`;
  groups.forEach((g, gi) => {
    html += `<div style="margin: 1rem 0; padding: 1rem; background: var(--bg-soft, #f5f5f5); border-radius: 12px;">
      <div style="font-weight: 600; margin-bottom: 0.5rem;">第 ${gi + 1} 组 · ${g.length} 张</div>
      <div class="photo-grid" style="grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));">`;
    g.forEach((p) => {
      const idx = all.indexOf(p);
      html += `
        <div class="photo-item" data-idx="${idx}" style="cursor:pointer">
          ${p.thumbUrl ? `<img src="${esc(p.thumbUrl)}" loading="lazy" decoding="async">` : '<div class="ph-empty">无缩略图</div>'}
          <div class="ph-name" title="${esc(p.filename)}">${esc(p.filename)}</div>
          <div class="ph-sub">${esc(p.albumName || '')}</div>
        </div>`;
    });
    html += `</div></div>`;
  });
  $view.innerHTML = html;
  $view.querySelectorAll('.photo-item').forEach((el) => {
    el.onclick = () => openViewer(parseInt(el.dataset.idx, 10));
  });
}

// ==================== 视图：用量统计（管理员） ====================

async function renderStats() {
  if (!isAdmin()) {
    $view.innerHTML = `<div class="empty">需要管理员登录</div>`;
    return;
  }
  $view.innerHTML = `<div class="empty">加载中…</div>`;
  let data;
  try {
    data = await api('GET', '/admin/stats');
  } catch (err) {
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  currentAlbumId = null;
  currentPhotos = [];
  const t = data.totals;
  const q = data.quota;
  const pct = q.usagePercent;
  const barClass = pct >= 90 ? 'danger' : pct >= 70 ? 'warn' : '';

  // D1 免费额度：读 500 万行/天、写 10 万行/天（UTC 自然日重置）；每月为当月累计，无月度上限
  const d1 = data.d1;
  const fmtNum = (n) => (n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + ' 万' : String(n));
  const d1Bar = (label, used, limit) => {
    const p = Math.min(100, Math.round((used / limit) * 100));
    const cls = p >= 90 ? 'danger' : p >= 70 ? 'warn' : '';
    return `
      <div class="quota-bar-row">
        <div class="quota-bar-label">${label} <span class="quota-bar-nums">${fmtNum(used)} / ${fmtNum(limit)}</span></div>
        <div class="quota-bar-wrap">
          <div class="quota-bar"><div class="quota-bar-fill ${cls}" style="width:${p}%"></div></div>
          <div class="quota-bar-text">${p}%</div>
        </div>
      </div>`;
  };

  const statCard = (label, value, sub = '') => `
    <div class="stat-card">
      <div class="stat-card-value">${esc(value)}</div>
      <div class="stat-card-label">${esc(label)}</div>
      ${sub ? `<div class="stat-card-sub">${esc(sub)}</div>` : ''}
    </div>`;

  $view.innerHTML = `
    <div class="page-head">
      <h1>📊 用量统计</h1>
      <div class="page-actions"><a class="btn" href="#/albums">← 返回</a></div>
    </div>

    <div class="quota-card">
      <div class="quota-info">
        <div class="quota-title">R2 存储空间 <span class="quota-tag">免费 10 GB</span></div>
        <div class="quota-desc">
          已用 <b>${esc(fmtSize(q.usedBytes))}</b> · 剩余 <b>${esc(fmtSize(q.remainBytes))}</b> · 占用 ${pct}%
        </div>
      </div>
      <div class="quota-bar-wrap">
        <div class="quota-bar">
          <div class="quota-bar-fill ${barClass}" style="width:${pct}%"></div>
        </div>
        <div class="quota-bar-text">${pct}%</div>
      </div>
      <a class="btn btn-upgrade" href="https://dash.cloudflare.com/?to=/:account/r2/plans" target="_blank" rel="noopener">⚡ 立即扩容</a>
    </div>

    <div class="quota-card">
      <div class="quota-info">
        <div class="quota-title">D1 数据库 <span class="quota-tag">免费版·按天重置</span></div>
        <div class="quota-desc">
          本月累计 读 <b>${fmtNum(d1.monthRead)}</b> 行 · 写 <b>${fmtNum(d1.monthWritten)}</b> 行
          <br>自统计口径（部署后起计），与官方账单可能略有出入
        </div>
      </div>
      <div class="quota-bars">
        ${d1Bar('今日读行数（UTC ' + esc(d1.date) + '）', d1.todayRead, d1.readLimit)}
        ${d1Bar('今日写行数', d1.todayWritten, d1.writeLimit)}
      </div>
      <a class="btn btn-upgrade" href="https://dash.cloudflare.com/?to=/:account/workers/plans" target="_blank" rel="noopener">⚡ 立即扩容</a>
    </div>

    <div class="stat-cards">
      ${statCard('照片总数', t.photos, `其中视频 ${t.videos} 个`)}
      ${statCard('存储用量', fmtSize(t.bytes), 'R2 实际占用（含缩略图）')}
      ${statCard('相册数量', t.albums)}
      ${statCard('回收站', t.trashed, '未打标签 ' + t.untagged + ' 张')}
    </div>
    <h3 class="stat-section-title">各相册用量</h3>
    <table class="stat-table">
      <thead>
        <tr><th>相册</th><th class="num">照片</th><th class="num">视频</th><th class="num">用量</th></tr>
      </thead>
      <tbody>
        ${data.byAlbum.map((r) => `
          <tr>
            <td><a href="#/album/${encodeURIComponent(r.albumId)}">${esc(r.name)}</a></td>
            <td class="num">${r.photos}</td>
            <td class="num">${r.videos}</td>
            <td class="num">${fmtSize(r.bytes)}</td>
          </tr>`).join('')}
      </tbody>
    </table>

    <div class="quota-card">
      <div class="quota-info">
        <div class="quota-title">🔍 语义检索索引 <span class="quota-tag">bge-m3 中文模型</span></div>
        <div class="quota-desc">
          升级模型后需重建一次：用新视觉模型补生成「画面描述句」，并按 bge-m3 重算全部照片向量。
          全局覆盖式重打，每批 20 张，受每日 AI 额度限制，可跨天继续。
        </div>
        <div id="rebuild-tip" class="quota-desc" style="margin-top:8px"></div>
      </div>
      <button class="btn btn-upgrade" id="btn-rebuild-emb">🔄 重建语义索引</button>
    </div>`;

  document.getElementById('btn-rebuild-emb')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const tip = document.getElementById('rebuild-tip');
    const ok = await confirmModal(
      '重建语义索引',
      '将用新模型覆盖全部已有标签并补生成画面描述句、重算 bge-m3 向量；每张消耗今日 AI 额度（每天最多 200 张，可分多天完成）。未打标签的照片不受影响。确定继续？',
      '开始重建', true
    );
    if (!ok) return;
    btn.disabled = true;
    const since = new Date().toISOString();
    let batches = 0, done = 0, failed = 0, total = 0;
    try {
      for (;;) {
        const r = await api('POST', '/admin/backfill-tags', { limit: 20, mode: 'retag', since });
        batches++;
        done += r.done; failed += r.failed || 0;
        total = Math.max(total, done + failed + r.remaining);
        renderAiProgress(tip, { action: '本批重算', total, done, failed, remaining: r.remaining, quotaLeft: r.quotaLeft, failReasons: r.failReasons });
        if (r.quotaExhausted) { toast('今日 AI 额度已用尽，明天可继续重建'); break; }
        if (r.remaining <= 0) { toast('语义索引重建完成'); break; }
        if (batches >= 10) { toast('已连续重算 200 张，今天先到这，明天可继续'); break; }
      }
    } catch (err) {
      toast('重建中断：' + err.message, true);
    } finally {
      btn.disabled = false;
    }
  });
}

// ==================== 打包下载（JSZip CDN，UMD 全局 JSZip） ====================

// 打包当前已加载照片为 zip：并发 3 抓取原图（URL 15 分钟有效，随用随换）
async function zipDownload(albumName, btn) {
  if (typeof JSZip !== 'function') { toast('打包组件未加载（CDN），请稍后再试', true); return; }
  const photos = currentPhotos;
  if (!photos.length) { toast('没有可下载的照片', true); return; }
  const scope = searchState.favoriteOnly ? '收藏的'
    : searchState.active ? '搜索结果中的' : '已加载的';
  if (!await confirmModal('打包下载',
    `将把当前${scope} ${photos.length} 张照片打包为 zip${searchState.active ? '' : '（向下滚动可加载更多）'}。`, '开始打包')) return;
  btn.disabled = true;
  const tip = document.getElementById('backfill-tip');
  tip.style.display = '';
  const zip = new JSZip();
  let idx = 0, ok = 0;
  try {
    async function worker() {
      for (;;) {
        const i = idx++;
        if (i >= photos.length) return;
        const p = photos[i];
        try {
          const url = await freshPhotoUrl(p);
          const resp = await fetch(url);
          if (!resp.ok) throw new Error('HTTP ' + resp.status);
          zip.file(p.filename || (p.id + '.jpg'), await resp.blob());
          ok++;
        } catch { /* 单张失败跳过，不打断整包 */ }
        tip.textContent = `打包中… ${ok}/${photos.length}`;
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    if (!ok) throw new Error('没有照片下载成功');
    tip.textContent = '正在生成 zip…';
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${albumName}-${new Date().toISOString().slice(0, 10)}.zip`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(`打包完成（${ok} 张）`);
  } catch (err) {
    toast('打包失败：' + err.message, true);
  } finally {
    tip.style.display = 'none';
    tip.textContent = '';
    btn.disabled = false;
  }
}

// ==================== 拖拽上传 ====================

let dragDepth = 0;

function initDragDrop() {
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  document.addEventListener('dragenter', (e) => {
    if (!canEditAlbum()) return;
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    e.preventDefault();
    if (++dragDepth === 1) document.body.classList.add('dragging');
  });
  document.addEventListener('dragleave', () => {
    if (dragDepth > 0 && --dragDepth === 0) document.body.classList.remove('dragging');
  });
  document.addEventListener('drop', (e) => {
    const can = canEditAlbum();
    document.body.classList.remove('dragging');
    dragDepth = 0;
    e.preventDefault();
    if (!can) return;
    const files = [...(e.dataTransfer?.files ?? [])]
      .filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/')
        || /\.(heic|heif)$/i.test(f.name));
    if (files.length) uploadFiles(currentAlbumId, files);
  });
}

// ==================== 路由 ====================

async function render() {
  disconnectRecycleObserver(); // 离开照片网格类页面：释放观察器对旧节点的引用
  // 清理可能残留的多选 UI（批量成功后 finishBatch 已清，这里兜底）
  if (selectMode) {
    selectMode = false;
    selectedIds.clear();
    document.querySelectorAll('.photo-item').forEach((el) => {
      el.classList.remove('selecting', 'selected');
      el.querySelector('.pick-check')?.remove();
    });
  }
  document.getElementById('select-bar')?.remove();
  renderAuthArea();
  currentAlbumId = null; // 各页面自行赋值；防止离开相册页后拖拽误传
  const hash = location.hash || '#/albums';
  if (hash.startsWith('#/idphoto')) {
    renderIdPhoto();
    return;
  }
  if (hash.startsWith('#/style-transfer')) {
    renderStyleTransfer();
    return;
  }
  if (hash.startsWith('#/bg-replace')) {
    renderBgReplace();
    return;
  }
  if (hash.startsWith('#/trash')) {
    renderTrash();
    return;
  }
  if (hash.startsWith('#/on-this-day')) {
    renderOnThisDay();
    return;
  }
  if (hash.startsWith('#/map')) {
    renderMap();
    return;
  }
  if (hash.startsWith('#/smart')) {
    const qp = new URLSearchParams(hash.slice(hash.indexOf('?') + 1));
    if (qp.get('start') && qp.get('end')) {
      renderSmartPhotos(qp.get('start'), qp.get('end'), qp.get('albumId') || '');
    } else {
      renderSmart();
    }
    return;
  }
  if (hash.startsWith('#/duplicates')) {
    renderDuplicates();
    return;
  }
  if (hash.startsWith('#/stats')) {
    renderStats();
    return;
  }
  const sm = hash.match(/^#\/share\/([0-9a-f]+)/i);
  if (sm) { await renderShare(sm[1]); return; }
  shareMode = false;
  collectMode = false;
  viewerCrossAlbum = false;
  const m = hash.match(/^#\/album\/([0-9a-f-]+)/i);
  if (m) await renderAlbum(m[1]);
  else await renderAlbums();
}

window.addEventListener('hashchange', render);
initTheme();
initDragDrop();
render();

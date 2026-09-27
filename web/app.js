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

// ==================== API 调用 ====================

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
    });
  } catch {
    throw { status: 0, message: '网络错误：请检查 config.js 里的 Worker 地址' };
  }
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok || data.ok === false) {
    // 错误对象附带完整响应体（如还原接口 409 时的可选相册列表）
    throw { status: resp.status, message: data.error || '请求失败(' + resp.status + ')', data };
  }
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
    </div>`, async (m) => {
    const pw = m.querySelector('#f-pw').value;
    const r = await api('POST', '/login', { password: pw });
    saveToken(localStorage, ADMIN_KEY, r.token, r.expiresIn);
    renderAuthArea(); render();
    toast('已登录');
  }, '登录');
  m.querySelector('#f-pw').focus();
}

function showUnlockModal(albumId, albumName) {
  const m = promptModal(`输入「${albumName}」的密码`, `
    <div class="field">
      <input class="pw" id="f-pw" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
    </div>`, async (m) => {
    const pw = m.querySelector('#f-pw').value;
    if (!/^\d{6}$/.test(pw)) throw { message: '请输入6位数字密码' };
    const r = await api('POST', `/albums/${albumId}/unlock`, { password: pw });
    saveToken(sessionStorage, 'unlock_' + albumId, r.token, r.expiresIn);
    location.hash = '#/album/' + albumId;
    render();
  }, '解锁');
  m.querySelector('#f-pw').focus();
}

// 工具页（证件照 / 换风格）使用的相册解锁：弹密码框，成功后只存 token 并 resolve(true)，不跳转；取消返回 false
function promptAlbumPassword(albumId, albumName) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const m = promptModal(`输入「${albumName}」的密码`, `
      <div class="field">
        <input class="pw" id="f-pw" type="tel" inputmode="numeric" maxlength="6" placeholder="••••••" autocomplete="off">
      </div>`, async (mm) => {
      const pw = mm.querySelector('#f-pw').value;
      if (!/^\d{6}$/.test(pw)) throw { message: '请输入6位数字密码' };
      const r = await api('POST', `/albums/${albumId}/unlock`, { password: pw });
      saveToken(sessionStorage, 'unlock_' + albumId, r.token, r.expiresIn);
      finish(true);
    }, '解锁');
    m.querySelector('[data-r="cancel"]').addEventListener('click', () => finish(false));
    $modalRoot.querySelector('.modal-mask').addEventListener('click', (e) => {
      if (e.target === e.currentTarget) finish(false);
    });
    m.querySelector('#f-pw').focus();
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
          <a class="btn" href="#/stats">📊 用量统计</a>
          <a class="btn" href="#/idphoto">证件照工具</a>
          <a class="btn" href="#/style-transfer">🎨 照片换风格</a>
          <a class="btn" href="#/bg-replace">🖼️ 更换背景</a>
          <button class="btn primary" id="btn-new-album">+ 新建相册</button>` : `
          <a class="btn" href="#/on-this-day">📅 往年今日</a>
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
        ? `<img class="album-cover" src="${esc(a.coverUrl)}" loading="lazy" alt="">`
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
  if (a.locked && !isAdmin() && !getUnlockToken(a.id)) showUnlockModal(a.id, a.name);
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
  const m = promptModal(album ? '编辑相册' : '新建相册', `
    <div class="field">
      <label>相册名（事件/主题）</label>
      <input id="f-name" maxlength="100" placeholder="例：2026 婺源春游" value="${esc(album?.name ?? '')}">
    </div>
    <div class="field">
      <label>描述（可选）</label>
      <textarea id="f-desc" rows="2" maxlength="500" placeholder="一句话介绍">${esc(album?.description ?? '')}</textarea>
    </div>`, async (m) => {
    const name = m.querySelector('#f-name').value.trim();
    const desc = m.querySelector('#f-desc').value.trim();
    if (!name) throw { message: '请填写相册名' };
    if (album) {
      await api('PATCH', `/albums/${album.id}`, { name, description: desc });
      toast('已保存');
    } else {
      await api('POST', '/albums', { name, description: desc });
      toast('相册已创建');
    }
    render();
  }, album ? '保存' : '创建');
  m.querySelector('#f-name').focus();
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
let searchTerm = '';   // 相册内标签/文件名搜索词
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
  const wrap = document.getElementById('photo-area');
  if (!wrap) return;
  if (albumGroupMode === 'date') {
    wrap.innerHTML = `<div id="photo-groups"></div>`;
  } else {
    wrap.innerHTML = `<div class="photo-grid" id="photo-grid"></div>`;
  }
}

// 单个照片元素（平铺与分组共用，保证行为一致）
function createPhotoItem(p, admin) {
  const item = document.createElement('div');
  item.className = 'photo-item' + (p.kind === 'video' ? ' is-video' : '')
    + (selectMode ? ' selecting' : '');
  item.dataset.photoId = p.id;
  item.innerHTML = `
    <img src="${esc(p.thumbUrl)}" loading="lazy" alt="${esc(p.filename)}">
    ${selectMode ? '<span class="pick-check"></span>' : ''}
    ${p.kind === 'video' ? `<span class="video-badge">▶${p.duration ? '<i>' + esc(fmtDuration(p.duration)) + '</i>' : ''}</span>` : ''}
    ${admin ? '<button class="del" title="删除">×</button>' : ''}`;
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
    if (!await confirmModal('删除照片', `「${p.filename}」将移入回收站，10 天内可还原。`, '移入回收站', true)) return;
    try {
      await api('DELETE', `/photos/${p.id}`);
      item.remove();
      currentPhotos = currentPhotos.filter((x) => x.id !== p.id);
      toast('已移入回收站');
    } catch (err) { toast(err.message, true); }
  });
  return item;
}

// 追加照片：平铺直接入网格；按日期找/建对应日期分组（列表为时间倒序，新日期组在底部）
function addPhotoItems(photos, admin) {
  if (albumGroupMode === 'flat') {
    const grid = document.getElementById('photo-grid');
    if (!grid) return;
    for (const p of photos) grid.appendChild(createPhotoItem(p, admin));
    return;
  }
  const groups = document.getElementById('photo-groups');
  if (!groups) return;
  for (const p of photos) {
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
    group.querySelector('.photo-grid').appendChild(createPhotoItem(p, admin));
  }
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

// 当前搜索词过滤后的照片（标签/文件名，不区分大小写）
function filteredPhotos() {
  const term = searchTerm.trim().toLowerCase();
  if (!term) return currentPhotos;
  return currentPhotos.filter((p) =>
    p.filename.toLowerCase().includes(term) ||
    (p.tags ?? []).some((t) => t.toLowerCase().includes(term)));
}

// 重建照片容器并按当前搜索词渲染（无限滚动追加后也走这里，保证过滤不丢）
function rerenderPhotoArea() {
  buildPhotoArea();
  addPhotoItems(filteredPhotos(), isAdmin());
  const note = document.getElementById('search-note');
  if (note) {
    const term = searchTerm.trim();
    note.textContent = term && pageState.hasMore
      ? '仅搜索了已加载的照片，滚动到底加载更多后可继续匹配' : '';
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
      // 解锁 token 缺失/过期 → 重新输密码
      sessionStorage.removeItem('unlock_' + albumId);
      const nameMatch = location.hash.match(/[?&]name=([^&]*)/);
      const name = nameMatch ? decodeURIComponent(nameMatch[1]) : '该相册';
      showUnlockModal(albumId, name);
      $view.innerHTML = `<div class="empty">此相册已上锁</div>`;
      return;
    }
    $view.innerHTML = `<div class="empty">${esc(err.message)}</div>`;
    return;
  }
  currentAlbumId = albumId;
  currentPhotos = [];
  currentCoverPhotoId = data.album.coverPhotoId ?? null;
  searchTerm = '';
  pageState = { cursor: data.nextCursor, loading: false, hasMore: !!data.nextCursor };
  const admin = isAdmin();
  const canEdit = canEditAlbum();

  $view.innerHTML = `
    <div class="page-head">
      <h1>${esc(data.album.name)}${data.album.locked ? ' <span class="lock" style="vertical-align:3px">已上锁</span>' : ''}</h1>
      <div class="page-actions">
        <a class="btn" href="#/albums">← 返回</a>
        ${admin ? `<button class="btn" id="btn-share">🔗 分享</button>` : ''}
        ${admin && data.photos.length ? `<button class="btn" id="btn-select-mode">☑ 多选</button>` : ''}
        ${canEdit && data.photos.length ? `<button class="btn" id="btn-zip">⬇ 打包下载</button>` : ''}
        ${admin && data.album.coverPhotoId ? `
          <button class="btn" id="btn-clear-cover">取消自定义封面</button>` : ''}
        ${admin && data.missingThumbs > 0 ? `
          <button class="btn" id="btn-backfill">回填历史缩略图（${data.missingThumbs}张）</button>` : ''}
        ${canEdit && data.untaggedCount > 0 ? `
          <button class="btn" id="btn-backfill-tags">🏷 补打标签（${data.untaggedCount}张）</button>` : ''}
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
    <div class="search-row">
      <input id="f-search" type="search" placeholder="搜索标签 / 文件名…" autocomplete="off">
      <span id="search-note" class="search-note"></span>
    </div>
    <div id="backfill-tip" class="backfill-tip" style="display:none"></div>
    ${data.album.description ? `<p style="color:var(--muted);font-size:14px;margin-bottom:14px">${esc(data.album.description)}</p>` : ''}
    <div id="upload-progress"></div>
    ${data.photos.length ? `
      <div id="photo-area"></div>
      <div id="page-sentinel" class="page-sentinel"></div>
      <div id="page-status" class="page-status"></div>`
      : `<div class="empty">还没有照片${canEdit ? '，点「上传照片」开始（手机会打开相册选择器）' : ''}</div>`}`;

  if (data.photos.length) {
    currentPhotos.push(...data.photos);
    rerenderPhotoArea();
    bindGroupModeToggle();
    bindBackfillButton();
    if (pageState.hasMore) setupInfiniteLoad();
  }
  document.getElementById('f-search')?.addEventListener('input', (e) => {
    searchTerm = e.target.value;
    rerenderPhotoArea();
  });
  // 补打 AI 标签：循环按批调用，直到剩余 0 或当日额度用尽
  document.getElementById('btn-backfill-tags')?.addEventListener('click', async (e) => {
    const btn = e.target;
    const tip = document.getElementById('backfill-tip');
    btn.disabled = true;
    tip.style.display = '';
    try {
      for (;;) {
        const r = await api('POST', '/admin/backfill-tags', { albumId, limit: 20 }, albumId);
        tip.textContent = `本批打标 ${r.done} 张 · 剩余 ${r.remaining} 张 · 今日额度剩 ${r.quotaLeft}`;
        if (!r.remaining || !r.quotaLeft || r.done === 0) break;
      }
      toast('补打完成');
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
      const data = await api('GET',
        `/albums/${currentAlbumId}/photos?limit=${ALBUM_PAGE_SIZE}&cursor=${encodeURIComponent(pageState.cursor)}`,
        null, currentAlbumId);
      currentPhotos.push(...data.photos);
      rerenderPhotoArea();
      pageState.cursor = data.nextCursor;
      pageState.hasMore = !!data.nextCursor;
      if (!pageState.hasMore) {
        status.textContent = '— 已经到底了 —';
        infiniteObserver.disconnect();
      } else {
        status.textContent = '';
      }
    } catch (err) {
      status.textContent = '';
      toast(err.message || '加载失败', true);
    } finally {
      pageState.loading = false;
    }
  }, { rootMargin: '600px 0px' });
  infiniteObserver.observe(sentinel);
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
            <img src="${esc(p.thumbUrl)}" loading="lazy" alt="${esc(p.filename)}">
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

// 浏览器端压缩（browser-image-compression CDN，UMD 全局 imageCompression）
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

// 上传：浏览器端先解析 EXIF + 生成缩略图 → 一次拿 3 个预签名 URL → PUT 直传 R2 → confirm
// 文件间串行（避免手机端内存过大），单文件的 3 个 PUT 并发
async function uploadFiles(albumId, files) {
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
      let exif = null, thumbs = { small: null, large: null }, uploadBlob = file, duration = null;
      if (isVideo) {
        if (file.size > 500 * 1024 * 1024) throw { message: '视频超过 500MB 建议上限，已跳过' };
        // 抽帧 best-effort：失败则无缩略图上传，由后端 MEDIA 绑定补帧
        try {
          const vf = await captureVideoFrame(file);
          thumbs.small = vf.small;
          thumbs.large = vf.large;
          duration = vf.duration;
        } catch { /* 无法解码（如 HEVC），无缩略图 */ }
      } else {
        // EXIF/缩略图用原图（元数据完整、缩略图质量高）；上传体用压缩结果
        [exif, thumbs, uploadBlob] = await Promise.all([
          extractExif(file), makeThumbnails(file), maybeCompress(file),
        ]);
      }
      const createBody = {
        filename: file.name,
        contentType: uploadBlob.type || file.type,
        thumbContentType: thumbs.small ? thumbs.small.type : null,
      };
      if (isVideo) {
        createBody.duration = duration;
      } else {
        createBody.takenAt = exif.takenAt;
        createBody.camera = exif.camera;
        createBody.gpsLat = exif.gpsLat;
        createBody.gpsLng = exif.gpsLng;
      }
      // 上传体 ≤50MB 才算哈希，做同相册重复检测；>50MB 跳过
      if (uploadBlob.size > 0 && uploadBlob.size <= 50 * 1024 * 1024) {
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
      const puts = [
        fetch(r.uploadUrl, { method: 'PUT', body: uploadBlob, headers: { 'Content-Type': uploadBlob.type || file.type } }),
      ];
      if (r.thumbUploadUrl) {
        puts.push(fetch(r.thumbUploadUrl, {
          method: 'PUT', body: thumbs.small, headers: { 'Content-Type': thumbs.small.type },
        }));
        puts.push(fetch(r.largeUploadUrl, {
          method: 'PUT', body: thumbs.large, headers: { 'Content-Type': thumbs.large.type },
        }));
      }
      const putResps = await Promise.all(puts);
      if (putResps.some((x) => !x.ok)) throw { message: '直传 R2 失败' };
      await api('POST', `/photos/${r.photoId}/confirm`, null, albumId);
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
  if (Array.isArray(p.tags) && p.tags.length) {
    parts.push(p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join(''));
  }
  return parts.join(' · ');
}

// 取新鲜原图 URL（成功后缓存到条目；失败降级缩略图）
// 跨相册页（往年今日）按照片所属相册取 token 槽位
async function freshPhotoUrl(p) {
  try {
    const r = await api('GET', `/photos/${p.id}/url`, null, p.albumId || currentAlbumId);
    p.url = r.url;
    return r.url;
  } catch {
    return p.thumbUrl;
  }
}

function openViewer(i) {
  viewerIdx = i;
  const p = currentPhotos[i];
  const el = document.createElement('div');
  el.className = 'viewer';
  el.innerHTML = `
    <div class="v-name">${esc(p.filename)} · ${fmtSize(p.size)}</div>
    <div class="v-info" id="v-info">${viewerInfoHtml(p)}</div>
    <div class="v-media" id="v-media"></div>
    ${currentPhotos.length > 1 ? '<button class="v-btn v-prev">‹</button><button class="v-btn v-next">›</button>' : ''}
    <div class="v-bar">
      ${isAdmin() && !shareMode && !viewerCrossAlbum ? '<button class="v-btn" data-a="cover">📌 设为封面</button>' : ''}
      ${isAdmin() && !shareMode && !viewerCrossAlbum ? '<button class="v-btn" data-a="share-one">分享这张</button>' : ''}
      ${shareMode || p.kind === 'video' || viewerCrossAlbum ? '' : `
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
  const showAt = async (idx) => {
    const q = currentPhotos[idx];
    el.querySelector('.v-name').textContent = `${q.filename} · ${fmtSize(q.size)}`;
    el.querySelector('#v-info').innerHTML = viewerInfoHtml(q);
    mediaBox.innerHTML = '';
    if (q.kind === 'video') {
      const video = document.createElement('video');
      video.controls = true;
      video.playsInline = true;
      video.preload = 'metadata';
      video.className = 'v-video loading';
      video.addEventListener('loadeddata', () => video.classList.remove('loading'));
      video.addEventListener('error', () => video.classList.remove('loading'));
      video.src = q.url || await freshPhotoUrl(q);
      mediaBox.appendChild(video);
    } else {
      const img = document.createElement('img');
      img.className = 'loading';
      img.alt = '';
      img.addEventListener('load', () => img.classList.remove('loading'));
      img.addEventListener('error', () => img.classList.remove('loading'));
      img.src = q.url || await freshPhotoUrl(q);
      mediaBox.appendChild(img);
    }
  };

  const close = () => { document.removeEventListener('keydown', onKey); el.remove(); };
  const nav = (d) => {
    viewerIdx = (viewerIdx + d + currentPhotos.length) % currentPhotos.length;
    showAt(viewerIdx);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'ArrowLeft') nav(-1);
    if (e.key === 'ArrowRight') nav(1);
  };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => { if (e.target === el) close(); });
  el.querySelector('.v-close').addEventListener('click', close);
  el.querySelector('[data-a="close"]').addEventListener('click', close);
  el.querySelector('.v-prev')?.addEventListener('click', () => nav(-1));
  el.querySelector('.v-next')?.addEventListener('click', () => nav(1));
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
    let url = q.url;
    try {
      toast('开始下载…');
      if (!url) url = await freshPhotoUrl(q);
      const resp = await fetch(url);
      const blob = await resp.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = q.filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch { if (url) window.open(url, '_blank'); }
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
      <img src="${esc(p.thumbUrl)}" loading="lazy" alt="${esc(p.filename)}">
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
      <button class="btn small" data-op="copy">复制</button>
      <button class="btn small danger" data-op="revoke">撤销</button>`;
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
    </div>
    ${data.album.description ? `<p style="color:var(--muted);font-size:14px;margin-bottom:14px">${esc(data.album.description)}</p>` : ''}
    ${list.photos.length ? `
      <div id="photo-area"></div>
      <div id="page-sentinel" class="page-sentinel"></div>
      <div id="page-status" class="page-status"></div>`
      : `<div class="empty">这个相册还没有照片</div>`}`;

  if (list.photos.length) {
    currentPhotos.push(...list.photos);
    buildPhotoArea();
    addPhotoItems(list.photos, false); // 只读：无删除按钮
    if (pageState.hasMore) setupInfiniteLoad();
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
    for (const p of data.photos) grid.appendChild(createPhotoItem(p, isAdmin()));
  }
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
    </table>`;
}

// ==================== 打包下载（JSZip CDN，UMD 全局 JSZip） ====================

// 打包当前已加载照片为 zip：并发 3 抓取原图（URL 15 分钟有效，随用随换）
async function zipDownload(albumName, btn) {
  if (typeof JSZip !== 'function') { toast('打包组件未加载（CDN），请稍后再试', true); return; }
  const photos = filteredPhotos();
  if (!photos.length) { toast('没有可下载的照片', true); return; }
  if (!await confirmModal('打包下载',
    `将把当前${searchTerm.trim() ? '搜索范围内的' : '已加载的'} ${photos.length} 张照片打包为 zip。`, '开始打包')) return;
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
      .filter((f) => f.type.startsWith('image/') || f.type.startsWith('video/'));
    if (files.length) uploadFiles(currentAlbumId, files);
  });
}

// ==================== 路由 ====================

async function render() {
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

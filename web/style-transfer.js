/* 牧野云相册 - 照片换风格
 * 云端 AI：Cloudflare Workers AI · FLUX.2 [klein] 指令式图生图
 *   fast（4B）：快速，每 IP 每天 30 张
 *   hd（9B）  ：高质量，每 IP 每天 3 张
 * 参考图在浏览器端压到 504px 长边（模型要求输入小于 512×512），输出 1024/1280 长边
 */
import { toast, esc, promptModal, $view } from './js/ui.js';
import { api, isAdmin, getAdminToken, getUnlockToken } from './js/api.js';
import { promptAlbumPassword } from './js/auth.js';

// ==================== 风格定义（与服务端白名单一致） ====================

const ST_STYLES = [
  {
    id: 'impasto', name: '厚涂微缩景观', emoji: '🎨',
    desc: '颜料堆积 · 刮刀纹理 · 雕塑体积，明亮温暖的油画微缩世界',
    fixes: [
      { id: 'miniature', label: '加强微缩感' },
      { id: 'paint', label: '加强颜料质感' },
      { id: 'bright', label: '更明亮温暖' },
      { id: 'edges', label: '更圆润雕塑' },
    ],
  },
  {
    id: 'watercolor', name: '水彩插画', emoji: '💧',
    desc: '湿润晕染 · 纸纹颗粒 · 通透清新的手绘水彩',
    fixes: [
      { id: 'edges', label: '加强晕染' },
      { id: 'paper', label: '加强纸纹' },
      { id: 'bright', label: '更清透明亮' },
    ],
  },
  {
    id: 'ghibli', name: '吉卜力动漫', emoji: '🌿',
    desc: '手绘动画感 · 暖光云层 · 治愈怀旧的童话场景',
    fixes: [
      { id: 'soft', label: '更柔和' },
      { id: 'vivid', label: '更鲜艳' },
      { id: 'line', label: '加强线稿' },
    ],
  },
  {
    id: 'ink', name: '水墨丹青', emoji: '🖌️',
    desc: '墨分五色 · 留白意境 · 宣纸笔触的东方水墨',
    fixes: [
      { id: 'mist', label: '加雾气留白' },
      { id: 'brush', label: '加强笔锋' },
      { id: 'minimal', label: '更写意简约' },
    ],
  },
  {
    id: 'wcard', name: '水彩旅行票卡', emoji: '🎫',
    desc: '邮票齿孔 · 英文标题 · 档案栏，收藏级水彩记忆卡',
    fixes: [
      { id: 'thin', label: '更清透水彩' },
      { id: 'pen', label: '加强钢笔线稿' },
      { id: 'perforation', label: '加强齿孔' },
      { id: 'airy', label: '更多留白' },
    ],
  },
  {
    id: 'pixel', name: '像素消隐', emoji: '🕹️',
    desc: '限色像素块 · 记忆消融 · 大量留白的诗意海报',
    fixes: [
      { id: 'gradient', label: '加强消融感' },
      { id: 'space', label: '更多留白' },
      { id: 'square', label: '更硬核像素' },
      { id: 'palette', label: '更少颜色' },
    ],
  },
  {
    id: 'penwash', name: '钢笔淡彩手记', emoji: '✒️',
    desc: '断续线稿 · 少量淡彩 · 私人旅行手记般的留白',
    fixes: [
      { id: 'sketchy', label: '更强手绘感' },
      { id: 'sparse', label: '减少上色' },
      { id: 'unfinished', label: '更未完成感' },
      { id: 'paper', label: '加强纸纹' },
    ],
  },
  {
    id: 'paper', name: '纸艺微缩场景', emoji: '📦',
    desc: '层叠卡纸 · 手工折痕 · 捧在手心的 3D 旅行明信片',
    fixes: [
      { id: 'layers', label: '加强层叠' },
      { id: 'craft', label: '加强手工感' },
      { id: 'mini', label: '加强微缩感' },
      { id: 'soft', label: '更柔和淡雅' },
    ],
  },
];

const ST_TIERS = {
  fast: { name: '快速', model: 'FLUX.2 Klein 4B', limit: 30, longEdge: 1024 },
  hd: { name: '高质量', model: 'FLUX.2 Klein 9B', limit: 3, longEdge: 1280 },
};

// ==================== 状态 ====================

const stState = {
  sourceImg: null,       // 原始 Image
  sourceDataUrl: null,   // 原图 data URL（对比用）
  sourceType: 'local',
  albumPhotos: [],
  albums: [],
  currentAlbumId: null,
  style: 'impasto',
  tier: 'fast',
  resultUrl: null,
  resultBlob: null,
  busy: false,
  remaining: null,
  adminUnlimited: false,
};

// ==================== 页面渲染 ====================

export function renderStyleTransfer() {
  const adminMode = isAdmin();
  $view.innerHTML = `
    <div class="page-head">
      <h1>照片换风格</h1>
      <div class="page-actions">
        <a class="btn" href="#/albums">← 返回相册</a>
      </div>
    </div>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px">
      云端 AI 把照片重绘成艺术作品：参考图仅在生成时上传到 Cloudflare AI 处理，不留存。
      <strong>快速档每天 ${ST_TIERS.fast.limit} 张、高质量档每天 ${ST_TIERS.hd.limit} 张</strong>（按访问设备计数，凌晨重置）${adminMode ? '，管理员不限量' : ''}。
    </p>

    <div class="idp-section">
      <label class="idp-label">选择照片来源</label>
      <div class="idp-source-tabs">
        <button class="btn small ${stState.sourceType === 'local' ? 'primary' : ''}" data-source="local">本地上传</button>
        <button class="btn small ${stState.sourceType === 'album' ? 'primary' : ''}" data-source="album">从相册选择</button>
      </div>
    </div>

    <div id="st-upload-area" class="idp-upload-area" style="display:${stState.sourceType === 'local' ? 'block' : 'none'}">
      <input type="file" id="st-file" accept="image/*" hidden>
      <div class="idp-upload-hint">
        <p>点击或拖拽上传照片</p>
        <p style="font-size:12px;color:var(--muted);margin-top:8px">风景、建筑、街拍、静物效果最佳；人物会被艺术化重绘（非写实保留）</p>
      </div>
    </div>

    <div id="st-album-picker" class="idp-album-picker" style="display:${stState.sourceType === 'album' ? 'block' : 'none'}">
      <select id="st-album-select" class="idp-album-select" title="选择相册"></select>
      <div class="idp-album-list" id="st-album-list">
        <p style="color:var(--muted);text-align:center;padding:40px 0">点击上方"从相册选择"加载照片</p>
      </div>
    </div>

    <div id="st-status" class="idp-ai-status" style="display:none">
      <div class="idp-loading">
        <div class="idp-spinner"></div>
        <p id="st-status-text">AI 正在创作…</p>
        <div class="idp-progress"><div class="idp-progress-bar" id="st-bar"></div></div>
        <p id="st-status-detail" style="font-size:12px;color:var(--muted);margin-top:6px"></p>
      </div>
    </div>

    <div id="st-editor" style="display:${stState.sourceDataUrl ? 'block' : 'none'}">
      <div class="idp-section">
        <label class="idp-label">已选照片</label>
        <div class="st-source-preview">
          <img id="st-source" alt="选中的原图">
        </div>
      </div>

      <div class="idp-section">
        <label class="idp-label">选择艺术风格</label>
        <div class="st-style-grid" id="st-style-grid"></div>
      </div>

      <div class="idp-section">
        <label class="idp-label">生成档位</label>
        <div class="st-tiers" id="st-tiers">
          <button type="button" class="st-tier ${stState.tier === 'fast' ? 'active' : ''}" data-tier="fast">
            <span class="st-tier-title">⚡ 快速档</span>
            <span class="st-tier-sub">${ST_TIERS.fast.model} · 约 3 秒 · 每天 ${ST_TIERS.fast.limit} 张</span>
          </button>
          <button type="button" class="st-tier ${stState.tier === 'hd' ? 'active' : ''}" data-tier="hd">
            <span class="st-tier-title">✨ 高质量档</span>
            <span class="st-tier-sub">${ST_TIERS.hd.model} · 细节更好 · 每天 ${ST_TIERS.hd.limit} 张</span>
          </button>
        </div>
      </div>

      <button type="button" class="btn primary st-generate-btn" id="st-generate">🎨 生成艺术海报</button>

      <div id="st-result-wrap" class="idp-section" style="display:none">
        <label class="idp-label">效果预览（拖动分隔线对比）</label>
        <div class="st-compare" id="st-compare">
          <img id="st-after" class="st-after" alt="风格化成品">
          <div class="st-before-mask" id="st-before-mask">
            <img id="st-before" alt="原图">
          </div>
          <div class="st-divider" id="st-divider">
            <span class="st-divider-handle">⇆</span>
          </div>
          <span class="st-tag st-tag-before">原图</span>
          <span class="st-tag st-tag-after">成品</span>
          <input type="range" min="0" max="100" value="50" id="st-range" class="st-range" aria-label="对比滑块">
        </div>

        <div class="st-fixes" id="st-fixes"></div>

        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <button type="button" class="btn primary" id="st-download">下载作品</button>
          ${adminMode ? '<button type="button" class="btn" id="st-save-album">保存到相册</button>' : ''}
          <button type="button" class="btn ghost" id="st-repick">换一张照片</button>
        </div>
        <p id="st-quota-tip" class="st-quota-tip"></p>
      </div>
    </div>
  `;

  initStEvents();
  renderStStyleCards();

  // 重渲染时恢复已选照片预览
  if (stState.sourceDataUrl) {
    const srcEl = document.getElementById('st-source');
    if (srcEl) srcEl.src = stState.sourceDataUrl;
    document.getElementById('st-upload-area').style.display = 'none';
    document.getElementById('st-album-picker').style.display = 'none';
  }

  // 支持从大图查看器带 ?photo=<id> 直接进入
  const query = location.hash.split('?')[1];
  const qs = query ? new URLSearchParams(query) : null;
  const directPhotoId = qs ? qs.get('photo') : null;
  const directAlbumId = qs ? qs.get('album') : null;
  if (directPhotoId) {
    stLoadPhotoFromId(directPhotoId, directAlbumId)
      .catch(e => toast('照片加载失败: ' + e.message, true));
  }
}

function renderStStyleCards() {
  const grid = document.getElementById('st-style-grid');
  if (!grid) return;
  grid.innerHTML = ST_STYLES.map(s => `
    <button type="button" class="st-style-card ${stState.style === s.id ? 'active' : ''}" data-style="${s.id}">
      <span class="st-style-emoji">${s.emoji}</span>
      <span class="st-style-name">${s.name}</span>
      <span class="st-style-desc">${s.desc}</span>
    </button>
  `).join('');
  grid.querySelectorAll('.st-style-card').forEach(card => {
    card.addEventListener('click', () => {
      stState.style = card.dataset.style;
      grid.querySelectorAll('.st-style-card').forEach(c => c.classList.toggle('active', c === card));
      // 已生成的结果是旧风格，刷新纠偏按钮；旧成品保留可见直到重新生成
      renderStFixButtons();
    });
  });
}

function renderStFixButtons() {
  const wrap = document.getElementById('st-fixes');
  if (!wrap || !stState.resultUrl) {
    if (wrap) wrap.innerHTML = '';
    return;
  }
  const style = ST_STYLES.find(s => s.id === stState.style);
  wrap.innerHTML = `
    <label class="idp-label" style="margin-top:16px">不满意？按问题微调重生成（每次消耗 1 张额度）</label>
    <div class="st-fix-row">
      ${style.fixes.map(f => `<button type="button" class="btn small" data-fix="${f.id}">${f.label}</button>`).join('')}
      <button type="button" class="btn small ghost" data-fix="">🎲 换个随机效果</button>
    </div>
  `;
  wrap.querySelectorAll('[data-fix]').forEach(btn => {
    btn.addEventListener('click', () => stGenerate(btn.dataset.fix || null));
  });
}

// ==================== 事件 ====================

function initStEvents() {
  const fileInput = document.getElementById('st-file');
  const uploadArea = document.getElementById('st-upload-area');

  const tabs = document.querySelectorAll('.idp-source-tabs .btn');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      const source = btn.dataset.source;
      if (!source) return;
      stState.sourceType = source;
      tabs.forEach(b => b.classList.toggle('primary', b === btn));
      document.getElementById('st-upload-area').style.display = source === 'local' ? 'block' : 'none';
      document.getElementById('st-album-picker').style.display = source === 'album' ? 'block' : 'none';
      if (source === 'album') stLoadAlbumPhotos();
    });
  });

  uploadArea.addEventListener('click', () => fileInput.click());
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) stLoadFile(file);
  });
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) stLoadFile(file);
    e.target.value = '';
  });

  document.getElementById('st-tiers').querySelectorAll('.st-tier').forEach(btn => {
    btn.addEventListener('click', () => {
      stState.tier = btn.dataset.tier;
      document.querySelectorAll('.st-tier').forEach(b => b.classList.toggle('active', b === btn));
    });
  });

  document.getElementById('st-generate').addEventListener('click', () => stGenerate(null));
  document.getElementById('st-download').addEventListener('click', stDownload);
  document.getElementById('st-save-album')?.addEventListener('click', stSaveToAlbum);
  document.getElementById('st-repick').addEventListener('click', stReset);

  // 对比滑块
  const range = document.getElementById('st-range');
  const mask = document.getElementById('st-before-mask');
  const divider = document.getElementById('st-divider');
  const applyPos = (pos) => {
    mask.style.clipPath = `inset(0 ${100 - pos}% 0 0)`;
    divider.style.left = pos + '%';
  };
  range.addEventListener('input', () => applyPos(Number(range.value)));
  applyPos(50);
}

// ==================== 加载图片 ====================

function stLoadFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      stState.sourceImg = img;
      stState.sourceDataUrl = e.target.result;
      stClearResult();
      document.getElementById('st-source').src = e.target.result;
      document.getElementById('st-upload-area').style.display = 'none';
      document.getElementById('st-album-picker').style.display = 'none';
      document.getElementById('st-editor').style.display = 'block';
      window.scrollTo({ top: document.getElementById('st-editor').offsetTop - 20, behavior: 'smooth' });
    };
    img.onerror = () => toast('图片无法读取，请换一张试试', true);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function stLoadPhotoFromId(photoId, albumId) {
  toast('正在加载照片...');
  const { url } = await api('GET', `/photos/${photoId}/url`, null, albumId);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  stLoadFile(new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' }));
}

// 加载相册列表并渲染相册选择器，默认加载第一个相册
async function stLoadAlbumPhotos() {
  const listEl = document.getElementById('st-album-list');
  const selectEl = document.getElementById('st-album-select');
  listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">加载中…</p>';
  try {
    const { albums } = await api('GET', '/albums');
    stState.albums = albums;
    if (!albums.length) {
      selectEl.style.display = 'none';
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">暂无相册</p>';
      return;
    }

    selectEl.style.display = '';
    selectEl.innerHTML =
      '<option value="">请选择相册…</option>' +
      albums.map(a =>
        `<option value="${a.id}">${esc(a.name)}${a.locked ? ' 🔒' : ''}</option>`).join('');

    const prevId = stState.currentAlbumId;
    if (albums.some(a => a.id === prevId)) {
      // 之前已选过相册（如切换来源后再切回来）：恢复选择并加载
      selectEl.value = prevId;
      await stLoadPhotosFromAlbum(prevId);
    } else {
      // 初次进入：不自动加载第一个相册（避免立刻弹密码），等用户主动选择
      selectEl.value = '';
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">请先在上方选择相册</p>';
    }

    selectEl.onchange = async () => {
      const id = selectEl.value;
      if (!id) return;
      const ok = await stLoadPhotosFromAlbum(id);
      if (!ok) selectEl.value = stState.currentAlbumId || '';
    };
  } catch (e) {
    listEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:40px 0">加载失败：${esc(e.message)}</p>`;
  }
}

// 加载指定相册的照片网格；加密相册先弹独立密码框。返回是否成功使用该相册
async function stLoadPhotosFromAlbum(albumId, isRetry = false) {
  const listEl = document.getElementById('st-album-list');
  const album = stState.albums.find(a => a.id === albumId);
  if (!album) return false;

  // 加密相册：非管理员且没有有效解锁凭证时，先验证独立密码
  if (album.locked && !isAdmin() && !getUnlockToken(albumId)) {
    const ok = await promptAlbumPassword(albumId, album.name);
    if (!ok) return false;
  }

  try {
    listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">加载中…</p>';
    const { photos } = await api('GET', `/albums/${albumId}/photos`, null, albumId);
    stState.currentAlbumId = albumId;
    stState.albumPhotos = photos.map(p => ({
      ...p, albumId, albumName: album.name,
    }));

    if (!photos.length) {
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">该相册暂无照片</p>';
      return true;
    }

    listEl.innerHTML = `
      <div class="idp-photo-grid">
        ${photos.map(p => `
          <div class="idp-photo-item" data-photo-id="${p.id}">
            <img src="${p.thumbUrl}" alt="${esc(p.filename)}" loading="lazy">
            <div class="idp-photo-info">
              <span class="idp-photo-name">${esc(p.filename)}</span>
            </div>
          </div>`).join('')}
      </div>`;
    listEl.querySelectorAll('.idp-photo-item').forEach(item => {
      item.addEventListener('click', () => stPickFromAlbum(item.dataset.photoId));
    });
    return true;
  } catch (e) {
    // 解锁 token 过期（后端 30 分钟失效）：清掉旧凭证后重试一次，会重新弹密码框
    if (e.status === 403 && !isRetry) {
      sessionStorage.removeItem('unlock_' + albumId);
      return stLoadPhotosFromAlbum(albumId, true);
    }
    listEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:40px 0">加载失败：${esc(e.message)}</p>`;
    return false;
  }
}

async function stPickFromAlbum(photoId) {
  const photo = stState.albumPhotos.find(p => p.id === photoId);
  if (!photo) return toast('照片信息已过期，请重新加载列表', true);
  try {
    toast('正在加载照片…');
    // 列表里的预签名 URL 可能已过期（过期后 R2 错误响应不带 CORS 头，fetch 会报
    // "Failed to fetch"），所以先向 Worker 换新鲜 URL 再取图，与证件照页做法一致
    const { url } = await api('GET', `/photos/${photoId}/url`, null, photo.albumId);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const file = new File([blob], photo.filename || 'album.jpg', { type: blob.type || 'image/jpeg' });
    stLoadFile(file);
  } catch (e) {
    toast('加载照片失败：' + e.message, true);
  }
}

// ==================== 图片处理 ====================

// 等比缩放并输出 JPEG data URI（参考图必须小于 512×512）
function stToDataUri(img, longEdge, quality = 0.9) {
  const scale = Math.min(1, longEdge / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return { dataUri: c.toDataURL('image/jpeg', quality), width: img.width, height: img.height };
}

// 输出尺寸：对应长边，32 对齐，钳制 256~1536
function stOutputSize(img, tier) {
  const longEdge = ST_TIERS[tier].longEdge;
  const scale = longEdge / Math.max(img.width, img.height);
  let w = Math.round(img.width * scale / 32) * 32;
  let h = Math.round(img.height * scale / 32) * 32;
  w = Math.max(256, Math.min(1536, w));
  h = Math.max(256, Math.min(1536, h));
  return { width: w, height: h };
}

// ==================== 调用云端生成 ====================

async function stGenerate(fixId) {
  if (!stState.sourceImg) return toast('请先选择照片', true);
  if (stState.busy) return;

  stState.busy = true;
  const btn = document.getElementById('st-generate');
  btn.disabled = true;
  const statusEl = document.getElementById('st-status');
  statusEl.style.display = 'flex';
  const bar = document.getElementById('st-bar');
  const detail = document.getElementById('st-status-detail');
  const styleName = ST_STYLES.find(s => s.id === stState.style).name;
  document.getElementById('st-status-text').textContent =
    fixId ? '正在按你的反馈微调重绘…' : `正在创作「${styleName}」…`;
  bar.style.width = '15%';
  detail.textContent = '压缩参考图…';

  let fakeTimer = null;
  try {
    const { dataUri } = stToDataUri(stState.sourceImg, 504);
    const { width, height } = stOutputSize(stState.sourceImg, stState.tier);
    bar.style.width = '35%';
    detail.textContent = `上传到云端 AI（${ST_TIERS[stState.tier].model}，约 10~30 秒，请勿关闭页面）…`;
    fakeTimer = setInterval(() => {
      const w = parseFloat(bar.style.width) || 35;
      if (w < 80) bar.style.width = (w + 1.5) + '%';
    }, 1200);

    const headers = { 'Content-Type': 'application/json' };
    const adminToken = getAdminToken();
    if (adminToken) headers.Authorization = 'Bearer ' + adminToken;

    const resp = await fetch(window.API_BASE + '/style-transfer', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        image: dataUri,
        style: stState.style,
        tier: stState.tier,
        width,
        height,
        fix: fixId || undefined,
      }),
    });

    clearInterval(fakeTimer);
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    bar.style.width = '85%';
    detail.textContent = '接收作品…';
    const blob = await resp.blob();
    stApplyResult(blob, resp.headers);
    bar.style.width = '100%';
  } catch (e) {
    console.error('换风格失败:', e);
    toast('生成失败：' + (e?.message ?? e), true);
  } finally {
    clearInterval(fakeTimer);
    stState.busy = false;
    btn.disabled = false;
    statusEl.style.display = 'none';
  }
}

function stClearResult() {
  if (stState.resultUrl) URL.revokeObjectURL(stState.resultUrl);
  stState.resultUrl = null;
  stState.resultBlob = null;
  const wrap = document.getElementById('st-result-wrap');
  if (wrap) wrap.style.display = 'none';
}

function stApplyResult(blob, headers) {
  stClearResult();
  stState.resultBlob = blob;
  stState.resultUrl = URL.createObjectURL(blob);

  document.getElementById('st-before').src = stState.sourceDataUrl;
  const after = document.getElementById('st-after');
  after.src = stState.resultUrl;

  const wrap = document.getElementById('st-result-wrap');
  wrap.style.display = 'block';

  // 重置滑块
  const range = document.getElementById('st-range');
  range.value = 50;
  document.getElementById('st-before-mask').style.clipPath = 'inset(0 50% 0 0)';
  document.getElementById('st-divider').style.left = '50%';

  // 额度提示
  const remaining = headers.get('X-Quota-Remaining');
  stState.remaining = remaining;
  stState.adminUnlimited = remaining === 'unlimited';
  const tip = document.getElementById('st-quota-tip');
  if (remaining === 'unlimited') {
    tip.textContent = '管理员账号：不限量';
  } else if (remaining != null) {
    const tierName = ST_TIERS[stState.tier].name;
    tip.textContent = `本次使用${tierName}档，今日${tierName}档剩余 ${remaining} 张`;
  } else {
    tip.textContent = '';
  }

  renderStFixButtons();
  setTimeout(() => wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 100);
  toast('作品已生成，拖动分隔线对比效果');
}

// ==================== 下载 / 保存 / 重置 ====================

function stExtByMime(mime) {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  return 'jpg';
}

function stDownload() {
  if (!stState.resultBlob) return;
  const styleName = ST_STYLES.find(s => s.id === stState.style).name;
  const ext = stExtByMime(stState.resultBlob.type);
  const a = document.createElement('a');
  a.download = `牧野云相册_${styleName}_${new Date().toISOString().slice(0, 10)}.${ext}`;
  a.href = stState.resultUrl;
  a.click();
  toast('已开始下载');
}

async function stSaveToAlbum() {
  if (!stState.resultBlob) return;
  let data;
  try {
    data = await api('GET', '/albums');
  } catch (e) {
    return toast(e.message, true);
  }
  if (!data.albums.length) return toast('还没有相册，请先创建', true);

  const styleName = ST_STYLES.find(s => s.id === stState.style).name;
  const ext = stExtByMime(stState.resultBlob.type);
  const mime = stState.resultBlob.type || 'image/jpeg';
  const albumOptions = data.albums.map(a => `<option value="${a.id}">${esc(a.name)}</option>`).join('');

  promptModal('保存到相册', `
    <div class="field">
      <label>选择相册</label>
      <select id="f-album" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft);color:var(--text)">
        ${albumOptions}
      </select>
    </div>
    <div class="field">
      <label>文件名</label>
      <input id="f-filename" value="${styleName}_${new Date().toISOString().slice(0, 10)}.${ext}">
    </div>
  `, async (m) => {
    const albumId = m.querySelector('#f-album').value;
    const filename = (m.querySelector('#f-filename').value.trim() || `风格作品.${ext}`);

    const r = await api('POST', `/albums/${albumId}/photos`, { filename, contentType: mime });
    const put = await fetch(r.uploadUrl, {
      method: 'PUT',
      body: stState.resultBlob,
      headers: { 'Content-Type': mime },
    });
    if (!put.ok) throw { message: '直传 R2 失败' };
    await api('POST', `/photos/${r.photoId}/confirm`);
    toast('已保存到相册');
  }, '保存');
}

function stReset() {
  stClearResult();
  stState.sourceImg = null;
  stState.sourceDataUrl = null;
  document.getElementById('st-editor').style.display = 'none';
  document.getElementById(stState.sourceType === 'album' ? 'st-album-picker' : 'st-upload-area').style.display = 'block';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

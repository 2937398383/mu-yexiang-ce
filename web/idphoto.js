/* 牧野云相册 - 证件照工具页面
 * 双引擎 AI 抠图：
 *   方案一（默认）：浏览器本地 AI（@imgly/background-removal，ISNet 量化模型）
 *                  免费、照片不出本机
 *   方案二（进阶）：云端 BiRefNet 精修（经 Worker 代理 Replicate）
 *                  发丝级边缘，每日有限免费额度
 */
'use strict';

// ==================== 证件照工具状态 ====================

const idPhotoState = {
  sourceImg: null,        // 原始 Image 对象
  sourceFile: null,       // 原始 File/Blob 对象（本地 AI 输入）
  sourceType: 'local',    // 'local' | 'album'
  processedImg: null,     // 抠图后的 Image 对象（带透明背景）
  processedBlob: null,    // 抠图后的 Blob
  cutoutMode: null,       // 'local' | 'cloud' | null（未抠图）
  isProcessing: false,    // 是否正在 AI 处理
  albumPhotos: [],        // 相册来源时缓存的照片列表（含预签名 url）
  albums: [],             // 可见相册列表
  currentAlbumId: null,   // 当前选中的相册
  // 裁剪参数
  cropX: 0, cropY: 0, cropW: 0, cropH: 0,
  // 调整参数
  brightness: 100, contrast: 100, saturate: 100,
  bgColor: '#ffffff',
  spec: '1寸',
};

// 证件照规格定义（像素，300dpi）
const ID_SPECS = {
  '1寸': { w: 295, h: 413, ratio: 295/413, desc: '25×35mm' },
  '2寸': { w: 413, h: 579, ratio: 413/579, desc: '35×49mm' },
  '小1寸': { w: 260, h: 378, ratio: 260/378, desc: '22×32mm' },
  '护照': { w: 390, h: 567, ratio: 390/567, desc: '33×48mm' },
  '签证(美)': { w: 600, h: 600, ratio: 1, desc: '51×51mm' },
};

// 预设底色
const BG_COLORS = [
  { name: '白', value: '#FFFFFF' },
  { name: '蓝', value: '#438EDB' },
  { name: '红', value: '#FF0000' },
  { name: '深蓝', value: '#2E5C8A' },
  { name: '灰', value: '#E8E8E8' },
];

// ==================== 渲染证件照页面 ====================

function renderIdPhoto() {
  const isAdminMode = isAdmin();
  $view.innerHTML = `
    <div class="page-head">
      <h1>证件照工具</h1>
      <div class="page-actions">
        <a class="btn" href="#/albums">← 返回相册</a>
      </div>
    </div>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px">
      默认使用<strong>浏览器本地 AI</strong>抠图，免费且照片不离开本机；如对发丝边缘有更高要求，可使用进阶的<strong>云端精修</strong>。
      ${isAdminMode ? '管理员可保存到相册。' : ''}
    </p>

    <!-- 照片来源选择 -->
    <div class="idp-section">
      <label class="idp-label">选择照片来源</label>
      <div class="idp-source-tabs">
        <button class="btn small ${idPhotoState.sourceType === 'local' ? 'primary' : ''}" data-source="local">本地上传</button>
        <button class="btn small ${idPhotoState.sourceType === 'album' ? 'primary' : ''}" data-source="album">从相册选择</button>
      </div>
    </div>

    <!-- 本地上传区域 -->
    <div id="idp-upload-area" class="idp-upload-area" style="display:${idPhotoState.sourceType === 'local' ? 'block' : 'none'}">
      <input type="file" id="idp-file" accept="image/*" hidden>
      <div class="idp-upload-hint" id="idp-upload-hint">
        <p>点击或拖拽上传照片</p>
        <p style="font-size:12px;color:var(--muted);margin-top:8px">建议使用正面、纯色背景、光线均匀的照片</p>
      </div>
    </div>

    <!-- 相册选择区域 -->
    <div id="idp-album-picker" class="idp-album-picker" style="display:${idPhotoState.sourceType === 'album' ? 'block' : 'none'}">
      <select id="idp-album-select" class="idp-album-select" title="选择相册"></select>
      <div class="idp-album-list" id="idp-album-list">
        <p style="color:var(--muted);text-align:center;padding:40px 0">点击上方"从相册选择"加载照片</p>
      </div>
    </div>

    <!-- AI 处理状态 -->
    <div id="idp-ai-status" class="idp-ai-status" style="display:none">
      <div class="idp-loading">
        <div class="idp-spinner"></div>
        <p id="idp-ai-status-text">AI 正在处理...</p>
        <div class="idp-progress"><div class="idp-progress-bar" id="idp-progress-bar"></div></div>
        <p id="idp-progress-detail" style="font-size:12px;color:var(--muted);margin-top:6px"></p>
      </div>
    </div>

    <!-- 编辑区域（上传后显示） -->
    <div id="idp-editor" style="display:none">
      <!-- 规格选择 -->
      <div class="idp-section">
        <label class="idp-label">证件照规格</label>
        <div class="idp-specs" id="idp-specs"></div>
      </div>

      <!-- 裁剪预览 -->
      <div class="idp-section">
        <label class="idp-label">裁剪区域（拖动调整位置，滚轮缩放）</label>
        <div class="idp-crop-container" id="idp-crop-container">
          <canvas id="idp-crop-canvas"></canvas>
          <div class="idp-crop-overlay" id="idp-crop-overlay">
            <div class="idp-crop-box" id="idp-crop-box">
              <div class="idp-crop-handle nw"></div>
              <div class="idp-crop-handle ne"></div>
              <div class="idp-crop-handle sw"></div>
              <div class="idp-crop-handle se"></div>
            </div>
          </div>
        </div>
      </div>

      <!-- 底色选择 -->
      <div class="idp-section">
        <label class="idp-label">背景底色</label>
        <div class="idp-colors" id="idp-colors"></div>
        <div style="display:flex;gap:8px;align-items:center;margin-top:8px">
          <input type="color" id="idp-custom-color" value="#ffffff" style="width:40px;height:32px;border:none;cursor:pointer">
          <span style="font-size:13px;color:var(--muted)">自定义颜色</span>
        </div>
      </div>

      <!-- 图像调整 -->
      <div class="idp-section">
        <label class="idp-label">图像调整</label>
        <div class="idp-adjust">
          <div class="idp-slider">
            <span>亮度</span>
            <input type="range" id="idp-brightness" min="50" max="150" value="100">
            <span id="idp-brightness-val">100%</span>
          </div>
          <div class="idp-slider">
            <span>对比度</span>
            <input type="range" id="idp-contrast" min="50" max="150" value="100">
            <span id="idp-contrast-val">100%</span>
          </div>
          <div class="idp-slider">
            <span>饱和度</span>
            <input type="range" id="idp-saturate" min="0" max="200" value="100">
            <span id="idp-saturate-val">100%</span>
          </div>
        </div>
      </div>

      <!-- 结果预览 -->
      <div class="idp-section">
        <label class="idp-label">效果预览<span id="idp-engine-badge" style="margin-left:8px"></span></label>
        <div class="idp-result-container">
          <canvas id="idp-result-canvas"></canvas>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">
          <button class="btn primary" id="idp-download">下载证件照</button>
          ${isAdminMode ? '<button class="btn" id="idp-save-album">保存到相册</button>' : ''}
          <button class="btn" id="idp-cloud-refine" title="云端 BiRefNet 精修，发丝级边缘">☁ 云端精修（进阶）</button>
          <button class="btn ghost" id="idp-reprocess">重新本地抠图</button>
          <button class="btn ghost" id="idp-reset">重置</button>
        </div>
      </div>
    </div>
  `;

  initIdPhotoEvents();

  // 支持从大图查看器带 ?photo=<id> 直接进入：只加载该照片，省去遍历所有相册的全量加载
  const query = location.hash.split('?')[1];
  const qs = query ? new URLSearchParams(query) : null;
  const directPhotoId = qs ? qs.get('photo') : null;
  const directAlbumId = qs ? qs.get('album') : null;
  if (directPhotoId) {
    loadPhotoFromIdParam(directPhotoId, directAlbumId)
      .catch(e => toast('照片加载失败: ' + e.message, true));
  }
}

// 按 photoId 直接加载单张照片（复用按需换新鲜 URL 的接口），完成后进入编辑/抠图
async function loadPhotoFromIdParam(photoId, albumId) {
  toast('正在加载照片...');
  const { url } = await api('GET', `/photos/${photoId}/url`, null, albumId);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  await loadIdPhotoImage(new File([blob], 'photo.jpg', { type: blob.type }));
}

// ==================== 初始化事件 ====================

function initIdPhotoEvents() {
  const fileInput = document.getElementById('idp-file');
  const uploadArea = document.getElementById('idp-upload-area');

  // 来源切换
  document.querySelectorAll('.idp-source-tabs .btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const source = btn.dataset.source;
      idPhotoState.sourceType = source;
      document.querySelectorAll('.idp-source-tabs .btn').forEach(b => b.classList.remove('primary'));
      btn.classList.add('primary');
      document.getElementById('idp-upload-area').style.display = source === 'local' ? 'block' : 'none';
      document.getElementById('idp-album-picker').style.display = source === 'album' ? 'block' : 'none';
      if (source === 'album') loadAlbumPhotos();
    });
  });

  // 点击上传
  uploadArea.addEventListener('click', () => fileInput.click());

  // 拖拽上传
  uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
  });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) loadIdPhotoImage(file);
  });

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) loadIdPhotoImage(file);
    e.target.value = '';
  });

  // 规格选择
  const specsEl = document.getElementById('idp-specs');
  Object.entries(ID_SPECS).forEach(([name, spec]) => {
    const btn = document.createElement('button');
    btn.className = 'btn small' + (name === idPhotoState.spec ? ' primary' : '');
    btn.textContent = `${name} (${spec.desc})`;
    btn.addEventListener('click', () => {
      idPhotoState.spec = name;
      specsEl.querySelectorAll('.btn').forEach(b => b.classList.remove('primary'));
      btn.classList.add('primary');
      updateIdPhotoCrop();
      updateIdPhotoResult();
    });
    specsEl.appendChild(btn);
  });

  // 底色选择
  const colorsEl = document.getElementById('idp-colors');
  BG_COLORS.forEach(c => {
    const btn = document.createElement('button');
    btn.className = 'idp-color-btn' + (c.value === idPhotoState.bgColor ? ' active' : '');
    btn.style.background = c.value;
    btn.title = c.name;
    btn.addEventListener('click', () => {
      idPhotoState.bgColor = c.value;
      colorsEl.querySelectorAll('.idp-color-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('idp-custom-color').value = c.value;
      updateIdPhotoResult();
    });
    colorsEl.appendChild(btn);
  });

  document.getElementById('idp-custom-color').addEventListener('input', (e) => {
    idPhotoState.bgColor = e.target.value;
    colorsEl.querySelectorAll('.idp-color-btn').forEach(b => b.classList.remove('active'));
    updateIdPhotoResult();
  });

  // 滑块调整
  ['brightness', 'contrast', 'saturate'].forEach(key => {
    const input = document.getElementById('idp-' + key);
    const valEl = document.getElementById('idp-' + key + '-val');
    input.addEventListener('input', () => {
      idPhotoState[key] = parseInt(input.value);
      valEl.textContent = input.value + '%';
      updateIdPhotoResult();
    });
  });

  // 下载
  document.getElementById('idp-download').addEventListener('click', downloadIdPhoto);

  // 保存到相册（管理员）
  document.getElementById('idp-save-album')?.addEventListener('click', saveIdPhotoToAlbum);

  // 云端精修
  document.getElementById('idp-cloud-refine').addEventListener('click', cloudRefine);

  // 重置
  document.getElementById('idp-reset').addEventListener('click', resetIdPhoto);

  // 重新本地抠图
  document.getElementById('idp-reprocess').addEventListener('click', reprocessLocal);

  // 裁剪交互
  initCropInteraction();
}

// ==================== 加载图片 ====================

async function loadIdPhotoImage(file) {
  idPhotoState.sourceFile = file;
  const reader = new FileReader();
  reader.onload = async (e) => {
    const img = new Image();
    img.onload = async () => {
      idPhotoState.sourceImg = img;
      idPhotoState.processedImg = null;
      idPhotoState.processedBlob = null;
      idPhotoState.cutoutMode = null;
      document.getElementById('idp-upload-area').style.display = 'none';
      document.getElementById('idp-editor').style.display = 'block';

      // 先尝试本地 AI 抠图
      await processWithAILocal();

      initIdPhotoCrop();
      updateIdPhotoResult();
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// 加载相册列表并渲染相册选择器，默认加载第一个相册
async function loadAlbumPhotos() {
  const listEl = document.getElementById('idp-album-list');
  const selectEl = document.getElementById('idp-album-select');
  listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">加载中...</p>';

  try {
    const { albums } = await api('GET', '/albums');
    idPhotoState.albums = albums;
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

    const prevId = idPhotoState.currentAlbumId;
    if (albums.some(a => a.id === prevId)) {
      // 之前已选过相册（如切换来源后再切回来）：恢复选择并加载
      selectEl.value = prevId;
      await loadPhotosFromAlbum(prevId);
    } else {
      // 初次进入：不自动加载第一个相册（避免立刻弹密码），等用户主动选择
      selectEl.value = '';
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">请先在上方选择相册</p>';
    }

    selectEl.onchange = async () => {
      const id = selectEl.value;
      if (!id) return;
      const ok = await loadPhotosFromAlbum(id);
      if (!ok) selectEl.value = idPhotoState.currentAlbumId || '';
    };
  } catch (e) {
    listEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:40px 0">加载失败: ${esc(e.message)}</p>`;
  }
}

// 加载指定相册的照片网格；加密相册先弹独立密码框。返回是否成功使用该相册
async function loadPhotosFromAlbum(albumId, isRetry = false) {
  const listEl = document.getElementById('idp-album-list');
  const album = idPhotoState.albums.find(a => a.id === albumId);
  if (!album) return false;

  // 加密相册：非管理员且没有有效解锁凭证时，先验证独立密码
  if (album.locked && !isAdmin() && !getUnlockToken(albumId)) {
    const ok = await promptAlbumPassword(albumId, album.name);
    if (!ok) return false;
  }

  try {
    listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">加载中...</p>';
    const { photos } = await api('GET', `/albums/${albumId}/photos`, null, albumId);
    idPhotoState.currentAlbumId = albumId;
    idPhotoState.albumPhotos = photos.map(p => ({
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
          </div>
        `).join('')}
      </div>
    `;
    listEl.querySelectorAll('.idp-photo-item').forEach(item => {
      item.addEventListener('click', () => loadFromAlbum(item.dataset.photoId));
    });
    return true;
  } catch (e) {
    // 解锁 token 过期（后端 30 分钟失效）：清掉旧凭证后重试一次，会重新弹密码框
    if (e.status === 403 && !isRetry) {
      sessionStorage.removeItem('unlock_' + albumId);
      return loadPhotosFromAlbum(albumId, true);
    }
    listEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:40px 0">加载失败: ${esc(e.message)}</p>`;
    return false;
  }
}

// 从相册加载单张照片（直接用列表中已有的预签名 url）
async function loadFromAlbum(photoId) {
  const photo = idPhotoState.albumPhotos.find(p => p.id === photoId);
  if (!photo) {
    toast('照片信息已过期，请重新加载列表', true);
    return;
  }
  try {
    toast('正在加载照片...');
    // 列表里的预签名 URL 只有 15 分钟有效期，过期后 R2 的错误响应不带 CORS 头会导致 Failed to fetch，
    // 因此点击时先按需换取一个新鲜 URL（带上相册解锁凭证）
    const { url } = await api('GET', `/photos/${photoId}/url`, null, photo.albumId);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    const file = new File([blob], photo.filename || 'album-photo.jpg', { type: blob.type });

    idPhotoState.sourceFile = file;
    const img = new Image();
    img.onload = async () => {
      idPhotoState.sourceImg = img;
      idPhotoState.processedImg = null;
      idPhotoState.processedBlob = null;
      idPhotoState.cutoutMode = null;
      document.getElementById('idp-album-picker').style.display = 'none';
      document.getElementById('idp-editor').style.display = 'block';

      await processWithAILocal();

      initIdPhotoCrop();
      updateIdPhotoResult();
    };
    img.src = URL.createObjectURL(blob);

  } catch (e) {
    toast('加载照片失败: ' + e.message, true);
  }
}

// ==================== 方案一：浏览器本地 AI 抠图 ====================

let imglyModulePromise = null;

function loadImgly() {
  if (!imglyModulePromise) {
    imglyModulePromise = import(new URL('/vendor/imgly/index.mjs', location.href));
  }
  return imglyModulePromise;
}

// 资源 key → 友好名称
function resourceLabel(key) {
  if (key.includes('isnet_quint8')) return 'AI 模型';
  if (key.includes('.wasm')) return 'AI 推理引擎';
  if (key.includes('.mjs')) return 'AI 推理引擎';
  return key;
}

function showAIStatus(mainText) {
  const statusEl = document.getElementById('idp-ai-status');
  statusEl.style.display = 'flex';
  document.getElementById('idp-ai-status-text').textContent = mainText;
  document.getElementById('idp-progress-bar').style.width = '0%';
  document.getElementById('idp-progress-detail').textContent = '';
}

function hideAIStatus() {
  document.getElementById('idp-ai-status').style.display = 'none';
}

async function processWithAILocal() {
  if (!idPhotoState.sourceFile) return;

  idPhotoState.isProcessing = true;
  showAIStatus('本地 AI 正在抠图（照片不离开本机）');
  const bar = document.getElementById('idp-progress-bar');
  const detail = document.getElementById('idp-progress-detail');

  try {
    const { removeBackground } = await loadImgly();
    const blob = await removeBackground(idPhotoState.sourceFile, {
      publicPath: new URL('/vendor/imgly/', location.href).href,
      model: 'small',   // isnet_quint8 量化模型，44MB，证件照场景质量足够
      device: 'gpu',    // 优先 WebGPU（jsep），不支持时库自动回退 CPU
      progress: (key, current, total) => {
        const pct = Math.round((current / total) * 100);
        bar.style.width = pct + '%';
        detail.textContent = `下载${resourceLabel(key)}：${current}/${total}`;
      },
    });
    // 下载完成后进入推理阶段
    bar.style.width = '100%';
    detail.textContent = 'AI 推理中，请稍候…';

    await applyProcessedBlob(blob, 'local');
    toast('本地 AI 抠图完成');
  } catch (e) {
    console.error('本地 AI 抠图失败:', e);
    idPhotoState.processedImg = null;
    idPhotoState.processedBlob = null;
    idPhotoState.cutoutMode = null;
    toast('本地 AI 抠图失败，已切换原图模式：' + (e?.message ?? e), true);
  } finally {
    idPhotoState.isProcessing = false;
    hideAIStatus();
  }
}

// 重新本地抠图
async function reprocessLocal() {
  if (!idPhotoState.sourceFile) {
    toast('请先上传照片', true);
    return;
  }
  await processWithAILocal();
  initIdPhotoCrop();
  updateIdPhotoResult();
}

// 加载抠图结果 Blob 为 Image 并写入状态
function applyProcessedBlob(blob, mode) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      idPhotoState.processedBlob = blob;
      idPhotoState.processedImg = img;
      idPhotoState.cutoutMode = mode;
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('抠图结果无法解码'));
    };
    img.src = url;
  });
}

// ==================== 方案二：云端 BiRefNet 精修（进阶独立入口） ====================

// 将图片绘制到 canvas 并输出 data URI（限制最长边，减小上传体积）
function imageToDataUri(img, maxEdge, type = 'image/jpeg', quality = 0.92) {
  let { width, height } = img;
  if (Math.max(width, height) > maxEdge) {
    const s = maxEdge / Math.max(width, height);
    width = Math.round(width * s);
    height = Math.round(height * s);
  }
  const c = document.createElement('canvas');
  c.width = width;
  c.height = height;
  c.getContext('2d').drawImage(img, 0, 0, width, height);
  return c.toDataURL(type, quality);
}

async function cloudRefine() {
  if (!idPhotoState.sourceImg) {
    toast('请先上传照片', true);
    return;
  }
  if (idPhotoState.isProcessing) return;

  const ok = window.confirm(
    '云端精修会将原始照片上传到云端 AI（BiRefNet）处理，发丝边缘更精细。\n\n' +
    '免费额度：每天 15 张，管理员不限。\n\n是否继续？'
  );
  if (!ok) return;

  idPhotoState.isProcessing = true;
  showAIStatus('云端 AI 精修中（上传原图 → BiRefNet）');
  const bar = document.getElementById('idp-progress-bar');
  const detail = document.getElementById('idp-progress-detail');
  const btn = document.getElementById('idp-cloud-refine');
  btn.disabled = true;

  try {
    bar.style.width = '20%';
    detail.textContent = '压缩图片…';
    const dataUri = imageToDataUri(idPhotoState.sourceImg, 2048);

    bar.style.width = '40%';
    detail.textContent = '上传并等待云端处理（约 10~30 秒）…';
    const headers = { 'Content-Type': 'application/json' };
    const adminToken = getAdminToken();
    if (adminToken) headers.Authorization = 'Bearer ' + adminToken;

    const resp = await fetch(window.API_BASE + '/idphoto/cloud-cutout', {
      method: 'POST',
      headers,
      body: JSON.stringify({ image: dataUri }),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    bar.style.width = '90%';
    detail.textContent = '接收精修结果…';

    const blob = await resp.blob();
    await applyProcessedBlob(blob, 'cloud');
    bar.style.width = '100%';

    const remaining = resp.headers.get('X-Quota-Remaining');
    toast(remaining && remaining !== 'unlimited'
      ? `云端精修完成，今日剩余 ${remaining} 张`
      : '云端精修完成');

    // 云端结果边缘与本地不同，重新初始化裁剪框
    initIdPhotoCrop();
    updateIdPhotoResult();
  } catch (e) {
    console.error('云端精修失败:', e);
    toast('云端精修失败：' + (e?.message ?? e), true);
  } finally {
    idPhotoState.isProcessing = false;
    btn.disabled = false;
    hideAIStatus();
  }
}

// ==================== 裁剪功能 ====================

function initIdPhotoCrop() {
  const canvas = document.getElementById('idp-crop-canvas');
  const ctx = canvas.getContext('2d');
  // 使用抠图后的图片（如果有）或原图
  const img = idPhotoState.processedImg || idPhotoState.sourceImg;
  const spec = ID_SPECS[idPhotoState.spec];

  // 计算显示尺寸（最大宽度 500px）
  const maxW = 500;
  const scale = Math.min(maxW / img.width, maxW / img.height);
  canvas.width = img.width * scale;
  canvas.height = img.height * scale;

  // 如果有透明背景，先填充浅色棋盘底以便预览
  if (idPhotoState.processedImg) {
    ctx.fillStyle = '#f0f0f0';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // 初始裁剪区域（居中，按规格比例）
  const ratio = spec.ratio;
  let cropW, cropH;
  if (canvas.width / canvas.height > ratio) {
    cropH = canvas.height * 0.8;
    cropW = cropH * ratio;
  } else {
    cropW = canvas.width * 0.8;
    cropH = cropW / ratio;
  }
  idPhotoState.cropW = cropW;
  idPhotoState.cropH = cropH;
  idPhotoState.cropX = (canvas.width - cropW) / 2;
  idPhotoState.cropY = (canvas.height - cropH) / 2;

  updateCropOverlay();
}

function updateIdPhotoCrop() {
  const spec = ID_SPECS[idPhotoState.spec];
  const ratio = spec.ratio;
  const canvas = document.getElementById('idp-crop-canvas');

  // 保持中心，调整尺寸
  const centerX = idPhotoState.cropX + idPhotoState.cropW / 2;
  const centerY = idPhotoState.cropY + idPhotoState.cropH / 2;

  let newW = idPhotoState.cropW;
  let newH = newW / ratio;
  if (newH > canvas.height) {
    newH = canvas.height * 0.9;
    newW = newH * ratio;
  }
  if (newW > canvas.width) {
    newW = canvas.width * 0.9;
    newH = newW / ratio;
  }

  idPhotoState.cropW = newW;
  idPhotoState.cropH = newH;
  idPhotoState.cropX = Math.max(0, Math.min(canvas.width - newW, centerX - newW / 2));
  idPhotoState.cropY = Math.max(0, Math.min(canvas.height - newH, centerY - newH / 2));

  updateCropOverlay();
}

function updateCropOverlay() {
  const box = document.getElementById('idp-crop-box');
  box.style.left = idPhotoState.cropX + 'px';
  box.style.top = idPhotoState.cropY + 'px';
  box.style.width = idPhotoState.cropW + 'px';
  box.style.height = idPhotoState.cropH + 'px';
}

function initCropInteraction() {
  const box = document.getElementById('idp-crop-box');
  const container = document.getElementById('idp-crop-container');
  const canvas = document.getElementById('idp-crop-canvas');
  let isDragging = false, isResizing = false;
  let startX, startY, startLeft, startTop, startW, startH;
  let handle = null;

  box.addEventListener('mousedown', startDrag);
  box.addEventListener('touchstart', startDrag, { passive: false });

  function startDrag(e) {
    e.preventDefault();
    const t = e.target;
    if (t.classList.contains('idp-crop-handle')) {
      isResizing = true;
      handle = t.className.match(/(nw|ne|sw|se)/)[0];
    } else {
      isDragging = true;
    }
    const pos = getPos(e);
    startX = pos.x;
    startY = pos.y;
    startLeft = idPhotoState.cropX;
    startTop = idPhotoState.cropY;
    startW = idPhotoState.cropW;
    startH = idPhotoState.cropH;

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }

  function onMove(e) {
    e.preventDefault();
    const pos = getPos(e);
    const dx = pos.x - startX;
    const dy = pos.y - startY;
    const spec = ID_SPECS[idPhotoState.spec];
    const ratio = spec.ratio;

    if (isDragging) {
      idPhotoState.cropX = clamp(startLeft + dx, 0, canvas.width - idPhotoState.cropW);
      idPhotoState.cropY = clamp(startTop + dy, 0, canvas.height - idPhotoState.cropH);
    } else if (isResizing) {
      let newW = startW, newH = startH;
      if (handle === 'se') {
        newW = clamp(startW + dx, 50, canvas.width - startLeft);
        newH = newW / ratio;
        if (startTop + newH > canvas.height) {
          newH = canvas.height - startTop;
          newW = newH * ratio;
        }
      } else if (handle === 'sw') {
        newW = clamp(startW - dx, 50, startLeft + startW);
        newH = newW / ratio;
        if (startTop + newH > canvas.height) {
          newH = canvas.height - startTop;
          newW = newH * ratio;
        }
        idPhotoState.cropX = startLeft + startW - newW;
      } else if (handle === 'ne') {
        newW = clamp(startW + dx, 50, canvas.width - startLeft);
        newH = newW / ratio;
        if (startTop + startH - newH < 0) {
          newH = startTop + startH;
          newW = newH * ratio;
        }
        idPhotoState.cropY = startTop + startH - newH;
      } else if (handle === 'nw') {
        newW = clamp(startW - dx, 50, startLeft + startW);
        newH = newW / ratio;
        if (startTop + startH - newH < 0) {
          newH = startTop + startH;
          newW = newH * ratio;
        }
        idPhotoState.cropX = startLeft + startW - newW;
        idPhotoState.cropY = startTop + startH - newH;
      }
      idPhotoState.cropW = newW;
      idPhotoState.cropH = newH;
    }
    updateCropOverlay();
    updateIdPhotoResult();
  }

  function onEnd() {
    isDragging = false;
    isResizing = false;
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onEnd);
    document.removeEventListener('touchmove', onMove);
    document.removeEventListener('touchend', onEnd);
  }

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return {
      x: clientX - rect.left,
      y: clientY - rect.top,
    };
  }

  // 滚轮缩放
  container.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.95 : 1.05;
    const spec = ID_SPECS[idPhotoState.spec];
    const ratio = spec.ratio;
    const centerX = idPhotoState.cropX + idPhotoState.cropW / 2;
    const centerY = idPhotoState.cropY + idPhotoState.cropH / 2;

    let newW = clamp(idPhotoState.cropW * delta, 50, canvas.width);
    let newH = newW / ratio;
    if (newH > canvas.height) {
      newH = canvas.height;
      newW = newH * ratio;
    }

    idPhotoState.cropW = newW;
    idPhotoState.cropH = newH;
    idPhotoState.cropX = clamp(centerX - newW / 2, 0, canvas.width - newW);
    idPhotoState.cropY = clamp(centerY - newH / 2, 0, canvas.height - newH);

    updateCropOverlay();
    updateIdPhotoResult();
  }, { passive: false });
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ==================== 更新结果 ====================

function updateIdPhotoResult() {
  // 使用抠图后的图片（如果有）或原图
  const img = idPhotoState.processedImg || idPhotoState.sourceImg;
  if (!img) return;

  const spec = ID_SPECS[idPhotoState.spec];
  const resultCanvas = document.getElementById('idp-result-canvas');
  if (!resultCanvas) return;
  const resultCtx = resultCanvas.getContext('2d');

  // 设置输出尺寸
  resultCanvas.width = spec.w;
  resultCanvas.height = spec.h;

  // 填充背景色
  resultCtx.fillStyle = idPhotoState.bgColor;
  resultCtx.fillRect(0, 0, spec.w, spec.h);

  // 计算裁剪区域在原图上的映射
  const canvas = document.getElementById('idp-crop-canvas');
  const scaleX = img.width / canvas.width;
  const scaleY = img.height / canvas.height;

  const sx = idPhotoState.cropX * scaleX;
  const sy = idPhotoState.cropY * scaleY;
  const sw = idPhotoState.cropW * scaleX;
  const sh = idPhotoState.cropH * scaleY;

  // 应用滤镜
  resultCtx.filter = `brightness(${idPhotoState.brightness}%) contrast(${idPhotoState.contrast}%) saturate(${idPhotoState.saturate}%)`;

  // 绘制裁剪后的图像
  resultCtx.drawImage(img, sx, sy, sw, sh, 0, 0, spec.w, spec.h);

  // 重置滤镜
  resultCtx.filter = 'none';

  // 引擎标记
  const badge = document.getElementById('idp-engine-badge');
  if (badge) {
    if (idPhotoState.cutoutMode === 'cloud') {
      badge.textContent = '· 云端精修';
      badge.style.color = 'var(--primary, #438EDB)';
      badge.style.fontSize = '12px';
    } else if (idPhotoState.cutoutMode === 'local') {
      badge.textContent = '· 本地 AI';
      badge.style.color = 'var(--muted)';
      badge.style.fontSize = '12px';
    } else {
      badge.textContent = '· 原图模式';
      badge.style.color = 'var(--muted)';
      badge.style.fontSize = '12px';
    }
  }
}

// ==================== 下载与保存 ====================

function downloadIdPhoto() {
  const canvas = document.getElementById('idp-result-canvas');
  const spec = ID_SPECS[idPhotoState.spec];
  const link = document.createElement('a');
  link.download = `证件照_${idPhotoState.spec}_${spec.w}x${spec.h}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  toast('已开始下载');
}

async function saveIdPhotoToAlbum() {
  // 先让用户选择相册
  const data = await api('GET', '/albums');
  if (!data.albums.length) {
    toast('还没有相册，请先创建', true);
    return;
  }

  const albumOptions = data.albums.map(a =>
    `<option value="${a.id}">${esc(a.name)}</option>`
  ).join('');

  promptModal('保存到相册', `
    <div class="field">
      <label>选择相册</label>
      <select id="f-album" style="width:100%;padding:10px;border:1px solid var(--border);border-radius:10px;background:var(--bg-soft);color:var(--text)">
        ${albumOptions}
      </select>
    </div>
    <div class="field">
      <label>文件名</label>
      <input id="f-filename" value="证件照_${idPhotoState.spec}_${new Date().toISOString().slice(0,10)}.png">
    </div>
  `, async (m) => {
    const albumId = m.querySelector('#f-album').value;
    const filename = m.querySelector('#f-filename').value.trim() || '证件照.png';

    // 获取 Canvas Blob
    const canvas = document.getElementById('idp-result-canvas');
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));

    // 走现有上传流程
    const r = await api('POST', `/albums/${albumId}/photos`, {
      filename,
      contentType: 'image/png',
    });

    const put = await fetch(r.uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': 'image/png' },
    });
    if (!put.ok) throw { message: '直传 R2 失败' };
    await api('POST', `/photos/${r.photoId}/confirm`);

    toast('已保存到相册');
    render();
  }, '保存');
}

function resetIdPhoto() {
  idPhotoState.brightness = 100;
  idPhotoState.contrast = 100;
  idPhotoState.saturate = 100;
  idPhotoState.bgColor = '#ffffff';
  idPhotoState.spec = '1寸';
  idPhotoState.processedImg = null;
  idPhotoState.processedBlob = null;
  idPhotoState.cutoutMode = null;

  document.getElementById('idp-brightness').value = 100;
  document.getElementById('idp-brightness-val').textContent = '100%';
  document.getElementById('idp-contrast').value = 100;
  document.getElementById('idp-contrast-val').textContent = '100%';
  document.getElementById('idp-saturate').value = 100;
  document.getElementById('idp-saturate-val').textContent = '100%';
  document.getElementById('idp-custom-color').value = '#ffffff';

  // 重置规格按钮
  document.querySelectorAll('#idp-specs .btn').forEach((b, i) => {
    b.classList.toggle('primary', i === 0);
  });
  document.querySelectorAll('.idp-color-btn').forEach((b, i) => {
    b.classList.toggle('active', i === 0);
  });

  initIdPhotoCrop();
  updateIdPhotoResult();
  toast('已重置');
}

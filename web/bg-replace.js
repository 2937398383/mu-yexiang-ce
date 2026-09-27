/* 牧野云相册 - 更换背景
 * 双引擎 AI 抠图（复用证件照能力）：
 *   方案一（默认）：浏览器本地 AI（@imgly/background-removal，ISNet 量化模型）
 *   方案二（进阶）：云端 BiRefNet 精修（Cloudflare Images segment=foreground）
 * 抠图后与新背景图在浏览器端 Canvas 合成，不上传服务器，零成本。
 * 背景来源：内置默认图 / 本地上传 / 从云相册选择
 */
'use strict';

// ==================== 状态 ====================

const bgState = {
  // 前景（人物照）
  sourceImg: null,
  sourceFile: null,
  sourceType: 'local',
  sourceDataUrl: null,
  processedImg: null,     // 抠图后的透明 PNG
  processedBlob: null,
  cutoutMode: null,       // null | 'local' | 'cloud'
  isProcessing: false,
  albumPhotos: [],
  albums: [],
  currentAlbumId: null,
  // 背景
  bgImg: null,
  bgType: 'default',      // 'default' | 'local' | 'album'
  bgDataUrl: null,
  bgFit: 'cover',         // 'cover' | 'contain' | 'stretch'
  bgBlur: 0,              // px
  bgOpacity: 100,         // %
  bgAlbumPhotos: [],
  bgAlbums: [],
  bgCurrentAlbumId: null,
  // 前景调整
  brightness: 100,
  contrast: 100,
  saturate: 100,
};

const DEFAULT_BG = '/bg-default.jpg';

// ==================== 页面渲染 ====================

function renderBgReplace() {
  const adminMode = isAdmin();
  $view.innerHTML = `
    <div class="page-head">
      <h1>更换背景</h1>
      <div class="page-actions">
        <a class="btn" href="#/albums">← 返回相册</a>
      </div>
    </div>
    <p style="color:var(--muted);font-size:13px;margin-bottom:16px">
      AI 抠出人物后合成到新背景。默认使用<strong>浏览器本地 AI</strong>，照片不离开本机；需发丝级精细边缘可用<strong>云端精修</strong>（与证件照共用每日额度）。
      ${adminMode ? '管理员可保存到相册。' : ''}
    </p>

    <!-- 前景照片来源 -->
    <div class="idp-section">
      <label class="idp-label">选择人物照片</label>
      <div class="idp-source-tabs">
        <button class="btn small ${bgState.sourceType === 'local' ? 'primary' : ''}" data-source="local">本地上传</button>
        <button class="btn small ${bgState.sourceType === 'album' ? 'primary' : ''}" data-source="album">从相册选择</button>
      </div>
    </div>

    <div id="bg-upload-area" class="idp-upload-area" style="display:${bgState.sourceType === 'local' ? 'block' : 'none'}">
      <input type="file" id="bg-file" accept="image/*" hidden>
      <div class="idp-upload-hint">
        <p>点击或拖拽上传人物照片</p>
        <p style="font-size:12px;color:var(--muted);margin-top:8px">建议主体清晰、与背景有一定区分度</p>
      </div>
    </div>

    <div id="bg-album-picker" class="idp-album-picker" style="display:${bgState.sourceType === 'album' ? 'block' : 'none'}">
      <select id="bg-album-select" class="idp-album-select" title="选择相册"></select>
      <div class="idp-album-list" id="bg-album-list">
        <p style="color:var(--muted);text-align:center;padding:40px 0">点击上方"从相册选择"加载照片</p>
      </div>
    </div>

    <!-- AI 处理状态 -->
    <div id="bg-ai-status" class="idp-ai-status" style="display:none">
      <div class="idp-loading">
        <div class="idp-spinner"></div>
        <p id="bg-ai-status-text">AI 处理中…</p>
        <div class="idp-progress"><div class="idp-progress-bar" id="bg-progress-bar"></div></div>
        <p id="bg-progress-detail" style="font-size:12px;color:var(--muted);margin-top:6px"></p>
      </div>
    </div>

    <!-- 编辑器 -->
    <div id="bg-editor" style="display:${bgState.sourceImg ? 'block' : 'none'}">

      <div class="idp-section">
        <label class="idp-label">已选照片</label>
        <div class="st-source-preview">
          <img id="bg-source" alt="选中的原图">
        </div>
      </div>

      <!-- 抠图操作 -->
      <div class="idp-section">
        <label class="idp-label">AI 抠图</label>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button type="button" class="btn primary" id="bg-cutout-local">🧠 本地 AI 抠图</button>
          <button type="button" class="btn" id="bg-cutout-cloud">☁️ 云端精修</button>
          <span id="bg-cutout-badge" style="align-self:center;color:var(--muted);font-size:12px"></span>
        </div>
      </div>

      <!-- 背景选择 -->
      <div class="idp-section">
        <label class="idp-label">选择背景</label>
        <div class="bg-tabs">
          <button type="button" class="btn small ${bgState.bgType === 'default' ? 'primary' : ''}" data-bg="default">内置背景</button>
          <button type="button" class="btn small ${bgState.bgType === 'local' ? 'primary' : ''}" data-bg="local">本地上传</button>
          <button type="button" class="btn small ${bgState.bgType === 'album' ? 'primary' : ''}" data-bg="album">从相册选</button>
        </div>

        <div id="bg-default-area" style="display:${bgState.bgType === 'default' ? 'block' : 'none'};margin-top:10px">
          <div class="bg-default-card">
            <img src="${DEFAULT_BG}" alt="默认背景">
            <span>默认背景</span>
          </div>
        </div>

        <div id="bg-local-area" style="display:${bgState.bgType === 'local' ? 'block' : 'none'};margin-top:10px">
          <input type="file" id="bg-local-file" accept="image/*" hidden>
          <div class="idp-upload-area" id="bg-local-upload" style="padding:20px">
            <div class="idp-upload-hint"><p>点击或拖拽上传背景图</p></div>
          </div>
        </div>

        <div id="bg-album-area" style="display:${bgState.bgType === 'album' ? 'block' : 'none'};margin-top:10px">
          <select id="bg-album-select2" class="idp-album-select" title="选择背景相册"></select>
          <div class="idp-album-list" id="bg-album-list2" style="margin-top:8px">
            <p style="color:var(--muted);text-align:center;padding:24px 0">请先选择相册</p>
          </div>
        </div>
      </div>

      <!-- 背景调整 -->
      <div class="idp-section">
        <label class="idp-label">背景调整</label>
        <div class="idp-adjust">
          <div class="idp-slider">
            <span>填充方式</span>
            <select id="bg-fit" style="flex:1;padding:6px;border:1px solid var(--border);border-radius:8px;background:var(--bg-soft);color:var(--text)">
              <option value="cover" ${bgState.bgFit === 'cover' ? 'selected' : ''}>铺满（cover）</option>
              <option value="contain" ${bgState.bgFit === 'contain' ? 'selected' : ''}>适应（contain）</option>
              <option value="stretch" ${bgState.bgFit === 'stretch' ? 'selected' : ''}>拉伸（stretch）</option>
            </select>
          </div>
          <div class="idp-slider">
            <span>模糊</span>
            <input type="range" id="bg-blur" min="0" max="30" value="${bgState.bgBlur}">
            <span id="bg-blur-val">${bgState.bgBlur}px</span>
          </div>
          <div class="idp-slider">
            <span>不透明度</span>
            <input type="range" id="bg-opacity" min="10" max="100" value="${bgState.bgOpacity}">
            <span id="bg-opacity-val">${bgState.bgOpacity}%</span>
          </div>
        </div>
      </div>

      <!-- 前景调整 -->
      <div class="idp-section">
        <label class="idp-label">人物调整</label>
        <div class="idp-adjust">
          <div class="idp-slider">
            <span>亮度</span>
            <input type="range" id="bg-brightness" min="50" max="150" value="${bgState.brightness}">
            <span id="bg-brightness-val">${bgState.brightness}%</span>
          </div>
          <div class="idp-slider">
            <span>对比度</span>
            <input type="range" id="bg-contrast" min="50" max="150" value="${bgState.contrast}">
            <span id="bg-contrast-val">${bgState.contrast}%</span>
          </div>
          <div class="idp-slider">
            <span>饱和度</span>
            <input type="range" id="bg-saturate" min="0" max="200" value="${bgState.saturate}">
            <span id="bg-saturate-val">${bgState.saturate}%</span>
          </div>
        </div>
      </div>

      <!-- 合成预览 -->
      <div class="idp-section">
        <label class="idp-label">合成预览</label>
        <div class="bg-result-container">
          <canvas id="bg-result-canvas"></canvas>
          <p id="bg-result-hint" style="text-align:center;color:var(--muted);font-size:12px;margin-top:8px"></p>
        </div>
      </div>

      <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
        <button type="button" class="btn primary" id="bg-download">⬇️ 下载图片</button>
        ${adminMode ? '<button type="button" class="btn" id="bg-save-album">保存到相册</button>' : ''}
        <button type="button" class="btn ghost" id="bg-repick">换一张照片</button>
      </div>
    </div>
  `;

  initBgEvents();

  // 恢复已选照片
  if (bgState.sourceDataUrl) {
    const srcEl = document.getElementById('bg-source');
    if (srcEl) srcEl.src = bgState.sourceDataUrl;
  }
  // 恢复抠图标记
  updateCutoutBadge();

  // 默认背景自动加载
  if (bgState.bgType === 'default') loadDefaultBg();

  updateBgResult();

  // 从大图查看器带 ?photo=<id> 直接进入
  const query = location.hash.split('?')[1];
  const qs = query ? new URLSearchParams(query) : null;
  const directPhotoId = qs ? qs.get('photo') : null;
  const directAlbumId = qs ? qs.get('album') : null;
  if (directPhotoId && !bgState.sourceImg) {
    bgLoadPhotoFromId(directPhotoId, directAlbumId)
      .catch(e => toast('照片加载失败: ' + e.message, true));
  }
}

// ==================== 事件绑定 ====================

function initBgEvents() {
  // 前景来源切换
  const tabs = document.querySelectorAll('[data-source]');
  tabs.forEach(btn => {
    btn.addEventListener('click', () => {
      bgState.sourceType = btn.dataset.source;
      tabs.forEach(b => b.classList.toggle('primary', b === btn));
      document.getElementById('bg-upload-area').style.display = bgState.sourceType === 'local' ? 'block' : 'none';
      document.getElementById('bg-album-picker').style.display = bgState.sourceType === 'album' ? 'block' : 'none';
      if (bgState.sourceType === 'album') bgLoadAlbumPhotos();
    });
  });

  // 本地上传
  const uploadArea = document.getElementById('bg-upload-area');
  const fileInput = document.getElementById('bg-file');
  uploadArea.addEventListener('click', () => fileInput.click());
  uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); });
  uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
  uploadArea.addEventListener('drop', (e) => {
    e.preventDefault(); uploadArea.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('image/')) bgLoadFile(f);
  });
  fileInput.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) bgLoadFile(f);
    e.target.value = '';
  });

  // 抠图
  document.getElementById('bg-cutout-local').addEventListener('click', bgCutoutLocal);
  document.getElementById('bg-cutout-cloud').addEventListener('click', bgCutoutCloud);

  // 背景来源切换
  document.querySelectorAll('[data-bg]').forEach(btn => {
    btn.addEventListener('click', () => {
      bgState.bgType = btn.dataset.bg;
      document.querySelectorAll('[data-bg]').forEach(b => b.classList.toggle('primary', b === btn));
      document.getElementById('bg-default-area').style.display = bgState.bgType === 'default' ? 'block' : 'none';
      document.getElementById('bg-local-area').style.display = bgState.bgType === 'local' ? 'block' : 'none';
      document.getElementById('bg-album-area').style.display = bgState.bgType === 'album' ? 'block' : 'none';
      if (bgState.bgType === 'default') loadDefaultBg();
      else if (bgState.bgType === 'album') bgLoadBgAlbumPhotos();
    });
  });

  // 背景本地上传
  const bgLocalUpload = document.getElementById('bg-local-upload');
  const bgLocalFile = document.getElementById('bg-local-file');
  if (bgLocalUpload) {
    bgLocalUpload.addEventListener('click', () => bgLocalFile.click());
    bgLocalUpload.addEventListener('dragover', (e) => { e.preventDefault(); bgLocalUpload.classList.add('dragover'); });
    bgLocalUpload.addEventListener('dragleave', () => bgLocalUpload.classList.remove('dragover'));
    bgLocalUpload.addEventListener('drop', (e) => {
      e.preventDefault(); bgLocalUpload.classList.remove('dragover');
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) bgLoadBgFile(f);
    });
    bgLocalFile.addEventListener('change', (e) => {
      const f = e.target.files[0];
      if (f) bgLoadBgFile(f);
      e.target.value = '';
    });
  }

  // 背景调整
  document.getElementById('bg-fit').addEventListener('change', (e) => { bgState.bgFit = e.target.value; updateBgResult(); });
  document.getElementById('bg-blur').addEventListener('input', (e) => {
    bgState.bgBlur = +e.target.value;
    document.getElementById('bg-blur-val').textContent = bgState.bgBlur + 'px';
    updateBgResult();
  });
  document.getElementById('bg-opacity').addEventListener('input', (e) => {
    bgState.bgOpacity = +e.target.value;
    document.getElementById('bg-opacity-val').textContent = bgState.bgOpacity + '%';
    updateBgResult();
  });

  // 前景调整
  document.getElementById('bg-brightness').addEventListener('input', (e) => {
    bgState.brightness = +e.target.value;
    document.getElementById('bg-brightness-val').textContent = bgState.brightness + '%';
    updateBgResult();
  });
  document.getElementById('bg-contrast').addEventListener('input', (e) => {
    bgState.contrast = +e.target.value;
    document.getElementById('bg-contrast-val').textContent = bgState.contrast + '%';
    updateBgResult();
  });
  document.getElementById('bg-saturate').addEventListener('input', (e) => {
    bgState.saturate = +e.target.value;
    document.getElementById('bg-saturate-val').textContent = bgState.saturate + '%';
    updateBgResult();
  });

  // 下载 / 保存 / 换一张
  document.getElementById('bg-download').addEventListener('click', bgDownload);
  document.getElementById('bg-save-album')?.addEventListener('click', bgSaveToAlbum);
  document.getElementById('bg-repick').addEventListener('click', bgReset);
}

// ==================== 加载前景照片 ====================

function bgLoadFile(file) {
  bgState.sourceFile = file;
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      bgState.sourceImg = img;
      bgState.sourceDataUrl = e.target.result;
      // 换照片时清空抠图结果
      bgState.processedImg = null;
      bgState.processedBlob = null;
      bgState.cutoutMode = null;
      document.getElementById('bg-source').src = e.target.result;
      document.getElementById('bg-upload-area').style.display = 'none';
      document.getElementById('bg-album-picker').style.display = 'none';
      document.getElementById('bg-editor').style.display = 'block';
      updateCutoutBadge();
      updateBgResult();
      window.scrollTo({ top: document.getElementById('bg-editor').offsetTop - 20, behavior: 'smooth' });
    };
    img.onerror = () => toast('图片无法读取，请换一张试试', true);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

async function bgLoadPhotoFromId(photoId, albumId) {
  toast('正在加载照片...');
  const { url } = await api('GET', `/photos/${photoId}/url`, null, albumId);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const blob = await resp.blob();
  bgLoadFile(new File([blob], 'photo.jpg', { type: blob.type || 'image/jpeg' }));
}

// ==================== 前景相册选择 ====================

async function bgLoadAlbumPhotos() {
  const listEl = document.getElementById('bg-album-list');
  const selectEl = document.getElementById('bg-album-select');
  listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">加载中…</p>';
  try {
    const { albums } = await api('GET', '/albums');
    bgState.albums = albums;
    if (!albums.length) {
      selectEl.style.display = 'none';
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">暂无相册</p>';
      return;
    }
    selectEl.style.display = '';
    selectEl.innerHTML = '<option value="">请选择相册…</option>' +
      albums.map(a => `<option value="${a.id}">${esc(a.name)}${a.locked ? ' 🔒' : ''}</option>`).join('');

    const prevId = bgState.currentAlbumId;
    if (albums.some(a => a.id === prevId)) {
      selectEl.value = prevId;
      await bgLoadPhotosFromAlbum(prevId);
    } else {
      selectEl.value = '';
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">请先在上方选择相册</p>';
    }
    selectEl.onchange = async () => {
      const id = selectEl.value;
      if (!id) return;
      const ok = await bgLoadPhotosFromAlbum(id);
      if (!ok) selectEl.value = bgState.currentAlbumId || '';
    };
  } catch (e) {
    listEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:40px 0">加载失败：${esc(e.message)}</p>`;
  }
}

async function bgLoadPhotosFromAlbum(albumId, isRetry = false) {
  const listEl = document.getElementById('bg-album-list');
  const album = bgState.albums.find(a => a.id === albumId);
  if (!album) return false;

  if (album.locked && !isAdmin() && !getUnlockToken(albumId)) {
    const ok = await promptAlbumPassword(albumId, album.name);
    if (!ok) return false;
  }

  try {
    listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">加载中…</p>';
    const { photos } = await api('GET', `/albums/${albumId}/photos`, null, albumId);
    bgState.currentAlbumId = albumId;
    bgState.albumPhotos = photos.map(p => ({ ...p, albumId, albumName: album.name }));

    if (!photos.length) {
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:40px 0">该相册暂无照片</p>';
      return true;
    }
    listEl.innerHTML = `<div class="idp-photo-grid">${photos.map(p => `
      <div class="idp-photo-item" data-photo-id="${p.id}">
        <img src="${p.thumbUrl}" alt="${esc(p.filename)}" loading="lazy">
        <div class="idp-photo-info"><span class="idp-photo-name">${esc(p.filename)}</span></div>
      </div>`).join('')}</div>`;
    listEl.querySelectorAll('.idp-photo-item').forEach(item => {
      item.addEventListener('click', () => bgPickFromAlbum(item.dataset.photoId));
    });
    return true;
  } catch (e) {
    if (e.status === 403 && !isRetry) {
      sessionStorage.removeItem('unlock_' + albumId);
      return bgLoadPhotosFromAlbum(albumId, true);
    }
    listEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:40px 0">加载失败：${esc(e.message)}</p>`;
    return false;
  }
}

async function bgPickFromAlbum(photoId) {
  const photo = bgState.albumPhotos.find(p => p.id === photoId);
  if (!photo) return toast('照片信息已过期，请重新加载列表', true);
  try {
    toast('正在加载照片…');
    const { url } = await api('GET', `/photos/${photoId}/url`, null, photo.albumId);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    bgLoadFile(new File([blob], photo.filename || 'album.jpg', { type: blob.type || 'image/jpeg' }));
  } catch (e) {
    toast('加载照片失败：' + e.message, true);
  }
}

// ==================== 抠图（复用证件照双引擎） ====================

function showBgAIStatus(text) {
  const el = document.getElementById('bg-ai-status');
  el.style.display = 'flex';
  document.getElementById('bg-ai-status-text').textContent = text;
  document.getElementById('bg-progress-bar').style.width = '0%';
  document.getElementById('bg-progress-detail').textContent = '';
}
function hideBgAIStatus() {
  document.getElementById('bg-ai-status').style.display = 'none';
}

async function bgCutoutLocal() {
  if (!bgState.sourceFile) return toast('请先选择照片', true);
  if (bgState.isProcessing) return;

  bgState.isProcessing = true;
  showBgAIStatus('本地 AI 正在抠图（照片不离开本机）');
  const bar = document.getElementById('bg-progress-bar');
  const detail = document.getElementById('bg-progress-detail');

  try {
    const { removeBackground } = await loadImgly();
    const blob = await removeBackground(bgState.sourceFile, {
      publicPath: new URL('/vendor/imgly/', location.href).href,
      model: 'small',
      device: 'gpu', // 优先 WebGPU（jsep），不支持时库自动回退 CPU
      progress: (key, current, total) => {
        const pct = Math.round((current / total) * 100);
        bar.style.width = pct + '%';
        detail.textContent = `下载${resourceLabel(key)}：${current}/${total}`;
      },
    });
    bar.style.width = '100%';
    detail.textContent = 'AI 推理中，请稍候…';
    await bgApplyCutout(blob, 'local');
    toast('本地 AI 抠图完成');
  } catch (e) {
    console.error('本地 AI 抠图失败:', e);
    bgState.processedImg = null;
    bgState.processedBlob = null;
    bgState.cutoutMode = null;
    updateCutoutBadge();
    toast('本地 AI 抠图失败：' + (e?.message ?? e), true);
  } finally {
    bgState.isProcessing = false;
    hideBgAIStatus();
  }
}

async function bgCutoutCloud() {
  if (!bgState.sourceImg) return toast('请先选择照片', true);
  if (bgState.isProcessing) return;

  const ok = window.confirm(
    '云端精修会将照片上传到云端 AI 处理，发丝边缘更精细。\n\n' +
    '免费额度：每天 15 张（与证件照共用），管理员不限。\n\n是否继续？'
  );
  if (!ok) return;

  bgState.isProcessing = true;
  showBgAIStatus('云端 AI 精修中');
  const bar = document.getElementById('bg-progress-bar');
  const detail = document.getElementById('bg-progress-detail');

  try {
    bar.style.width = '20%'; detail.textContent = '压缩图片…';
    const dataUri = imageToDataUri(bgState.sourceImg, 2048);
    bar.style.width = '40%'; detail.textContent = '上传并等待云端处理…';

    const headers = { 'Content-Type': 'application/json' };
    const adminToken = getAdminToken();
    if (adminToken) headers.Authorization = 'Bearer ' + adminToken;

    const resp = await fetch(window.API_BASE + '/idphoto/cloud-cutout', {
      method: 'POST', headers, body: JSON.stringify({ image: dataUri }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${resp.status}`);
    }
    bar.style.width = '90%'; detail.textContent = '接收精修结果…';
    const blob = await resp.blob();
    await bgApplyCutout(blob, 'cloud');
    bar.style.width = '100%';

    const remaining = resp.headers.get('X-Quota-Remaining');
    toast(remaining && remaining !== 'unlimited'
      ? `云端精修完成，今日剩余 ${remaining} 张`
      : '云端精修完成');
  } catch (e) {
    console.error('云端精修失败:', e);
    toast('云端精修失败：' + (e?.message ?? e), true);
  } finally {
    bgState.isProcessing = false;
    hideBgAIStatus();
  }
}

function bgApplyCutout(blob, mode) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      bgState.processedBlob = blob;
      bgState.processedImg = img;
      bgState.cutoutMode = mode;
      URL.revokeObjectURL(url);
      updateCutoutBadge();
      updateBgResult();
      resolve();
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('抠图结果无法解码')); };
    img.src = url;
  });
}

function updateCutoutBadge() {
  const badge = document.getElementById('bg-cutout-badge');
  if (!badge) return;
  if (bgState.cutoutMode === 'cloud') badge.textContent = '· 已云端精修';
  else if (bgState.cutoutMode === 'local') badge.textContent = '· 已本地抠图';
  else badge.textContent = '· 未抠图（将直接使用原图）';
}

// ==================== 背景加载 ====================

function loadDefaultBg() {
  if (bgState.bgImg && bgState.bgType === 'default') return;
  const img = new Image();
  img.onload = () => {
    bgState.bgImg = img;
    bgState.bgDataUrl = DEFAULT_BG;
    updateBgResult();
  };
  img.onerror = () => toast('默认背景加载失败', true);
  img.src = DEFAULT_BG;
}

function bgLoadBgFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      bgState.bgImg = img;
      bgState.bgDataUrl = e.target.result;
      updateBgResult();
      toast('背景已更新');
    };
    img.onerror = () => toast('背景图无法读取', true);
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

// 背景：从相册选择
async function bgLoadBgAlbumPhotos() {
  const listEl = document.getElementById('bg-album-list2');
  const selectEl = document.getElementById('bg-album-select2');
  listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px 0">加载中…</p>';
  try {
    const { albums } = await api('GET', '/albums');
    bgState.bgAlbums = albums;
    if (!albums.length) {
      selectEl.style.display = 'none';
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px 0">暂无相册</p>';
      return;
    }
    selectEl.style.display = '';
    selectEl.innerHTML = '<option value="">请选择相册…</option>' +
      albums.map(a => `<option value="${a.id}">${esc(a.name)}${a.locked ? ' 🔒' : ''}</option>`).join('');

    const prevId = bgState.bgCurrentAlbumId;
    if (albums.some(a => a.id === prevId)) {
      selectEl.value = prevId;
      await bgLoadBgPhotosFromAlbum(prevId);
    } else {
      selectEl.value = '';
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px 0">请先选择相册</p>';
    }
    selectEl.onchange = async () => {
      const id = selectEl.value;
      if (!id) return;
      const ok = await bgLoadBgPhotosFromAlbum(id);
      if (!ok) selectEl.value = bgState.bgCurrentAlbumId || '';
    };
  } catch (e) {
    listEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:24px 0">加载失败：${esc(e.message)}</p>`;
  }
}

async function bgLoadBgPhotosFromAlbum(albumId, isRetry = false) {
  const listEl = document.getElementById('bg-album-list2');
  const album = bgState.bgAlbums.find(a => a.id === albumId);
  if (!album) return false;

  if (album.locked && !isAdmin() && !getUnlockToken(albumId)) {
    const ok = await promptAlbumPassword(albumId, album.name);
    if (!ok) return false;
  }

  try {
    listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px 0">加载中…</p>';
    const { photos } = await api('GET', `/albums/${albumId}/photos`, null, albumId);
    bgState.bgCurrentAlbumId = albumId;
    bgState.bgAlbumPhotos = photos.map(p => ({ ...p, albumId, albumName: album.name }));

    if (!photos.length) {
      listEl.innerHTML = '<p style="color:var(--muted);text-align:center;padding:24px 0">该相册暂无照片</p>';
      return true;
    }
    listEl.innerHTML = `<div class="idp-photo-grid">${photos.map(p => `
      <div class="idp-photo-item" data-photo-id="${p.id}">
        <img src="${p.thumbUrl}" alt="${esc(p.filename)}" loading="lazy">
        <div class="idp-photo-info"><span class="idp-photo-name">${esc(p.filename)}</span></div>
      </div>`).join('')}</div>`;
    listEl.querySelectorAll('.idp-photo-item').forEach(item => {
      item.addEventListener('click', () => bgPickBgFromAlbum(item.dataset.photoId));
    });
    return true;
  } catch (e) {
    if (e.status === 403 && !isRetry) {
      sessionStorage.removeItem('unlock_' + albumId);
      return bgLoadBgPhotosFromAlbum(albumId, true);
    }
    listEl.innerHTML = `<p style="color:var(--muted);text-align:center;padding:24px 0">加载失败：${esc(e.message)}</p>`;
    return false;
  }
}

async function bgPickBgFromAlbum(photoId) {
  const photo = bgState.bgAlbumPhotos.find(p => p.id === photoId);
  if (!photo) return toast('照片信息已过期', true);
  try {
    toast('正在加载背景…');
    const { url } = await api('GET', `/photos/${photoId}/url`, null, photo.albumId);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const blob = await resp.blob();
    bgLoadBgFile(new File([blob], photo.filename || 'bg.jpg', { type: blob.type || 'image/jpeg' }));
  } catch (e) {
    toast('加载背景失败：' + e.message, true);
  }
}

// ==================== 合成预览 ====================

function updateBgResult() {
  const canvas = document.getElementById('bg-result-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const hint = document.getElementById('bg-result-hint');

  const fg = bgState.processedImg || bgState.sourceImg;
  if (!fg) {
    canvas.width = 0; canvas.height = 0;
    return;
  }
  const bg = bgState.bgImg;

  // 输出尺寸：以前景原图为准，限制最长边 2000px
  const MAX_EDGE = 2000;
  let outW = fg.width, outH = fg.height;
  if (Math.max(outW, outH) > MAX_EDGE) {
    const s = MAX_EDGE / Math.max(outW, outH);
    outW = Math.round(outW * s);
    outH = Math.round(outH * s);
  }
  canvas.width = outW;
  canvas.height = outH;

  // 1. 绘制背景
  if (bg) {
    ctx.save();
    ctx.globalAlpha = bgState.bgOpacity / 100;
    if (bgState.bgBlur > 0) ctx.filter = `blur(${bgState.bgBlur}px)`;

    if (bgState.bgFit === 'stretch') {
      ctx.drawImage(bg, 0, 0, outW, outH);
    } else {
      // cover 或 contain：等比缩放
      const scale = bgState.bgFit === 'cover'
        ? Math.max(outW / bg.width, outH / bg.height)
        : Math.min(outW / bg.width, outH / bg.height);
      const dw = bg.width * scale;
      const dh = bg.height * scale;
      const dx = (outW - dw) / 2;
      const dy = (outH - dh) / 2;
      ctx.drawImage(bg, dx, dy, dw, dh);
    }
    ctx.restore();
  } else {
    // 无背景时棋盘格提示
    ctx.fillStyle = '#444';
    ctx.fillRect(0, 0, outW, outH);
  }

  // 2. 绘制前景（抠图结果或原图）
  ctx.save();
  ctx.filter = `brightness(${bgState.brightness}%) contrast(${bgState.contrast}%) saturate(${bgState.saturate}%)`;
  ctx.drawImage(fg, 0, 0, outW, outH);
  ctx.restore();

  // 提示
  if (bgState.cutoutMode) {
    hint.textContent = bgState.cutoutMode === 'cloud' ? '已使用云端精修抠图' : '已使用本地 AI 抠图';
  } else if (bgState.sourceImg) {
    hint.textContent = '尚未抠图，人物将与原背景一起显示；建议先点击「本地 AI 抠图」';
  }
}

// ==================== 下载 / 保存 / 重置 ====================

function bgDownload() {
  const canvas = document.getElementById('bg-result-canvas');
  if (!canvas || !canvas.width) return toast('请先选择照片', true);
  const link = document.createElement('a');
  link.download = `换背景_${new Date().toISOString().slice(0, 10)}.png`;
  link.href = canvas.toDataURL('image/png');
  link.click();
  toast('已开始下载');
}

async function bgSaveToAlbum() {
  const canvas = document.getElementById('bg-result-canvas');
  if (!canvas || !canvas.width) return toast('请先选择照片', true);

  let data;
  try {
    data = await api('GET', '/albums');
  } catch (e) {
    return toast(e.message, true);
  }
  if (!data.albums.length) return toast('还没有相册，请先创建', true);

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
      <input id="f-filename" value="换背景_${new Date().toISOString().slice(0, 10)}.png">
    </div>
  `, async (m) => {
    const albumId = m.querySelector('#f-album').value;
    const filename = m.querySelector('#f-filename').value.trim() || '换背景.png';
    const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
    const mime = 'image/png';

    const r = await api('POST', `/albums/${albumId}/photos`, { filename, contentType: mime });
    const put = await fetch(r.uploadUrl, {
      method: 'PUT', body: blob, headers: { 'Content-Type': mime },
    });
    if (!put.ok) throw { message: '直传 R2 失败' };
    await api('POST', `/photos/${r.photoId}/confirm`);
    toast('已保存到相册');
  }, '保存');
}

function bgReset() {
  bgState.sourceImg = null;
  bgState.sourceFile = null;
  bgState.sourceDataUrl = null;
  bgState.processedImg = null;
  bgState.processedBlob = null;
  bgState.cutoutMode = null;
  document.getElementById('bg-editor').style.display = 'none';
  document.getElementById('bg-upload-area').style.display = bgState.sourceType === 'local' ? 'block' : 'none';
  document.getElementById('bg-album-picker').style.display = bgState.sourceType === 'album' ? 'block' : 'none';
  if (bgState.sourceType === 'album') bgLoadAlbumPhotos();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

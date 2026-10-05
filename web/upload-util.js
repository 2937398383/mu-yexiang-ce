/* 牧野云相册 - 上传辅助工具
 * 1. extractExif(file)：从照片提取拍摄时间 / 机型 / GPS（exifr，失败静默降级）
 * 2. makeThumbnails(file)：一次解码产出两张缩略图
 *      small 400px 长边（网格用） / large 1600px 长边（预留）
 *    现代浏览器 createImageBitmap 自动按 EXIF 转正；大比例缩小分步减半保画质；
 *    Safari/iOS 无 WebP 编码器，自动回退 JPEG。
 */
// ---------- WebP 编码能力探测（页面生命周期缓存） ----------

let webpSupportPromise = null;

export function supportsWebpEncoding() {
  if (!webpSupportPromise) {
    webpSupportPromise = new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      c.toBlob((b) => resolve(!!b && b.type === 'image/webp'), 'image/webp');
    });
  }
  return webpSupportPromise;
}

// ---------- EXIF 提取 ----------

/**
 * 从 File 提取 EXIF
 * @returns {Promise<{takenAt:?string, camera:?string, gpsLat:?number, gpsLng:?number, exif:?object}>}
 */
export async function extractExif(file) {
  const out = { takenAt: null, camera: null, gpsLat: null, gpsLng: null, exif: null };
  if (!window.exifr) return out;
  let exif = null;
  try {
    exif = await window.exifr.parse(file);
  } catch {
    return out;
  }
  if (!exif) return out;

  // 拍摄时间：Date 实例，做合理性校验
  const d = exif.DateTimeOriginal;
  if (d instanceof Date && !isNaN(d)) {
    const t = d.getTime();
    if (t > Date.parse('1990-01-01') && t < Date.now() + 86_400_000) {
      out.takenAt = d.toISOString();
    }
  }

  // 机型：Make + Model（Model 常以 Make 开头，去重）
  const make = String(exif.Make ?? '').replace(/\0/g, '').trim();
  let model = String(exif.Model ?? '').replace(/\0/g, '').trim();
  if (make && model.toLowerCase().startsWith(make.toLowerCase())) {
    model = model.slice(make.length).trim();
  }
  const camera = [make, model].filter(Boolean).join(' ').slice(0, 120);
  if (camera) out.camera = camera;

  // GPS：exifr 自动换算成带符号十进制度数
  const lat = Number(exif.latitude);
  const lng = Number(exif.longitude);
  if (Number.isFinite(lat) && Number.isFinite(lng)
    && Math.abs(lat) <= 90 && Math.abs(lng) <= 180
    && (lat !== 0 || lng !== 0)) {
    out.gpsLat = lat;
    out.gpsLng = lng;
  }

  // 曝光参数（快门/光圈/ISO/焦距/镜头/闪光灯），用于查看器 EXIF 详情
  const e = {};
  const fnum = Number(exif.FNumber);
  if (Number.isFinite(fnum) && fnum > 0 && fnum < 100) e.aperture = Math.round(fnum * 10) / 10;
  const expo = Number(exif.ExposureTime);
  if (Number.isFinite(expo) && expo > 0 && expo < 3600) e.exposureTime = expo;
  const iso = Number(exif.ISO ?? exif.PhotographicSensitivity);
  if (Number.isFinite(iso) && iso > 0 && iso < 1000000) e.iso = Math.round(iso);
  const focal = Number(exif.FocalLength);
  if (Number.isFinite(focal) && focal > 0 && focal < 10000) e.focalLength = focal;
  const lens = String(exif.LensModel ?? '').replace(/\0/g, '').trim();
  if (lens) e.lensModel = lens.slice(0, 120);
  if (exif.Flash !== undefined && exif.Flash !== null) e.flash = Number(exif.Flash) & 1 ? 1 : 0;
  if (Object.keys(e).length) out.exif = e;

  return out;
}

// ---------- 缩略图生成 ----------

export function fitLongEdge(w, h, edge) {
  if (Math.max(w, h) <= edge) return { w, h }; // 小图不放大
  const s = edge / Math.max(w, h);
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

// 解码：显式要求按 EXIF 转正；旧浏览器（Safari15/iOS15）回退默认选项
export async function decodeBitmap(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    try {
      return await createImageBitmap(file);
    } catch {
      return null; // HEIC 在非 Apple 桌面浏览器等情况
    }
  }
}

// 等比缩放绘制；缩小倍数 >2 时分步减半，画质更好
export function drawScaled(source, sw, sh, dw, dh) {
  let cv = document.createElement('canvas');
  cv.width = sw; cv.height = sh;
  let ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, sw, sh);

  while (Math.max(sw, sh) > Math.max(dw, dh) * 2) {
    const nw = Math.max(1, Math.round(sw / 2));
    const nh = Math.max(1, Math.round(sh / 2));
    const next = document.createElement('canvas');
    next.width = nw; next.height = nh;
    const nctx = next.getContext('2d');
    nctx.imageSmoothingEnabled = true;
    nctx.imageSmoothingQuality = 'high';
    nctx.drawImage(cv, 0, 0, nw, nh);
    cv.width = cv.height = 0;
    cv = next; sw = nw; sh = nh;
  }

  const out = document.createElement('canvas');
  out.width = dw; out.height = dh;
  const octx = out.getContext('2d');
  octx.imageSmoothingEnabled = true;
  octx.imageSmoothingQuality = 'high';
  octx.drawImage(cv, 0, 0, dw, dh);
  cv.width = cv.height = 0;
  return out;
}

export async function encodeCanvas(canvas, webpQuality, jpegQuality) {
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  if (await supportsWebpEncoding()) {
    const b = await toBlob('image/webp', webpQuality);
    // 双保险：个别环境会静默回退 image/png
    if (b && b.type === 'image/webp') return b;
  }
  return toBlob('image/jpeg', jpegQuality);
}

// ---------- AVIF 编码（比 WebP 再小约 30%，仅 Chrome/Edge 支持编码） ----------

let avifSupportPromise = null;

export function supportsAvifEncoding() {
  if (!avifSupportPromise) {
    avifSupportPromise = new Promise((resolve) => {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      c.toBlob((b) => resolve(!!b && b.type === 'image/avif'), 'image/avif');
    });
  }
  return avifSupportPromise;
}

// 编码 AVIF；浏览器不支持或静默回退其他格式时返回 null（WebP/JPEG 兜底）
export async function encodeAvif(canvas, quality) {
  const toBlob = (q) => new Promise((r) => canvas.toBlob(r, 'image/avif', q));
  const b = await toBlob(quality);
  return (b && b.type === 'image/avif') ? b : null;
}

// ---------- ThumbHash 模糊占位 ----------

// 从已有 canvas 缩到 ≤100px 后编码 thumbhash（零额外解码成本）
// @returns {?string} base64 编码的 thumbhash（失败返回 null，不阻断上传）
export function computeThumbHash(canvas) {
  try {
    if (!window.ThumbHash || !canvas || !canvas.width || !canvas.height) return null;
    const s = fitLongEdge(canvas.width, canvas.height, 100);
    const cv = document.createElement('canvas');
    cv.width = s.w; cv.height = s.h;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(canvas, 0, 0, s.w, s.h);
    const { data } = ctx.getImageData(0, 0, s.w, s.h);
    const hash = window.ThumbHash.rgbaToThumbHash(s.w, s.h, data);
    cv.width = cv.height = 0;
    // Uint8Array → base64
    let bin = '';
    for (let i = 0; i < hash.length; i++) bin += String.fromCharCode(hash[i]);
    return btoa(bin);
  } catch {
    return null;
  }
}

/**
 * 生成两张缩略图 + thumbhash 占位 + （可选）AVIF 网格缩略图
 * @returns {Promise<{small:?Blob, large:?Blob, smallAvif:?Blob, thumbHash:?string}>}
 *   解码失败时 small/large 为 null，不阻断原图上传；AVIF 仅网格小图生成（省编码耗时），大图仍用 WebP/JPEG
 */
export async function makeThumbnails(file) {
  const bitmap = await decodeBitmap(file);
  if (!bitmap) return { small: null, large: null, smallAvif: null, thumbHash: null };
  try {
    const s = fitLongEdge(bitmap.width, bitmap.height, 400);
    const l = fitLongEdge(bitmap.width, bitmap.height, 1600);
    const cvSmall = drawScaled(bitmap, bitmap.width, bitmap.height, s.w, s.h);
    const cvLarge = drawScaled(bitmap, bitmap.width, bitmap.height, l.w, l.h);
    const thumbHash = computeThumbHash(cvSmall);
    const [small, large] = await Promise.all([
      encodeCanvas(cvSmall, 0.8, 0.85),
      encodeCanvas(cvLarge, 0.85, 0.92),
    ]);
    // AVIF 网格缩略图：支持 AVIF 编码的浏览器（Chrome/Edge）产出，Safari 自动跳过（WebP 兜底）
    let smallAvif = null;
    if (await supportsAvifEncoding()) {
      smallAvif = await encodeAvif(cvSmall, 0.6);
    }
    cvSmall.width = cvSmall.height = 0;
    cvLarge.width = cvLarge.height = 0;
    return { small, large, smallAvif, thumbHash };
  } finally {
    bitmap.close();
  }
}

// ---------- 视频抽帧 ----------

// 等待事件（带超时）
export function waitEvent(el, eventName, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout: ' + eventName));
    }, timeout);
    function cleanup() {
      clearTimeout(timer);
      el.removeEventListener(eventName, onEvent);
    }
    function onEvent() { cleanup(); resolve(); }
    el.addEventListener(eventName, onEvent);
  });
}

// 等下一帧真正可绘制（requestVideoFrameCallback 优先）；失败兜底超时
export function waitFrameReady(video) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 3000);
    if (typeof video.requestVideoFrameCallback === 'function') {
      video.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
    } else {
      resolve();
    }
  });
}

/**
 * 从视频文件抽取封面帧并生成两张缩略图（统一 JPEG）+ thumbhash
 * HEVC/浏览器无法解码时会抛错，由调用方按"无缩略图"处理
 * @returns {Promise<{small:?Blob, large:?Blob, duration:number, thumbHash:?string}>}
 */
export async function captureVideoFrame(file) {
  const out = { small: null, large: null, duration: 0, thumbHash: null };
  const objectUrl = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = objectUrl;
  try {
    await waitEvent(video, 'loadedmetadata');
    const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
    out.duration = duration;
    // 取 1 秒或片长 10% 处（避免片头黑屏）
    const target = duration > 0 ? Math.min(1, duration * 0.1) : 0;
    if (Math.abs(video.currentTime - target) > 0.05) {
      video.currentTime = target;
      await waitEvent(video, 'seeked');
    }
    await waitFrameReady(video);
    if (!video.videoWidth || !video.videoHeight) throw new Error('video has no decodable frame');

    const s = fitLongEdge(video.videoWidth, video.videoHeight, 400);
    const l = fitLongEdge(video.videoWidth, video.videoHeight, 1600);
    const cvSmall = drawScaled(video, video.videoWidth, video.videoHeight, s.w, s.h);
    const cvLarge = drawScaled(video, video.videoWidth, video.videoHeight, l.w, l.h);
    out.thumbHash = computeThumbHash(cvSmall);
    const toJpeg = (canvas, q) => new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
    const [small, large] = await Promise.all([
      toJpeg(cvSmall, 0.85),
      toJpeg(cvLarge, 0.9),
    ]);
    cvSmall.width = cvSmall.height = 0;
    cvLarge.width = cvLarge.height = 0;
    out.small = small;
    out.large = large;
    return out;
  } finally {
    video.pause();
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(objectUrl);
  }
}

// ---------- HEIC / HEIF（iPhone 默认格式，多数浏览器无法原生解码） ----------

export function isHeicFile(file) {
  return /image\/hei(c|f)/i.test(file.type) || /\.(heic|heif)$/i.test(file.name || '');
}

let heicLoading = null;

// 按需动态加载 heic2any（libheif WASM 内嵌，约 1.3MB，不拖慢首屏）
export function loadHeic2Any() {
  if (window.heic2any) return Promise.resolve();
  if (!heicLoading) {
    heicLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'vendor/heic2any/heic2any.min.js';
      s.onload = () => (window.heic2any ? resolve() : reject(new Error('HEIC 组件初始化失败')));
      s.onerror = () => reject(new Error('HEIC 组件加载失败'));
      document.head.appendChild(s);
    });
  }
  return heicLoading;
}

/**
 * HEIC/HEIF → JPEG；非 HEIC 文件原样返回
 * 注意：必须在转换前提取 EXIF（转码后元数据可能丢失）；多页 HEIC 取第一页
 * @returns {Promise<File>}
 */
export async function ensureJpeg(file) {
  if (!isHeicFile(file)) return file;
  await loadHeic2Any();
  const blob = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
  const out = Array.isArray(blob) ? blob[0] : blob;
  const base = (file.name || 'photo').replace(/\.(heic|heif)$/i, '');
  return new File([out], base + '.jpg', { type: 'image/jpeg', lastModified: Date.now() });
}

// ---------- 感知哈希 dHash（9×8 灰度→相邻比较→64-bit hex） ----------
// 用于重复照片检测：汉明距离 < 8 视为相似
export async function computeDHash(imageBlob) {
  try {
    const img = await createImageBitmap(imageBlob);
    const c = document.createElement('canvas');
    c.width = 9; c.height = 8;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, 9, 8);
    const { data } = ctx.getImageData(0, 0, 9, 8);
    // 灰度
    const gray = new Array(72);
    for (let i = 0; i < 72; i++) {
      gray[i] = (data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114) | 0;
    }
    // 每行 9 像素 → 8 个相邻比较；共 8 行 × 8 = 64 位
    let bits = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const idx = row * 9 + col;
        bits += gray[idx] > gray[idx + 1] ? '1' : '0';
      }
    }
    // 64 位二进制 → 16 位 hex
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    }
    img.close?.();
    return hex;
  } catch {
    return null;
  }
}

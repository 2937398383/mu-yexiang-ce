/* 牧野云相册 - 上传辅助工具
 * 1. extractExif(file)：从照片提取拍摄时间 / 机型 / GPS（exifr，失败静默降级）
 * 2. makeThumbnails(file)：一次解码产出两张缩略图
 *      small 400px 长边（网格用） / large 1600px 长边（预留）
 *    现代浏览器 createImageBitmap 自动按 EXIF 转正；大比例缩小分步减半保画质；
 *    Safari/iOS 无 WebP 编码器，自动回退 JPEG。
 */
'use strict';

// ---------- WebP 编码能力探测（页面生命周期缓存） ----------

let webpSupportPromise = null;

function supportsWebpEncoding() {
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
 * @returns {Promise<{takenAt:?string, camera:?string, gpsLat:?number, gpsLng:?number}>}
 */
async function extractExif(file) {
  const out = { takenAt: null, camera: null, gpsLat: null, gpsLng: null };
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
  return out;
}

// ---------- 缩略图生成 ----------

function fitLongEdge(w, h, edge) {
  if (Math.max(w, h) <= edge) return { w, h }; // 小图不放大
  const s = edge / Math.max(w, h);
  return { w: Math.round(w * s), h: Math.round(h * s) };
}

// 解码：显式要求按 EXIF 转正；旧浏览器（Safari15/iOS15）回退默认选项
async function decodeBitmap(file) {
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
function drawScaled(source, sw, sh, dw, dh) {
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

async function encodeCanvas(canvas, webpQuality, jpegQuality) {
  const toBlob = (type, q) => new Promise((r) => canvas.toBlob(r, type, q));
  if (await supportsWebpEncoding()) {
    const b = await toBlob('image/webp', webpQuality);
    // 双保险：个别环境会静默回退 image/png
    if (b && b.type === 'image/webp') return b;
  }
  return toBlob('image/jpeg', jpegQuality);
}

/**
 * 生成两张缩略图
 * @returns {Promise<{small:?Blob, large:?Blob}>} 解码失败时均为 null，不阻断原图上传
 */
async function makeThumbnails(file) {
  const bitmap = await decodeBitmap(file);
  if (!bitmap) return { small: null, large: null };
  try {
    const s = fitLongEdge(bitmap.width, bitmap.height, 400);
    const l = fitLongEdge(bitmap.width, bitmap.height, 1600);
    const cvSmall = drawScaled(bitmap, bitmap.width, bitmap.height, s.w, s.h);
    const cvLarge = drawScaled(bitmap, bitmap.width, bitmap.height, l.w, l.h);
    const [small, large] = await Promise.all([
      encodeCanvas(cvSmall, 0.8, 0.85),
      encodeCanvas(cvLarge, 0.85, 0.92),
    ]);
    cvSmall.width = cvSmall.height = 0;
    cvLarge.width = cvLarge.height = 0;
    return { small, large };
  } finally {
    bitmap.close();
  }
}

// ---------- 视频抽帧 ----------

// 等待事件（带超时）
function waitEvent(el, eventName, timeout = 15000) {
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
function waitFrameReady(video) {
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
 * 从视频文件抽取封面帧并生成两张缩略图（统一 JPEG）
 * HEVC/浏览器无法解码时会抛错，由调用方按"无缩略图"处理
 * @returns {Promise<{small:?Blob, large:?Blob, duration:number}>}
 */
async function captureVideoFrame(file) {
  const out = { small: null, large: null, duration: 0 };
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

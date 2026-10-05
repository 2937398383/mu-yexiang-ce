// js/enc.js — 加密相册密钥管理与密文解密（端到端：明文只存在于浏览器内存）
// 从 app.js 抽出（S5-Batch3）；依赖 crypto-core 的底层原语与 js/api 的 token 管理

import {
  enc_b64url, enc_b64urlDecode, enc_importKey, enc_deriveKEK, enc_unwrapAlbumKey,
  enc_decryptMeta, enc_decryptStream, enc_decryptFileKey, enc_decryptBlob,
} from '../crypto-core.js';
import { api, saveToken } from './api.js';

export const ENC_ALBUM_KEY_PREFIX = 'albumkey_';
export const encAlbumKeyCache = new Map(); // albumId -> CryptoKey

// 相册主密钥会话缓存：解锁/创建后以 raw base64 存 sessionStorage（与解锁 token 同生命周期）
export async function encGetAlbumKey(albumId) {
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

export async function encSetAlbumKey(albumId, albumKey) {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', albumKey));
  sessionStorage.setItem(ENC_ALBUM_KEY_PREFIX + albumId, enc_b64url(raw));
  encAlbumKeyCache.set(albumId, albumKey);
}

export function hasEncAlbumKey(albumId) {
  return !!sessionStorage.getItem(ENC_ALBUM_KEY_PREFIX + albumId);
}

// 解锁加密相册：服务端只返回被 KEK 包裹的相册主密钥 + 派生参数，口令校验在本地完成
export async function encUnlockAndStore(albumId, password, ttoken) {
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
export function encGetFileKeyCached(p, albumKey) {
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
export function encGetMetaCached(p, fileKey) {
  if (!p._meta) p._meta = enc_decryptMeta(fileKey, p.encMeta);
  return p._meta;
}

// 把解密后的元数据合并进照片对象，供信息栏/网格显示
export async function encHydratePhoto(p, albumId) {
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
export async function encLoadOriginal(p, albumId) {
  const albumKey = await encGetAlbumKey(albumId);
  if (!albumKey) throw { message: '相册未解锁' };
  const fileKey = await encGetFileKeyCached(p, albumKey);
  const { meta, nonceBase } = await encGetMetaCached(p, fileKey);
  const url = p.url || await window.freshPhotoUrl(p); // 路由层函数，app.js 挂载
  const resp = await fetch(url);
  if (!resp.ok) throw { message: '下载密文失败' };
  const ct = new Uint8Array(await resp.arrayBuffer());
  const pt = await enc_decryptStream(fileKey, nonceBase, ct, meta.chunks);
  return { blobUrl: URL.createObjectURL(new Blob([pt], { type: meta.contentType })), meta };
}

// 解密缩略图 → 设置 img.src（grid 用）
export async function encLoadThumb(p, imgEl, albumId) {
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
export function encBuildMeta(file, uploadBlob, exif, thumbs, isVideo, duration, chunks) {
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


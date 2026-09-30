/* 牧野云相册 Service Worker
 * 策略：
 *   静态资源（同源 + 白名单 CDN）→ stale-while-revalidate（缓存秒回 + 后台静默更新，防旧版滞留）
 *   GET /api/albums（相册列表）→ 网络优先，失败回缓存（离线可看列表骨架）
 *   其余 API / R2 直链 → 仅网络（照片数据量大且 URL 会过期，不缓存）
 */
'use strict';

const VERSION = 'v15';
const STATIC_CACHE = `album-static-${VERSION}`;
const API_CACHE = `album-api-${VERSION}`;
const THUMB_CACHE = `album-thumb-${VERSION}`;

// 核心静态资源（相对路径，安装时预缓存；ort/大文件不预缓存，用到了再运行时缓存）
const PRECACHE = [
  './',
  'index.html',
  'style.css',
  'config.js',
  'app.js',
  'upload-util.js',
  'idphoto.js',
  'style-transfer.js',
  'bg-replace.js',
  'bg-default.jpg',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/exifr/lite.umd.js',
  'vendor/qrcode/qrcode.min.js',
  'vendor/thumbhash/thumbhash.js',
  'vendor/browser-image-compression.js',
  'vendor/jszip.min.js',
];

// 静态资源全部同源（已无第三方 CDN 脚本），走 stale-while-revalidate
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(STATIC_CACHE)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => ![STATIC_CACHE, API_CACHE, THUMB_CACHE].includes(k))
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  // API：只缓存相册列表（网络优先）；其余 API 不干预
  if (url.pathname.startsWith('/api/')) {
    if (url.pathname === '/api/albums') {
      e.respondWith(networkFirst(request, API_CACHE));
    }
    return;
  }

  // R2 预签名直链：缩略图内容不可变（key 固定），用 ignoreSearch 匹配
  // 使同一缩略图在签名过期换新 URL 后仍能命中缓存；原图体积大不缓存
  if (url.search.includes('X-Amz-Signature')) {
    if (/\.(s|m)\.(webp|jpg|jpeg|png)$/i.test(url.pathname)) {
      e.respondWith(thumbCacheFirst(request));
    }
    return;
  }

  // 静态资源：同源 → stale-while-revalidate
  if (url.origin === self.location.origin) {
    // 页面导航：网络优先（保证拿到新 HTML），离线回退缓存首页
    if (request.mode === 'navigate') {
      e.respondWith(
        fetch(request)
          .then((resp) => {
            const copy = resp.clone();
            caches.open(STATIC_CACHE).then((c) => c.put('./', copy));
            return resp;
          })
          .catch(() => caches.match('./'))
      );
      return;
    }
    e.respondWith(staleWhileRevalidate(request, STATIC_CACHE, e));
  }
});

// 缓存命中立即返回，同时后台拉取最新版更新缓存（下次加载生效）
async function staleWhileRevalidate(request, cacheName, e) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  const updating = fetch(request).then((resp) => {
    // 只缓存成功的基本/跨域 CORS 响应（opaque 不缓存，避免污染）
    if (resp.ok && (resp.type === 'basic' || resp.type === 'cors')) {
      cache.put(request, resp.clone());
    }
    return resp;
  });
  // 后台更新不阻断响应；失败（如离线）静默忽略
  if (e) e.waitUntil(updating.catch(() => {}));
  return hit || updating;
}

// R2 缩略图缓存：ignoreSearch 匹配（签名过期换新 URL 仍命中同一份内容）
async function thumbCacheFirst(request) {
  const cache = await caches.open(THUMB_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const resp = await fetch(request);
  if (resp.ok && (resp.type === 'basic' || resp.type === 'cors')) {
    cache.put(request, resp.clone());
  }
  return resp;
}

async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const resp = await fetch(request);
    if (resp.ok) cache.put(request, resp.clone());
    return resp;
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw new Error('离线且无缓存');
  }
}

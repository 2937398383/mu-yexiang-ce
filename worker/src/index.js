// 相册云存储 API —— Cloudflare Worker
// 绑定：env.R2（存储）、env.DB（D1 数据库）
// 密钥（wrangler secret）：ADMIN_PASSWORD、JWT_SECRET、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY
import { signJwt, getAuth, hashPassword } from './auth.js';
import { presignR2 } from './presign.js';
import { handleCloudCutout } from './idphoto.js';
import { handleStyleTransfer } from './style-transfer.js';
import { runBackfillBatch } from './backfill.js';
import {
  listTrash, restorePhoto, emptyTrashBatch, purgePhotos, runScheduledCleanup,
} from './trash.js';
import { checkLock, recordFailure, clearFailures } from './auth-guard.js';
import { createShare, listShares, revokeShare, redeemShare,
         collectHit, COLLECT_HOUR_LIMIT } from './share.js';
import { tagPhotoOnUpload, backfillTags } from './ai-tags.js';
import { backfillVideoPosters } from './video-thumb.js';
import { edgeGuard } from './edge-guard.js';

// ---------- 常量 ----------

const PHOTO_URL_TTL = 900;       // 浏览用预签名 URL：15 分钟
const UPLOAD_URL_TTL = 3600;     // 上传用预签名 URL：1 小时（大图上传慢）
const ALBUM_TOKEN_TTL = 1800;    // 相册解锁 token：30 分钟
const ADMIN_TOKEN_TTL = 43200;   // 管理员 token：12 小时
const IMG_EXT_WHITELIST = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'avif', 'svg',
]);
// 视频有限支持：原样存储不转码；MEDIA 绑定官方仅保证 H.264 MP4
const VIDEO_EXT_WHITELIST = new Set(['mp4', 'webm', 'mov', 'm4v']);
const VIDEO_MAX_SIZE = 500 * 1024 * 1024; // 建议单个视频 ≤500MB

// ---------- 基础工具 ----------

// CORS 白名单：仅对白名单来源回显 Origin
const ORIGIN_WHITELIST = new Set([
  'https://cdc2937398383qqcom.dpdns.org',
  'https://www.cdc2937398383qqcom.dpdns.org',
  'https://album-web.pages.dev',
  'http://localhost:8080',
]);

function allowedOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return null;
  if (ORIGIN_WHITELIST.has(origin)) return origin;
  // Pages 部署预览子域
  if (origin.startsWith('https://') && origin.endsWith('.album-web.pages.dev')) return origin;
  return null;
}

function withCors(resp, request) {
  const origin = request ? allowedOrigin(request) : null;
  if (origin) {
    resp.headers.set('Access-Control-Allow-Origin', origin);
    resp.headers.set('Vary', 'Origin');
    resp.headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    resp.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    resp.headers.set('Access-Control-Expose-Headers',
      'X-Quota-Remaining, X-Style, X-Tier');
    resp.headers.set('Access-Control-Max-Age', '86400');
  }
  return resp;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function fail(error, status = 400) {
  return json({ ok: false, error }, status);
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function isSixDigits(s) {
  return typeof s === 'string' && /^\d{6}$/.test(s);
}

function requireEnv(env) {
  const missing = [];
  if (!env.DB) missing.push('D1 绑定(DB)');
  if (!env.R2) missing.push('R2 绑定(R2)');
  if (!env.ADMIN_PASSWORD) missing.push('ADMIN_PASSWORD');
  if (!env.JWT_SECRET) missing.push('JWT_SECRET');
  if (!env.R2_ACCOUNT_ID || env.R2_ACCOUNT_ID.startsWith('TODO')) missing.push('R2_ACCOUNT_ID');
  if (!env.R2_ACCESS_KEY_ID) missing.push('R2_ACCESS_KEY_ID');
  if (!env.R2_SECRET_ACCESS_KEY) missing.push('R2_SECRET_ACCESS_KEY');
  return missing;
}

function isAdmin(auth) {
  return !!auth && auth.role === 'admin';
}

// 访问相册的条件：管理员 / 相册公开 / 持有该相册的解锁 token / 持有该相册的分享 token
function canAccessAlbum(auth, album) {
  if (isAdmin(auth)) return true;
  if (auth && auth.role === 'share' && auth.albumId === album.id) return true;
  if (!album.password_hash) return true;
  return !!auth && auth.role === 'album' && auth.albumId === album.id;
}

// ---------- 表结构迁移（幂等，每个 isolate 只跑一次） ----------

let photoSchemaEnsured = false;

async function ensurePhotoSchema(env) {
  if (photoSchemaEnsured) return;
  const newColumns = {
    thumb_key: 'TEXT', large_key: 'TEXT',
    taken_at: 'TEXT', camera: 'TEXT',
    gps_lat: 'REAL', gps_lng: 'REAL',
    trashed_at: 'TEXT',
    tags: 'TEXT',
    duration: 'INTEGER',
    sha256: 'TEXT',
  };
  const { results: cols } = await env.DB.prepare('PRAGMA table_info(photo)').all();
  const existing = new Set(cols.map((c) => c.name));
  for (const [name, type] of Object.entries(newColumns)) {
    if (!existing.has(name)) {
      await env.DB.prepare(`ALTER TABLE photo ADD COLUMN ${name} ${type}`).run();
    }
  }
  // kind 带默认值，需单独处理
  if (!existing.has('kind')) {
    await env.DB.prepare("ALTER TABLE photo ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'").run();
  }
  // album 表加自定义封面列
  const { results: albumCols } = await env.DB.prepare('PRAGMA table_info(album)').all();
  if (!albumCols.some((c) => c.name === 'cover_photo_id')) {
    await env.DB.prepare('ALTER TABLE album ADD COLUMN cover_photo_id TEXT').run();
  }
  // 登录/解锁失败计数表
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS auth_fail (
      scope        TEXT NOT NULL,
      ip           TEXT NOT NULL,
      fails        INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT,
      updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (scope, ip)
    )`
  ).run();
  // WHERE/ORDER BY 必须使用与此索引完全相同的表达式才能命中
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_photo_sort
     ON photo (COALESCE(taken_at, created_at) DESC, id DESC)`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_photo_trashed ON photo(status, trashed_at)`
  ).run();
  // 相册分享链接（kind: album 整相册 | photo 单张 | collect 求照片上传收集）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS share_link (
      id            TEXT PRIMARY KEY,
      album_id      TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at    TEXT NOT NULL,
      revoked       INTEGER NOT NULL DEFAULT 0,
      note          TEXT,
      kind          TEXT NOT NULL DEFAULT 'album',
      photo_id      TEXT,
      password_hash TEXT
    )`
  ).run();
  // 老库 share_link 补列
  const { results: shareCols } = await env.DB.prepare('PRAGMA table_info(share_link)').all();
  const shareExisting = new Set(shareCols.map((c) => c.name));
  const shareNewColumns = {
    kind: "TEXT NOT NULL DEFAULT 'album'",
    photo_id: 'TEXT',
    password_hash: 'TEXT',
  };
  for (const [name, type] of Object.entries(shareNewColumns)) {
    if (!shareExisting.has(name)) {
      await env.DB.prepare(`ALTER TABLE share_link ADD COLUMN ${name} ${type}`).run();
    }
  }
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_share_album ON share_link(album_id)`
  ).run();
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_share_photo ON share_link(photo_id)`
  ).run();
  // 上传体哈希（同相册去重）
  await env.DB.prepare(
    `CREATE INDEX IF NOT EXISTS idx_photo_sha ON photo(album_id, sha256)`
  ).run();
  // AI 打标每日全局限额（Workers AI 免费 10000 neurons/天）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_tag_daily (
      day    TEXT PRIMARY KEY,
      count  INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
  // 全局限流计数（ip + 分钟窗口）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS rate_event (
      ip     TEXT NOT NULL,
      minute TEXT NOT NULL,
      count  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (ip, minute)
    )`
  ).run();
  // 求照片链接上传计数（每链接每 IP 每小时）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS collect_event (
      share_id TEXT NOT NULL,
      ip       TEXT NOT NULL,
      hour     TEXT NOT NULL,
      count    INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (share_id, ip, hour)
    )`
  ).run();
  photoSchemaEnsured = true;
}

// ---------- 鉴权 ----------

async function handleLogin(request, env) {
  // 静默锁定期：不暴露锁定状态，伪装成普通密码错误
  if (await checkLock(env, 'admin', request)) return fail('密码错误', 401);
  const body = await readJson(request);
  if (!body.password || body.password !== env.ADMIN_PASSWORD) {
    const r = await recordFailure(env, 'admin', request);
    await delay(500); // 拖慢密码爆破
    // 触发锁定时同样伪装
    return fail(r.locked ? '密码错误' : `密码错误，还可尝试 ${r.remaining} 次`, 401);
  }
  await clearFailures(env, 'admin', request);
  const token = await signJwt({ role: 'admin' }, env.JWT_SECRET, ADMIN_TOKEN_TTL);
  return json({ ok: true, token, expiresIn: ADMIN_TOKEN_TTL });
}

async function handleUnlock(request, env, albumId) {
  const album = await env.DB.prepare('SELECT id, password_hash FROM album WHERE id = ?')
    .bind(albumId).first();
  if (!album) return fail('相册不存在', 404);
  if (!album.password_hash) return json({ ok: true, token: null, note: '公开相册无需解锁' });

  const scope = `album:${albumId}`;
  // 静默锁定期：伪装成普通密码错误
  if (await checkLock(env, scope, request)) return fail('相册密码错误', 401);

  const body = await readJson(request);
  const hash = await hashPassword(String(body.password ?? ''));
  if (hash !== album.password_hash) {
    const r = await recordFailure(env, scope, request);
    await delay(800); // 6位数字空间小，必须拖慢遍历
    return fail(r.locked ? '相册密码错误' : `相册密码错误，还可尝试 ${r.remaining} 次`, 401);
  }
  await clearFailures(env, scope, request);
  const token = await signJwt({ role: 'album', albumId }, env.JWT_SECRET, ALBUM_TOKEN_TTL);
  return json({ ok: true, token, expiresIn: ALBUM_TOKEN_TTL });
}

// ---------- 相册 ----------

function albumView(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    photoCount: row.photo_count ?? 0,
    locked: !!row.password_hash,
    createdAt: row.created_at,
  };
}

async function listAlbums(request, env) {
  const auth = await getAuth(request, env);
  const admin = isAdmin(auth);
  // 封面选择：显式封面优先（失效则自动最新），与列表排序同规则
  const coverOrder =
    `ORDER BY CASE WHEN a.cover_photo_id IS NOT NULL AND cp.id = a.cover_photo_id
                     THEN 0 ELSE 1 END,
             COALESCE(cp.taken_at, cp.created_at) DESC, cp.id DESC
      LIMIT 1`;
  const { results } = await env.DB.prepare(
    `SELECT a.*,
       (SELECT COUNT(*) FROM photo p
         WHERE p.album_id = a.id AND p.status = 'ready') AS photo_count,
       (SELECT COALESCE(cp.thumb_key, cp.object_key) FROM photo cp
         WHERE cp.album_id = a.id AND cp.status = 'ready'
         ${coverOrder}) AS cover_key,
       (SELECT cp.id FROM photo cp
         WHERE cp.album_id = a.id AND cp.status = 'ready'
         ${coverOrder}) AS cover_id
     FROM album a ORDER BY a.created_at DESC`
  ).all();

  const albums = [];
  for (const row of results) {
    const v = albumView(row);
    // 加密相册对非管理员不签真实封面（列表无需解锁，防止内容泄露）
    const showReal = admin || !row.password_hash;
    v.coverUrl = showReal && row.cover_key
      ? await presignR2(env, 'GET', row.cover_key, PHOTO_URL_TTL) : null;
    v.coverIsAuto = !row.cover_photo_id || row.cover_id !== row.cover_photo_id;
    v.lockedCover = !!row.password_hash && !admin; // 前端显示锁形占位
    albums.push(v);
  }
  return json({
    ok: true,
    isAdmin: admin,
    albums,
  });
}

async function createAlbum(request, env) {
  const body = await readJson(request);
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 100) return fail('相册名必填且不超过100字');
  const description = String(body.description ?? '').trim().slice(0, 500);
  const id = crypto.randomUUID();
  const passwordHash = body.password != null
    ? (isSixDigits(body.password) ? await hashPassword(body.password) : null)
    : null;
  if (body.password != null && !isSixDigits(body.password)) return fail('密码必须是6位数字');
  await env.DB.prepare('INSERT INTO album (id, name, description, password_hash) VALUES (?, ?, ?, ?)')
    .bind(id, name, description, passwordHash).run();
  const row = await env.DB.prepare('SELECT *, 0 AS photo_count FROM album WHERE id = ?').bind(id).first();
  return json({ ok: true, album: albumView(row) }, 201);
}

async function updateAlbum(request, env, albumId) {
  const body = await readJson(request);
  const album = await env.DB.prepare('SELECT id FROM album WHERE id = ?').bind(albumId).first();
  if (!album) return fail('相册不存在', 404);
  const name = body.name != null ? String(body.name).trim() : null;
  if (name !== null && (!name || name.length > 100)) return fail('相册名不能为空且不超过100字');
  const description = body.description != null ? String(body.description).trim().slice(0, 500) : null;
  await env.DB.prepare('UPDATE album SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?')
    .bind(name, description, albumId).run();

  // coverPhotoId：字符串=指定照片；null=取消自定义恢复自动；undefined=不变
  if ('coverPhotoId' in body) {
    if (body.coverPhotoId == null) {
      await env.DB.prepare('UPDATE album SET cover_photo_id = NULL WHERE id = ?')
        .bind(albumId).run();
    } else {
      const cpId = String(body.coverPhotoId);
      const photo = await env.DB.prepare(
        "SELECT id FROM photo WHERE id = ? AND album_id = ? AND status = 'ready'"
      ).bind(cpId, albumId).first();
      if (!photo) return fail('封面照片不存在或不属于该相册');
      await env.DB.prepare('UPDATE album SET cover_photo_id = ? WHERE id = ?')
        .bind(cpId, albumId).run();
    }
  }
  return json({ ok: true });
}

async function deleteAlbum(request, env, albumId) {
  const album = await env.DB.prepare('SELECT id FROM album WHERE id = ?').bind(albumId).first();
  if (!album) return fail('相册不存在', 404);
  // 相册内全部照片移入回收站（已在回收站的保留原删除时间）；R2 对象不删
  const countRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photo WHERE album_id = ? AND status != 'trashed'`
  ).bind(albumId).first();
  await env.DB.prepare(
    `UPDATE photo
       SET status = 'trashed',
           trashed_at = COALESCE(trashed_at, datetime('now'))
      WHERE album_id = ?`
  ).bind(albumId).run();
  await env.DB.prepare('DELETE FROM album WHERE id = ?').bind(albumId).run();
  return json({ ok: true, movedPhotos: countRow?.n ?? 0 });
}

// ---------- 相册密码（单个 / 批量） ----------

async function setAlbumPassword(request, env, albumId) {
  const body = await readJson(request);
  if (!isSixDigits(body.password)) return fail('密码必须是6位数字');
  const album = await env.DB.prepare('SELECT id FROM album WHERE id = ?').bind(albumId).first();
  if (!album) return fail('相册不存在', 404);
  const hash = await hashPassword(body.password);
  await env.DB.prepare('UPDATE album SET password_hash = ? WHERE id = ?').bind(hash, albumId).run();
  return json({ ok: true });
}

async function clearAlbumPassword(request, env, albumId) {
  const result = await env.DB.prepare('UPDATE album SET password_hash = NULL WHERE id = ?')
    .bind(albumId).run();
  if (!result.meta.changes) return fail('相册不存在', 404);
  return json({ ok: true });
}

async function setAllAlbumPasswords(request, env) {
  const body = await readJson(request);
  if (!isSixDigits(body.password)) return fail('密码必须是6位数字');
  const hash = await hashPassword(body.password);
  const result = await env.DB.prepare('UPDATE album SET password_hash = ?').bind(hash).run();
  return json({ ok: true, updated: result.meta.changes });
}

async function clearAllAlbumPasswords(request, env) {
  const result = await env.DB.prepare('UPDATE album SET password_hash = NULL').run();
  return json({ ok: true, updated: result.meta.changes });
}

// ---------- 照片 ----------

// ---------- 游标编解码（base64url + JSON，客户端视为不透明字符串） ----------

function encodeCursor(sortAt, id) {
  const bytes = new TextEncoder().encode(JSON.stringify({ t: sortAt, i: id }));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeCursor(cursor) {
  const b64 = cursor.replace(/-/g, '+').replace(/_/g, '/');
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const o = JSON.parse(new TextDecoder().decode(bytes));
  if (!o || typeof o.t !== 'string' || typeof o.i !== 'string') throw new Error('bad cursor');
  return { t: o.t, i: o.i };
}

const SORT_EXPR = `COALESCE(taken_at, created_at)`; // 排序键，与 idx_photo_sort 表达式一致

async function listPhotos(request, env, albumId) {
  const album = await env.DB.prepare('SELECT * FROM album WHERE id = ?').bind(albumId).first();
  if (!album) return fail('相册不存在', 404);
  const auth = await getAuth(request, env);
  if (!canAccessAlbum(auth, album)) return fail('需要相册密码', 403);

  const reqUrl = new URL(request.url);
  let limit = parseInt(reqUrl.searchParams.get('limit') ?? '60', 10);
  if (!Number.isFinite(limit)) limit = 60;
  limit = Math.max(1, Math.min(100, limit));

  let cursor = null;
  const cursorParam = reqUrl.searchParams.get('cursor');
  if (cursorParam) {
    try {
      cursor = decodeCursor(cursorParam);
    } catch {
      return fail('无效的分页游标', 400);
    }
  }

  const selectCols =
    `SELECT id, filename, object_key, thumb_key, content_type, size, kind, duration,
            created_at, taken_at, camera, tags, ${SORT_EXPR} AS sort_at`;
  // missing=1：只列缺缩略图的照片（回填选择器用）
  const missingOnly = reqUrl.searchParams.get('missing') === '1';
  // 动态附加条件（保持参数化）
  const extraSql = [];
  const extraParams = [];
  if (missingOnly) extraSql.push('thumb_key IS NULL');
  // 单张分享：只能看到被分享的那一张（忽略分页游标）
  const singleShareId = auth.role === 'share' && auth.photoId ? auth.photoId : null;
  if (singleShareId) {
    extraSql.push('id = ?');
    extraParams.push(singleShareId);
  }
  const whereTail = extraSql.length ? ' AND ' + extraSql.join(' AND ') : '';
  let stmt;
  if (cursor && !singleShareId) {
    stmt = env.DB.prepare(
      `${selectCols} FROM photo
        WHERE album_id = ? AND status = 'ready'${whereTail}
          AND (${SORT_EXPR}, id) < (?, ?)
        ORDER BY ${SORT_EXPR} DESC, id DESC
        LIMIT ?`
    ).bind(albumId, ...extraParams, cursor.t, cursor.i, limit + 1);
  } else {
    stmt = env.DB.prepare(
      `${selectCols} FROM photo
        WHERE album_id = ? AND status = 'ready'${whereTail}
        ORDER BY ${SORT_EXPR} DESC, id DESC
        LIMIT ?`
    ).bind(albumId, ...extraParams, limit + 1);
  }
  const { results } = await stmt.all();
  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;

  const photos = [];
  for (const r of page) {
    // 网格用小缩略图；没有缩略图的老照片降级原图
    const key = r.thumb_key ?? r.object_key;
    let tags = [];
    try { tags = r.tags ? JSON.parse(r.tags) : []; } catch { tags = []; }
    photos.push({
      id: r.id,
      filename: r.filename,
      size: r.size,
      contentType: r.content_type,
      kind: r.kind ?? 'image',
      duration: r.duration ?? null,
      createdAt: r.created_at,
      takenAt: r.taken_at,
      camera: r.camera,
      tags,
      isThumb: !!r.thumb_key,
      thumbUrl: await presignR2(env, 'GET', key, PHOTO_URL_TTL),
    });
  }

  // 缺缩略图的照片数（管理员据此显示回填按钮）
  const missingRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photo
      WHERE album_id = ? AND status = 'ready' AND thumb_key IS NULL`
  ).bind(albumId).first();
  // 未打 AI 标签的照片数（管理员据此显示补打按钮）
  const untaggedRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photo
      WHERE album_id = ? AND status = 'ready' AND tags IS NULL`
  ).bind(albumId).first();

  return json({
    ok: true,
    album: {
      id: album.id, name: album.name,
      description: album.description,
      locked: !!album.password_hash,
      coverPhotoId: album.cover_photo_id ?? null,
    },
    photos,
    missingThumbs: missingRow?.n ?? 0,
    untaggedCount: untaggedRow?.n ?? 0,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1].sort_at,
                                                       page[page.length - 1].id) : null,
    urlExpiresIn: PHOTO_URL_TTL,
  });
}

async function createPhotoUpload(request, env, albumId, auth) {
  const album = await env.DB.prepare('SELECT id FROM album WHERE id = ?').bind(albumId).first();
  if (!album) return fail('相册不存在', 404);

  // 求照片链接访客：每链接每 IP 每小时限 50 次
  if (auth?.role === 'collect') {
    const hits = await collectHit(env, auth.shareId, request);
    if (hits > COLLECT_HOUR_LIMIT) {
      return fail('上传过于频繁，请一小时后再试', 429);
    }
  }

  const body = await readJson(request);
  const filename = String(body.filename ?? 'photo.jpg').slice(0, 255);
  const contentType = String(body.contentType ?? 'application/octet-stream');

  // kind 由服务端按 contentType 判定，不信前端传值
  const isVideo = contentType.startsWith('video/');
  const isImage = contentType.startsWith('image/');
  if (!isImage && !isVideo) return fail('只支持上传图片或视频');

  // 扩展名只取安全字符并做白名单校验
  const dot = filename.lastIndexOf('.');
  const rawExt = dot > -1 ? filename.slice(dot + 1).toLowerCase() : '';
  const extWhitelist = isVideo ? VIDEO_EXT_WHITELIST : IMG_EXT_WHITELIST;
  const ext = extWhitelist.has(rawExt) ? rawExt : 'bin';

  // 视频时长（前端 video.duration，服务端校验为有限整数）
  let duration = null;
  if (isVideo && Number.isFinite(body.duration)) {
    const d = Math.round(Number(body.duration));
    if (d >= 0 && d <= 86400) duration = d;
  }

  // ---- 上传体 SHA-256（同相册去重；>50MB 文件前端不算哈希） ----
  let sha256 = null;
  if (typeof body.sha256 === 'string' && /^[0-9a-f]{64}$/.test(body.sha256)) {
    sha256 = body.sha256;
  }
  if (sha256 && !body.forceSha) {
    const dup = await env.DB.prepare(
      `SELECT id, filename FROM photo
        WHERE album_id = ? AND sha256 = ? AND status = 'ready' LIMIT 1`
    ).bind(albumId, sha256).first();
    if (dup) {
      return json({
        ok: false, duplicate: true,
        existingId: dup.id, existingFilename: dup.filename,
        error: '该相册中已存在完全相同的文件',
      }, 409);
    }
  }

  // ---- EXIF（前端解析后传入，做服务端校验；视频无 EXIF） ----
  let takenAt = null;
  if (!isVideo && body.takenAt != null) {
    const t = Date.parse(body.takenAt);
    if (Number.isFinite(t)) {
      const now = Date.now();
      if (t > Date.parse('1990-01-01') && t < now + 86_400_000) {
        takenAt = new Date(t).toISOString();
      }
    }
  }
  const camera = !isVideo && typeof body.camera === 'string' && body.camera.trim()
    ? body.camera.trim().slice(0, 120) : null;
  let gpsLat = null, gpsLng = null;
  if (!isVideo && typeof body.gpsLat === 'number' && typeof body.gpsLng === 'number'
    && Number.isFinite(body.gpsLat) && Number.isFinite(body.gpsLng)
    && Math.abs(body.gpsLat) <= 90 && Math.abs(body.gpsLng) <= 180
    && (body.gpsLat !== 0 || body.gpsLng !== 0)) {
    gpsLat = body.gpsLat;
    gpsLng = body.gpsLng;
  }

  // ---- 缩略图 key ----
  // 图片：格式由前端实际编码结果决定（webp/jpg）；视频：前端抽帧固定 jpg
  const thumbFmt = isVideo ? 'jpg'
    : (body.thumbContentType === 'image/webp' ? 'webp' : 'jpg');

  const id = crypto.randomUUID();
  const objectKey = `albums/${albumId}/${id}.${ext}`;
  const smallKey = body.thumbContentType ? `albums/${albumId}/${id}.s.${thumbFmt}` : null;
  const largeKey = body.thumbContentType ? `albums/${albumId}/${id}.m.${thumbFmt}` : null;
  const kind = isVideo ? 'video' : 'image';

  await env.DB.prepare(
    `INSERT INTO photo
       (id, album_id, filename, object_key, content_type, status, kind, duration, sha256,
        thumb_key, large_key, taken_at, camera, gps_lat, gps_lng)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, albumId, filename, objectKey, contentType, 'uploading', kind, duration, sha256,
    smallKey, largeKey, takenAt, camera, gpsLat, gpsLng).run();

  const uploadUrl = await presignR2(env, 'PUT', objectKey, UPLOAD_URL_TTL);
  let thumbUploadUrl = null, largeUploadUrl = null;
  if (smallKey) {
    [thumbUploadUrl, largeUploadUrl] = await Promise.all([
      presignR2(env, 'PUT', smallKey, UPLOAD_URL_TTL),
      presignR2(env, 'PUT', largeKey, UPLOAD_URL_TTL),
    ]);
  }
  return json({
    ok: true, photoId: id, kind,
    uploadUrl, thumbUploadUrl, largeUploadUrl,
    objectKey, smallKey, largeKey,
    uploadUrlExpiresIn: UPLOAD_URL_TTL,
  }, 201);
}

async function confirmPhoto(request, env, photoId, ctx) {
  const photo = await env.DB.prepare(
    "SELECT id, object_key, status, kind, thumb_key, large_key FROM photo WHERE id = ?"
  ).bind(photoId).first();
  if (!photo) return fail('照片记录不存在', 404);
  if (photo.status === 'ready') return json({ ok: true, photo });

  const obj = await env.R2.head(photo.object_key);
  if (!obj) return fail('R2 中未找到文件，请先完成直传', 409);

  // 缩略图 best-effort 校验：若小图没传成功，则清空缩略图字段，前端自动降级原图
  let thumbKey = photo.thumb_key, largeKey = photo.large_key;
  if (thumbKey) {
    const t = await env.R2.head(thumbKey);
    if (!t) {
      thumbKey = null;
      if (largeKey && !(await env.R2.head(largeKey))) largeKey = null;
    }
  }

  await env.DB.prepare(
    `UPDATE photo SET status = 'ready', size = ?, content_type = ?,
                      thumb_key = ?, large_key = ? WHERE id = ?`
  ).bind(obj.size, obj.httpContentType ?? null, thumbKey, largeKey, photoId).run();
  // 视频且前端未能抽帧：后台用 MEDIA 绑定 best-effort 补封面帧
  if (photo.kind === 'video' && !thumbKey) {
    ctx?.waitUntil(ensureVideoPoster(env, { id: photoId, object_key: photo.object_key }));
  }
  // 异步 AI 打标（额度内），不阻塞响应
  ctx?.waitUntil(tagPhotoOnUpload(env, photoId));
  return json({ ok: true, photo: { id: photoId, size: obj.size } });
}

// 按需换取新鲜的预签名 URL（列表里的 URL 可能已过期）
async function getPhotoUrl(request, env, photoId) {
  const row = await env.DB.prepare(
    `SELECT p.object_key, a.id AS album_id, a.password_hash
     FROM photo p JOIN album a ON a.id = p.album_id
     WHERE p.id = ? AND p.status = 'ready'`
  ).bind(photoId).first();
  if (!row) return fail('照片不存在', 404);

  const auth = await getAuth(request, env);
  if (!canAccessAlbum(auth, { id: row.album_id, password_hash: row.password_hash })) {
    return fail('需要相册密码', 403);
  }
  // 单张分享 token 不得换取其他照片
  if (auth?.role === 'share' && auth.photoId && photoId !== auth.photoId) {
    return fail('无权访问该照片', 403);
  }
  const url = await presignR2(env, 'GET', row.object_key, PHOTO_URL_TTL);
  return json({ ok: true, url, expiresIn: PHOTO_URL_TTL });
}

async function deletePhoto(request, env, photoId) {
  const photo = await env.DB.prepare(
    'SELECT id, object_key, thumb_key, large_key, status FROM photo WHERE id = ?'
  ).bind(photoId).first();
  if (!photo) return fail('照片记录不存在', 404);
  if (photo.status === 'trashed') {
    // 回收站中的删除 = 彻底删除（?permanent=1 显式语义，无参数也同样处理）
    await purgePhotos(env, [photo]);
    return json({ ok: true, purged: true });
  }
  // 正常照片：移入回收站，R2 对象保留
  await env.DB.prepare(
    "UPDATE photo SET status = 'trashed', trashed_at = datetime('now') WHERE id = ?"
  ).bind(photoId).run();
  return json({ ok: true, trashed: true });
}

// 回收站还原；原相册已删除时需前端选择目标相册
async function restorePhotoHandler(request, env, photoId) {
  const body = await readJson(request);
  const r = await restorePhoto(env, photoId,
    typeof body.targetAlbumId === 'string' ? body.targetAlbumId : null);
  if (r.notFound) return fail('照片不存在或不在回收站', 404);
  if (r.badTarget) return fail('目标相册不存在', 400);
  if (r.needTarget) {
    return json({ ok: false, needTarget: true, albums: r.albums }, 409);
  }
  return json({ ok: true, albumId: r.albumId });
}

// ---------- 多选批量操作（管理员） ----------
// delete：批量入回收站；move：跨相册 R2 copy+delete（单批 ≤30）；rename：按 id 映射改文件名（≤100）
async function batchPhotos(request, env) {
  const body = await readJson(request);
  const action = String(body.action ?? '');
  if (!['delete', 'move', 'rename'].includes(action)) return fail('未知批量操作');
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.map(String))].slice(0, 100) : [];
  if (!ids.length) return fail('未选择照片');

  const placeholders = ids.map(() => '?').join(',');
  const { results } = await env.DB.prepare(
    `SELECT id, album_id, filename, object_key, thumb_key, large_key, status
       FROM photo WHERE id IN (${placeholders})`
  ).bind(...ids).all();
  if (results.length !== ids.length) return fail('部分照片不存在', 404);
  if (results.some((r) => r.status === 'trashed')) {
    return fail('回收站照片不支持批量操作');
  }
  const byId = new Map(results.map((r) => [r.id, r]));

  if (action === 'delete') {
    await env.DB.prepare(
      `UPDATE photo SET status = 'trashed', trashed_at = datetime('now')
        WHERE id IN (${placeholders})`
    ).bind(...ids).run();
    return json({ ok: true, deleted: ids.length });
  }

  if (action === 'move') {
    if (ids.length > 30) return fail('单次移动最多 30 张');
    const targetAlbumId = String(body.targetAlbumId ?? '');
    if (!targetAlbumId) return fail('缺少目标相册');
    const target = await env.DB.prepare('SELECT id FROM album WHERE id = ?')
      .bind(targetAlbumId).first();
    if (!target) return fail('目标相册不存在', 404);

    let moved = 0, failed = 0, skipped = 0;
    for (const id of ids) {
      const r = byId.get(id);
      if (r.album_id === targetAlbumId) { skipped++; continue; }
      try {
        const rebase = (k) =>
          k.replace(`albums/${r.album_id}/`, `albums/${targetAlbumId}/`);
        const newObjectKey = rebase(r.object_key);
        const newThumbKey = r.thumb_key ? rebase(r.thumb_key) : null;
        const newLargeKey = r.large_key ? rebase(r.large_key) : null;
        const pairs = [[r.object_key, newObjectKey]];
        if (r.thumb_key) pairs.push([r.thumb_key, newThumbKey]);
        if (r.large_key) pairs.push([r.large_key, newLargeKey]);
        // R2 服务端 copy 成功后再改元数据，最后删旧对象（中途失败旧对象仍在）
        for (const [src, dst] of pairs) await env.R2.copy(src, dst);
        await env.DB.prepare(
          'UPDATE photo SET album_id = ?, object_key = ?, thumb_key = ?, large_key = ? WHERE id = ?'
        ).bind(targetAlbumId, newObjectKey, newThumbKey, newLargeKey, r.id).run();
        for (const [src] of pairs) await env.R2.delete(src);
        moved++;
      } catch (e) {
        console.log('batch move failed:', r.id, e?.message ?? String(e));
        failed++;
      }
    }
    return json({ ok: true, moved, failed, skipped });
  }

  // rename：body.names = { [id]: newFilename }
  const names = body.names;
  if (!names || typeof names !== 'object') return fail('缺少新文件名');
  let renamed = 0;
  for (const id of ids) {
    const raw = names[id];
    const newName = raw != null ? String(raw).trim().slice(0, 255) : '';
    if (!newName || /[\\/]/.test(newName)) continue;
    await env.DB.prepare('UPDATE photo SET filename = ? WHERE id = ?')
      .bind(newName, id).run();
    renamed++;
  }
  return json({ ok: true, renamed });
}

// ---------- 往年今日 ----------
// 历史年份（早于今年）同月同日拍摄/上传的照片；只能看到自己有权访问的相册
async function onThisDay(request, env) {
  const auth = await getAuth(request, env);
  const admin = isAdmin(auth);
  // 可见相册条件：公开相册 / 管理员全部 / 已解锁的那个相册
  const albumVisible = admin ? '1=1'
    : auth?.role === 'album' ? '(a.password_hash IS NULL OR a.id = ?)'
    : 'a.password_hash IS NULL';
  const params = auth?.role === 'album' && !admin ? [auth.albumId] : [];

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.filename, p.object_key, p.thumb_key, p.content_type, p.size,
            p.kind, p.duration, p.created_at, p.taken_at, p.camera, p.tags,
            p.album_id, a.name AS album_name,
            COALESCE(p.taken_at, p.created_at) AS sort_at
       FROM photo p JOIN album a ON a.id = p.album_id
      WHERE p.status = 'ready'
        AND strftime('%m-%d', COALESCE(p.taken_at, p.created_at))
            = strftime('%m-%d', 'now')
        AND CAST(strftime('%Y', COALESCE(p.taken_at, p.created_at)) AS INTEGER)
            < CAST(strftime('%Y', 'now') AS INTEGER)
        AND ${albumVisible}
      ORDER BY sort_at DESC, p.id DESC
      LIMIT 60`
  ).bind(...params).all();

  const photos = [];
  for (const r of results) {
    let tags = [];
    try { tags = r.tags ? JSON.parse(r.tags) : []; } catch { tags = []; }
    const key = r.thumb_key ?? r.object_key;
    photos.push({
      id: r.id,
      albumId: r.album_id,
      albumName: r.album_name,
      filename: r.filename,
      size: r.size,
      contentType: r.content_type,
      kind: r.kind ?? 'image',
      duration: r.duration ?? null,
      createdAt: r.created_at,
      takenAt: r.taken_at,
      camera: r.camera,
      tags,
      isThumb: !!r.thumb_key,
      thumbUrl: await presignR2(env, 'GET', key, PHOTO_URL_TTL),
    });
  }
  return json({ ok: true, photos, todayMmDd: new Date().toISOString().slice(5, 10) });
}

// ---------- 管理员用量统计 ----------
async function adminStats(request, env) {
  const totals = await env.DB.prepare(
    `SELECT
       COUNT(*) AS total,
       COALESCE(SUM(CASE WHEN kind='video' THEN 1 ELSE 0 END), 0) AS videos,
       COALESCE(SUM(size), 0) AS bytes,
       COALESCE(SUM(CASE WHEN status='trashed' THEN 1 ELSE 0 END), 0) AS trashed,
       COALESCE(SUM(CASE WHEN tags IS NULL OR tags='[]' THEN 1 ELSE 0 END), 0) AS untagged,
       COALESCE(SUM(CASE WHEN thumb_key IS NULL THEN 1 ELSE 0 END), 0) AS missing_thumbs
     FROM photo`
  ).first();
  const albumCount = await env.DB.prepare('SELECT COUNT(*) AS n FROM album').first();
  const { results } = await env.DB.prepare(
    `SELECT a.id, a.name,
            COUNT(p.id) AS photos,
            COALESCE(SUM(CASE WHEN p.kind='video' THEN 1 ELSE 0 END), 0) AS videos,
            COALESCE(SUM(p.size), 0) AS bytes
       FROM album a LEFT JOIN photo p
         ON p.album_id = a.id AND p.status = 'ready'
      GROUP BY a.id
      ORDER BY bytes DESC`
  ).all();

  return json({
    ok: true,
    totals: {
      photos: totals.total,
      videos: totals.videos,
      bytes: totals.bytes,
      albums: albumCount.n,
      trashed: totals.trashed,
      untagged: totals.untagged,
      missingThumbs: totals.missing_thumbs,
    },
    byAlbum: results.map((r) => ({
      albumId: r.id, name: r.name,
      photos: r.photos, videos: r.videos, bytes: r.bytes,
    })),
  });
}

async function route(request, env, ctx) {
  const missing = requireEnv(env);
  if (missing.length) return fail('服务未配置完成，缺少: ' + missing.join(', '), 503);

  // 迁移先行（isolate 内只执行一次），随后进行应用层边缘检查
  await ensurePhotoSchema(env);
  const edgeHit = await edgeGuard(request, env);
  if (edgeHit) return edgeHit;

  const url = new URL(request.url);
  const seg = url.pathname.split('/').filter(Boolean);
  const method = request.method;
  const auth = await getAuth(request, env);
  const adminOnly = () => (isAdmin(auth) ? null : fail('需要管理员登录', 401));
  // 内容级权限：管理员 / 相册解锁访客 / 求照片链接访客（仅可上传）
  const denyUnlessAlbumEditor = (albumId) => {
    if (isAdmin(auth)) return null;
    if (auth?.role === 'album' && auth.albumId === albumId) return null;
    if (auth?.role === 'collect' && auth.albumId === albumId) return null;
    return fail('需要管理员登录或相册解锁', 401);
  };

  // 无需登录
  if (method === 'GET' && url.pathname === '/api/health') return json({ ok: true });
  if (method === 'POST' && url.pathname === '/api/login') return handleLogin(request, env);
  if (method === 'POST' && seg[1] === 'albums' && seg[3] === 'unlock' && seg.length === 4) {
    return handleUnlock(request, env, seg[2]);
  }
  // 证件照云端精修：公开接口，内部自行限流
  if (method === 'POST' && seg[1] === 'idphoto' && seg[2] === 'cloud-cutout' && seg.length === 3) {
    return handleCloudCutout(request, env);
  }
  // 照片换风格（FLUX.2 Klein 图生图）：公开接口，内部按档位限流
  if (method === 'POST' && seg[1] === 'style-transfer' && seg.length === 2) {
    return handleStyleTransfer(request, env);
  }

  // 表结构迁移已在路由入口完成（isolate 内只执行一次）

  // 分享链接换取信息 + 短期 token（公开；带密码的链接须 POST password）
  if ((method === 'GET' || method === 'POST') && seg[1] === 'share' && seg.length === 3) {
    return redeemShare(request, env, seg[2]);
  }

  // 相册列表：访客可见（含 locked 标记），管理员视角含 isAdmin
  if (method === 'GET' && seg[1] === 'albums' && seg.length === 2) return listAlbums(request, env);

  // ---- 以下全部管理员 ----

  if (method === 'POST' && seg[1] === 'albums' && seg.length === 2) {
    const deny = adminOnly(); if (deny) return deny;
    return createAlbum(request, env);
  }
  // 批量密码操作必须先于 /:id 匹配
  if (method === 'PATCH' && url.pathname === '/api/albums/passwords') {
    const deny = adminOnly(); if (deny) return deny;
    return setAllAlbumPasswords(request, env);
  }
  if (method === 'DELETE' && url.pathname === '/api/albums/passwords') {
    const deny = adminOnly(); if (deny) return deny;
    return clearAllAlbumPasswords(request, env);
  }
  if (method === 'PATCH' && seg[1] === 'albums' && seg[3] === 'password' && seg.length === 4) {
    const deny = adminOnly(); if (deny) return deny;
    return setAlbumPassword(request, env, seg[2]);
  }
  if (method === 'DELETE' && seg[1] === 'albums' && seg[3] === 'password' && seg.length === 4) {
    const deny = adminOnly(); if (deny) return deny;
    return clearAlbumPassword(request, env, seg[2]);
  }
  if (method === 'PATCH' && seg[1] === 'albums' && seg.length === 3) {
    const deny = adminOnly(); if (deny) return deny;
    return updateAlbum(request, env, seg[2]);
  }
  if (method === 'DELETE' && seg[1] === 'albums' && seg.length === 3) {
    const deny = adminOnly(); if (deny) return deny;
    return deleteAlbum(request, env, seg[2]);
  }
  if (method === 'GET' && seg[1] === 'albums' && seg[3] === 'photos' && seg.length === 4) {
    return listPhotos(request, env, seg[2]);
  }
  // 按需换取新鲜预签名 URL（公开，但内部校验相册访问权限）
  if (method === 'GET' && seg[1] === 'photos' && seg[3] === 'url' && seg.length === 4) {
    return getPhotoUrl(request, env, seg[2]);
  }
  if (method === 'POST' && seg[1] === 'albums' && seg[3] === 'photos' && seg.length === 4) {
    const deny = denyUnlessAlbumEditor(seg[2]); if (deny) return deny;
    return createPhotoUpload(request, env, seg[2], auth);
  }
  if (method === 'POST' && seg[1] === 'photos' && seg[3] === 'confirm' && seg.length === 4) {
    // 非管理员需确认该照片属于其可操作的相册（解锁访客 / 求照片访客）
    if (!isAdmin(auth)) {
      if (auth?.role !== 'album' && auth?.role !== 'collect') {
        return fail('需要管理员登录或相册解锁', 401);
      }
      const row = await env.DB.prepare('SELECT album_id FROM photo WHERE id = ?')
        .bind(seg[2]).first();
      if (!row || row.album_id !== auth.albumId) return fail('无权操作该照片', 403);
    }
    return confirmPhoto(request, env, seg[2], ctx);
  }
  if (method === 'DELETE' && seg[1] === 'photos' && seg.length === 3) {
    const deny = adminOnly(); if (deny) return deny;
    return deletePhoto(request, env, seg[2]);
  }
  if (method === 'POST' && seg[1] === 'photos' && seg[3] === 'restore' && seg.length === 4) {
    const deny = adminOnly(); if (deny) return deny;
    return restorePhotoHandler(request, env, seg[2]);
  }
  // 回收站（管理员）
  if (method === 'GET' && url.pathname === '/api/admin/trash') {
    const deny = adminOnly(); if (deny) return deny;
    return json({ ok: true, ...(await listTrash(env)) });
  }
  // 分享链接管理（管理员）
  if (method === 'POST' && url.pathname === '/api/admin/shares') {
    const deny = adminOnly(); if (deny) return deny;
    return createShare(request, env);
  }
  if (method === 'GET' && url.pathname === '/api/admin/shares') {
    const deny = adminOnly(); if (deny) return deny;
    return listShares(request, env);
  }
  if (method === 'DELETE' && seg[1] === 'admin' && seg[2] === 'shares' && seg.length === 4) {
    const deny = adminOnly(); if (deny) return deny;
    return revokeShare(request, env, seg[3]);
  }
  if (method === 'POST' && url.pathname === '/api/admin/trash/empty') {
    const deny = adminOnly(); if (deny) return deny;
    const r = await emptyTrashBatch(env);
    return json({ ok: true, ...r });
  }
  // 历史照片缩略图回填（管理员触发，每批 5 张；可按相册/上传日期/指定照片筛选）
  if (method === 'POST' && url.pathname === '/api/admin/backfill-thumbs') {
    const deny = adminOnly(); if (deny) return deny;
    let opts = {};
    try {
      if (request.headers.get('content-type')?.includes('application/json')) {
        opts = await request.json();
      }
    } catch { opts = {}; }
    const cleanOpts = {
      albumId: typeof opts.albumId === 'string' ? opts.albumId : undefined,
      dateFrom: typeof opts.dateFrom === 'string' ? opts.dateFrom : undefined,
      dateTo: typeof opts.dateTo === 'string' ? opts.dateTo : undefined,
      ids: Array.isArray(opts.ids) ? opts.ids.filter((x) => typeof x === 'string').slice(0, 5) : undefined,
    };
    const result = await runBackfillBatch(env, cleanOpts);
    // 始终 200：quotaExhausted 由响应体标志，便于前端正常读取进度
    return json({ ok: true, ...result });
  }
  // 历史照片 AI 标签回填（管理员或解锁访客触发，每批最多 20 张）
  if (method === 'POST' && url.pathname === '/api/admin/backfill-tags') {
    let opts = {};
    try {
      if (request.headers.get('content-type')?.includes('application/json')) {
        opts = await request.json();
      }
    } catch { opts = {}; }
    // 解锁访客只能补打自己解锁的相册，不能指定其他相册
    let albumId;
    if (isAdmin(auth)) {
      albumId = typeof opts.albumId === 'string' ? opts.albumId : undefined;
    } else if (auth?.role === 'album') {
      albumId = auth.albumId;
    } else {
      return fail('需要管理员登录或相册解锁', 401);
    }
    const result = await backfillTags(env, {
      albumId,
      limit: Number.isFinite(opts.limit) ? opts.limit : 20,
    });
    return json({ ok: true, ...result });
  }
  // 往年今日（公开，内部按相册可见性过滤）
  if (method === 'GET' && url.pathname === '/api/on-this-day') {
    return onThisDay(request, env);
  }
  // 用量统计（管理员）
  if (method === 'GET' && url.pathname === '/api/admin/stats') {
    const deny = adminOnly(); if (deny) return deny;
    return adminStats(request, env);
  }
  // 多选批量操作（管理员）：删除/移动/重命名
  if (method === 'POST' && url.pathname === '/api/photos/batch') {
    const deny = adminOnly(); if (deny) return deny;
    return batchPhotos(request, env);
  }
  // 无封面视频批量补帧（管理员，每批 3 个；MEDIA 公测免费）
  if (method === 'POST' && url.pathname === '/api/admin/backfill-video-thumbs') {
    const deny = adminOnly(); if (deny) return deny;
    const opts = await readJson(request);
    const result = await backfillVideoPosters(env, { limit: opts.limit });
    return json({ ok: true, ...result });
  }

  return fail('接口不存在', 404);
}

export default {
  async fetch(request, env, ctx) {
    let resp;
    try {
      if (request.method === 'OPTIONS') {
        resp = new Response(null, { status: 204 });
      } else {
        resp = await route(request, env, ctx);
      }
    } catch (err) {
      // 详细错误仅写入 Worker 日志，对外脱敏
      console.log('worker error:', err?.stack ?? String(err));
      resp = json({ ok: false, error: '服务器开小差了，请稍后再试' }, 500);
    }
    // CORS 在出口统一按请求 Origin 白名单添加
    return withCors(resp, request);
  },

  // 每日定时清理（wrangler.toml [triggers].crons）
  async scheduled(controller, env) {
    console.log('scheduled fired:', controller.cron);
    const summary = await runScheduledCleanup(env);
    console.log('scheduled summary:', JSON.stringify(summary));
  },
};

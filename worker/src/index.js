// 相册云存储 API —— Cloudflare Worker
// 绑定：env.R2（存储）、env.DB（D1 数据库）
// 密钥（wrangler secret）：ADMIN_PASSWORD、JWT_SECRET、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY
import { signJwt, getAuth, hashPassword, timingSafeEqualStr } from './auth.js';
import { presignR2, initiateMultipart, completeMultipart, abortMultipart } from './presign.js';
import { handleCloudCutout } from './idphoto.js';
import { handleStyleTransfer } from './style-transfer.js';
import { runBackfillBatch } from './backfill.js';
import {
  listTrash, restorePhoto, emptyTrashBatch, purgePhotos, runScheduledCleanup, cleanupOrphans,
} from './trash.js';
import { checkLock, recordFailure, clearFailures } from './auth-guard.js';
import { createShare, listShares, revokeShare, redeemShare,
         collectHit, COLLECT_HOUR_LIMIT } from './share.js';
import { tagPhotoOnUpload, backfillTags, EMBED_MODEL, EMBED_VERSION, SEMANTIC_THRESHOLD } from './ai-tags.js';
import { buildTagGroups, ensureTagEmbTable } from './tag-groups.js';
import { backfillVideoPosters, ensureVideoProxy } from './video-thumb.js';
import { edgeGuard } from './edge-guard.js';
import { verifyTurnstile } from './turnstile.js';
import { createUsageMeter, flushUsage } from './usage-meter.js';
import { costGuardDaily, r2UploadGuard, imagesUsedThisMonth, R2_FREE_BYTES,
         IMAGES_MONTHLY_CAP, IMAGES_MONTHLY_FREE } from './cost-guard.js';
import { json, fail } from './util.js';
import { bumpAlbumVersion, getAlbumVersion } from './album-version.js';

// ---------- 常量 ----------

const PHOTO_URL_TTL = 900;       // 浏览用预签名 URL：15 分钟
// P3：列表/搜索类 JSON 用私有 SWR——30s 内直接用缓存，过期后 5 分钟内先回旧数据再后台重取。
// private + Vary:Authorization 确保只进浏览器私有缓存且按身份隔离，不进 CDN 共享缓存（防越权泄漏）
const API_CACHE = 'private, max-age=30, stale-while-revalidate=300';
const API_CACHE_HEADERS = { 'Cache-Control': API_CACHE, 'Vary': 'Authorization' };
const UPLOAD_URL_TTL = 3600;     // 上传用预签名 URL：1 小时（大图上传慢）
// 缩略图内容不可变（key 固定），浏览器长期缓存；原图按下载场景不设 immutable
const THUMB_CACHE = 'public, max-age=31536000, immutable';
const ALBUM_TOKEN_TTL = 1800;    // 相册解锁 token：30 分钟
const ADMIN_TOKEN_TTL = 43200;   // 管理员 token：12 小时
// 上传扩展名白名单（SVG 不允许：可携带脚本，直开预签名 URL 会执行）
const IMG_EXT_WHITELIST = new Set([
  'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'heic', 'heif', 'tif', 'tiff', 'avif',
]);
// 视频有限支持：原样存储不转码；MEDIA 绑定官方仅保证 H.264 MP4
const VIDEO_EXT_WHITELIST = new Set(['mp4', 'webm', 'mov', 'm4v']);
const VIDEO_MAX_SIZE = 500 * 1024 * 1024; // 建议单个视频 ≤500MB
// 扩展名 → 权威 MIME 映射（服务端按扩展名锁定 R2 对象 Content-Type，
// 不信任客户端传入值，防止把 text/html 等存进 R2 形成存储型 XSS/钓鱼页）
export const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', heic: 'image/heic', heif: 'image/heif',
  tif: 'image/tiff', tiff: 'image/tiff', avif: 'image/avif',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', m4v: 'video/mp4',
};
// 上传分类判定（纯函数，便于单测）：扩展名 → {ext, kind, mime}；不在白名单返回 null（拒绝）
export function resolveUploadExt(filename) {
  const dot = filename.lastIndexOf('.');
  const rawExt = dot > -1 ? filename.slice(dot + 1).toLowerCase() : '';
  if (VIDEO_EXT_WHITELIST.has(rawExt)) {
    return { ext: rawExt, kind: 'video', mime: EXT_MIME[rawExt] };
  }
  if (IMG_EXT_WHITELIST.has(rawExt)) {
    return { ext: rawExt, kind: 'image', mime: EXT_MIME[rawExt] };
  }
  return null;
}

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
    // 合并而非覆盖：P3 列表接口已带 Vary: Authorization（按身份隔离缓存）
    const vary = resp.headers.get('Vary');
    const hasOrigin = vary
      ? vary.split(',').some((t) => t.trim().toLowerCase() === 'origin') : false;
    resp.headers.set('Vary', vary ? (hasOrigin ? vary : `${vary}, Origin`) : 'Origin');
    resp.headers.set('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    resp.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    resp.headers.set('Access-Control-Expose-Headers',
      'X-Quota-Remaining, X-Style, X-Tier, ETag');
    resp.headers.set('Access-Control-Max-Age', '86400');
  }
  return resp;
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

// 安全解析 JSON 文本（EXIF 等存储为 JSON 字符串），失败返回 null
function parseJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
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
// 加密相册（encrypted=1）不可公开访问：内容为密文，需解锁后（role=album）才能取回包裹密钥与密文
// 导出供单元测试做权限判定矩阵
export function canAccessAlbum(auth, album) {
  if (isAdmin(auth)) return true;
  if (auth && auth.role === 'share' && auth.albumId === album.id) return true;
  if (!album.password_hash && !album.encrypted) return true;
  return !!auth && auth.role === 'album' && auth.albumId === album.id;
}

// 聚合接口（往年今日/地图/智能相册）的可见相册 SQL 片段。
// 口径必须与 photoScope() 一致：加密相册一律排除（时间戳/GPS/密文缩略图也算隐私），
// 解锁访客可看公开相册 + 自己解锁的那个。
function albumVisibleSql(auth, admin) {
  if (admin) return { sql: '1=1', params: [] };
  if (auth?.role === 'album') {
    return {
      sql: '((a.password_hash IS NULL AND a.encrypted = 0) OR a.id = ?)',
      params: [auth.albumId],
    };
  }
  return { sql: '(a.password_hash IS NULL AND a.encrypted = 0)', params: [] };
}

// ---------- 表结构迁移（幂等，每个 isolate 只跑一次） ----------

let photoSchemaEnsured = false;
let schemaMigration = null; // 迁移互斥锁：并发冷启动请求共享同一次迁移，避免重复 ALTER 冲突

const SCHEMA_RETRY = 3;        // 迁移失败重试次数（D1 并发冷启动偶发锁竞争 / 超时）
const SCHEMA_RETRY_DELAY = 250; // 重试基础退避（毫秒）

async function ensurePhotoSchema(env) {
  if (photoSchemaEnsured) return true;
  // 复用进行中的迁移：手机端 PWA 首屏会并发触发导航 + 多个 API 请求，
  // 若各自独立跑迁移会同时执行非幂等的 ALTER TABLE 导致 D1 "duplicate column" 报错 → 500
  if (!schemaMigration) {
    schemaMigration = (async () => {
      for (let attempt = 1; attempt <= SCHEMA_RETRY; attempt++) {
        try {
          await runSchemaMigration(env);
          photoSchemaEnsured = true;
          return true;
        } catch (e) {
          // 迁移全部语句均幂等（addCol 容错 duplicate column、CREATE IF NOT EXISTS、
          // 回填 UPDATE 仅补 NULL），可安全重跑。D1 冷启动并发下偶发 "database is locked"/
          // 超时，重试即可补齐。若始终失败，返回 false 让路由层回 503，而不是让依赖新列的
          // 接口（listPhotos）抛 "no such column" 变成 500「服务器开小差」。
          console.error(`[schema] migration attempt ${attempt}/${SCHEMA_RETRY} failed:`, e?.message ?? e);
          if (attempt < SCHEMA_RETRY) await delay(SCHEMA_RETRY_DELAY * attempt);
        }
      }
      return false;
    })().finally(() => { schemaMigration = null; });
  }
  return await schemaMigration;
}

async function runSchemaMigration(env) {
  // ALTER 容错：跨 isolate 并发冷启动（不同边缘节点同时迁移）可能撞到重复列，忽略 duplicate column 错误
  const addCol = async (table, col, type) => {
    try {
      await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`).run();
    } catch (e) {
      if (!/duplicate column/i.test(String(e?.message ?? e))) throw e;
    }
  };
  // 索引创建容错：索引只是查询优化，失败（如表达式索引在旧数据上建不了）不应中断
  // 后续的 addCol，否则会漏加列 → 依赖新列的接口（listPhotos）报 no such column
  const safeExec = async (label, sql) => {
    try { await env.DB.prepare(sql).run(); }
    catch (e) { console.error(`[schema] ${label} failed (non-fatal):`, e?.message ?? e); }
  };
  const newColumns = {
    thumb_key: 'TEXT', large_key: 'TEXT',
    thumb_avif_key: 'TEXT', large_avif_key: 'TEXT',
    proxy_key: 'TEXT',
    exif: 'TEXT',
    taken_at: 'TEXT', camera: 'TEXT',
    gps_lat: 'REAL', gps_lng: 'REAL',
    trashed_at: 'TEXT',
    tags: 'TEXT',
    duration: 'INTEGER',
    sha256: 'TEXT',
    is_favorite: 'INTEGER NOT NULL DEFAULT 0', // ⭐ 收藏（管理员策展，对所有访客可见）
    caption: 'TEXT',                            // 照片故事备注（≤500 字）
    tagged_at: 'TEXT',                          // 最近一次 AI 打标成功时间（重打活动游标）
    thumb_hash: 'TEXT',                         // ThumbHash 模糊占位（base64，~25 字节）
    enc_key: 'TEXT',                            // 加密相册：albumKey 加密的 fileKey（JSON {enc,iv}）
    enc_meta: 'TEXT',                           // 加密相册：fileKey 加密的元数据（base64：nonceBase||GCM(meta)）
  };
  const { results: cols } = await env.DB.prepare('PRAGMA table_info(photo)').all();
  const existing = new Set(cols.map((c) => c.name));
  for (const [name, type] of Object.entries(newColumns)) {
    if (!existing.has(name)) {
      await addCol('photo', name, type);
    }
  }
  // kind 带默认值，需单独处理
  if (!existing.has('kind')) {
    await addCol('photo', 'kind', "TEXT NOT NULL DEFAULT 'image'");
  }
  // album 表加自定义封面列
  const { results: albumCols } = await env.DB.prepare('PRAGMA table_info(album)').all();
  if (!albumCols.some((c) => c.name === 'cover_photo_id')) {
    await addCol('album', 'cover_photo_id', 'TEXT');
  }
  if (!albumCols.some((c) => c.name === 'updated_at')) {
    await addCol('album', 'updated_at', 'TEXT');
  }
  // 加密相册：密钥包裹与口令派生参数
  const albumEncCols = [
    ['encrypted', 'INTEGER NOT NULL DEFAULT 0'],
    ['enc_key', 'TEXT'],
    ['kek_salt', 'TEXT'],
    ['kek_iters', 'INTEGER'],
  ];
  for (const [colName, colType] of albumEncCols) {
    if (!albumCols.some((c) => c.name === colName)) {
      await addCol('album', colName, colType);
    }
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
  await safeExec('idx_photo_sort',
    `CREATE INDEX IF NOT EXISTS idx_photo_sort
     ON photo (COALESCE(taken_at, created_at) DESC, id DESC)`);
  await safeExec('idx_photo_trashed',
    `CREATE INDEX IF NOT EXISTS idx_photo_trashed ON photo(status, trashed_at)`);
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
      await addCol('share_link', name, type);
    }
  }
  await safeExec('idx_share_album',
    `CREATE INDEX IF NOT EXISTS idx_share_album ON share_link(album_id)`);
  await safeExec('idx_share_photo',
    `CREATE INDEX IF NOT EXISTS idx_share_photo ON share_link(photo_id)`);
  // 上传体哈希（同相册去重）
  await safeExec('idx_photo_sha',
    `CREATE INDEX IF NOT EXISTS idx_photo_sha ON photo(album_id, sha256)`);
  // 收藏筛选（部分索引，只索引已收藏照片）
  await safeExec('idx_photo_favorite',
    `CREATE INDEX IF NOT EXISTS idx_photo_favorite ON photo(album_id) WHERE is_favorite = 1`);
  // AI 打标每日全局限额（Workers AI 免费 10000 neurons/天）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_tag_daily (
      day    TEXT PRIMARY KEY,
      count  INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
  // 应用元数据键值表（如 Llama 3.2 license 同意时间戳）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS app_meta (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    )`
  ).run();
  // AI 打标失败诊断日志（保留最近 50 条）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS ai_tag_error (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id   TEXT,
      reason     TEXT,
      created_at TEXT
    )`
  ).run();
  // D1 用量自统计表（每天一行，UTC 自然日）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS d1_usage (
      date         TEXT PRIMARY KEY,
      rows_read    INTEGER NOT NULL DEFAULT 0,
      rows_written INTEGER NOT NULL DEFAULT 0
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
  // 照片最后修改时间（预留，未来可用于排序/展示；ETag 用 album_version 表）
  if (!existing.has('updated_at')) {
    await addCol('photo', 'updated_at', 'TEXT');
  }
  // 感知哈希（dHash 64-bit hex 字符串），用于重复照片检测
  if (!existing.has('phash')) {
    await addCol('photo', 'phash', 'TEXT');
  }
  // BGE 文本向量（标签+描述的 embedding，JSON 数组），用于语义搜索
  if (!existing.has('embedding')) {
    await addCol('photo', 'embedding', 'TEXT');
  }
  // 向量模型版本：不同模型/维度的向量隔离，只与同版本查询向量比对
  if (!existing.has('emb_model')) {
    await addCol('photo', 'emb_model', 'TEXT');
  }
  // AI 生成的中文画面描述句（15~30 字），与标签共同构成语义索引文本
  if (!existing.has('ai_desc')) {
    await addCol('photo', 'ai_desc', 'TEXT');
  }
  // 标签关联表：加速标签搜索（替代 LIKE 扫描 JSON 文本）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS photo_tag (
      photo_id TEXT NOT NULL,
      tag      TEXT NOT NULL,
      PRIMARY KEY (photo_id, tag)
    )`
  ).run();
  await safeExec('idx_photo_tag_tag',
    `CREATE INDEX IF NOT EXISTS idx_photo_tag_tag ON photo_tag(tag)`);
  // 回填：仅 photo_tag 为空时执行一次（json_each 全表扫描是冷启动主开销之一；
  // 此后打标路径同步维护 photo_tag（ai-tags.js），日常冷启动直接跳过）
  try {
    const hasAny = await env.DB.prepare('SELECT 1 FROM photo_tag LIMIT 1').first();
    if (!hasAny) {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO photo_tag(photo_id, tag)
         SELECT p.id, je.value
           FROM photo p, json_each(p.tags) je
          WHERE p.tags IS NOT NULL AND json_valid(p.tags) AND je.type = 'text'`
      ).run();
    }
  } catch { /* 回填失败不影响启动 */ }
  // 拍摄月日（MM-DD）：往年今日查询可走索引，避免 strftime 全表扫
  if (!existing.has('taken_md')) {
    await addCol('photo', 'taken_md', 'TEXT');
    // 仅新建列时一次性回填历史数据（大表 UPDATE 是冷启动延迟主因；
    // 日常缺失补齐由每日 Cron 兜底，见 trash.js runScheduledCleanup）
    try {
      await env.DB.prepare(
        `UPDATE photo SET taken_md = substr(COALESCE(taken_at, created_at), 6, 5)
          WHERE taken_md IS NULL AND COALESCE(taken_at, created_at) IS NOT NULL`
      ).run();
    } catch (e) {
      console.log('taken_md backfill failed (non-fatal):', e?.message ?? String(e));
    }
  }
  await safeExec('idx_photo_taken_md',
    `CREATE INDEX IF NOT EXISTS idx_photo_taken_md ON photo(taken_md, status)`);
  // 相册数据版本号（任何照片/相册变更自增，用于列表 ETag）
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS album_version (
      album_id TEXT PRIMARY KEY,
      v        INTEGER NOT NULL DEFAULT 0
    )`
  ).run();
}

// 获取相册版本号：见 album-version.js（与 bump 同源）

// ---------- 鉴权 ----------

async function handleLogin(request, env) {
  // 静默锁定期：不暴露锁定状态，伪装成普通密码错误
  if (await checkLock(env, 'admin', request)) return fail('密码错误', 401);
  const body = await readJson(request);
  const vt = await verifyTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
  if (!vt.ok) return fail(vt.error, vt.status);
  if (!body.password || !(await timingSafeEqualStr(body.password, env.ADMIN_PASSWORD))) {
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
  const album = await env.DB.prepare(
    'SELECT id, password_hash, encrypted, enc_key, kek_salt, kek_iters FROM album WHERE id = ?'
  ).bind(albumId).first();
  if (!album) return fail('相册不存在', 404);

  // 加密相册：服务端无法验证口令（端到端）。返回被 KEK 包裹的相册主密钥与派生参数，
  // 解包成功与否由客户端用口令判断（口令错则 PBKDF2→AES 解包失败）。安全靠口令强度 + PBKDF2 迭代成本。
  if (album.encrypted) {
    if (await checkLock(env, `album:${albumId}`, request)) return fail('尝试过于频繁，请稍后再试', 429);
    const encBody = await readJson(request);
    const vtEnc = await verifyTurnstile(env, encBody.turnstileToken, request.headers.get('CF-Connecting-IP'));
    if (!vtEnc.ok) return fail(vtEnc.error, vtEnc.status);
    const token = await signJwt({ role: 'album', albumId }, env.JWT_SECRET, ALBUM_TOKEN_TTL);
    return json({
      ok: true, token, encrypted: true,
      encKey: album.enc_key, kekSalt: album.kek_salt, kekIters: album.kek_iters,
      expiresIn: ALBUM_TOKEN_TTL,
    });
  }

  if (!album.password_hash) return json({ ok: true, token: null, note: '公开相册无需解锁' });

  const scope = `album:${albumId}`;
  // 静默锁定期：伪装成普通密码错误
  if (await checkLock(env, scope, request)) return fail('相册密码错误', 401);

  const body = await readJson(request);
  const vt = await verifyTurnstile(env, body.turnstileToken, request.headers.get('CF-Connecting-IP'));
  if (!vt.ok) return fail(vt.error, vt.status);
  const hash = await hashPassword(String(body.password ?? ''));
  if (!(await timingSafeEqualStr(hash, album.password_hash))) {
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
    encrypted: !!row.encrypted,
    createdAt: row.created_at,
  };
}

async function listAlbums(request, env) {
  const auth = await getAuth(request, env);
  const admin = isAdmin(auth);

  // ETag：所有相册版本号的最大值（任何相册变更都会反映）
  // 时间桶：预签名 URL 15 分钟过期，桶翻转后强制 200 返回新鲜 URL
  // 身份位：响应内容随管理员/访客不同（封面签名/lockedCover），ETag 必须区分防 304 串身份
  const verRow = await env.DB.prepare(
    'SELECT COALESCE(MAX(v), 0) AS m FROM album_version'
  ).first();
  const urlBucket = Math.floor(Date.now() / 1000 / PHOTO_URL_TTL);
  const etag = `W/"albums-v${verRow?.m ?? 0}-t${urlBucket}-a${admin ? 1 : 0}"`;
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, ...API_CACHE_HEADERS },
    });
  }

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

  // 封面签名并行（相册数量可能上百，串行 await 累积明显延迟）
  const coverUrls = await Promise.all(results.map((row) => {
    // 加密/加锁相册对非管理员不签真实封面（列表无需解锁，防止内容泄露）
    const showReal = admin || (!row.password_hash && !row.encrypted);
    return showReal && row.cover_key
      ? presignR2(env, 'GET', row.cover_key, PHOTO_URL_TTL, { cacheControl: THUMB_CACHE })
      : null;
  }));
  const albums = results.map((row, idx) => {
    const v = albumView(row);
    v.coverUrl = coverUrls[idx];
    v.coverIsAuto = !row.cover_photo_id || row.cover_id !== row.cover_photo_id;
    v.lockedCover = (!!row.password_hash || !!row.encrypted) && !admin; // 前端显示锁形占位
    return v;
  });
  return json({
    ok: true,
    isAdmin: admin,
    albums,
  }, 200, { ETag: etag, ...API_CACHE_HEADERS });
}

async function createAlbum(request, env) {
  const body = await readJson(request);
  const name = String(body.name ?? '').trim();
  if (!name || name.length > 100) return fail('相册名必填且不超过100字');
  const description = String(body.description ?? '').trim().slice(0, 500);
  const id = crypto.randomUUID();

  // 加密相册：服务端只存「被 KEK 包裹的相册主密钥」与口令派生参数，永远拿不到明文密钥
  let encrypted = 0, encKey = null, kekSalt = null, kekIters = null;
  if (body.encrypted) {
    const enc = parseJson(typeof body.encKey === 'string' ? body.encKey : null);
    if (!enc || typeof enc.wrapped !== 'string' || typeof enc.iv !== 'string'
      || !/^[A-Za-z0-9_-]{16,512}$/.test(enc.wrapped) || !/^[A-Za-z0-9_-]{8,64}$/.test(enc.iv)) {
      return fail('加密相册缺少有效的包裹密钥');
    }
    if (typeof body.kekSalt !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(body.kekSalt)) {
      return fail('加密相册缺少有效的派生盐');
    }
    const iters = Number(body.kekIters);
    if (!Number.isSafeInteger(iters) || iters < 10000 || iters > 5000000) {
      return fail('加密相册迭代次数非法');
    }
    encrypted = 1;
    encKey = JSON.stringify(enc);
    kekSalt = body.kekSalt;
    kekIters = iters;
  }

  const passwordHash = body.password != null
    ? (isSixDigits(body.password) ? await hashPassword(body.password) : null)
    : null;
  if (body.password != null && !isSixDigits(body.password)) return fail('密码必须是6位数字');
  if (encrypted && passwordHash) return fail('加密相册使用加密口令，无需再设置数字密码');

  await env.DB.prepare(
    `INSERT INTO album (id, name, description, password_hash, encrypted, enc_key, kek_salt, kek_iters)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, name, description, passwordHash, encrypted, encKey, kekSalt, kekIters).run();
  await bumpAlbumVersion(env, id);
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
  await bumpAlbumVersion(env, albumId);
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
  await bumpAlbumVersion(env, albumId);
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
  await bumpAlbumVersion(env, albumId);
  return json({ ok: true });
}

async function clearAlbumPassword(request, env, albumId) {
  const result = await env.DB.prepare('UPDATE album SET password_hash = NULL WHERE id = ?')
    .bind(albumId).run();
  if (!result.meta.changes) return fail('相册不存在', 404);
  await bumpAlbumVersion(env, albumId);
  return json({ ok: true });
}

async function setAllAlbumPasswords(request, env) {
  const body = await readJson(request);
  if (!isSixDigits(body.password)) return fail('密码必须是6位数字');
  const hash = await hashPassword(body.password);
  // 加密相册走端到端口令，数字密码对其无意义，明确排除
  const result = await env.DB.prepare(
    'UPDATE album SET password_hash = ? WHERE encrypted = 0'
  ).bind(hash).run();
  return json({ ok: true, updated: result.meta.changes });
}

async function clearAllAlbumPasswords(request, env) {
  const result = await env.DB.prepare(
    'UPDATE album SET password_hash = NULL WHERE encrypted = 0'
  ).run();
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

// 预签名缩略图/大图 URL 集合（含 AVIF 变体；无 AVIF 时对应字段为 null，前端降级 WebP/JPEG）
// 签名是纯 CPU 操作（HMAC），5 个并行消除串行 await 的排队开销
async function presignMedia(env, r) {
  const thumbKey = r.thumb_key ?? r.object_key;
  const [thumbUrl, thumbAvifUrl, largeUrl, largeAvifUrl, proxyUrl] = await Promise.all([
    presignR2(env, 'GET', thumbKey, PHOTO_URL_TTL, { cacheControl: THUMB_CACHE }),
    r.thumb_avif_key
      ? presignR2(env, 'GET', r.thumb_avif_key, PHOTO_URL_TTL, { cacheControl: THUMB_CACHE }) : null,
    r.large_key
      ? presignR2(env, 'GET', r.large_key, PHOTO_URL_TTL, { cacheControl: THUMB_CACHE }) : null,
    r.large_avif_key
      ? presignR2(env, 'GET', r.large_avif_key, PHOTO_URL_TTL, { cacheControl: THUMB_CACHE }) : null,
    r.proxy_key
      ? presignR2(env, 'GET', r.proxy_key, PHOTO_URL_TTL) : null,
  ]);
  return { thumbUrl, thumbAvifUrl, largeUrl, largeAvifUrl, proxyUrl };
}

async function listPhotos(request, env, albumId) {
  const album = await env.DB.prepare('SELECT * FROM album WHERE id = ?').bind(albumId).first();
  if (!album) return fail('相册不存在', 404);
  const auth = await getAuth(request, env);
  if (!canAccessAlbum(auth, album)) {
    // 加密相册对未解锁访客也返回 403，但附带 encrypted 标记让前端弹「口令」框而非「数字密码」框
    return json({ ok: false, error: '需要相册密码', encrypted: !!album.encrypted }, 403);
  }

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

  // missing=1：只列缺缩略图的照片（回填选择器用）
  const missingOnly = reqUrl.searchParams.get('missing') === '1';

  // ETag：基于相册版本号（任何变更自增），命中则 304 省掉主查询
  // 时间桶保证预签名 URL 过期后强制 200 刷新（URL TTL 15 分钟）；身份位防 304 串身份
  const version = await getAlbumVersion(env, albumId);
  const cursorKey = cursorParam ? cursorParam.slice(0, 16) : '0';
  const urlBucket = Math.floor(Date.now() / 1000 / PHOTO_URL_TTL);
  const etag = `W/"v${version}-${cursorKey}-${limit}-${missingOnly ? 1 : 0}-t${urlBucket}-a${isAdmin(auth) ? 1 : 0}"`;
  if (request.headers.get('If-None-Match') === etag) {
    return new Response(null, {
      status: 304,
      headers: { ETag: etag, ...API_CACHE_HEADERS },
    });
  }

  const selectCols =
    `SELECT id, filename, object_key, thumb_key, large_key, thumb_avif_key, large_avif_key, proxy_key,
            content_type, size, kind, duration,
            created_at, taken_at, camera, tags, ai_desc, is_favorite, caption, thumb_hash, exif,
            enc_key, enc_meta,
            ${SORT_EXPR} AS sort_at`;
  // 动态附加条件（保持参数化）
  const extraSql = [];
  const extraParams = [];
  if (missingOnly) extraSql.push('thumb_key IS NULL');
  // 单张分享：只能看到被分享的那一张（忽略分页游标）
  // 注意：匿名访客 auth 为 null，必须短路判断，否则访问 auth.role 抛 TypeError → 500
  const singleShareId = auth && auth.role === 'share' && auth.photoId ? auth.photoId : null;
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

  // 行级签名并行（每页 60 张 × 最多 5 个签名，串行 await 是列表延迟的主要构成）
  const mediaList = await Promise.all(page.map((r) => presignMedia(env, r)));
  const photos = [];
  for (let idx = 0; idx < page.length; idx++) {
    const r = page[idx];
    let tags = [];
    try { tags = r.tags ? JSON.parse(r.tags) : []; } catch { tags = []; }
    // 加密相册：明文字段一律不下发（文件名/相机/标签/描述/备注/EXIF/缩略哈希），改下发密文元数据与包裹的文件密钥
    const isEnc = !!album.encrypted;
    photos.push({
      id: r.id,
      filename: isEnc ? null : r.filename,
      size: r.size,
      contentType: r.content_type,
      kind: r.kind ?? 'image',
      duration: r.duration ?? null,
      createdAt: r.created_at,
      takenAt: r.taken_at,
      camera: isEnc ? null : r.camera,
      tags: isEnc ? [] : tags,
      aiDesc: isEnc ? null : r.ai_desc,
      isFavorite: !!r.is_favorite,
      caption: isEnc ? null : r.caption,
      isThumb: !!r.thumb_key,
      thumbHash: isEnc ? null : r.thumb_hash,
      exif: isEnc ? null : parseJson(r.exif),
      encrypted: isEnc,
      encKey: isEnc ? r.enc_key : null,
      encMeta: isEnc ? r.enc_meta : null,
      ...mediaList[idx],
    });
  }

  // 缺缩略图/未打标计数仅管理员需要（前端据此显示回填/补打按钮），访客省 2 次全相册 COUNT
  let missingThumbs = 0, untaggedCount = 0;
  if (isAdmin(auth)) {
    const missingRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM photo
        WHERE album_id = ? AND status = 'ready' AND thumb_key IS NULL`
    ).bind(albumId).first();
    const untaggedRow = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM photo
        WHERE album_id = ? AND status = 'ready' AND tags IS NULL`
    ).bind(albumId).first();
    missingThumbs = missingRow?.n ?? 0;
    untaggedCount = untaggedRow?.n ?? 0;
  }

  return json({
    ok: true,
    album: {
      id: album.id, name: album.name,
      description: album.description,
      locked: !!album.password_hash,
      encrypted: !!album.encrypted,
      coverPhotoId: album.cover_photo_id ?? null,
    },
    photos,
    missingThumbs,
    untaggedCount,
    nextCursor: hasMore && page.length ? encodeCursor(page[page.length - 1].sort_at,
                                                       page[page.length - 1].id) : null,
    urlExpiresIn: PHOTO_URL_TTL,
  }, 200, { ETag: etag, ...API_CACHE_HEADERS });
}

async function createPhotoUpload(request, env, albumId, auth) {
  const album = await env.DB.prepare('SELECT id, encrypted FROM album WHERE id = ?').bind(albumId).first();
  if (!album) return fail('相册不存在', 404);

  // 成本护栏：R2 接近免费额度上限（>9.5GB）时冻结访客上传，管理员放行但响应携带告警
  const r2Alert = await r2UploadGuard(env);
  if (r2Alert && auth?.role === 'collect') {
    return fail('存储空间即将达到免费额度上限，访客上传已暂停，请联系管理员', 507);
  }

  // 求照片链接访客：每链接每 IP 每小时限 50 次
  if (auth?.role === 'collect') {
    const hits = await collectHit(env, auth.shareId, request);
    if (hits > COLLECT_HOUR_LIMIT) {
      return fail('上传过于频繁，请一小时后再试', 429);
    }
  }

  const body = await readJson(request);
  const filename = String(body.filename ?? 'photo.jpg').slice(0, 255);

  // ---- 分类与 Content-Type 由服务端权威决定，不信任客户端传入的 contentType ----
  // 非加密相册：按扩展名白名单判定（不在白名单直接拒绝，R2 对象 MIME 与扩展名绑定，
  // 防止把 text/html 等存进 R2 形成存储型 XSS/钓鱼页）；加密相册密文无扩展名，
  // kind 采信客户端声明（仅影响展示分类），密文对象一律 application/octet-stream
  let isVideo = false, contentType = null, storageMime = 'application/octet-stream', ext = 'bin';
  if (album.encrypted) {
    const declared = String(body.contentType ?? '');
    isVideo = declared.startsWith('video/');
    if (!isVideo && !declared.startsWith('image/')) return fail('只支持上传图片或视频');
    contentType = isVideo ? 'video/mp4' : 'image/jpeg';
  } else {
    const upload = resolveUploadExt(filename);
    if (!upload) return fail('不支持的文件格式');
    isVideo = upload.kind === 'video';
    contentType = upload.mime;
    storageMime = upload.mime;
    ext = upload.ext;
  }

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
  if (sha256 && !body.forceSha && !album.encrypted) {
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
  // ---- 全量 EXIF（快门/光圈/ISO/焦距/镜头/闪光灯），仅图片，做类型白名单校验 ----
  let exifJson = null;
  if (!isVideo && body.exif && typeof body.exif === 'object' && !Array.isArray(body.exif)) {
    const e = {};
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const aperture = num(body.exif.aperture);
    if (aperture && aperture > 0 && aperture < 100) e.aperture = aperture;
    const exposureTime = num(body.exif.exposureTime);
    if (exposureTime && exposureTime > 0 && exposureTime < 3600) e.exposureTime = exposureTime;
    const iso = num(body.exif.iso);
    if (iso && iso > 0 && iso < 1000000) e.iso = Math.round(iso);
    const focalLength = num(body.exif.focalLength);
    if (focalLength && focalLength > 0 && focalLength < 10000) e.focalLength = focalLength;
    if (typeof body.exif.lensModel === 'string' && body.exif.lensModel.trim()) {
      e.lensModel = body.exif.lensModel.trim().slice(0, 120);
    }
    if (body.exif.flash === 0 || body.exif.flash === 1) e.flash = body.exif.flash;
    if (Object.keys(e).length) exifJson = JSON.stringify(e);
  }

  // ---- 加密相册：接收 albumKey 加密的 fileKey 与 fileKey 加密的元数据 ----
  let encKey = null, encMeta = null;
  if (album.encrypted) {
    const enc = parseJson(typeof body.encKey === 'string' ? body.encKey : null);
    if (!enc || typeof enc.enc !== 'string' || typeof enc.iv !== 'string'
      || !/^[A-Za-z0-9_-]{16,512}$/.test(enc.enc) || !/^[A-Za-z0-9_-]{8,64}$/.test(enc.iv)) {
      return fail('加密相册缺少有效的文件密钥');
    }
    if (typeof body.encMeta !== 'string' || !/^[A-Za-z0-9_-]{16,8192}$/.test(body.encMeta)) {
      return fail('加密相册缺少有效的加密元数据');
    }
    encKey = JSON.stringify(enc);
    encMeta = body.encMeta;
  }

  // ---- 缩略图 key ----
  // 图片：格式由前端实际编码结果决定（webp/jpg）；视频：前端抽帧固定 jpg
  const thumbFmt = isVideo ? 'jpg'
    : (body.thumbContentType === 'image/webp' ? 'webp' : 'jpg');
  // AVIF：仅图片且前端实际产出了 AVIF 编码结果时启用（WebP/JPEG 仍保留作兜底）
  const hasAvif = !isVideo && body.thumbAvifContentType === 'image/avif';

  const id = crypto.randomUUID();
  const objectKey = `albums/${albumId}/${id}.${ext}`;
  const smallKey = body.thumbContentType ? `albums/${albumId}/${id}.s.${thumbFmt}` : null;
  const largeKey = body.thumbContentType ? `albums/${albumId}/${id}.m.${thumbFmt}` : null;
  const avifSmallKey = hasAvif ? `albums/${albumId}/${id}.s.avif` : null;
  const avifLargeKey = hasAvif ? `albums/${albumId}/${id}.m.avif` : null;
  const kind = isVideo ? 'video' : 'image';
  // 月日（MM-DD）：优先拍摄日期，无 EXIF 则用上传日期（UTC），用于往年今日索引
  const takenMd = (takenAt ?? new Date().toISOString()).slice(5, 10);

  await env.DB.prepare(
    `INSERT INTO photo
       (id, album_id, filename, object_key, content_type, status, kind, duration, sha256,
        thumb_key, large_key, thumb_avif_key, large_avif_key, taken_at, camera, gps_lat, gps_lng, taken_md, exif,
        enc_key, enc_meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, albumId, album.encrypted ? 'encrypted' : filename, objectKey, contentType, 'uploading', kind, duration, sha256,
    smallKey, largeKey, avifSmallKey, avifLargeKey, takenAt,
    album.encrypted ? null : camera, album.encrypted ? null : gpsLat, album.encrypted ? null : gpsLng,
    takenMd, album.encrypted ? null : exifJson,
    encKey, encMeta).run();

  // 预签名 PUT 把 Content-Type 纳入 SigV4 签名：前端必须用返回的权威 MIME 上传，
  // 否则签名校验失败——从协议层锁死 R2 对象的 Content-Type
  const uploadUrl = await presignR2(env, 'PUT', objectKey, UPLOAD_URL_TTL, { contentType: storageMime });
  // 大视频分段上传：前端显式请求 multipart 时发起，控制面在此，数据面直传 R2
  let uploadId = null;
  if (isVideo && body.multipart === true) {
    uploadId = await initiateMultipart(env, objectKey, storageMime);
  }
  const thumbMime = album.encrypted ? 'application/octet-stream'
    : (thumbFmt === 'webp' ? 'image/webp' : 'image/jpeg');
  const avifMime = album.encrypted ? 'application/octet-stream' : 'image/avif';
  let thumbUploadUrl = null, largeUploadUrl = null;
  let thumbAvifUploadUrl = null, largeAvifUploadUrl = null;
  const putJobs = [];
  if (smallKey) putJobs.push([smallKey, thumbMime], [largeKey, thumbMime]);
  if (avifSmallKey) putJobs.push([avifSmallKey, avifMime], [avifLargeKey, avifMime]);
  if (putJobs.length) {
    const urls = await Promise.all(
      putJobs.map(([k, m]) => presignR2(env, 'PUT', k, UPLOAD_URL_TTL, { contentType: m })));
    let i = 0;
    if (smallKey) { thumbUploadUrl = urls[i++]; largeUploadUrl = urls[i++]; }
    if (avifSmallKey) { thumbAvifUploadUrl = urls[i++]; largeAvifUploadUrl = urls[i++]; }
  }
  return json({
    ok: true, photoId: id, kind,
    multipart: !!uploadId, uploadId,
    uploadUrl: uploadId ? null : uploadUrl,
    thumbUploadUrl, largeUploadUrl, thumbAvifUploadUrl, largeAvifUploadUrl,
    uploadContentType: storageMime,
    thumbUploadContentType: smallKey ? thumbMime : null,
    avifUploadContentType: avifSmallKey ? avifMime : null,
    objectKey, smallKey, largeKey, avifSmallKey, avifLargeKey,
    uploadUrlExpiresIn: UPLOAD_URL_TTL,
    ...(r2Alert ? { r2Warning: '存储空间即将达到免费额度上限（>9.5GB），请尽快清理' } : {}),
  }, 201);
}

// 校验上传体元数据（phash / thumbHash），供 confirm 与 multipart complete 共用
function parseUploadMeta(request) {
  return readJson(request).then((body) => {
    let phash = null, thumbHash = null;
    if (body && typeof body.phash === 'string' && /^[0-9a-f]{16}$/i.test(body.phash)) {
      phash = body.phash.toLowerCase();
    }
    if (body && typeof body.thumbHash === 'string'
      && /^[A-Za-z0-9+/=]{1,60}$/.test(body.thumbHash)) {
      thumbHash = body.thumbHash;
    }
    return { phash, thumbHash };
  }).catch(() => ({ phash: null, thumbHash: null }));
}

// 上传完成后的统一收尾：校验 R2 对象与缩略图 → 置 ready → 异步视频补帧 / AI 打标 → 版本递增
// 返回 { notFound | missing | ok(size) }，供直传 confirm 与分段 complete 复用
async function finalizePhoto(env, photoId, ctx, { phash = null, thumbHash = null } = {}) {
  const photo = await env.DB.prepare(
    "SELECT p.id, p.album_id, p.object_key, p.status, p.kind, p.thumb_key, p.large_key, p.thumb_avif_key, p.large_avif_key, a.encrypted FROM photo p JOIN album a ON a.id = p.album_id WHERE p.id = ?"
  ).bind(photoId).first();
  if (!photo) return { notFound: true };
  if (photo.status === 'ready') return { ready: true };

  const obj = await env.R2.head(photo.object_key);
  if (!obj) return { missing: true };

  // Content-Type 兜底校验：R2 实际 MIME 必须与扩展名的权威映射一致
  // （预签名已把 Content-Type 纳入签名，此处防绕过/历史误传对象入库；
  //   加密相册密文为 application/octet-stream，不在扩展名映射表内则跳过）
  const expectMime = EXT_MIME[photo.object_key.split('.').pop()?.toLowerCase() ?? ''];
  const actualMime = (obj.httpContentType ?? '').split(';')[0].trim().toLowerCase();
  if (expectMime && actualMime && actualMime !== expectMime
    && actualMime !== 'application/octet-stream') {
    await env.R2.delete(photo.object_key).catch(() => {});
    return { mismatch: true };
  }

  // 缩略图 best-effort 校验：若小图没传成功（或 MIME 异常）则清空缩略图字段，前端自动降级原图
  const thumbMimeOk = (httpContentType) => {
    const m = (httpContentType ?? '').split(';')[0].trim().toLowerCase();
    return !m || m.startsWith('image/') || m === 'application/octet-stream';
  };
  let thumbKey = photo.thumb_key, largeKey = photo.large_key;
  if (thumbKey) {
    const t = await env.R2.head(thumbKey);
    if (!t || !thumbMimeOk(t.httpContentType)) {
      thumbKey = null;
      if (largeKey && !(await env.R2.head(largeKey))) largeKey = null;
    }
  }
  // AVIF 缩略图 best-effort：主缩略图缺失时一并清理；AVIF 单独缺失/异常则降级 WebP
  let thumbAvifKey = photo.thumb_avif_key, largeAvifKey = photo.large_avif_key;
  if (thumbAvifKey) {
    const a = thumbKey ? await env.R2.head(thumbAvifKey) : null;
    if (!a || !thumbMimeOk(a.httpContentType)) {
      thumbAvifKey = null;
      if (largeAvifKey && !(await env.R2.head(largeAvifKey))) largeAvifKey = null;
    }
  }

  await env.DB.prepare(
    `UPDATE photo SET status = 'ready', size = ?, content_type = ?,
                      thumb_key = ?, large_key = ?, thumb_avif_key = ?, large_avif_key = ?,
                      phash = ?, thumb_hash = COALESCE(?, thumb_hash)
     WHERE id = ?`
  ).bind(obj.size, obj.httpContentType ?? null, thumbKey, largeKey, thumbAvifKey, largeAvifKey,
    phash, thumbHash, photoId).run();
  // 加密相册跳过全部服务端 AI（内容为密文，无法处理）：视频补帧/代理转码、AI 打标、语义 embedding
  if (!photo.encrypted) {
    // 视频且前端未能抽帧：后台用 MEDIA 绑定 best-effort 补封面帧；并生成 H.264 代理
    if (photo.kind === 'video') {
      if (!thumbKey) {
        ctx?.waitUntil(ensureVideoPoster(env, { id: photoId, object_key: photo.object_key }));
      }
      ctx?.waitUntil(ensureVideoProxy(env, { id: photoId, object_key: photo.object_key }));
    }
    // 异步 AI 打标（额度内），不阻塞响应
    ctx?.waitUntil(tagPhotoOnUpload(env, photoId));
  }
  await bumpAlbumVersion(env, photo.album_id);
  return { ok: true, size: obj.size };
}

async function confirmPhoto(request, env, photoId, ctx) {
  const { phash, thumbHash } = await parseUploadMeta(request);
  const r = await finalizePhoto(env, photoId, ctx, { phash, thumbHash });
  if (r.notFound) return fail('照片记录不存在', 404);
  if (r.missing) return fail('R2 中未找到文件，请先完成直传', 409);
  if (r.mismatch) return fail('文件内容类型与声明不符，已拒绝入库', 415);
  return json({ ok: true, photo: { id: photoId, size: r.size } });
}

// 分段上传：换取单个分段的预签名 PUT URL（uploadId 由 createPhotoUpload 发起）
async function multipartPartUrl(request, env, photoId) {
  const photo = await env.DB.prepare(
    "SELECT id, album_id, object_key, content_type, status FROM photo WHERE id = ?"
  ).bind(photoId).first();
  if (!photo) return fail('照片记录不存在', 404);
  if (photo.status !== 'uploading') return fail('该照片无需继续上传', 409);

  const body = await readJson(request);
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
  const partNumber = Number(body.partNumber);
  if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return fail('无效的分段参数');
  }
  const url = await presignR2(env, 'PUT', photo.object_key, UPLOAD_URL_TTL, {
    contentType: photo.content_type ?? 'application/octet-stream',
    query: { partNumber, uploadId },
  });
  return json({ ok: true, url, contentType: photo.content_type ?? 'application/octet-stream', expiresIn: UPLOAD_URL_TTL });
}

// 分段上传完成：合并分段 → 校验 → 收尾（与直传 confirm 同逻辑）
async function multipartComplete(request, env, photoId, ctx) {
  const photo = await env.DB.prepare(
    "SELECT id, album_id, object_key, status FROM photo WHERE id = ?"
  ).bind(photoId).first();
  if (!photo) return fail('照片记录不存在', 404);
  if (photo.status === 'ready') return json({ ok: true, photo: { id: photoId } });

  const body = await readJson(request);
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
  const parts = Array.isArray(body.parts) ? body.parts
    .filter((p) => p && Number.isInteger(Number(p.partNumber)) && typeof p.etag === 'string')
    .map((p) => ({ partNumber: Number(p.partNumber), etag: p.etag })) : [];
  if (!uploadId || !parts.length) return fail('缺少上传凭证或分段列表');
  // 分段号必须连续且从 1 开始（客户端按序合并）
  const sorted = parts.map((p) => p.partNumber).sort((a, b) => a - b);
  if (sorted[0] !== 1 || sorted.some((n, i) => i > 0 && n !== sorted[i - 1] + 1)) {
    return fail('分段号必须从 1 连续递增');
  }

  try {
    await completeMultipart(env, photo.object_key, uploadId, parts);
  } catch (e) {
    console.log('multipart complete failed:', photoId, e?.message ?? String(e));
    return fail('合并分段失败，请重试', 500);
  }

  // phash / thumbHash 与上传凭证同体携带，避免二次读取请求体
  let phash = null, thumbHash = null;
  if (typeof body.phash === 'string' && /^[0-9a-f]{16}$/i.test(body.phash)) {
    phash = body.phash.toLowerCase();
  }
  if (typeof body.thumbHash === 'string' && /^[A-Za-z0-9+/=]{1,60}$/.test(body.thumbHash)) {
    thumbHash = body.thumbHash;
  }
  const r = await finalizePhoto(env, photoId, ctx, { phash, thumbHash });
  if (r.notFound) return fail('照片记录不存在', 404);
  if (r.missing) return fail('合并后对象校验失败，请重试', 409);
  if (r.mismatch) return fail('文件内容类型与声明不符，已拒绝入库', 415);
  return json({ ok: true, photo: { id: photoId, size: r.size } });
}

// 分段上传放弃（前端取消/失败时清理，避免 R2 残留未完成分段计费）
async function multipartAbort(request, env, photoId) {
  const photo = await env.DB.prepare(
    "SELECT id, album_id, object_key, status FROM photo WHERE id = ?"
  ).bind(photoId).first();
  if (!photo) return fail('照片记录不存在', 404);
  const body = await readJson(request);
  const uploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
  if (!uploadId) return fail('缺少 uploadId');
  await abortMultipart(env, photo.object_key, uploadId).catch(() => {});
  // 未完成即放弃：删除照片记录（保留已完成单段的 R2 残留由 abort 清理）
  await env.DB.prepare("DELETE FROM photo WHERE id = ? AND status = 'uploading'")
    .bind(photoId).run();
  return json({ ok: true });
}

// 按需换取新鲜的预签名 URL（列表里的 URL 可能已过期）
async function getPhotoUrl(request, env, photoId) {
  const row = await env.DB.prepare(
    `SELECT p.object_key, p.proxy_key, a.id AS album_id, a.password_hash, a.encrypted
     FROM photo p JOIN album a ON a.id = p.album_id
     WHERE p.id = ? AND p.status = 'ready'`
  ).bind(photoId).first();
  if (!row) return fail('照片不存在', 404);

  // 权限判定必须携带 encrypted（与 listPhotos 同口径）：加密相册不可未解锁访问，
  // 否则 password_hash 为 NULL 的加密相册会被误判为公开，匿名即可换取密文 URL
  const auth = await getAuth(request, env);
  if (!canAccessAlbum(auth, { id: row.album_id, password_hash: row.password_hash, encrypted: row.encrypted })) {
    return fail(row.encrypted ? '需要相册解锁' : '需要相册密码', 403);
  }
  // 单张分享 token 不得换取其他照片
  if (auth?.role === 'share' && auth.photoId && photoId !== auth.photoId) {
    return fail('无权访问该照片', 403);
  }
  const url = await presignR2(env, 'GET', row.object_key, PHOTO_URL_TTL);
  const proxyUrl = row.proxy_key ? await presignR2(env, 'GET', row.proxy_key, PHOTO_URL_TTL) : null;
  return json({ ok: true, url, proxyUrl, expiresIn: PHOTO_URL_TTL });
}

async function deletePhoto(request, env, photoId) {
  const photo = await env.DB.prepare(
    `SELECT id, album_id, object_key, thumb_key, large_key,
            thumb_avif_key, large_avif_key, proxy_key, status
       FROM photo WHERE id = ?`
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
  await bumpAlbumVersion(env, photo.album_id);
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
    `SELECT id, album_id, filename, object_key, thumb_key, large_key,
            thumb_avif_key, large_avif_key, proxy_key, status
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
    for (const aid of new Set(results.map((r) => r.album_id))) await bumpAlbumVersion(env, aid);
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
    // 全部衍生对象 key 都要跟着 rebase（漏掉 AVIF/proxy 会在旧前缀留下孤儿对象）
    const MOVE_KEY_COLS = ['object_key', 'thumb_key', 'large_key', 'thumb_avif_key', 'large_avif_key', 'proxy_key'];
    for (const id of ids) {
      const r = byId.get(id);
      if (r.album_id === targetAlbumId) { skipped++; continue; }
      try {
        const rebase = (k) =>
          k.replace(`albums/${r.album_id}/`, `albums/${targetAlbumId}/`);
        const pairs = [];
        const updates = {};
        for (const col of MOVE_KEY_COLS) {
          if (!r[col]) continue;
          const dst = rebase(r[col]);
          pairs.push([r[col], dst]);
          updates[col] = dst;
        }
        // R2 服务端 copy 成功后再改元数据，最后删旧对象（中途失败旧对象仍在）
        for (const [src, dst] of pairs) await env.R2.copy(src, dst);
        await env.DB.prepare(
          `UPDATE photo SET album_id = ?, ${MOVE_KEY_COLS.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`
        ).bind(targetAlbumId, ...MOVE_KEY_COLS.map((c) => updates[c] ?? null), r.id).run();
        for (const [src] of pairs) await env.R2.delete(src);
        moved++;
      } catch (e) {
        console.log('batch move failed:', r.id, e?.message ?? String(e));
        failed++;
      }
    }
    if (moved > 0) {
      for (const aid of new Set(results.map((r) => r.album_id))) await bumpAlbumVersion(env, aid);
      await bumpAlbumVersion(env, targetAlbumId);
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
  if (renamed > 0) {
    for (const aid of new Set(results.map((r) => r.album_id))) await bumpAlbumVersion(env, aid);
  }
  return json({ ok: true, renamed });
}

// ---------- 往年今日 ----------
// 历史年份（早于今年）同月同日拍摄/上传的照片；只能看到自己有权访问的相册
async function onThisDay(request, env) {
  const auth = await getAuth(request, env);
  const admin = isAdmin(auth);
  // 可见相册条件：公开相册（加密相册一律排除）/ 管理员全部 / 已解锁的那个相册
  const visible = albumVisibleSql(auth, admin);
  const albumVisible = visible.sql;
  const params = [...visible.params];

  const todayMd = new Date().toISOString().slice(5, 10); // MM-DD
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.filename, p.object_key, p.thumb_key, p.large_key, p.thumb_avif_key, p.large_avif_key, p.proxy_key,
            p.content_type, p.size,
            p.kind, p.duration, p.created_at, p.taken_at, p.camera, p.tags, p.ai_desc,
            p.is_favorite, p.caption, p.thumb_hash, p.exif,
            p.album_id, a.name AS album_name,
            COALESCE(p.taken_at, p.created_at) AS sort_at
       FROM photo p JOIN album a ON a.id = p.album_id
      WHERE p.status = 'ready'
        AND p.taken_md = ?
        AND CAST(strftime('%Y', COALESCE(p.taken_at, p.created_at)) AS INTEGER)
            < CAST(strftime('%Y', 'now') AS INTEGER)
        AND ${albumVisible}
      ORDER BY sort_at DESC, p.id DESC
      LIMIT 60`
  ).bind(todayMd, ...params).all();

  // 行级签名并行
  const mediaList = await Promise.all(results.map((r) => presignMedia(env, r)));
  const photos = results.map((r, idx) => {
    let tags = [];
    try { tags = r.tags ? JSON.parse(r.tags) : []; } catch { tags = []; }
    return {
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
      aiDesc: r.ai_desc ?? null,
      isFavorite: !!r.is_favorite,
      caption: r.caption ?? '',
      isThumb: !!r.thumb_key,
      thumbHash: r.thumb_hash ?? null,
      exif: parseJson(r.exif),
      ...mediaList[idx],
    };
  });
  return json({ ok: true, photos, todayMmDd: new Date().toISOString().slice(5, 10) });
}
// ---------- 地图视图：返回所有带 GPS 坐标的照片 ----------
async function geoPhotos(request, env) {
  const reqUrl = new URL(request.url);
  const auth = await getAuth(request, env);
  const admin = isAdmin(auth);
  const albumId = reqUrl.searchParams.get('albumId');

  // 可见相册条件（加密相册一律排除）
  const visible = albumVisibleSql(auth, admin);
  const albumVisible = visible.sql;
  const params = [...visible.params];

  const albumFilter = albumId ? 'AND p.album_id = ?' : '';
  if (albumId) params.push(albumId);

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.filename, p.thumb_key, p.thumb_avif_key, p.proxy_key, p.object_key, p.content_type,
            p.kind, p.taken_at, p.created_at, p.album_id, a.name AS album_name,
            p.gps_lat, p.gps_lng
       FROM photo p JOIN album a ON a.id = p.album_id
      WHERE p.status = 'ready'
        AND p.gps_lat IS NOT NULL AND p.gps_lng IS NOT NULL
        AND ${albumVisible}
        ${albumFilter}
      ORDER BY COALESCE(p.taken_at, p.created_at) DESC
      LIMIT 2000`
  ).bind(...params).all();

  // 行级签名并行
  const mediaList = await Promise.all(results.map((r) => presignMedia(env, r)));
  const photos = results.map((r, idx) => ({
    id: r.id,
    albumId: r.album_id,
    albumName: r.album_name,
    filename: r.filename,
    contentType: r.content_type,
    kind: r.kind ?? 'image',
    takenAt: r.taken_at,
    lat: r.gps_lat,
    lng: r.gps_lng,
    ...mediaList[idx],
  }));
  return json({ ok: true, photos });
}

// ---------- 重复照片检测：按 dHash 汉明距离 < 8 分组 ----------
function hammingHex(a, b) {
  let dist = 0;
  for (let i = 0; i < 16; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    // 4 bits 的 popcount
    dist += (x & 1) + ((x >> 1) & 1) + ((x >> 2) & 1) + ((x >> 3) & 1);
  }
  return dist;
}

async function findDuplicates(request, env) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.filename, p.thumb_key, p.large_key, p.thumb_avif_key, p.large_avif_key, p.proxy_key, p.object_key, p.phash,
            p.album_id, a.name AS album_name, p.created_at
       FROM photo p JOIN album a ON a.id = p.album_id
      WHERE p.status = 'ready' AND p.phash IS NOT NULL
      ORDER BY p.phash`
  ).all();

  if (results.length < 2) return json({ ok: true, groups: [] });

  // 并查集分组：汉明距离 < 8 视为相似
  const n = results.length;
  const parent = new Array(n).fill(0).map((_, i) => i);
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (x, y) => { const rx = find(x), ry = find(y); if (rx !== ry) parent[rx] = ry; };

  // LSH 分桶：64-bit dHash（16 hex 字符）拆 8 段 × 8-bit，仅共享任一段的对才计算完整距离。
  // 距离 ≤7 的对漏检率 <1%（需 8 个段全部含差异位才会漏），随机无关对进入候选 ~1/32，
  // 全量比较从 O(n²) 降到 ~O(n²/64)，避免大库撞 Worker CPU 限额
  const BANDS = 8;
  const buckets = Array.from({ length: BANDS }, () => new Map());
  for (let i = 0; i < n; i++) {
    const h = results[i].phash;
    for (let b = 0; b < BANDS; b++) {
      const key = h.slice(b * 2, b * 2 + 2);
      const arr = buckets[b].get(key);
      if (arr) arr.push(i); else buckets[b].set(key, [i]);
    }
  }
  const seen = new Set();
  for (const bucketMap of buckets) {
    for (const arr of bucketMap.values()) {
      for (let x = 0; x < arr.length; x++) {
        for (let y = x + 1; y < arr.length; y++) {
          const i = arr[x], j = arr[y];
          const pairKey = i * n + j;
          if (seen.has(pairKey)) continue;
          seen.add(pairKey);
          if (hammingHex(results[i].phash, results[j].phash) < 8) union(i, j);
        }
      }
    }
  }

  // 分组结构先行（纯 CPU），命中组的成员签名批量并行
  const groupIdx = new Map(); // root -> [行号]
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groupIdx.has(root)) groupIdx.set(root, []);
    groupIdx.get(root).push(i);
  }
  const usedRows = [...groupIdx.values()]
    .filter((rows) => rows.length >= 2).flat();
  const mediaMap = new Map(
    await Promise.all(usedRows.map(async (i) => [i, await presignMedia(env, results[i])]))
  );

  const groups = [...groupIdx.values()]
    .filter((rows) => rows.length >= 2)
    .map((rows) => rows.map((i) => {
      const r = results[i];
      return {
        id: r.id,
        filename: r.filename,
        albumId: r.album_id,
        albumName: r.album_name,
        createdAt: r.created_at,
        ...mediaMap.get(i),
      };
    }));
  return json({ ok: true, groups });
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

  // R2 免费额度常量统一来自 cost-guard（护栏与展示同源，改一处即可）
  const usedBytes = totals.bytes;
  const remainBytes = Math.max(0, R2_FREE_BYTES - usedBytes);
  const quota = {
    freeBytes: R2_FREE_BYTES,
    usedBytes,
    remainBytes,
    usagePercent: Math.min(100, Math.round((usedBytes / R2_FREE_BYTES) * 100)),
  };

  // D1 读写行数（usage-meter.js 自统计，UTC 自然日；免费额度按天计：读 500 万、写 10 万）
  const D1_READ_DAY = 5_000_000;
  const D1_WRITE_DAY = 100_000;
  const todayUtc = new Date().toISOString().slice(0, 10);
  const monthStart = todayUtc.slice(0, 7) + '-01';
  // 合并当日与当月 D1 用量为单条条件聚合，减少一次查询
  const d1Row = await env.DB.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN date = ? THEN rows_read ELSE 0 END), 0) AS today_read,
       COALESCE(SUM(CASE WHEN date = ? THEN rows_written ELSE 0 END), 0) AS today_written,
       COALESCE(SUM(rows_read), 0) AS month_read,
       COALESCE(SUM(rows_written), 0) AS month_written
       FROM d1_usage WHERE date >= ?`
  ).bind(todayUtc, todayUtc, monthStart).first();
  const d1 = {
    date: todayUtc,
    todayRead: d1Row?.today_read ?? 0,
    todayWritten: d1Row?.today_written ?? 0,
    monthRead: d1Row?.month_read ?? 0,
    monthWritten: d1Row?.month_written ?? 0,
    readLimit: D1_READ_DAY,
    writeLimit: D1_WRITE_DAY,
  };

  // 成本护栏：Images 月度用量（免费 5000 次/月，熔断线 4500）
  const imagesUsed = await imagesUsedThisMonth(env);
  const guard = {
    r2Alert: await r2UploadGuard(env),
    images: {
      used: imagesUsed,
      cap: IMAGES_MONTHLY_CAP,
      free: IMAGES_MONTHLY_FREE,
    },
  };

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
    quota,
    d1,
    guard,
    byAlbum: results.map((r) => ({
      albumId: r.id, name: r.name,
      photos: r.photos, videos: r.videos, bytes: r.bytes,
    })),
  });
}

// ---------- 语义搜索：BGE 向量余弦相似度 ----------
async function semanticSearch(request, env) {
  const reqUrl = new URL(request.url);
  const q = (reqUrl.searchParams.get('q') || '').trim();
  const albumIdParam = reqUrl.searchParams.get('albumId') || '';
  if (!q) return fail('搜索词不能为空', 400);

  // 生成查询文本的 embedding（与索引同模型，bge-m3 多语言）
  let queryVec;
  try {
    const emb = await env.AI.run(EMBED_MODEL, { text: q });
    queryVec = emb?.data?.[0];
    if (!Array.isArray(queryVec)) throw new Error('embedding empty');
  } catch (err) {
    return fail('语义搜索模型暂不可用：' + (err?.message || 'unknown'), 503);
  }

  // 可见范围与普通搜索完全一致（photoScope）：传入 albumId 即只在该相册内检索
  const auth = await getAuth(request, env);
  const scope = photoScope(auth, albumIdParam);
  if (scope.denied) return fail('无权搜索', 403);

  // 只检索当前模型版本的向量（旧模型向量自动隔离，防串维度）
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.filename, p.thumb_key, p.large_key, p.thumb_avif_key, p.large_avif_key, p.proxy_key, p.object_key, p.content_type,
            p.kind, p.taken_at, p.thumb_hash, p.album_id, a.name AS album_name,
            p.embedding
       FROM photo p JOIN album a ON a.id = p.album_id
      WHERE p.status = 'ready' AND p.embedding IS NOT NULL AND p.emb_model = ? ${scope.where}`
  ).bind(EMBED_VERSION, ...scope.params).all();

  // 查询向量预归一化 + Float32Array：qn/sqrt 只算一次（原先每行重复计算，白耗 CPU）
  const qv = Float32Array.from(queryVec);
  const dim = qv.length;
  let qn = 0;
  for (let i = 0; i < dim; i++) qn += qv[i] * qv[i];
  const qNorm = Math.sqrt(qn);

  const scored = [];
  for (const r of results) {
    let vec;
    try { vec = JSON.parse(r.embedding); } catch { continue; }
    if (!Array.isArray(vec) || vec.length !== dim) continue;
    // 余弦相似度
    let dot = 0, vn = 0;
    for (let i = 0; i < dim; i++) {
      const v = vec[i];
      dot += qv[i] * v;
      vn += v * v;
    }
    const sim = qNorm > 0 && vn > 0 ? dot / (qNorm * Math.sqrt(vn)) : 0;
    if (sim > SEMANTIC_THRESHOLD) { // bge-m3 实测校准的阈值
      scored.push({
        id: r.id,
        filename: r.filename,
        albumId: r.album_id,
        albumName: r.album_name,
        contentType: r.content_type,
        kind: r.kind ?? 'image',
        takenAt: r.taken_at,
        score: sim,
        thumbHash: r.thumb_hash ?? null,
        _row: r, // 签名推迟到 top-K 裁剪后，避免对落选行白白签名
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, 50);
  const mediaList = await Promise.all(top.map((s) => presignMedia(env, s._row)));
  const photos = top.map((s, i) => {
    const { _row, ...rest } = s;
    return { ...rest, ...mediaList[i] };
  });
  return json({ ok: true, photos });
}

// ---------- 服务端搜索 / 标签云 ----------

// LIKE 通配符与 JSON 引号转义（配合 ESCAPE '\'）
function likeEscape(s) {
  return String(s).replace(/[\\%_"]/g, (c) => '\\' + c);
}

/**
 * 解析调用方可访问的相册范围（搜索 / 标签云共用）
 * @returns {{where: string, params: string[], singlePhotoId: ?string, denied: boolean}}
 *   where 含前导 AND；admin 全局；album 公开相册+自己解锁的；share 仅其分享相册（单张收敛）
 */
function photoScope(auth, albumIdParam) {
  if (isAdmin(auth)) {
    return albumIdParam
      ? { where: 'AND p.album_id = ?', params: [albumIdParam], singlePhotoId: null, denied: false }
      : { where: '', params: [], singlePhotoId: null, denied: false };
  }
  if (auth?.role === 'share') {
    return {
      where: 'AND p.album_id = ?',
      params: [auth.albumId],
      singlePhotoId: auth.photoId ?? null,
      denied: false,
    };
  }
  if (auth?.role === 'album') {
    if (albumIdParam) {
      return {
        where: 'AND p.album_id = ? AND ((a.password_hash IS NULL AND a.encrypted = 0) OR a.id = ?)',
        params: [albumIdParam, auth.albumId],
        singlePhotoId: null,
        denied: false,
      };
    }
    return {
      where: 'AND ((a.password_hash IS NULL AND a.encrypted = 0) OR a.id = ?)',
      params: [auth.albumId],
      singlePhotoId: null,
      denied: false,
    };
  }
  // 匿名访客：必须指定相册，且该相册公开（未加密、无密码）
  return {
    where: 'AND p.album_id = ? AND a.password_hash IS NULL AND a.encrypted = 0',
    params: [albumIdParam],
    singlePhotoId: null,
    denied: !albumIdParam,
  };
}

// 搜索结果行 → 前端照片对象（与 listPhotos 同构，附带 albumId/albumName）
async function photoOut(env, r) {
  let tags = [];
  try { tags = r.tags ? JSON.parse(r.tags) : []; } catch { tags = []; }
  return {
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
    isFavorite: !!r.is_favorite,
    caption: r.caption ?? '',
    isThumb: !!r.thumb_key,
    thumbHash: r.thumb_hash ?? null,
    ...(await presignMedia(env, r)),
  };
}

// GET /api/search?q=&albumId=&favorite=1&cursor=  服务端全量搜索标签/文件名
async function searchPhotos(request, env, auth) {
  if (auth?.role === 'collect') return fail('求照片链接不支持搜索', 403);
  const u = new URL(request.url);
  const q = String(u.searchParams.get('q') ?? '').trim().slice(0, 60);
  const albumIdParam = u.searchParams.get('albumId') || '';
  const favoriteOnly = u.searchParams.get('favorite') === '1';
  const hasTagsParam = !!(u.searchParams.get('tags') || '').trim();
  if (!q && !favoriteOnly && !hasTagsParam) return fail('请输入搜索关键词', 400);

  const scope = photoScope(auth, albumIdParam);
  if (scope.denied) return fail('请先解锁相册再搜索', 403);

  let limit = parseInt(u.searchParams.get('limit') ?? '60', 10);
  if (!Number.isFinite(limit)) limit = 60;
  limit = Math.max(1, Math.min(100, limit));

  let cursor = null;
  const cursorParam = u.searchParams.get('cursor');
  if (cursorParam) {
    try { cursor = decodeCursor(cursorParam); } catch { return fail('无效的分页游标', 400); }
  }

  const conds = [`p.status = 'ready'`];
  const params = [];
  // tags=逗号分隔多标签（语义归组搜索）：组内任一标签命中即返回（OR）
  const tagList = (u.searchParams.get('tags') || '')
    .split(',').map((s) => s.trim().slice(0, 24)).filter(Boolean);
  const uniqTags = [...new Set(tagList)].slice(0, 16);
  if (q) {
    const filePat = '%' + likeEscape(q) + '%';
    // 文件名用 LIKE 模糊匹配；标签用 photo_tag 关联表精确匹配（走索引，不扫 JSON）
    conds.push(`(p.filename LIKE ? ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM photo_tag pt WHERE pt.photo_id = p.id AND pt.tag = ?
    ))`);
    params.push(filePat, q);
  }
  if (uniqTags.length) {
    conds.push(`EXISTS (
      SELECT 1 FROM photo_tag pt WHERE pt.photo_id = p.id AND pt.tag IN (${uniqTags.map(() => '?').join(',')})
    )`);
    params.push(...uniqTags);
  }
  if (!q && !favoriteOnly && !uniqTags.length) return fail('请输入搜索关键词', 400);
  if (favoriteOnly) conds.push('p.is_favorite = 1');
  if (scope.where) conds.push(scope.where.replace(/^AND /, ''));
  params.push(...scope.params);
  if (scope.singlePhotoId) { conds.push('p.id = ?'); params.push(scope.singlePhotoId); }
  // 注意：JOIN album 后 created_at 列名歧义（album 也有该列），排序表达式必须带 p. 前缀
  const sortExpr = 'COALESCE(p.taken_at, p.created_at)';
  if (cursor) {
    conds.push(`(${sortExpr}, p.id) < (?, ?)`);
    params.push(cursor.t, cursor.i);
  }

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.filename, p.object_key, p.thumb_key, p.large_key, p.thumb_avif_key, p.large_avif_key, p.proxy_key,
            p.content_type, p.size,
            p.kind, p.duration, p.created_at, p.taken_at, p.camera, p.tags, p.ai_desc,
            p.is_favorite, p.caption, p.thumb_hash, p.exif, p.album_id, a.name AS album_name,
            ${sortExpr} AS sort_at
       FROM photo p JOIN album a ON a.id = p.album_id
      WHERE ${conds.join(' AND ')}
      ORDER BY ${sortExpr} DESC, p.id DESC
      LIMIT ?`
  ).bind(...params, limit + 1).all();

  const hasMore = results.length > limit;
  const page = hasMore ? results.slice(0, limit) : results;
  const photos = await Promise.all(page.map((r) => photoOut(env, r)));

  return json({
    ok: true,
    photos,
    nextCursor: hasMore && page.length
      ? encodeCursor(page[page.length - 1].sort_at, page[page.length - 1].id) : null,
  }, 200, API_CACHE_HEADERS);
}

// GET /api/tags?albumId=  标签云（JSON 数组行展开聚合计数，Top 50）
async function listTags(request, env, auth) {
  if (auth?.role === 'collect') return fail('求照片链接不支持标签浏览', 403);
  const u = new URL(request.url);
  const scope = photoScope(auth, u.searchParams.get('albumId') || '');
  if (scope.denied) return fail('请先解锁相册再查看标签', 403);

  const conds = [`p.status = 'ready'`];
  const params = [];
  if (scope.where) conds.push(scope.where.replace(/^AND /, ''));
  params.push(...scope.params);
  if (scope.singlePhotoId) { conds.push('p.id = ?'); params.push(scope.singlePhotoId); }

  const { results } = await env.DB.prepare(
    `SELECT pt.tag AS tag, COUNT(*) AS n
       FROM photo_tag pt
       JOIN photo p ON p.id = pt.photo_id
       JOIN album a ON a.id = p.album_id
      WHERE ${conds.join(' AND ')}
      GROUP BY pt.tag
      ORDER BY n DESC, tag ASC
      LIMIT 50`
  ).bind(...params).all();

  return json({ ok: true, tags: results.map((r) => ({ tag: r.tag, n: r.n })) });
}

// GET /api/tag-groups?albumId=  语义归组标签云：同义标签合并为一组，每组代表词+组内照片数
async function listTagGroups(request, env, auth) {
  if (auth?.role === 'collect') return fail('求照片链接不支持标签浏览', 403);
  const u = new URL(request.url);
  const scope = photoScope(auth, u.searchParams.get('albumId') || '');
  if (scope.denied) return fail('请先解锁相册再查看标签', 403);

  const conds = [`p.status = 'ready'`];
  const params = [];
  if (scope.where) conds.push(scope.where.replace(/^AND /, ''));
  params.push(...scope.params);
  if (scope.singlePhotoId) { conds.push('p.id = ?'); params.push(scope.singlePhotoId); }

  const { results } = await env.DB.prepare(
    `SELECT pt.tag AS tag, COUNT(DISTINCT p.id) AS n
       FROM photo_tag pt
       JOIN photo p ON p.id = pt.photo_id
       JOIN album a ON a.id = p.album_id
      WHERE ${conds.join(' AND ')}
      GROUP BY pt.tag
      ORDER BY n DESC, tag ASC
      LIMIT 300`
  ).bind(...params).all();
  if (!results.length) return json({ ok: true, groups: [] });

  await ensureTagEmbTable(env);
  const clusters = await buildTagGroups(env, results);

  // 组内照片数：直接对组内标签计数求和（零额外查询）。
  // 近似依据：AI 打标提示词禁止同图出现互为近义的标签，同簇标签共存于同一照片的概率极低，
  // 求和与 COUNT(DISTINCT photo) 几乎一致（仅手工打了近义标签时会轻微高估，展示场景可接受）。
  const nOf = new Map(results.map((r) => [r.tag, r.n]));
  const groups = [];
  for (const c of clusters) {
    const members = [...c.members].sort((a, b) => (nOf.get(b) ?? 0) - (nOf.get(a) ?? 0));
    const n = members.reduce((sum, t) => sum + (nOf.get(t) ?? 0), 0);
    groups.push({ rep: members[0], n, tags: members });
  }

  groups.sort((a, b) => b.n - a.n || a.rep.localeCompare(b.rep, 'zh'));
  return json({ ok: true, groups: groups.slice(0, 24) });
}

// ---------- 收藏 / 备注 ----------

// 照片内容编辑权限：管理员，或解锁相册游客且照片归属其解锁相册（分享只读不行）
async function denyPhotoEditor(env, auth, photoId) {
  if (isAdmin(auth)) return null;
  if (auth?.role !== 'album') return fail('需要管理员登录或相册解锁', 401);
  const row = await env.DB.prepare(
    "SELECT album_id FROM photo WHERE id = ? AND status = 'ready'"
  ).bind(photoId).first();
  if (!row || row.album_id !== auth.albumId) return fail('无权操作该照片', 403);
  return null;
}

// POST /api/photos/:id/favorite  { value: true|false }
async function setFavorite(request, env, photoId) {
  const body = await readJson(request);
  const value = body.value === true || body.value === 1;
  const r = await env.DB.prepare(
    "UPDATE photo SET is_favorite = ? WHERE id = ? AND status = 'ready'"
  ).bind(value ? 1 : 0, photoId).run();
  if (!r.meta?.changes) return fail('照片不存在', 404);
  const row = await env.DB.prepare('SELECT album_id FROM photo WHERE id = ?').bind(photoId).first();
  if (row) await bumpAlbumVersion(env, row.album_id);
  return json({ ok: true, isFavorite: value });
}

// PATCH /api/photos/:id  { caption: string|null }
async function updatePhoto(request, env, photoId) {
  const body = await readJson(request);
  if (!('caption' in body)) return fail('缺少要更新的字段');
  const caption = String(body.caption ?? '').trim().slice(0, 500);
  const r = await env.DB.prepare(
    "UPDATE photo SET caption = ? WHERE id = ? AND status = 'ready'"
  ).bind(caption || null, photoId).run();
  if (!r.meta?.changes) return fail('照片不存在', 404);
  const row = await env.DB.prepare('SELECT album_id FROM photo WHERE id = ?').bind(photoId).first();
  if (row) await bumpAlbumVersion(env, row.album_id);
  return json({ ok: true, caption });
}

// ---------- 分享卡片封面（公开，供 OG 爬虫抓取） ----------

const OG_DEFAULT_ICON = 'https://album-web.pages.dev/icons/icon-512.png';

// GET /api/og/:shareId → 302 到封面签名图；无效链接或带访问密码的分享回退站点图标
async function ogCover(request, env, shareId) {
  const share = await env.DB.prepare(
    `SELECT album_id, photo_id, password_hash FROM share_link
      WHERE id = ? AND revoked = 0 AND expires_at > datetime('now')`
  ).bind(shareId).first();
  if (!share || share.password_hash) return Response.redirect(OG_DEFAULT_ICON, 302);

  const pickKey = async (photoId) => (await env.DB.prepare(
    `SELECT COALESCE(thumb_key, large_key, object_key) AS k FROM photo
      WHERE id = ? AND status = 'ready'`
  ).bind(photoId).first())?.k ?? null;

  let key = null;
  if (share.photo_id) {
    key = await pickKey(share.photo_id);
  } else {
    const album = await env.DB.prepare('SELECT cover_photo_id FROM album WHERE id = ?')
      .bind(share.album_id).first();
    if (album?.cover_photo_id) key = await pickKey(album.cover_photo_id);
    if (!key) {
      const r = await env.DB.prepare(
        `SELECT COALESCE(thumb_key, large_key, object_key) AS k FROM photo
          WHERE album_id = ? AND status = 'ready'
          ORDER BY ${SORT_EXPR} DESC, id DESC LIMIT 1`
      ).bind(share.album_id).first();
      key = r?.k ?? null;
    }
  }
  if (!key) return Response.redirect(OG_DEFAULT_ICON, 302);
  return Response.redirect(await presignR2(env, 'GET', key, PHOTO_URL_TTL), 302);
}

// ---------- 智能相册：按拍摄时间间隔聚类（旅行/事件） ----------

// 相邻两段间隔超过该阈值即切分为新的「事件」：12 小时（跨天）自动切分旅行/聚会
const EVENT_GAP_MS = 12 * 3600 * 1000;

// GET /api/smart/events?albumId=  返回按时间聚类的事件列表（含封面、起止、中心坐标）
async function smartEvents(request, env) {
  const u = new URL(request.url);
  const auth = await getAuth(request, env);
  const admin = isAdmin(auth);
  const albumIdParam = u.searchParams.get('albumId') || '';
  // 可见相册条件（与往年今日/地图一致，加密相册一律排除）
  const visible = albumVisibleSql(auth, admin);
  const params = [...visible.params];
  const conds = [`p.status = 'ready'`, visible.sql];
  if (albumIdParam) { conds.push('p.album_id = ?'); params.push(albumIdParam); }

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.thumb_key, p.thumb_avif_key, p.large_key, p.object_key,
            p.taken_at, p.created_at, p.gps_lat, p.gps_lng
       FROM photo p JOIN album a ON a.id = p.album_id
      WHERE ${conds.join(' AND ')}
      ORDER BY COALESCE(p.taken_at, p.created_at) ASC
      LIMIT 5000`
  ).bind(...params).all();
  if (!results.length) return json({ ok: true, events: [] });

  // 时间聚类：相邻照片间隔 > EVENT_GAP_MS 即切分
  const clusters = [];
  let cur = null;
  for (const r of results) {
    const ts = Date.parse(r.taken_at || r.created_at);
    if (!Number.isFinite(ts)) continue;
    if (!cur || ts - cur.lastTs > EVENT_GAP_MS) {
      cur = { start: ts, end: ts, lastTs: ts, last: r, count: 0, sumLat: 0, sumLng: 0, locCount: 0 };
      clusters.push(cur);
    }
    cur.end = ts; cur.lastTs = ts; cur.last = r; cur.count++;
    if (r.gps_lat != null && r.gps_lng != null) {
      cur.sumLat += r.gps_lat; cur.sumLng += r.gps_lng; cur.locCount++;
    }
  }

  const eventsRaw = [];
  for (const c of clusters) {
    if (c.count < 2) continue; // 单张不构成事件
    const cover = c.last; // 最近一张作封面
    const coverKey = cover.thumb_key ?? cover.thumb_avif_key ?? cover.object_key;
    eventsRaw.push({
      key: String(c.start),
      start: new Date(c.start).toISOString(),
      end: new Date(c.end).toISOString(),
      count: c.count,
      centerLat: c.locCount >= 2 ? c.sumLat / c.locCount : null,
      centerLng: c.locCount >= 2 ? c.sumLng / c.locCount : null,
      coverKey,
      coverAvifKey: cover.thumb_avif_key ?? null,
    });
  }
  // 封面签名并行
  const signed = await Promise.all(eventsRaw.map((e) => Promise.all([
    e.coverKey ? presignR2(env, 'GET', e.coverKey, PHOTO_URL_TTL, { cacheControl: THUMB_CACHE }) : null,
    e.coverAvifKey ? presignR2(env, 'GET', e.coverAvifKey, PHOTO_URL_TTL, { cacheControl: THUMB_CACHE }) : null,
  ])));
  const events = eventsRaw.map((e, i) => ({
    key: e.key, start: e.start, end: e.end, count: e.count,
    centerLat: e.centerLat, centerLng: e.centerLng,
    thumbUrl: signed[i][0], thumbAvifUrl: signed[i][1],
  }));
  return json({ ok: true, events });
}

// GET /api/smart/photos?albumId=&start=&end=  返回某段时间内的照片（同 listPhotos 形状）
async function smartPhotos(request, env) {
  const u = new URL(request.url);
  const auth = await getAuth(request, env);
  const admin = isAdmin(auth);
  const albumIdParam = u.searchParams.get('albumId') || '';
  const visible = albumVisibleSql(auth, admin);

  const start = u.searchParams.get('start') || '';
  const end = u.searchParams.get('end') || '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(start) || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(end)) {
    return fail('缺少时间范围', 400);
  }

  const conds = [`p.status = 'ready'`, visible.sql];
  const params = [...visible.params];
  // 与聚类口径一致：按 COALESCE(taken_at, created_at) 过滤
  conds.push(`COALESCE(p.taken_at, p.created_at) >= ? AND COALESCE(p.taken_at, p.created_at) <= ?`);
  params.push(start, end);
  if (albumIdParam) { conds.push('p.album_id = ?'); params.push(albumIdParam); }

  const sortExpr = 'COALESCE(p.taken_at, p.created_at)';
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.filename, p.object_key, p.thumb_key, p.large_key, p.thumb_avif_key, p.large_avif_key, p.proxy_key,
            p.content_type, p.size, p.kind, p.duration, p.created_at, p.taken_at, p.camera, p.tags, p.ai_desc,
            p.is_favorite, p.caption, p.thumb_hash, p.exif, p.album_id, a.name AS album_name
       FROM photo p JOIN album a ON a.id = p.album_id
      WHERE ${conds.join(' AND ')}
      ORDER BY ${sortExpr} DESC, p.id DESC
      LIMIT 300`
  ).bind(...params).all();

  const photos = await Promise.all(results.map((r) => photoOut(env, r)));
  return json({ ok: true, photos });
}
async function route(request, env, ctx) {
  const missing = requireEnv(env);
  if (missing.length) return fail('服务未配置完成，缺少: ' + missing.join(', '), 503);

  // 迁移先行（isolate 内只执行一次），随后进行应用层边缘检查
  const schemaReady = await ensurePhotoSchema(env);
  if (!schemaReady) {
    // 迁移反复失败（如 D1 异常）：返回 503 让客户端稍后重试，
    // 避免依赖新列（enc_key/enc_meta 等）的 listPhotos 抛 "no such column" → 500「服务器开小差」
    return json({ ok: false, error: '服务正在初始化，请稍后重试', retryable: true }, 503);
  }
  const edgeHit = await edgeGuard(request, env);
  if (edgeHit) return edgeHit;

  const url = new URL(request.url);
  const seg = url.pathname.split('/').filter(Boolean);
  // HEAD 按 GET 路由（OG 爬虫/健康检查常用；Response 会自动省去 body）
  const method = request.method === 'HEAD' ? 'GET' : request.method;
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
  // 分享卡片封面（公开，302 跳转；内部自行校验分享有效性，带密码不暴露真实图）
  if (method === 'GET' && seg[1] === 'og' && seg.length === 3) {
    return ogCover(request, env, seg[2]);
  }
  // 服务端全量搜索 / 标签云（公开，内部按相册可见性过滤）
  if (method === 'GET' && url.pathname === '/api/search') {
    return searchPhotos(request, env, auth);
  }
  if (method === 'GET' && url.pathname === '/api/tags') {
    return listTags(request, env, auth);
  }
  if (method === 'GET' && url.pathname === '/api/tag-groups') {
    return listTagGroups(request, env, auth);
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
  // 收藏 / 取消收藏（管理员或解锁相册游客，归属校验）
  if (method === 'POST' && seg[1] === 'photos' && seg[3] === 'favorite' && seg.length === 4) {
    const deny = await denyPhotoEditor(env, auth, seg[2]);
    if (deny) return deny;
    return setFavorite(request, env, seg[2]);
  }
  // 更新照片属性（目前仅 caption 备注；管理员或解锁相册游客，归属校验）
  if (method === 'PATCH' && seg[1] === 'photos' && seg.length === 3) {
    const deny = await denyPhotoEditor(env, auth, seg[2]);
    if (deny) return deny;
    return updatePhoto(request, env, seg[2]);
  }
  if (method === 'POST' && seg[1] === 'albums' && seg[3] === 'photos' && seg.length === 4) {
    const deny = denyUnlessAlbumEditor(seg[2]); if (deny) return deny;
    return createPhotoUpload(request, env, seg[2], auth);
  }
  // 照片内容级权限：管理员，或该照片归属其解锁相册（album/collect）
  const checkPhotoOwner = async (photoId) => {
    if (isAdmin(auth)) return null;
    if (auth?.role !== 'album' && auth?.role !== 'collect') {
      return fail('需要管理员登录或相册解锁', 401);
    }
    const row = await env.DB.prepare('SELECT album_id FROM photo WHERE id = ?')
      .bind(photoId).first();
    if (!row || row.album_id !== auth.albumId) return fail('无权操作该照片', 403);
    return null;
  };
  if (method === 'POST' && seg[1] === 'photos' && seg[3] === 'confirm' && seg.length === 4) {
    const deny = await checkPhotoOwner(seg[2]); if (deny) return deny;
    return confirmPhoto(request, env, seg[2], ctx);
  }
  // 大视频分段上传：换分段签名 / 合并 / 放弃
  if (method === 'POST' && seg[1] === 'photos' && seg[3] === 'upload-part' && seg.length === 4) {
    const deny = await checkPhotoOwner(seg[2]); if (deny) return deny;
    return multipartPartUrl(request, env, seg[2]);
  }
  if (method === 'POST' && seg[1] === 'photos' && seg[3] === 'complete-multipart' && seg.length === 4) {
    const deny = await checkPhotoOwner(seg[2]); if (deny) return deny;
    return multipartComplete(request, env, seg[2], ctx);
  }
  if (method === 'POST' && seg[1] === 'photos' && seg[3] === 'abort-multipart' && seg.length === 4) {
    const deny = await checkPhotoOwner(seg[2]); if (deny) return deny;
    return multipartAbort(request, env, seg[2]);
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
    // 覆盖式重打（批量 / 单张）仅管理员，避免访客消耗全站 AI 额度
    const adminMode = isAdmin(auth) && opts.mode === 'retag' ? 'retag' : 'fill';
    const photoId = isAdmin(auth) && typeof opts.photoId === 'string' ? opts.photoId : null;
    // since 必须是 ISO 时间串（前端在整轮重打开始时生成一次）
    const since = adminMode === 'retag' && typeof opts.since === 'string'
      && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(opts.since) ? opts.since : null;
    const result = await backfillTags(env, {
      albumId,
      limit: Number.isFinite(opts.limit) ? opts.limit : 20,
      mode: adminMode,
      photoId,
      since,
    });
    return json({ ok: true, ...result });
  }
  // 往年今日（公开，内部按相册可见性过滤）
  if (method === 'GET' && url.pathname === '/api/on-this-day') {
    return onThisDay(request, env);
  }
  // 智能相册：旅行/事件聚类（公开，内部按相册可见性过滤）
  if (method === 'GET' && url.pathname === '/api/smart/events') {
    return smartEvents(request, env);
  }
  if (method === 'GET' && url.pathname === '/api/smart/photos') {
    return smartPhotos(request, env);
  }
  // 地图视图：带 GPS 坐标的照片
  if (method === 'GET' && url.pathname === '/api/photos/geo') {
    return geoPhotos(request, env);
  }
  // 重复照片检测（管理员）
  if (method === 'GET' && url.pathname === '/api/duplicates') {
    const deny = adminOnly(); if (deny) return deny;
    return findDuplicates(request, env);
  }
  // 语义搜索（BGE 向量相似度）
  if (method === 'GET' && url.pathname === '/api/search/semantic') {
    return semanticSearch(request, env);
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
  // R2 孤儿对象一键清理（管理员）：删除 photo 表无引用的历史残留，直接降低 R2 计费基数
  if (method === 'POST' && url.pathname === '/api/admin/cleanup-orphans') {
    const deny = adminOnly(); if (deny) return deny;
    const r = await cleanupOrphans(env);
    return json({ ok: true, scanned: r.scanned, deleted: r.deleted, hasMore: r.hasMore });
  }

  return fail('接口不存在', 404);
}

export default {
  async fetch(request, env, ctx) {
    const { meteredEnv, counters } = createUsageMeter(env);
    let resp;
    try {
      if (request.method === 'OPTIONS') {
        resp = new Response(null, { status: 204 });
      } else {
        resp = await route(request, meteredEnv, ctx);
      }
    } catch (err) {
      // 详细错误仅写入 Worker 日志，对外脱敏
      console.log('worker error:', err?.stack ?? String(err));
      resp = json({ ok: false, error: '服务器开小差了，请稍后再试' }, 500);
    }
    flushUsage(env, counters, ctx); // 原始 env 落账，不计入自身
    // CORS 在出口统一按请求 Origin 白名单添加
    return withCors(resp, request);
  },

  // 每日定时清理（wrangler.toml [triggers].crons）
  async scheduled(controller, env) {
    console.log('scheduled fired:', controller.cron);
    const { meteredEnv, counters } = createUsageMeter(env);
    const summary = await runScheduledCleanup(meteredEnv);
    // 成本护栏：检查 R2 用量是否逼近免费额度，写/清告警标记
    summary.costGuard = await costGuardDaily(env);
    flushUsage(env, counters, controller);
    console.log('scheduled summary:', JSON.stringify(summary));
  },
};

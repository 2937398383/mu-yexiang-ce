// 分享链接：管理员签发/撤销；访客凭链接换短期 token
// 三种 kind：
//   album   整相册只读（role:'share'）
//   photo   单张照片只读（role:'share' + photoId，listPhotos 自动收敛为一张）
//   collect 求照片：访客可匿名上传，不能浏览（role:'collect'，每链接每 IP 每小时 50 次）
// token 为 HS256 JWT，最长 24 小时；可设访问密码（防链接外泄）
import { signJwt, hashSharePassword } from './auth.js';
import { checkLock, recordFailure, clearFailures } from './auth-guard.js';

const SHARE_TOKEN_TTL = 24 * 3600; // 换取的访问 token 最长 24h
const DAYS_WHITELIST = new Set([1, 7, 30]);
const KINDS = new Set(['album', 'photo', 'collect']);
// 路径式链接：Pages Functions(/s/:id) 向社交软件爬虫输出 OG 卡片，真人浏览器跳回 #/share/:id
const BASE_URL = 'https://album-web.pages.dev/s/';
const COLLECT_HOUR_LIMIT = 50;

function fail(error, status = 400, extra = {}) {
  return new Response(JSON.stringify({ ok: false, error, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

// 生成分享链接（管理员）
export async function createShare(request, env) {
  const body = await request.json().catch(() => ({}));
  const albumId = String(body.albumId ?? '');
  const kind = String(body.kind ?? 'album');
  const days = Number(body.days);
  if (!albumId) return fail('缺少相册 ID');
  if (!KINDS.has(kind)) return fail('分享类型不合法');
  if (!DAYS_WHITELIST.has(days)) return fail('有效期只支持 1 / 7 / 30 天');

  const album = await env.DB.prepare('SELECT id FROM album WHERE id = ?').bind(albumId).first();
  if (!album) return fail('相册不存在', 404);

  // 单张分享必须绑定该相册内一张就绪照片
  let photoId = null;
  if (kind === 'photo') {
    photoId = String(body.photoId ?? '');
    if (!photoId) return fail('单张分享缺少照片 ID');
    const photo = await env.DB.prepare(
      "SELECT id FROM photo WHERE id = ? AND album_id = ? AND status = 'ready'"
    ).bind(photoId, albumId).first();
    if (!photo) return fail('照片不存在或不属于该相册', 404);
  }

  // 可选访问密码：1–64 字符
  let passwordHash = null;
  if (body.password != null && String(body.password).length) {
    const password = String(body.password).slice(0, 64);
    if (password.length < 1) return fail('访问密码不能为空');
    passwordHash = await hashSharePassword(password);
  }

  const id = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  await env.DB.prepare(
    `INSERT INTO share_link (id, album_id, kind, photo_id, password_hash, expires_at)
     VALUES (?, ?, ?, ?, ?, datetime('now', '+' || ? || ' days'))`
  ).bind(id, albumId, kind, photoId, passwordHash, days).run();

  const row = await env.DB.prepare('SELECT expires_at FROM share_link WHERE id = ?').bind(id).first();
  return json({
    ok: true,
    id,
    kind,
    photoId,
    hasPassword: !!passwordHash,
    url: BASE_URL + id,
    expiresAt: row.expires_at,
  }, 201);
}

// 列出相册的有效分享（管理员）
export async function listShares(request, env) {
  const albumId = new URL(request.url).searchParams.get('albumId') ?? '';
  if (!albumId) return fail('缺少相册 ID');
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.kind, s.photo_id, s.password_hash, s.created_at, s.expires_at,
            (SELECT filename FROM photo ph WHERE ph.id = s.photo_id) AS photo_filename
       FROM share_link s
      WHERE s.album_id = ? AND s.revoked = 0 AND s.expires_at > datetime('now')
      ORDER BY s.created_at DESC`
  ).bind(albumId).all();
  return json({
    ok: true,
    shares: results.map((r) => ({
      id: r.id,
      kind: r.kind,
      photoId: r.photo_id,
      photoFilename: r.photo_filename,
      hasPassword: !!r.password_hash,
      url: BASE_URL + r.id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
    })),
  });
}

// 撤销分享（管理员）
export async function revokeShare(request, env, shareId) {
  const r = await env.DB.prepare('UPDATE share_link SET revoked = 1 WHERE id = ?')
    .bind(shareId).run();
  if (!r.meta?.changes) return fail('分享不存在', 404);
  return json({ ok: true });
}

// 访客凭分享链接换取信息 + 短期 token（公开）
// GET 无需密码；带密码的链接须 POST { password }
export async function redeemShare(request, env, shareId) {
  const share = await env.DB.prepare(
    `SELECT s.id, s.album_id, s.kind, s.photo_id, s.password_hash, s.expires_at,
            a.name, a.description
       FROM share_link s JOIN album a ON a.id = s.album_id
      WHERE s.id = ? AND s.revoked = 0 AND s.expires_at > datetime('now')`
  ).bind(shareId).first();
  if (!share) return fail('分享链接不存在或已失效', 404);

  // ---- 访问密码 ----
  if (share.password_hash) {
    if (request.method !== 'POST') {
      return fail('需要访问密码', 401, { needsPassword: true, kind: share.kind });
    }
    const scope = `share:${share.id}`;
    if (await checkLock(env, scope, request)) {
      return fail('密码错误或尝试次数过多', 401, { needsPassword: true, kind: share.kind });
    }
    const body = await request.json().catch(() => ({}));
    const hash = await hashSharePassword(String(body.password ?? ''));
    if (hash !== share.password_hash) {
      const r = await recordFailure(env, scope, request);
      return fail(r.locked ? '密码错误或尝试次数过多' : '密码错误', 401,
        { needsPassword: true, kind: share.kind });
    }
    await clearFailures(env, scope, request);
  }

  // token 有效期 = min(分享剩余时间, 24h)，到期前端重新换取
  const expiresMs = Date.parse(share.expires_at.replace(' ', 'T') + 'Z') - Date.now();
  const ttl = Math.max(60, Math.min(SHARE_TOKEN_TTL, Math.floor(expiresMs / 1000)));

  const claims = { role: share.kind === 'collect' ? 'collect' : 'share',
                   shareId: share.id, albumId: share.album_id };
  if (share.kind === 'photo') claims.photoId = share.photo_id;
  const token = await signJwt(claims, env.JWT_SECRET, ttl);

  return json({
    ok: true,
    kind: share.kind,
    photoId: share.kind === 'photo' ? share.photo_id : null,
    album: { id: share.album_id, name: share.name, description: share.description },
    token,
    expiresIn: ttl,
  });
}

// ---------- 求照片限流：每链接每 IP 每小时 50 次上传 ----------

function ipOf(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}
function hourKey() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}`;
}

// 计数 +1，返回当前小时累计次数；D1 故障时返回 0（降级放行）
export async function collectHit(env, shareId, request) {
  try {
    const row = await env.DB.prepare(
      `INSERT INTO collect_event (share_id, ip, hour, count) VALUES (?, ?, ?, 1)
       ON CONFLICT(share_id, ip, hour) DO UPDATE SET count = collect_event.count + 1
       RETURNING count`
    ).bind(shareId, ipOf(request), hourKey()).first();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

export { COLLECT_HOUR_LIMIT };

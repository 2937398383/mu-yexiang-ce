// 回收站：软删除后的查看/还原/彻底删除/清空，以及 scheduled 定时清理
import { presignR2 } from './presign.js';
import { bumpAlbumVersion } from './album-version.js';

const TRASH_URL_TTL = 900;
const EMPTY_BATCH = 100;       // 清空回收站单轮张数
const CRON_MAX = 200;          // scheduled 单轮总处理上限
const AGE_DAYS = 10;           // 回收站保留天数
const SIZE_LIMIT = 500 * 1024 * 1024; // 回收站原图总量上限 500MB

const PHOTO_COLS =
  `SELECT p.id, p.filename, p.object_key, p.thumb_key, p.large_key,
          p.content_type, p.size, p.created_at, p.taken_at, p.camera,
          p.trashed_at, p.album_id, a.name AS album_name`;

// 照片在 R2 的全部衍生对象 key（原图/缩略图/中图/双 AVIF/视频代理），物理删除必须全覆盖，
// 漏一类就永久残留 → 白白占用 R2 免费额度（10GB）
const ALL_KEY_COLS = ['object_key', 'thumb_key', 'large_key', 'thumb_avif_key', 'large_avif_key', 'proxy_key'];

// 统一物理删除：R2 对象（原图+全部衍生变体，批量合并）→ DB 行 → 封面引用清空
export async function purgePhotos(env, rows) {
  if (!rows.length) return;
  const keys = new Set();
  const ids = [];
  for (const r of rows) {
    ids.push(r.id);
    for (const col of ALL_KEY_COLS) {
      if (r[col]) keys.add(r[col]);
    }
  }
  const keyArr = [...keys];
  for (let i = 0; i < keyArr.length; i += 1000) {
    await env.R2.delete(keyArr.slice(i, i + 1000));
  }
  // 引用这些照片为自定义封面的相册：置空恢复自动
  await env.DB.prepare(
    `UPDATE album SET cover_photo_id = NULL
      WHERE cover_photo_id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).run();
  await env.DB.prepare(
    `DELETE FROM photo_tag WHERE photo_id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).run();
  await env.DB.prepare(
    `DELETE FROM photo WHERE id IN (${ids.map(() => '?').join(',')})`
  ).bind(...ids).run();
}

// 回收站列表（LEFT JOIN：原相册可能已删除）+ 计数与总大小
export async function listTrash(env) {
  const { results } = await env.DB.prepare(
    `${PHOTO_COLS} FROM photo p
      LEFT JOIN album a ON a.id = p.album_id
      WHERE p.status = 'trashed'
      ORDER BY p.trashed_at DESC, p.id DESC`
  ).all();

  const statRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS total
      FROM photo WHERE status = 'trashed'`
  ).first();

  const photos = [];
  for (const r of results) {
    const key = r.thumb_key ?? r.object_key;
    photos.push({
      id: r.id,
      filename: r.filename,
      size: r.size,
      contentType: r.content_type,
      createdAt: r.created_at,
      takenAt: r.taken_at,
      camera: r.camera,
      trashedAt: r.trashed_at,
      albumId: r.album_id,
      albumName: r.album_name, // 原相册已删除时为 null
      thumbUrl: await presignR2(env, 'GET', key, TRASH_URL_TTL),
    });
  }

  return {
    photos,
    count: statRow?.n ?? 0,
    totalSize: statRow?.total ?? 0,
    rules: { ageDays: AGE_DAYS, sizeLimit: SIZE_LIMIT },
  };
}

/**
 * 还原照片
 * @returns {Promise<{ok:true}|{needTarget:true, albums:Array}>}
 */
export async function restorePhoto(env, photoId, targetAlbumId) {
  const photo = await env.DB.prepare(
    'SELECT id, album_id FROM photo WHERE id = ? AND status = ?'
  ).bind(photoId, 'trashed').first();
  if (!photo) return { notFound: true };

  let target = photo.album_id;
  const origAlbum = photo.album_id
    ? await env.DB.prepare('SELECT id FROM album WHERE id = ?').bind(photo.album_id).first()
    : null;
  if (!origAlbum) target = null;

  if (!target) {
    if (!targetAlbumId) {
      const { results } = await env.DB.prepare(
        'SELECT id, name FROM album ORDER BY created_at DESC'
      ).all();
      return { needTarget: true, albums: results };
    }
    const ok = await env.DB.prepare('SELECT id FROM album WHERE id = ?')
      .bind(targetAlbumId).first();
    if (!ok) return { badTarget: true };
    target = targetAlbumId;
  }

  await env.DB.prepare(
    "UPDATE photo SET status = 'ready', trashed_at = NULL, album_id = ? WHERE id = ?"
  ).bind(target, photoId).run();
  await bumpAlbumVersion(env, target);
  return { ok: true, albumId: target };
}

// 清空回收站：单轮 EMPTY_BATCH 张，返回已删/剩余，供前端循环
export async function emptyTrashBatch(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, ${ALL_KEY_COLS.join(', ')} FROM photo
      WHERE status = 'trashed'
      ORDER BY trashed_at ASC
      LIMIT ?`
  ).bind(EMPTY_BATCH).all();
  await purgePhotos(env, results);
  const remainRow = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM photo WHERE status = 'trashed'"
  ).first();
  return { deleted: results.length, remaining: remainRow?.n ?? 0 };
}

// scheduled：① 超 10 天 ② 总量超 500MB（最早删除优先）③ uploading 孤儿
export async function runScheduledCleanup(env) {
  const summary = { expired: 0, oversize: 0, orphans: 0 };

  // ① 超过保留天数
  const { results: expired } = await env.DB.prepare(
    `SELECT id, ${ALL_KEY_COLS.join(', ')} FROM photo
      WHERE status = 'trashed' AND trashed_at < datetime('now', ?)
      LIMIT ?`
  ).bind(`-${AGE_DAYS} days`, CRON_MAX).all();
  if (expired.length) {
    await purgePhotos(env, expired);
    summary.expired = expired.length;
  }

  // ② 总量超限：按最早删除顺序淘汰，直到不超限或用满单轮上限
  const statRow = await env.DB.prepare(
    "SELECT COALESCE(SUM(size), 0) AS total FROM photo WHERE status = 'trashed'"
  ).first();
  if ((statRow?.total ?? 0) > SIZE_LIMIT) {
    const budget = CRON_MAX - summary.expired;
    let used = 0;
    while (used < budget) {
      const take = Math.min(50, budget - used);
      const { results: batch } = await env.DB.prepare(
        `SELECT id, ${ALL_KEY_COLS.join(', ')}, size FROM photo
          WHERE status = 'trashed'
          ORDER BY trashed_at ASC
          LIMIT ?`
      ).bind(take).all();
      if (!batch.length) break;
      await purgePhotos(env, batch);
      used += batch.length;
      const nowRow = await env.DB.prepare(
        "SELECT COALESCE(SUM(size), 0) AS total FROM photo WHERE status = 'trashed'"
      ).first();
      if ((nowRow?.total ?? 0) <= SIZE_LIMIT) break;
    }
    summary.oversize = used;
  }

  // ③ 上传中断超 24 小时的孤儿：删行 + best-effort 删可能存在的 R2 对象
  const { results: orphans } = await env.DB.prepare(
    `SELECT id, object_key FROM photo
      WHERE status = 'uploading' AND created_at < datetime('now', '-1 day')
      LIMIT ?`
  ).bind(CRON_MAX).all();
  if (orphans.length) {
    const keys = new Set();
    for (const o of orphans) {
      if (o.object_key) {
        keys.add(o.object_key);
        // 推导全部衍生 key（与上传 key 规则一致：缩略图可能是 jpg/webp/avif，视频有 proxy）
        const base = o.object_key.replace(/\.[^.]+$/, '');
        for (const s of ['.s.jpg', '.m.jpg', '.s.webp', '.m.webp', '.s.avif', '.m.avif', '.proxy.mp4']) {
          keys.add(base + s);
        }
      }
    }
    const keyArr = [...keys];
    for (let i = 0; i < keyArr.length; i += 1000) {
      try { await env.R2.delete(keyArr.slice(i, i + 1000)); } catch { /* 忽略 */ }
    }
    await env.DB.prepare(
      `DELETE FROM photo WHERE id IN (${orphans.map(() => '?').join(',')})`
    ).bind(...orphans.map((o) => o.id)).run();
    summary.orphans = orphans.length;
  }

  // 补齐缺失的 taken_md（历史回填已从冷启动迁移移至此处兜底；
  // 命中 taken_md 索引，无缺失行时近乎零成本）
  try {
    await env.DB.prepare(
      `UPDATE photo SET taken_md = substr(COALESCE(taken_at, created_at), 6, 5)
        WHERE taken_md IS NULL AND COALESCE(taken_at, created_at) IS NOT NULL`
    ).run();
  } catch { /* 非致命 */ }

  // 失败计数表清理（30 天未更新）
  // 过期 30 天的登录失败记录
  await env.DB.prepare(
    "DELETE FROM auth_fail WHERE updated_at < datetime('now', '-30 days')"
  ).run();

  // 过期 30 天的分享链接
  await env.DB.prepare(
    "DELETE FROM share_link WHERE expires_at < datetime('now', '-30 days')"
  ).run();

  // 限流计数清理（2 小时前的分钟窗口）
  await env.DB.prepare(
    "DELETE FROM rate_event WHERE minute < strftime('%Y%m%d%H%M', 'now', '-2 hours')"
  ).run();
  // 求照片计数清理（2 小时前的小时窗口）
  await env.DB.prepare(
    "DELETE FROM collect_event WHERE hour < strftime('%Y%m%d%H', 'now', '-2 hours')"
  ).run();

  return summary;
}

// 管理员一键清理 R2 孤儿对象：遍历 albums/ 前缀，删除 photo 表无引用的对象
// （历史版本泄漏的 AVIF/proxy 变体、上传中断残留等）。单轮最多扫 6000 个对象，
// 响应带 hasMore 提示是否继续调用。R2 list 属 Class B 操作（免费 1000 万次/月）。
export async function cleanupOrphans(env) {
  const referenced = new Set();
  const { results } = await env.DB.prepare(
    `SELECT ${ALL_KEY_COLS.join(', ')} FROM photo`
  ).all();
  for (const r of results) {
    for (const col of ALL_KEY_COLS) {
      if (r[col]) referenced.add(r[col]);
    }
  }

  const SCAN_LIMIT = 6000;
  let scanned = 0;
  const orphans = [];
  let cursor;
  do {
    const list = await env.R2.list({ prefix: 'albums/', cursor, limit: 1000 });
    scanned += list.objects.length;
    for (const obj of list.objects) {
      if (!referenced.has(obj.key)) orphans.push(obj.key);
    }
    cursor = list.truncated ? list.cursor : undefined;
  } while (cursor && scanned < SCAN_LIMIT && orphans.length < SCAN_LIMIT);

  let deleted = 0;
  for (let i = 0; i < orphans.length; i += 1000) {
    await env.R2.delete(orphans.slice(i, i + 1000));
    deleted += Math.min(1000, orphans.length - i);
  }
  return { scanned, deleted, orphans, hasMore: !!cursor };
}

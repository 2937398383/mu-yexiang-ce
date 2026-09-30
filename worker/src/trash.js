// 回收站：软删除后的查看/还原/彻底删除/清空，以及 scheduled 定时清理
import { presignR2 } from './presign.js';

const TRASH_URL_TTL = 900;
const EMPTY_BATCH = 100;       // 清空回收站单轮张数
const CRON_MAX = 200;          // scheduled 单轮总处理上限
const AGE_DAYS = 10;           // 回收站保留天数
const SIZE_LIMIT = 500 * 1024 * 1024; // 回收站原图总量上限 500MB

const PHOTO_COLS =
  `SELECT p.id, p.filename, p.object_key, p.thumb_key, p.large_key,
          p.content_type, p.size, p.created_at, p.taken_at, p.camera,
          p.trashed_at, p.album_id, a.name AS album_name`;

// 统一物理删除：R2 对象（原图+缩略图，批量合并）→ DB 行 → 封面引用清空
export async function purgePhotos(env, rows) {
  if (!rows.length) return;
  const keys = new Set();
  const ids = [];
  for (const r of rows) {
    ids.push(r.id);
    for (const k of [r.object_key, r.thumb_key, r.large_key]) {
      if (k) keys.add(k);
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
  // 递增相册版本号（列表 ETag 失效）
  try {
    await env.DB.prepare(
      `INSERT INTO album_version(album_id, v) VALUES(?, 1)
       ON CONFLICT(album_id) DO UPDATE SET v = v + 1`
    ).bind(target).run();
  } catch { /* ignore */ }
  return { ok: true, albumId: target };
}

// 清空回收站：单轮 EMPTY_BATCH 张，返回已删/剩余，供前端循环
export async function emptyTrashBatch(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, object_key, thumb_key, large_key FROM photo
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
    `SELECT id, object_key, thumb_key, large_key FROM photo
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
        `SELECT id, object_key, thumb_key, large_key, size FROM photo
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
        // 推导缩略图 key（与上传 key 规则一致）
        keys.add(o.object_key.replace(/(\.[^.]+)$/, '.s$1'));
        keys.add(o.object_key.replace(/(\.[^.]+)$/, '.m$1'));
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

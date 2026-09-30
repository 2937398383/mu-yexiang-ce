// 历史照片缩略图回填 —— Cloudflare Images 绑定批量生成
// 由管理员触发（POST /api/admin/backfill-thumbs），每批 BATCH_SIZE 张：
//   R2 取原图 → Images 双尺寸 WebP（400 / 1600）→ 写回 R2 → 更新 D1
// Free 计划每月 5000 unique transformations（每张照片 2 次）；input 上限 20MB。

const BATCH_SIZE = 5;
const MAX_INPUT_BYTES = 20_000_000;

// 从原图 key 派生缩略图 key：albums/<album>/<photo>.jpg → .../<photo>.s.webp
function thumbKeyOf(objectKey, suffix) {
  return objectKey.replace(/\.[^.]+$/, `.${suffix}.webp`);
}

// 调用一次 Images 缩放，返回字节；HTTP 失败时抛出含响应体的错误
async function imageToWebp(env, bytes, width, quality) {
  const pipe = env.IMAGES.input(bytes)
    .transform({ width, fit: 'scale-down' })
    .output({ format: 'image/webp', quality });
  const resp = pipe.response();
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 300); } catch { /* ignore */ }
    throw new Error(`Images HTTP ${resp.status} ${detail}`);
  }
  return new Uint8Array(await resp.arrayBuffer());
}

function isQuotaError(message) {
  return /9422|quota|usage limit|rate limit/i.test(message);
}

/**
 * 执行一批回填
 * @param {object} env
 * @param {object} [opts]
 * @param {string} [opts.albumId]  限定相册
 * @param {string} [opts.dateFrom] 上传起始日（YYYY-MM-DD，含）
 * @param {string} [opts.dateTo]   上传截止日（YYYY-MM-DD，含）
 * @param {string[]} [opts.ids]    指定照片（至多 5 张）；提供时忽略其他筛选
 * @returns {{processed:number, skipped:number, remaining:number, quotaExhausted:boolean}}
 */
export async function runBackfillBatch(env, opts = {}) {
  const where = ["status = 'ready'", "thumb_key IS NULL"];
  const binds = [];

  if (Array.isArray(opts.ids) && opts.ids.length) {
    const ids = [...new Set(opts.ids)].slice(0, 5);
    where.push(`id IN (${ids.map(() => '?').join(',')})`);
    binds.push(...ids);
  } else {
    if (opts.albumId) { where.push('album_id = ?'); binds.push(opts.albumId); }
    if (/^\d{4}-\d{2}-\d{2}$/.test(opts.dateFrom ?? '')) {
      where.push("created_at >= ?"); binds.push(opts.dateFrom + ' 00:00:00');
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(opts.dateTo ?? '')) {
      where.push("created_at <= ?"); binds.push(opts.dateTo + ' 23:59:59');
    }
  }

  const whereSql = 'WHERE ' + where.join(' AND ');
  const { results } = await env.DB.prepare(
    `SELECT id, album_id, object_key FROM photo ${whereSql}
      ORDER BY created_at ASC
      LIMIT ?`
  ).bind(...binds, BATCH_SIZE).all();

  let processed = 0;
  let skipped = 0;
  let quotaExhausted = false;
  const doneIds = [];

  for (const p of results) {
    try {
      const head = await env.R2.head(p.object_key);
      if (!head || head.size > MAX_INPUT_BYTES) { skipped++; continue; }

      const obj = await env.R2.get(p.object_key);
      const bytes = await obj.arrayBuffer();

      let smallBytes, largeBytes;
      try {
        // 两次独立 pipeline（参数组合不同，各自计一次 unique transformation）
        [smallBytes, largeBytes] = await Promise.all([
          imageToWebp(env, bytes, 400, 80),
          imageToWebp(env, bytes, 1600, 85),
        ]);
      } catch (e) {
        if (isQuotaError(String(e?.message ?? e))) {
          quotaExhausted = true;
          break;
        }
        skipped++;
        continue;
      }

      const smallKey = thumbKeyOf(p.object_key, 's');
      const largeKey = thumbKeyOf(p.object_key, 'm');
      await Promise.all([
        env.R2.put(smallKey, smallBytes,
          { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' } }),
        env.R2.put(largeKey, largeBytes,
          { httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' } }),
      ]);
      await env.DB.prepare(
        'UPDATE photo SET thumb_key = ?, large_key = ? WHERE id = ?'
      ).bind(smallKey, largeKey, p.id).run();
      // 缩略图生成 → 相册列表 ETag 失效
      try {
        await env.DB.prepare(
          `INSERT INTO album_version(album_id, v) VALUES(?, 1)
           ON CONFLICT(album_id) DO UPDATE SET v = v + 1`
        ).bind(p.album_id).run();
      } catch { /* ignore */ }
      processed++;
      doneIds.push(p.id);
    } catch {
      skipped++;
    }
  }

  const remainRow = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photo ${whereSql}`
  ).bind(...binds).first();

  return {
    processed,
    skipped,
    remaining: remainRow?.n ?? 0,
    quotaExhausted,
    doneIds,
  };
}

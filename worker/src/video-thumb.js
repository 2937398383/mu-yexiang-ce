// 视频封面帧：通过 Media Transformations 绑定从 R2 视频抽取静态帧
// Media 绑定 2026-03 公测，期间转换操作不计费
// 官方限制：输入 <100MB、时长 <10 分钟、官方仅保证 H.264 MP4；其他格式 best-effort
// 全部调用均为 best-effort：失败仅记日志，不影响原视频与主流程

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
const FRAME_TIME = '1s'; // 取 1 秒处，避免片头黑屏

// 从一个 R2 对象抽取指定宽度的 JPEG 帧；MEDIA.input 的 body 只能消费一次
async function extractFrame(env, r2Object, width) {
  if (!env.MEDIA) throw new Error('MEDIA binding missing');
  const result = env.MEDIA.input(r2Object.body)
    .transform({ width })
    .output({ mode: 'frame', time: FRAME_TIME, format: 'jpg' });
  return {
    stream: await result.media(),
    contentType: await result.contentType(),
  };
}

// 给单个视频补封面帧；photo 需含 id、object_key
export async function ensureVideoPoster(env, photo) {
  try {
    const head = await env.R2.head(photo.object_key);
    if (!head) return { ok: false, reason: 'missing' };
    if (head.size > MAX_VIDEO_BYTES) return { ok: false, reason: 'too_large' };

    const dot = photo.object_key.lastIndexOf('.');
    const base = photo.object_key.slice(0, dot); // albums/<albumId>/<uuid>
    const smallKey = base + '.s.jpg';
    const largeKey = base + '.m.jpg';

    // 小图（网格用）
    const objSmall = await env.R2.get(photo.object_key);
    const small = await extractFrame(env, objSmall, 640);
    await env.R2.put(smallKey, small.stream, {
      httpMetadata: { contentType: small.contentType || 'image/jpeg' },
    });

    // 大图（查看器用）；失败时仅登记小图
    try {
      const objLarge = await env.R2.get(photo.object_key);
      const large = await extractFrame(env, objLarge, 1600);
      await env.R2.put(largeKey, large.stream, {
        httpMetadata: { contentType: large.contentType || 'image/jpeg' },
      });
      await env.DB.prepare(
        'UPDATE photo SET thumb_key = ?, large_key = ? WHERE id = ?'
      ).bind(smallKey, largeKey, photo.id).run();
    } catch (e) {
      await env.DB.prepare(
        'UPDATE photo SET thumb_key = ? WHERE id = ?'
      ).bind(smallKey, photo.id).run();
      console.log('video large frame failed:', photo.id, e?.message ?? String(e));
    }
    return { ok: true };
  } catch (e) {
    console.log('ensureVideoPoster failed:', photo.id, e?.message ?? String(e));
    return { ok: false, reason: 'error' };
  }
}

// 批量回填无封面视频（默认每批 3 个）
export async function backfillVideoPosters(env, { limit = 3 } = {}) {
  limit = Math.max(1, Math.min(5, Number(limit) || 3));
  const { results } = await env.DB.prepare(
    `SELECT id, object_key FROM photo
      WHERE kind = 'video' AND status = 'ready' AND thumb_key IS NULL
      LIMIT ?`
  ).bind(limit).all();

  let done = 0, skipped = 0;
  for (const row of results) {
    const r = await ensureVideoPoster(env, row);
    if (r.ok) done++;
    else skipped++;
  }

  const { results: cnt } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photo
      WHERE kind = 'video' AND status = 'ready' AND thumb_key IS NULL`
  ).all();
  return { done, skipped, remaining: cnt[0]?.n ?? 0 };
}

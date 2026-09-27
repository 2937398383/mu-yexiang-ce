// AI 照片标签：Workers AI LLaVA 图生文，异步打标，失败不阻塞主流程
// 额度：全站每日 300 张（免费层 10000 neurons/天，LLaVA 单张约 20~30 neurons，留足余量）

const MODEL = '@cf/llava-hf/llava-1.5-7b-hf';
const DAILY_LIMIT = 300;
const MAX_INPUT_BYTES = 8 * 1024 * 1024; // 大图跳过（thumb 通常远小于此）
const PROMPT = '用3到6个中文词语描述这张照片的内容，只输出词语，用逗号分隔';

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// 额度预检 + 消费（原子：先查后加，单日最多 DAILY_LIMIT 张）
async function consumeQuota(env) {
  const day = todayUTC();
  const row = await env.DB.prepare('SELECT count FROM ai_tag_daily WHERE day = ?')
    .bind(day).first();
  if ((row?.count ?? 0) >= DAILY_LIMIT) return false;
  await env.DB.prepare(
    `INSERT INTO ai_tag_daily (day, count) VALUES (?, 1)
     ON CONFLICT(day) DO UPDATE SET count = count + 1`
  ).bind(day).run();
  return true;
}

export async function quotaLeftToday(env) {
  const row = await env.DB.prepare('SELECT count FROM ai_tag_daily WHERE day = ?')
    .bind(todayUTC()).first();
  return Math.max(0, DAILY_LIMIT - (row?.count ?? 0));
}

// 解析模型输出 → 标签数组（兼容中英文逗号/顿号/换行）
function parseTags(text) {
  return String(text ?? '')
    .split(/[,，、\n;；]+/)
    .map((t) => t.trim().replace(/^[。.\s]+|[。.\s]+$/g, ''))
    .filter((t) => t && t.length <= 20)
    .slice(0, 8);
}

// 给单张照片打标；成功写回 tags 返回 true，失败/跳过返回 false
export async function tagPhoto(env, photo) {
  const key = photo.thumb_key ?? photo.object_key;
  if (!key) return false;
  const obj = await env.R2.get(key);
  if (!obj || obj.size > MAX_INPUT_BYTES) return false;
  const bytes = new Uint8Array(await obj.arrayBuffer());

  const result = await env.AI.run(MODEL, {
    image: [...bytes],
    prompt: PROMPT,
    max_tokens: 60,
  });
  const tags = parseTags(result?.description);
  if (!tags.length) return false;

  await env.DB.prepare('UPDATE photo SET tags = ? WHERE id = ?')
    .bind(JSON.stringify(tags), photo.id).run();
  return true;
}

// 上传确认后异步打标（ctx.waitUntil 调用）：额度内才执行
export async function tagPhotoOnUpload(env, photoId) {
  try {
    if (!await consumeQuota(env)) return;
    const photo = await env.DB.prepare(
      "SELECT id, object_key, thumb_key FROM photo WHERE id = ? AND status = 'ready'"
    ).bind(photoId).first();
    if (!photo) return;
    await tagPhoto(env, photo);
  } catch (e) {
    console.log('tagPhotoOnUpload failed:', e?.message ?? String(e));
  }
}

// 历史照片批量补打标签（管理员触发，每批最多 20 张）
export async function backfillTags(env, { albumId, limit = 20 } = {}) {
  limit = Math.max(1, Math.min(20, limit));
  const where = albumId
    ? "status = 'ready' AND tags IS NULL AND album_id = ?"
    : "status = 'ready' AND tags IS NULL";
  const bindArgs = albumId ? [albumId] : [];

  const { results: rows } = await env.DB.prepare(
    `SELECT id, object_key, thumb_key FROM photo WHERE ${where} LIMIT ?`
  ).bind(...bindArgs, limit).all();

  let done = 0;
  for (const row of rows) {
    if (!await consumeQuota(env)) break;
    try {
      if (await tagPhoto(env, row)) done++;
    } catch (e) {
      console.log('backfill tag failed:', row.id, e?.message ?? String(e));
    }
  }

  const { results: cnt } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photo WHERE ${where}`
  ).bind(...bindArgs).all();

  return { done, remaining: cnt[0]?.n ?? 0, quotaLeft: await quotaLeftToday(env) };
}

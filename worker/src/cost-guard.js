// 成本护栏：把全站用量锁死在 Cloudflare 免费额度内（目标全年 0 元）
// 免费额度对标（2026 口径）：
//   R2         10 GB 存储/月（超出 $0.015/GB/月，唯一容易超的扣费项）
//   Images     5000 次变换/月（超出 $0.50/千次）
//   Workers AI 10000 neurons/天（超限直接失败不扣费，另有 ai_tag_daily 全站日限额兜底）
//   D1/Workers 超配额为限流/拒绝，不产生账单
'use strict';

export const R2_FREE_BYTES = 10 * 1024 * 1024 * 1024;
const R2_WARN_BYTES = 9.5 * 1024 * 1024 * 1024; // 95% 告警线
export const IMAGES_MONTHLY_FREE = 5000;
export const IMAGES_MONTHLY_CAP = 4500;         // 留 10% 余量熔断

const ALERT_KEY = 'r2_alert';
let alertCache = null;          // isolate 内 5 分钟缓存，避免每个上传请求都查 D1
let alertCacheAt = 0;
const ALERT_CACHE_MS = 5 * 60_000;

/**
 * 每日 Cron 调用：R2 总量（photo.size 之和，DB 口径）超 95% 写入告警标记，
 * 回落到告警线下自动清除。告警标记供上传端点熔断访客上传。
 */
export async function costGuardDaily(env) {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(size), 0) AS bytes, COUNT(*) AS n FROM photo WHERE status IN ('ready', 'trashed')"
  ).first();
  const bytes = row?.bytes ?? 0;
  const over = bytes > R2_WARN_BYTES;
  try {
    if (over) {
      await env.DB.prepare(
        `INSERT INTO app_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      ).bind(ALERT_KEY, JSON.stringify({ bytes, photos: row.n, at: new Date().toISOString() })).run();
    } else {
      await env.DB.prepare('DELETE FROM app_meta WHERE key = ?').bind(ALERT_KEY).run();
    }
  } catch (e) {
    console.log('cost-guard daily failed:', e?.message ?? String(e));
  }
  return { bytes, warned: over };
}

/**
 * 上传端点的熔断检查：返回告警信息（超线）或 null。缓存 5 分钟。
 */
export async function r2UploadGuard(env) {
  const now = Date.now();
  if (alertCache && now - alertCacheAt < ALERT_CACHE_MS) return alertCache;
  try {
    const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(ALERT_KEY).first();
    alertCache = row?.value ? JSON.parse(row.value) : null;
  } catch {
    alertCache = null; // 检查失败不阻断上传
  }
  alertCacheAt = now;
  return alertCache;
}

const imgKey = () => 'img_used_' + new Date().toISOString().slice(0, 7); // YYYY-MM

/**
 * Images 月度计量（原子自增）：达到熔断线后返回 allowed:false。
 * 每次真实调用 Images 绑定前消费 1 次，调用失败用 refundImagesQuota 退还。
 */
export async function consumeImagesQuota(env) {
  const key = imgKey();
  try {
    const row = await env.DB.prepare(
      `INSERT INTO app_meta (key, value) VALUES (?, '1')
       ON CONFLICT(key) DO UPDATE SET
         value = CAST(CAST(app_meta.value AS INTEGER) + 1 AS TEXT)
       WHERE CAST(app_meta.value AS INTEGER) < ?
       RETURNING value`
    ).bind(key, IMAGES_MONTHLY_CAP).first();
    if (row) return { allowed: true, used: Number(row.value) };
    const cur = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(key).first();
    return { allowed: false, used: Number(cur?.value ?? IMAGES_MONTHLY_CAP) };
  } catch (e) {
    console.log('images quota failed:', e?.message ?? String(e));
    return { allowed: true, used: 0 }; // 计量故障不阻断业务（可用性优先）
  }
}

/** Images 调用失败后的月度退款 */
export async function refundImagesQuota(env) {
  try {
    await env.DB.prepare(
      `UPDATE app_meta SET value = CAST(MAX(CAST(value AS INTEGER) - 1, 0) AS TEXT)
        WHERE key = ?`
    ).bind(imgKey()).run();
  } catch { /* 退款失败忽略 */ }
}

/**
 * 一次消费 n 次 Images 配额（如回填缩略图每张 2 次变换）。
 * 达到熔断线时退还已取的名额并返回 allowed:false。
 */
export async function takeImagesQuota(env, n = 1) {
  let taken = 0;
  for (let i = 0; i < n; i++) {
    const r = await consumeImagesQuota(env);
    if (!r.allowed) {
      for (let j = 0; j < taken; j++) await refundImagesQuota(env);
      return { allowed: false, taken: 0 };
    }
    taken++;
  }
  return { allowed: true, taken };
}

/** 当月 Images 用量（stats 展示用） */
export async function imagesUsedThisMonth(env) {
  try {
    const row = await env.DB.prepare('SELECT value FROM app_meta WHERE key = ?').bind(imgKey()).first();
    return Number(row?.value ?? 0);
  } catch {
    return 0;
  }
}

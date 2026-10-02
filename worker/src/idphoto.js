// 证件照云端精修 —— Cloudflare Images 抠图（segment=foreground，底层 BiRefNet）
// 公开可用，D1 限流：非管理员每 IP 每天 DAILY_LIMIT 张；管理员不限
// Images Free 计划：每月 5000 次变换免费，无需任何密钥（binding 直连）
import { getAuth } from './auth.js';
import { consumeWindowQuota, refundWindowQuota } from './quota.js';
import { consumeImagesQuota, refundImagesQuota } from './cost-guard.js';
import { fail, todayUTC, dataUriToBytes } from './util.js';

const DAILY_LIMIT = 15;             // 非管理员每日每 IP 限额
const MAX_DATAURI_LEN = 11_000_000; // data URI 上限（约 8MB 原图）

let tableEnsured = false;

async function ensureQuotaTable(env) {
  if (tableEnsured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS idphoto_quota (
      ip TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ip, day)
    )`
  ).run();
  tableEnsured = true;
}

// 原子消费（quota.js）：检查与自增单语句完成，并发下不超限
async function checkAndConsumeQuota(env, ip) {
  const r = await consumeWindowQuota(env, {
    table: 'idphoto_quota',
    keys: [['ip', ip], ['day', todayUTC()]],
    limit: DAILY_LIMIT,
    touchUpdatedAt: true,
  });
  return { allowed: r.allowed, remaining: r.allowed ? DAILY_LIMIT - r.count : 0 };
}

// 调用 Cloudflare Images 抠图（前景分割），返回 PNG Uint8Array
async function runCloudCutout(env, dataUri) {
  if (!env.IMAGES) {
    throw { status: 503, message: 'Worker 未绑定 Images（需在 wrangler.toml 添加 [images] 绑定并重新部署）' };
  }
  const bytes = dataUriToBytes(dataUri);

  let output;
  try {
    output = await env.IMAGES.input(new Response(bytes).body)
      .transform({ segment: 'foreground' })
      .output({ format: 'image/png' });
  } catch (e) {
    throw { status: 502, message: 'Images 抠图失败：' + (e?.message ?? '未知错误') };
  }

  const resp = output.response();
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.text()).slice(0, 200); } catch { /* ignore */ }
    throw { status: 502, message: `Images 抠图失败 HTTP ${resp.status} ${detail}`.trimEnd() };
  }
  return new Uint8Array(await resp.arrayBuffer());
}

export async function handleCloudCutout(request, env) {
  await ensureQuotaTable(env);

  const auth = await getAuth(request, env);
  const isAdmin = !!auth && auth.role === 'admin';

  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  // Images 月度总量护栏（对所有人生效，含管理员）：免费层 5000 次/月，超量会计费
  const images = await consumeImagesQuota(env);
  if (!images.allowed) {
    return fail('本月云端精修免费额度已用完（每月 5000 次），下月再试或使用本地 AI', 429);
  }
  // 每 IP 每日限额（管理员不限次，但仍计入月度总量）
  let quota = null;
  if (!isAdmin) {
    quota = await checkAndConsumeQuota(env, ip);
    if (!quota.allowed) {
      await refundImagesQuota(env);
      return fail(`今日云端精修额度已用完（每天 ${DAILY_LIMIT} 张），明天再来或使用本地 AI`, 429);
    }
  }

  let body;
  try {
    body = await request.json();
  } catch {
    await refundImagesQuota(env);
    return fail('请求体不是合法 JSON');
  }
  const image = body.image;
  if (typeof image !== 'string' || !/^data:image\/(png|jpe?g|webp|bmp);base64,/.test(image)) {
    await refundImagesQuota(env);
    return fail('缺少 image 参数（需为 base64 data URI 图片）');
  }
  if (image.length > MAX_DATAURI_LEN) {
    await refundImagesQuota(env);
    return fail('图片过大，请压缩后再试（建议宽度不超过 2000px）', 413);
  }

  try {
    const png = await runCloudCutout(env, image);
    return new Response(png, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'X-Quota-Remaining': quota ? String(quota.remaining) : 'unlimited',
      },
    });
  } catch (e) {
    if (quota) await refundWindowQuota(env, { table: 'idphoto_quota', keys: [['ip', ip], ['day', todayUTC()]] });
    await refundImagesQuota(env);
    return fail(e?.message ?? '云端精修失败', e?.status ?? 502);
  }
}

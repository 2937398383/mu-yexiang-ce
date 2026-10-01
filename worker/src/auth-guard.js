// 登录/解锁失败计数与临时锁定（D1 单表，按 scope + IP）

const MAX_FAILS = 3;          // 连续失败上限
const LOCK_MINUTES = 15;      // 静默锁定时长

function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || 'unknown';
}

// lockedUntil(UTC "YYYY-MM-DD HH:MM:SS") 距现在的剩余分钟
function minutesBetween(lockedUntil) {
  const d = new Date(lockedUntil.replace(' ', 'T') + 'Z');
  return Math.ceil((d.getTime() - Date.now()) / 60000);
}

// 锁定中返回 {retryAfterMinutes}，否则 null
export async function checkLock(env, scope, request) {
  const ip = clientIp(request);
  const row = await env.DB.prepare(
    'SELECT locked_until FROM auth_fail WHERE scope = ? AND ip = ?'
  ).bind(scope, ip).first();
  if (!row?.locked_until) return null;
  const left = minutesBetween(row.locked_until);
  return left > 0 ? { retryAfterMinutes: left } : null;
}

/**
 * 记录一次失败（原子 UPSERT + RETURNING，并发下计数不丢）
 * @returns {{fails:number, remaining:number, locked:boolean}}
 */
export async function recordFailure(env, scope, request) {
  const ip = clientIp(request);
  // 锁定中：维持计数；旧锁定已过期：重新从 1 计数；未锁定过：连续累加
  let fails;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO auth_fail (scope, ip, fails, locked_until, updated_at)
        VALUES (?, ?, 1, NULL, datetime('now'))
       ON CONFLICT(scope, ip) DO UPDATE SET
         fails = CASE
           WHEN auth_fail.locked_until IS NOT NULL
                AND auth_fail.locked_until > datetime('now') THEN auth_fail.fails
           WHEN auth_fail.locked_until IS NOT NULL THEN 1
           ELSE auth_fail.fails + 1
         END,
         updated_at = datetime('now')
       RETURNING fails`
    ).bind(scope, ip).first();
    fails = row?.fails ?? 1;
  } catch (e) {
    // D1 故障降级：计数按 1 处理，不触发锁定（不因风控故障阻断登录）
    console.log('recordFailure failed:', e?.message ?? String(e));
    return { fails: 1, remaining: MAX_FAILS - 1, locked: false };
  }
  const locked = fails >= MAX_FAILS;
  if (locked) {
    await env.DB.prepare(
      "UPDATE auth_fail SET locked_until = datetime('now', ?) WHERE scope = ? AND ip = ?"
    ).bind(`+${LOCK_MINUTES} minutes`, scope, ip).run().catch(() => {});
  }
  return { fails, remaining: Math.max(0, MAX_FAILS - fails), locked };
}

// 成功时清除计数
export async function clearFailures(env, scope, request) {
  const ip = clientIp(request);
  await env.DB.prepare('DELETE FROM auth_fail WHERE scope = ? AND ip = ?')
    .bind(scope, ip).run();
}

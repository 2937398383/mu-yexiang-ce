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
 * 记录一次失败
 * @returns {{fails:number, remaining:number, locked:boolean}}
 */
export async function recordFailure(env, scope, request) {
  const ip = clientIp(request);
  const row = await env.DB.prepare(
    'SELECT fails, locked_until FROM auth_fail WHERE scope = ? AND ip = ?'
  ).bind(scope, ip).first();

  // 锁定中：维持计数；旧锁定已过期：重新从 1 计数；未锁定过：连续累加
  const wasLocked = !!row?.locked_until;
  const stillLocked = wasLocked && minutesBetween(row.locked_until) > 0;
  let fails;
  if (!row) fails = 1;
  else if (stillLocked) fails = row.fails;
  else if (wasLocked) fails = 1;
  else fails = row.fails + 1;
  const locked = fails >= MAX_FAILS;

  // 先 UPSERT 计数（locked_until 先置 NULL），锁定时再设到期时间
  await env.DB.prepare(
    `INSERT INTO auth_fail (scope, ip, fails, locked_until, updated_at)
      VALUES (?, ?, ?, NULL, datetime('now'))
     ON CONFLICT(scope, ip) DO UPDATE SET
       fails = excluded.fails,
       locked_until = NULL,
       updated_at = datetime('now')`
  ).bind(scope, ip, fails).run();
  if (locked) {
    await env.DB.prepare(
      "UPDATE auth_fail SET locked_until = datetime('now', ?) WHERE scope = ? AND ip = ?"
    ).bind(`+${LOCK_MINUTES} minutes`, scope, ip).run();
  }
  return { fails, remaining: Math.max(0, MAX_FAILS - fails), locked };
}

// 成功时清除计数
export async function clearFailures(env, scope, request) {
  const ip = clientIp(request);
  await env.DB.prepare('DELETE FROM auth_fail WHERE scope = ? AND ip = ?')
    .bind(scope, ip).run();
}

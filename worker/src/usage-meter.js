/**
 * D1 用量自统计（对标免费额度：读 500 万行/天、写 10 万行/天，UTC 自然日重置）
 * 原理：包装 env.DB，每次查询后从 result.meta 提取 rows_read / rows_written
 *       累计到请求级计数器，请求结束由 ctx.waitUntil 异步 UPSERT 进 d1_usage 表。
 * 口径说明：D1 的 first() 不返回 meta，这里等价改写为 all()[0] 以拿到计量
 *          （本项目所有 first() 均为单行查询：主键查找 / COUNT / RETURNING）。
 *          统计从部署后开始累积，无历史数据；flush 失败静默降级不影响业务。
 */
'use strict';

export function createUsageMeter(env) {
  const counters = { read: 0, written: 0 };

  async function meter(promise) {
    const res = await promise;
    counters.read += res.meta?.rows_read ?? 0;
    counters.written += res.meta?.rows_written ?? 0;
    return res;
  }

  function wrapStmt(stmt) {
    return {
      bind(...args) { return wrapStmt(stmt.bind(...args)); },
      run: () => meter(stmt.run()),
      all: () => meter(stmt.all()),
      first: () => meter(stmt.all()).then((r) => r.results?.[0] ?? null),
    };
  }

  const meteredDB = { prepare: (sql) => wrapStmt(env.DB.prepare(sql)) };
  const meteredEnv = new Proxy(env, { get: (t, k) => (k === 'DB' ? meteredDB : t[k]) });
  return { meteredEnv, counters };
}

// 用原始（未计量）env.DB 落账，避免自统计递归计入自身
export function flushUsage(env, counters, waiter) {
  if (!counters.read && !counters.written) return;
  const day = new Date().toISOString().slice(0, 10); // UTC 自然日，与 CF 计费口径一致
  waiter.waitUntil(
    env.DB.prepare(
      `INSERT INTO d1_usage (date, rows_read, rows_written) VALUES (?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET
         rows_read = rows_read + excluded.rows_read,
         rows_written = rows_written + excluded.rows_written`
    ).bind(day, counters.read, counters.written).run()
      .catch((e) => console.log('usage flush failed:', e))
  );
}

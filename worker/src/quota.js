// 原子配额/计数工具（D1 单语句完成「检查 + 自增」）
// 「先查后加」在并发下计数会丢失（N 个并发都读到同一个旧值），统一收敛到这里，
// 用 INSERT ... ON CONFLICT ... WHERE ... RETURNING 的原子语义：
//   - 新 key：插入 count=1，返回 {allowed:true, count:1}
//   - 旧 key 且 count < limit：自增后返回新值
//   - 旧 key 且 count >= limit：WHERE 不满足 → 无返回行 → {allowed:false}
//   - D1 故障：放行（可用性优先，各调用方上游还有边缘限流兜底）
'use strict';

/**
 * 原子消费一次窗口配额
 * @param {object} env Worker 绑定
 * @param {object} opts
 * @param {string} opts.table 计数表名（内部白名单之外不引用，无注入面）
 * @param {Array<[string, string]>} opts.keys 唯一键列与值，如 [['ip', ip], ['day', day]]
 * @param {number} opts.limit 上限（允许计数增长到的最大值）
 * @param {boolean} [opts.touchUpdatedAt] 表有 updated_at 列时同步刷新
 * @returns {Promise<{allowed: boolean, count: number}>}
 */
export async function consumeWindowQuota(env, { table, keys, limit, touchUpdatedAt = false }) {
  const cols = keys.map(([c]) => c);
  const vals = keys.map(([, v]) => v);
  const placeholders = cols.map(() => '?').join(', ');
  const setExtra = touchUpdatedAt ? ", updated_at = datetime('now')" : '';
  try {
    const row = await env.DB.prepare(
      `INSERT INTO ${table} (${cols.join(', ')}, count)
        VALUES (${placeholders}, 1)
       ON CONFLICT(${cols.join(', ')}) DO UPDATE SET
         count = ${table}.count + 1${setExtra}
       WHERE ${table}.count < ?
       RETURNING count`
    ).bind(...vals, limit).first();
    if (row) return { allowed: true, count: row.count };
    // 无返回行 = 已达上限
    return { allowed: false, count: limit };
  } catch (e) {
    console.log(`quota(${table}) failed:`, e?.message ?? String(e));
    return { allowed: true, count: 0 };
  }
}

/**
 * 原子退还一次配额（调用失败时退款）；表需有 count 列，退到 0 为止
 */
export async function refundWindowQuota(env, { table, keys }) {
  const cols = keys.map(([c]) => c);
  const vals = keys.map(([, v]) => v);
  const setExtra = cols.some(([c]) => c === 'updated_at')
    ? ", updated_at = datetime('now')" : '';
  try {
    await env.DB.prepare(
      `UPDATE ${table} SET count = MAX(count - 1, 0)${setExtra}
        WHERE ${cols.map((c) => `${c} = ?`).join(' AND ')}`
    ).bind(...vals).run();
  } catch (e) {
    console.log(`refund(${table}) failed:`, e?.message ?? String(e));
  }
}

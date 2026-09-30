// 标签语义聚类：把 AI 打标产生的同义碎片（白衬衫/白衬衣、房间/房间内）归为一组
// 向量用 bge-m3（与语义搜索同模型），tag_emb 表按词缓存（跨相册复用，每词只算一次）
import { EMBED_MODEL, EMBED_VERSION } from './ai-tags.js';

const SIM_CONTAIN = 0.72; // 一词包含另一词（房间⊂房间内、黑衣⊂黑衣男）→ 低阈值即可合并
const SIM_PLAIN = 0.9;   // 无包含关系的近义词（白衬衫/白衬衣）→ 高阈值，防止男孩/女孩这类对立词误合并

export async function ensureTagEmbTable(env) {
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS tag_emb (
       tag TEXT PRIMARY KEY,
       model TEXT NOT NULL,
       embedding TEXT NOT NULL
     )`
  ).run();
}

function cosSim(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0;
}

// 取全部词向量：tag_emb 缓存优先，缺失的分批调 bge-m3 补算并回写缓存
async function embeddingsFor(env, tags) {
  const vecs = new Map();
  // 先读缓存（IN 参数分批，控制在 D1 100 绑定上限内）
  for (let i = 0; i < tags.length; i += 90) {
    const slice = tags.slice(i, i + 90);
    try {
      const { results } = await env.DB.prepare(
        `SELECT tag, embedding FROM tag_emb WHERE model = ? AND tag IN (${slice.map(() => '?').join(',')})`
      ).bind(EMBED_VERSION, ...slice).all();
      for (const r of results) {
        try {
          const v = JSON.parse(r.embedding);
          if (Array.isArray(v) && v.length) vecs.set(r.tag, v);
        } catch { /* 缓存行损坏视为缺失重算 */ }
      }
    } catch { /* 缓存读取失败则全部现算 */ }
  }

  const missing = tags.filter((t) => !vecs.has(t));
  for (let i = 0; i < missing.length; i += 32) {
    const chunk = missing.slice(i, i + 32);
    try {
      const res = await env.AI.run(EMBED_MODEL, { text: chunk });
      const rows = [];
      chunk.forEach((t, j) => {
        const v = res?.data?.[j];
        if (Array.isArray(v) && v.length) {
          vecs.set(t, v);
          rows.push([t, JSON.stringify(v)]);
        }
      });
      if (rows.length) {
        const stmt = env.DB.prepare('INSERT OR REPLACE INTO tag_emb(tag, model, embedding) VALUES(?, ?, ?)');
        for (const [tag, emb] of rows) {
          try { await stmt.bind(tag, EMBED_VERSION, emb).run(); } catch { /* 缓存写失败不影响本次 */ }
        }
      }
    } catch (e) {
      console.log('tag-emb batch failed:', e?.message ?? String(e)); // 失败的词无向量 → 独立成组
    }
  }
  return vecs;
}

// 贪心聚类：按出现次数从多到少依次入组，与已有组任一成员满足合并规则即入组
// 入参 [{tag, n}]；返回 [{ members: [tag...] }]（组内保持计数降序）
export async function buildTagGroups(env, tagCounts) {
  const sorted = [...tagCounts].sort((a, b) => b.n - a.n).slice(0, 300);
  const vecs = await embeddingsFor(env, sorted.map((r) => r.tag));

  const clusters = [];
  for (const { tag } of sorted) {
    const v = vecs.get(tag);
    let target = null;
    if (v) {
      for (const c of clusters) {
        for (const m of c.members) {
          const mv = vecs.get(m);
          if (!mv) continue;
          const sim = cosSim(v, mv);
          const contain = m.includes(tag) || tag.includes(m);
          if ((contain && sim > SIM_CONTAIN) || sim > SIM_PLAIN) { target = c; break; }
        }
        if (target) break;
      }
    }
    if (target) target.members.push(tag);
    else clusters.push({ members: [tag] });
  }
  return clusters;
}

// AI 照片标签：Workers AI Llama 3.2 11B Vision 图生文，异步打标，失败不阻塞主流程
// 额度：全站每日 200 张（免费层 10000 neurons/天，单张实测约 5~20 neurons，留足余量）
// 2026-09-27：LLaVA 1.5 7B → Llama 3.2 11B Vision；结构化 JSON 输出 + 同义词归一/包含去重
import { consumeWindowQuota } from './quota.js';
import { bumpAlbumVersion } from './album-version.js';
import { todayUTC } from './util.js';

const MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
// bge-m3：多语言（含中文）文本向量，1024 维；2026-09 实测中文家庭相册查询 7/7 命中，
// 领先 qwen3-embedding 且推理快约 10 倍。换模型必须同步升级 EMBED_VERSION（旧向量自动隔离）
export const EMBED_MODEL = '@cf/baai/bge-m3';
export const EMBED_VERSION = 'bge-m3-1024';
export const SEMANTIC_THRESHOLD = 0.45; // 实测真匹配 ≥0.55、无匹配 ≤0.48，留安全边界
const DAILY_LIMIT = 200;
const MAX_INPUT_BYTES = 8 * 1024 * 1024; // 大图跳过（thumb 400px webp 通常仅几十 KB）
const MAX_TAGS = 4;
const MIN_TAGS = 2;   // 少于 2 个有效标签视为本次失败（不覆盖旧标签）
const MAX_ATTEMPTS = 2; // 同张最多调用 2 次（抗偶发畸形输出/网关抖动）

const SYSTEM_PROMPT =
  '你是一个严谨的照片标签整理助手，服务于中文家庭相册的检索。' +
  '只依据图片中真实可见的内容贴标签，不猜测、不联想、不输出情绪和任何解释。';

const USER_PROMPT =
  '为这张照片生成检索标签和一句画面描述，严格只输出一行 JSON：{"tags":["主体","场景或地点","行为或事件","显眼特征"],"desc":"一句15到30字的中文客观描述"}\n' +
  '标签规则：\n' +
  '1. tags 数组里必须恰好4个标签，不多不少；每个标签2到5个汉字。\n' +
  '2. 第1个标签是画面最突出的主体，必须具体：能写「金毛犬」就不写「狗」，能写「生日蛋糕」就不写「食物」。\n' +
  '3. 第2个写场景或地点（如客厅、街道、海边、雪地）；第3个写动作或事件（如吹蜡烛、跑步、聚餐），看不出动作就写主体状态；第4个写一个最显眼的视觉特征（颜色、天气、光线、标志性物品）。\n' +
  '4. 4个标签含义必须互不相同、不得近义、不得重复任何词语（禁止连续出现相似词）。\n' +
  '5. 禁止输出没有区分度的词：照片、图片、特写、镜头、画面、场景、人物、人像、生活、日常、时光、美好、回忆、风景。\n' +
  '6. 看不清或不确定的内容不要写。\n' +
  'desc 规则：用一句15到30字的中文，按「谁/什么+在哪里+做什么或什么样」客观描述画面，' +
  '只写真实可见的内容，不猜测、不抒情、不写拍摄参数、不与标签逐字重复。\n' +
  '直接输出 JSON，禁止 markdown、编号、原因、解释，JSON 前后不要有任何文字。\n' +
  '示例：{"tags":["金毛犬","公园草地","叼飞盘","夕阳逆光"],"desc":"一只金毛犬在公园草地上跃起叼住飞盘，傍晚阳光从侧后方照来"}\n' +
  '现在直接输出 JSON：';

// 无区分度的废词黑名单（精确匹配，小写比较）
const TAG_BLACKLIST = new Set([
  '照片', '图片', '图像', '相片', '特写', '镜头', '画面', '场景', '风景', '风光',
  '人物', '人像', '肖像', '静物', '生活', '日常', '时光', '美好', '回忆', '记忆',
  '瞬间', '色彩', '颜色', '彩色', '自然光', '一个人', '多人', '一人', '无人',
  '无', '未知', '不确定', '看不清', '其他', '杂项', 'none', 'n/a', 'na', 'image',
  'photo', 'picture', 'portrait', 'photography', 'object', 'unknown',
]);

// 近义词归并（仅精确匹配才归一，避免误伤"金毛犬"这类具体词）
const SYNONYM_MAP = (() => {
  const groups = [
    [['男士', '男人', '男性', '男生'], '男子'],
    [['女士', '女人', '女性', '女生'], '女子'],
    [['孩童', '小孩', '小孩子', '小朋友', '孩子们', '孩子'], '儿童'],
    [['小宝宝', '婴幼儿', '新生儿', '婴孩'], '婴儿'],
    [['狗狗', '小狗', '狗子', '犬只', '犬'], '狗'],
    [['猫咪', '小猫', '猫猫', '喵星人'], '猫'],
    [['小汽车', '轿车', '车辆', '车子'], '汽车'],
    [['蓝天白云'], '蓝天'],
    [['海面', '海水', '海洋'], '大海'],
  ];
  const m = new Map();
  for (const [words, canon] of groups) {
    for (const w of words) m.set(w, canon);
    m.set(canon, canon);
  }
  return m;
})();

// 允许保留的单字词（其余单字信息量不足，丢弃）
const ONE_CHAR_ALLOW = new Set(
  ['狗', '猫', '车', '海', '山', '雪', '花', '树', '天', '云', '雨', '夜', '灯', '船', '桥', '湖']
);

// 额度预检 + 消费（原子：quota.js 单语句完成检查与自增，并发下不超每日全站限额）
async function consumeQuota(env) {
  const r = await consumeWindowQuota(env, {
    table: 'ai_tag_daily',
    keys: [['day', todayUTC()]],
    limit: DAILY_LIMIT,
  });
  return r.allowed;
}

// 打标失败（模型异常/结果无效）时退还已扣的当日额度
async function refundQuota(env) {
  try {
    await env.DB.prepare(
      `INSERT INTO ai_tag_daily (day, count) VALUES (?, 0)
       ON CONFLICT(day) DO UPDATE SET count = MAX(0, count - 1)`
    ).bind(todayUTC()).run();
  } catch (e) {
    console.log('refundQuota failed:', e?.message ?? String(e));
  }
}

export async function quotaLeftToday(env) {
  const row = await env.DB.prepare('SELECT count FROM ai_tag_daily WHERE day = ?')
    .bind(todayUTC()).first();
  return Math.max(0, DAILY_LIMIT - (row?.count ?? 0));
}

// 从模型输出中抽取候选标签：
// 1) 完整 JSON（数组或 {"tags":[...]}） 2) 被 max_tokens 截断的残 JSON：抓引号内字符串
// 3) 标点分割兜底
function extractRawTags(text) {
  const s = String(text ?? '').trim();

  const arr = s.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      const parsed = JSON.parse(arr[0]);
      if (Array.isArray(parsed) && parsed.length) return parsed.map((x) => String(x));
    } catch { /* 继续 */ }
  }
  const obj = s.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      const parsed = JSON.parse(obj[0]);
      if (Array.isArray(parsed?.tags) && parsed.tags.length) return parsed.tags.map((x) => String(x));
    } catch { /* 继续 */ }
  }

  // 残 JSON 恢复：所有 "xxx" 引号串，排除 JSON 键名和英文键
  const quoted = [...s.matchAll(/"([^"\n]{1,12})"/g)]
    .map((m) => m[1].trim())
    .filter((t) => t !== 'tags' && !/^(主体|场景|场景或地点|行为或事件|显眼特征)$/.test(t))
    .filter((t) => /[一-龥]/.test(t)); // 标签必须含中文（顺带过滤键名/英文残片）
  if (quoted.length >= 2) return quoted;

  return s.split(/[,，、\n;；|]+/);
}

// 单个标签清洗：去序号/引号/emoji/标点，同义词归一；含 JSON 结构残片的一律作废
function cleanTag(raw) {
  let t = String(raw ?? '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .trim()
    .replace(/^\s*\d+\s*[.、:：)\-]?\s*/, '') // 序号前缀：1. / 2、 / 3)
    .replace(/^["'“”‘’「」『』《》()（）\[\]【】\s]+|["'“”‘’「」『』《》()（）\[\]【】\s。.,，、;；:：!！?？]+$/g, '')
    .trim();
  // JSON 残片（如 {"tags":["女孩）直接丢弃
  if (/[{}\[\]\\":]/.test(t)) return '';
  t = SYNONYM_MAP.get(t) ?? t;
  return t;
}

// 归一化：清洗 → 黑名单/长度过滤 → 精确去重 → 包含去重（保留更具体的长词）
function normalizeTags(rawTags) {
  const seen = new Set();
  const cleaned = [];
  for (const raw of rawTags) {
    const t = cleanTag(raw);
    if (!t || seen.has(t)) continue;
    if (TAG_BLACKLIST.has(t.toLowerCase())) continue;
    // 纯标点/数字编号类
    if (!/[\u4e00-\u9fa5a-zA-Z]/.test(t)) continue;
    if (t.length < 2 && !ONE_CHAR_ALLOW.has(t)) continue;
    if (t.length > 12) continue;
    seen.add(t);
    cleaned.push(t);
  }
  // 包含去重（如"连衣裙"被"红色连衣裙"包含则丢弃短词），最终保持模型输出的原始顺序
  const dropped = new Set();
  for (const t of cleaned) {
    if (t.length < 2) continue;
    if (cleaned.some((k) => k !== t && k.includes(t))) dropped.add(t);
  }
  return cleaned.filter((t) => !dropped.has(t)).slice(0, MAX_TAGS);
}

// 规整模型响应：绑定返回形态不稳定——纯 JSON 时可能直接给对象，畸形/带解释时给字符串
// 返回 { text（原始字符串）, structured（{tags, desc} 或 null）, usage }
function pickModelOutput(result) {
  let out = result?.response ?? result?.description ?? result?.result ?? '';
  let structured = null;
  if (out && typeof out === 'object') {
    if (Array.isArray(out?.tags)) {
      structured = { tags: out.tags.map((x) => String(x)), desc: out.desc != null ? String(out.desc) : null };
    }
    out = JSON.stringify(out);
  }
  return {
    text: String(out ?? ''),
    structured,
    usage: result?.usage ?? result?.response_metadata?.usage ?? null,
  };
}

// 从模型文本里抽取 desc：只接受完整 JSON 对象中的 desc 字段（不从自由文本编造）
function extractDesc(text) {
  const obj = String(text ?? '').match(/\{[\s\S]*\}/);
  if (!obj) return null;
  try {
    const parsed = JSON.parse(obj[0]);
    if (typeof parsed?.desc === 'string') return parsed.desc;
  } catch { /* 畸形 JSON 不提取 */ }
  return null;
}

// 描述句清洗：去序号/引号/emoji/标点外壳；要求含中文且 8~60 字，否则视为无效
function cleanDesc(raw) {
  let d = String(raw ?? '')
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .replace(/^\s*\d+\s*[.、:：)\-]?\s*/, '')
    .replace(/^["'“”‘’「」『』《》()（）\[\]【】\s]+|["'“”‘’「」『』《》()（）\[\]【】\s]+$/g, '')
    .trim();
  if (/[{}\[\]\\"]/.test(d)) return null;
  if (!/[\u4e00-\u9fa5]/.test(d)) return null;
  if (d.length < 8 || d.length > 60) return null;
  return d;
}

// Llama 3.2 License 同意标志：首次使用模型前必须发一次 {prompt:'agree'}，否则所有调用返回 5016/403
// 用 D1 app_meta 表幂等记录同意时间，避免每次调用都重发
async function ensureLlamaLicenseAgreed(env) {
  try {
    const row = await env.DB.prepare(
      "SELECT value FROM app_meta WHERE key = 'llama_license_agreed_at'"
    ).first();
    if (row?.value) return true;
    // 首次：发 agree 请求；即使返回错误也写标志位，避免反复重试占额度
    try {
      await env.AI.run(MODEL, { prompt: 'agree' });
    } catch (e) {
      // 5016 表示"未同意"，但 agree 请求本身可能也返回 5016（鸡生蛋）；
      // 实际上 agree 请求是"同意动作"，返回 200 即成功。若返回其他错误，仍写标志位避免无限重试
      console.log('llama agree request returned:', String(e?.message ?? e).slice(0, 120));
    }
    await env.DB.prepare(
      "INSERT INTO app_meta(key, value) VALUES('llama_license_agreed_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).bind(new Date().toISOString()).run();
    return true;
  } catch (e) {
    console.log('ensureLlamaLicenseAgreed failed:', e?.message ?? String(e));
    return false;
  }
}

// 调用视觉模型一次；返回 { text, structured, usage }，异常直接抛出
// 注意：该模型只认「顶层 prompt + 顶层 image」结构——messages 内嵌 image 会被静默忽略
// （实测 prompt_tokens=15 图像未编码，模型盲答）；顶层 image 用字节数组（binding 标准形式）
async function callVisionModel(env, bytes) {
  const body = {
    prompt: `${SYSTEM_PROMPT}\n\n${USER_PROMPT}`,
    image: Array.from(bytes),
    temperature: 0.2,
    max_tokens: 200,
    repetition_penalty: 1.15, // 抑制"黑色睫毛/黑色眼影"式重复退化
  };
  let result;
  try {
    result = await env.AI.run(MODEL, body);
  } catch (e) {
    const msg = String(e?.message ?? e);
    // 5016 Model agreement：账号未同意 Llama 3.2 license，自动重发 agree 后再试一次
    if (msg.includes('5016') || /not agreed/i.test(msg) || /Llama3.2 model terms/i.test(msg)) {
      console.log('llama license not agreed (5016), retrying agree...');
      // 清除旧标志位强制重发 agree
      try {
        await env.DB.prepare("DELETE FROM app_meta WHERE key = 'llama_license_agreed_at'").run();
      } catch {}
      await ensureLlamaLicenseAgreed(env);
      result = await env.AI.run(MODEL, body); // 再试一次，失败就抛出
    } else {
      throw e; // 其他错误继续抛
    }
  }
  return pickModelOutput(result);
}

// 给单张照片打标；成功写回 tags 并返回标签数组，失败返回 null（不覆盖旧标签，由调用方退额度）
// 输入优先 400px 缩略图（视觉 token 少、成本低），缺失再降级 1600px、原图
export async function tagPhoto(env, photo) {
  const key = photo.thumb_key ?? photo.large_key ?? photo.object_key;
  if (!key) return { tags: null, reason: 'no-key' };
  const obj = await env.R2.get(key);
  if (!obj) return { tags: null, reason: 'r2-missing' };
  if (obj.size > MAX_INPUT_BYTES) return { tags: null, reason: 'too-large' };
  // 首次调用前确保 Llama 3.2 license 已同意（5016 错误兜底）
  await ensureLlamaLicenseAgreed(env);

  const bytes = new Uint8Array(await obj.arrayBuffer());

  const reasons = [];
  let lastReason = 'empty';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let text = '';
    let structured = null;
    try {
      const r = await callVisionModel(env, bytes);
      text = r.text;
      structured = r.structured;
      if (r.usage) console.log('ai-tag usage:', JSON.stringify(r.usage));
    } catch (e) {
      lastReason = String(e?.message ?? e).slice(0, 120);
      reasons.push(`模型异常: ${lastReason}`);
      console.log(`ai-tag model error (attempt ${attempt}):`, lastReason);
      continue;
    }
    const tags = normalizeTags(structured?.tags ?? extractRawTags(text));
    const desc = cleanDesc(structured?.desc ?? extractDesc(text));
    if (tags.length >= MIN_TAGS) {
      // 生成 bge-m3 embedding（标签 + 画面描述句的语义向量）用于语义搜索
      let embedding = null;
      try {
        const embText = desc ? `${tags.join('，')}。${desc}` : tags.join('，');
        const emb = await env.AI.run(EMBED_MODEL, { text: embText });
        if (emb?.data?.[0] && Array.isArray(emb.data[0])) embedding = JSON.stringify(emb.data[0]);
      } catch { /* 向量生成失败不影响打标 */ }
      await env.DB.prepare(
        `UPDATE photo SET tags = ?, tagged_at = ?, ai_desc = ?,
               embedding = ?, emb_model = ? WHERE id = ?`
      ).bind(
        JSON.stringify(tags), new Date().toISOString(), desc,
        embedding, embedding ? EMBED_VERSION : null, photo.id
      ).run();
      // 维护 photo_tag 关联表：先删旧标签，再插入新标签
      try {
        await env.DB.prepare('DELETE FROM photo_tag WHERE photo_id = ?').bind(photo.id).run();
        if (tags.length) {
          const stmt = env.DB.prepare('INSERT OR IGNORE INTO photo_tag(photo_id, tag) VALUES(?, ?)');
          for (const t of tags) await stmt.bind(photo.id, t).run();
        }
      } catch { /* photo_tag 维护失败不影响打标 */ }
      // 标签变更 → 相册列表 ETag 失效
        const aid = (await env.DB.prepare('SELECT album_id FROM photo WHERE id = ?').bind(photo.id).first())?.album_id;
        if (aid) await bumpAlbumVersion(env, aid);
      return { tags, desc, attempts: attempt };
    }
    lastReason = 'fewer-than-min-tags';
    reasons.push(`输出无效: ${JSON.stringify(text).slice(0, 100)}`);
    console.log(`ai-tag invalid output (attempt ${attempt}):`, JSON.stringify(text).slice(0, 200));
  }
  // 失败原因落库，便于事后诊断（保留最近 50 条）
  const failDetail = reasons.join(' | ') || lastReason;
  try {
    await env.DB.prepare(
      'INSERT INTO ai_tag_error(photo_id, reason, created_at) VALUES(?, ?, ?)'
    ).bind(photo.id, failDetail, new Date().toISOString()).run();
    await env.DB.prepare(
      `DELETE FROM ai_tag_error WHERE id NOT IN (SELECT id FROM ai_tag_error ORDER BY id DESC LIMIT 50)`
    ).run();
  } catch { /* 日志失败不影响主流程 */ }
  return { tags: null, reason: failDetail };
}

// 上传确认后异步打标（ctx.waitUntil 调用）：额度内才执行，失败退额度
export async function tagPhotoOnUpload(env, photoId) {
  if (!await consumeQuota(env)) return;
  try {
    const photo = await env.DB.prepare(
      "SELECT id, object_key, thumb_key, large_key FROM photo WHERE id = ? AND status = 'ready'"
    ).bind(photoId).first();
    if (!photo) { await refundQuota(env); return; }
    const { tags } = await tagPhoto(env, photo);
    if (!tags) await refundQuota(env);
  } catch (e) {
    console.log('tagPhotoOnUpload failed:', e?.message ?? String(e));
    await refundQuota(env);
  }
}

// 历史照片批量标签（管理员/解锁访客触发，每批最多 20 张）
// mode: 'fill'  = 只补 tags 为空的（默认，解锁访客可用）
//       'retag' = 重打已有标签的（仅管理员）；since=活动开始时间，只选 tagged_at 早于它的照片，
//                 成功后 tagged_at 推进到当前时间，避免重复选取
// photoId: 单张重打（仅管理员），成功时返回 tags
export async function backfillTags(env, { albumId, limit = 20, mode = 'fill', photoId = null, since = null } = {}) {
  limit = Math.max(1, Math.min(20, limit));

  if (photoId) {
    const photo = await env.DB.prepare(
      "SELECT id, object_key, thumb_key, large_key FROM photo WHERE id = ? AND status = 'ready'"
    ).bind(photoId).first();
    if (!photo) return { done: 0, remaining: 0, tags: null, quotaLeft: await quotaLeftToday(env) };
    if (!await consumeQuota(env)) {
      return { done: 0, remaining: 1, tags: null, quotaLeft: 0, quotaExhausted: true };
    }
    let tags = null;
    let reason = null;
    try { ({ tags, reason } = await tagPhoto(env, photo)); }
    catch (e) { reason = String(e?.message ?? e).slice(0, 120); console.log('retag failed:', photoId, reason); }
    if (!tags) await refundQuota(env);
    return {
      done: tags ? 1 : 0,
      remaining: tags ? 0 : 1,
      tags,
      reason,
      quotaLeft: await quotaLeftToday(env),
      ...(tags ? {} : { failed: true }),
    };
  }

  let cond;
  const bindArgs = [];
  if (mode === 'retag') {
    // 无 since（旧调用方）不允许跑批量，防止无限重复选取
    if (!since) return { done: 0, failed: 0, remaining: 0, quotaLeft: await quotaLeftToday(env), skipped: true };
    cond = "status = 'ready' AND tags IS NOT NULL AND tags != '[]' AND (tagged_at IS NULL OR tagged_at < ?)";
    bindArgs.push(since);
  } else {
    cond = "status = 'ready' AND tags IS NULL";
  }
  if (albumId) { cond += ' AND album_id = ?'; bindArgs.push(albumId); }

  const { results: rows } = await env.DB.prepare(
    `SELECT id, object_key, thumb_key, large_key FROM photo WHERE ${cond}
     ORDER BY created_at DESC LIMIT ?`
  ).bind(...bindArgs, limit).all();

  let done = 0;
  let failed = 0;
  const failReasons = []; // 收集失败原因（最多 3 条），便于前端诊断展示
  for (const row of rows) {
    if (!await consumeQuota(env)) break;
    try {
      const { tags, reason } = await tagPhoto(env, row);
      if (tags) { done++; }
      else {
        failed++;
        if (reason && failReasons.length < 3) failReasons.push(reason);
        await refundQuota(env);
      }
    } catch (e) {
      failed++;
      if (failReasons.length < 3) failReasons.push(String(e?.message ?? e).slice(0, 120));
      await refundQuota(env);
      console.log('backfill tag failed:', row.id, e?.message ?? String(e));
    }
  }

  const { results: cnt } = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM photo WHERE ${cond}`
  ).bind(...bindArgs).all();

  return {
    done, failed, remaining: cnt[0]?.n ?? 0, quotaLeft: await quotaLeftToday(env),
    ...(failReasons.length ? { failReasons } : {}),
  };
}

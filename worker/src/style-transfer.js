// 照片换风格 —— Cloudflare Workers AI · FLUX.2 [klein] 指令式图生图
// 公开可用，D1 限流：
//   fast（FLUX.2 klein-4B，约 110 neurons/张）：每 IP 每天 30 张
//   hd  （FLUX.2 klein-9B，约 1400 neurons/张）：每 IP 每天 3 张
//   管理员不限；调用失败退还额度
// Workers AI 免费额度 10000 neurons/天（UTC 0 点重置），与账户其他 AI 调用共享
import { getAuth } from './auth.js';

const MODELS = {
  fast: '@cf/black-forest-labs/flux-2-klein-4b',
  hd: '@cf/black-forest-labs/flux-2-klein-9b',
};
const DAILY_LIMIT = { fast: 30, hd: 3 };
const GUIDANCE = 2.5;                 // FLUX.2 Kontext 编辑场景推荐值
const MAX_DATAURI_LEN = 3_000_000;    // 前端已把参考图压到 504px 长边（约 0.1~0.3MB）
const LONG_EDGE = { fast: 1024, hd: 1280 };

let tableEnsured = false;

// ---------- 风格预设（prompt 只允许服务端组装，防止前端传任意 prompt 浪费额度） ----------
// 厚涂微缩景观的五段式编译器来自 MIT 协议的 xiaochengtong/impasto-miniature-landscape skill

const STYLES = {
  impasto: {
    name: '厚涂微缩景观',
    base: [
      'Transform the photo in image 0 into an impasto miniature landscape artwork.',
      'impasto miniature landscape, thick oil painting texture, palette knife strokes, sculptural volume, tilt-shift miniature effect.',
      'Keep the main subject and the composition of the photo clearly recognizable, reconstructed as a miniature oil painting sculpture.',
      'The entire scene rendered in thick impasto oil paint with visible palette knife strokes, paint buildup on all edges, the colors from the photo brightened and warmed, sculptural volume with clear light and shadow.',
      'A few tiny miniature figures and props in correct small scale, shallow depth of field like macro photography, warm bright lighting.',
      'No smooth digital rendering, no dark gloomy tones, no photorealistic details, no text, no watermark.',
    ],
    fixes: {
      miniature: 'strong tilt-shift effect, miniature diorama model, tiny figures, macro photography shallow depth of field, looks like a small model scene',
      paint: 'thick impasto paint, heavy paint buildup, visible palette knife marks, textured brushstrokes, 3D paint texture',
      bright: 'bright warm lighting, high key tones, vibrant fresh colors, no dark shadows, warm highlights',
      edges: 'rounded edges, sculptural form, clay-like volume, soft rounded corners, no sharp architectural edges',
    },
  },
  watercolor: {
    name: '水彩插画',
    base: [
      'Transform the photo in image 0 into a luminous hand-painted watercolor illustration.',
      'Loose wet-on-wet washes, pigment blooms, soft diffused bleeding edges, visible cold-pressed paper grain, delicate paint splatters, light and airy.',
      'Preserve the composition and the main subject of the photo.',
      'Soft fresh translucent palette with white paper breathing space, gentle natural light.',
      'No photorealistic details, no digital smoothness, no harsh outlines, no text, no watermark.',
    ],
    fixes: {
      edges: 'more bleeding wet edges, stronger wet-on-wet pigment diffusion, softer borders',
      paper: 'strong textured watercolor paper grain, deckled paper edge, more handcrafted feel',
      bright: 'lighter translucent washes, brighter clearer palette, more white space',
    },
  },
  ghibli: {
    name: '吉卜力动漫',
    base: [
      'Transform the photo in image 0 into a Studio Ghibli style hand-drawn anime scene.',
      'Soft hand-painted watercolor backgrounds, cel-shaded forms, warm golden light, lush vibrant greens, soft pastel clouds, gentle nostalgic animated film atmosphere, Miyazaki aesthetic.',
      'Keep the composition, landmarks and main subject recognizable.',
      'Detailed hand-drawn background art, dreamy soft shadows, warm hopeful mood.',
      'No 3D render, no photorealism, no western cartoon style, no text, no watermark.',
    ],
    fixes: {
      soft: 'softer pastel colors, gentler diffused lighting, more delicate hand-drawn touch',
      vivid: 'more vibrant lush colors, dramatic expressive sky, stronger light and shadow',
      line: 'clear anime cel outlines, richer hand-drawn background details',
    },
  },
  ink: {
    name: '水墨丹青',
    base: [
      'Transform the photo in image 0 into a traditional Chinese ink wash painting, shui-mo style.',
      'Varying ink density from deep black to pale grey, expressive calligraphic brush strokes, misty negative space, xuan rice paper texture, subtle mineral color accents, elegant oriental composition.',
      'Preserve the spirit, structure and spatial relations of the original scene.',
      'Mountains, trees and terrain rendered with classic cun brush texture, poetic and serene.',
      'No oil painting look, no photorealism, no vivid saturated colors, no text, no watermark.',
    ],
    fixes: {
      mist: 'more drifting mist and fog, more empty white space, deeper atmospheric perspective',
      brush: 'stronger calligraphic brush strokes, dry brush feibai texture, bolder ink contrast',
      minimal: 'more minimalist, fewer details, greater abstraction, restrained literati painting',
    },
  },
  // 以下 4 个风格的五段式编译器来自同系列 MIT 协议 skill：
  // xiaochengtong/watercolor-travel-card · pixel-dissolve-landscape
  // · observational-pen-wash · papercraft-travel-diorama
  wcard: {
    name: '水彩旅行票卡',
    base: [
      'Transform the photo in image 0 into a watercolor travel memory card, pen and ink with transparent watercolor washes.',
      'Keep the main subject clearly recognizable, fine pen sketch linework over soft watercolor, preserve the main features.',
      'The sky and background rendered in transparent watercolor washes drawn from the photo colors, soft bleeding and blending effects, white paper highlights, vintage textured watercolor paper background.',
      'Perforated postage stamp edges along all four borders, elegant English title "TRAVEL" at the top in classic serif font, a travel archive info bar at the bottom with small English text fields (DATE / LOCATION / NOTES).',
      'Warm nostalgic tone, bright and airy atmosphere, collectible ticket card layout, no Chinese characters, remove all watermarks and text from the original photo, high quality editorial illustration.',
    ],
    fixes: {
      thin: 'transparent watercolor, delicate washes, see-through layers, no thick paint',
      pen: 'fine pen and ink linework, ink sketch outlines, pen drawing over watercolor',
      perforation: 'clear perforated stamp edges, round perforation holes along all borders, die-cut ticket edges',
      airy: 'generous white space, airy composition, minimal layout',
    },
  },
  pixel: {
    name: '像素消隐',
    base: [
      'Transform the photo in image 0 into a pixel dissolve landscape, pixel art style, square pixel blocks, memory fading effect, minimal composition.',
      'Keep the main subject clearly recognizable in the center, rendered in small dense square pixel blocks with detailed features.',
      'Surrounding elements rendered in progressively larger and sparser pixel blocks, dissolving outward from the center, outer areas completely dissolved into white space, only a few isolated pixel dots at the edges.',
      'Limited color palette extracted from the original photo, brightened and desaturated, all pixels are strict squares, no anti-aliasing, no gradients.',
      'Generous white space across most of the canvas, minimal clean composition, no round pixels, no photorealistic details, no text, no watermark.',
    ],
    fixes: {
      gradient: 'progressive dissolve from center to edges, pixels get larger and sparser outward, outer areas fade to white, memory fading effect, only center is detailed',
      space: 'extensive white space, 70% white background, minimal composition, lots of empty space, sparse pixels, isolated pixel dots floating in white',
      square: 'strict square pixel blocks, hard pixel edges, no anti-aliasing, no gradients, 8-bit pixel art style, all elements made of squares',
      palette: 'limited color palette of 5-6 colors only, restricted palette, cohesive color scheme, no rainbow colors, muted harmonious tones',
    },
  },
  penwash: {
    name: '钢笔淡彩手记',
    base: [
      'Transform the photo in image 0 into an observational pen wash, minimalist pen and ink sketch with transparent watercolor washes, travel journal sketchbook style, hand-drawn imperfect lines.',
      'Keep the main subject recognizable, rendered in minimal broken pen lines, only key outlines and structural lines, no detailed rendering, sketchy hand-drawn quality.',
      'Only 1-2 areas with transparent watercolor washes drawn from the photo colors, soft bleeding edges, most of the canvas left as white paper, color only on the main subject.',
      'Textured cream sketchbook paper background, lines that fade out at the edges, a tiny handwritten date or location note in the corner, unfinished sketch feeling, off-center composition.',
      'No continuous clean lines, no full color coverage, no photorealistic details, no dark heavy tones, no Chinese text, no watermark.',
    ],
    fixes: {
      sketchy: 'broken sketchy lines, hand-drawn imperfect strokes, wobbly uneven lines, pen sketch quality, not vector clean lines, overlapping sketch lines',
      sparse: 'minimal watercolor only, sparse color washes, 70% white space, transparent thin washes, no flat color, no full coverage, color only in small areas',
      unfinished: 'unfinished sketch, lines fading into white space, cropped composition, sketchbook page feel, partial drawing, not a complete illustration, travel journal aesthetic',
      paper: 'textured cream paper background, old sketchbook paper, slight paper grain, off-white warm paper, not pure white digital background',
    },
  },
  paper: {
    name: '纸艺微缩场景',
    base: [
      'Transform the photo in image 0 into a handcrafted papercraft miniature scene, layered paper art, travel postcard aesthetic.',
      'Keep the main subject recognizable, rebuilt as a miniature papercraft model with foreground, middle and background layers.',
      'All elements made of colored cardstock and soft clay, visible cut edges, fold marks and paper texture, soft shadows between layers, colors softened from the photo, matte finish.',
      'Tiny paper figures and props, a small base platform, soft natural window light.',
      'No photorealistic rendering, no text, no watermark.',
    ],
    fixes: {
      layers: '3D layered paper sculpture, multiple depth layers with gaps between them, realistic shadows between layers, paper cutout diorama, physical 3D depth, not flat illustration',
      craft: 'visible paper texture, cut paper edges, fold marks, handcrafted quality, cardboard and washi paper material, subtle glue marks, physical craft texture, not digital rendering',
      mini: 'miniature diorama, tiny scale model, small paper figures, shallow depth of field, macro photography look, sits on a small base platform, collectible miniature',
      soft: 'muted desaturated colors, soft pastel palette, paper-toned colors, warm matte finish, no bright saturated colors, vintage postcard color grading',
    },
  },
};

function buildPrompt(styleId, fixId) {
  const style = STYLES[styleId];
  const parts = style.base.slice();
  if (fixId && style.fixes[fixId]) parts.push(style.fixes[fixId]);
  return parts.join(' ');
}

// 输出尺寸：按原图比例放大到对应长边，并对齐 32（FLUX 要求），钳制在 256~1536
function fitSize(width, height, tier) {
  const longEdge = LONG_EDGE[tier];
  const scale = longEdge / Math.max(width, height);
  let w = Math.round(width * scale / 32) * 32;
  let h = Math.round(height * scale / 32) * 32;
  w = Math.max(256, Math.min(1536, w));
  h = Math.max(256, Math.min(1536, h));
  return { width: w, height: h };
}

// ---------- 限流（表结构与 idphoto_quota 同构，多一个 tier 维度） ----------

async function ensureQuotaTable(env) {
  if (tableEnsured) return;
  await env.DB.prepare(
    `CREATE TABLE IF NOT EXISTS style_quota (
      ip TEXT NOT NULL,
      day TEXT NOT NULL,
      tier TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (ip, day, tier)
    )`
  ).run();
  tableEnsured = true;
}

function jsonFail(error, status = 400) {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

async function checkAndConsumeQuota(env, ip, tier) {
  const day = todayUTC();
  const limit = DAILY_LIMIT[tier];
  const row = await env.DB.prepare(
    'SELECT count FROM style_quota WHERE ip = ? AND day = ? AND tier = ?'
  ).bind(ip, day, tier).first();
  const used = row?.count ?? 0;
  if (used >= limit) return { allowed: false, remaining: 0 };
  await env.DB.prepare(
    `INSERT INTO style_quota (ip, day, tier, count, updated_at)
     VALUES (?, ?, ?, 1, datetime('now'))
     ON CONFLICT(ip, day, tier) DO UPDATE SET count = count + 1, updated_at = datetime('now')`
  ).bind(ip, day, tier).run();
  return { allowed: true, remaining: limit - used - 1 };
}

async function refundQuota(env, ip, tier) {
  await env.DB.prepare(
    `UPDATE style_quota SET count = MAX(count - 1, 0), updated_at = datetime('now')
     WHERE ip = ? AND day = ? AND tier = ?`
  ).bind(ip, todayUTC(), tier).run();
}

function dataUriToBytes(dataUri) {
  const b64 = dataUri.slice(dataUri.indexOf(',') + 1);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// 根据魔数判断图片格式，返回正确的 MIME
function sniffMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) return 'image/webp';
  return 'image/png';
}

// 调用 Workers AI · FLUX.2 [klein]（multipart 输入，参考图必须小于 512×512）
// options.rejectIfBusy：GPU 繁忙时立即拒绝（调用方重试），而非排队等待
async function runKlein(env, tier, prompt, inputBytes, width, height, seed, options = {}) {
  if (!env.AI) {
    throw { status: 503, message: 'Worker 未绑定 AI（需在 wrangler.toml 添加 [ai] 绑定并重新部署）' };
  }

  const form = new FormData();
  form.append('prompt', prompt);
  form.append('input_image_0', new Blob([inputBytes], { type: 'image/jpeg' }), 'input.jpg');
  form.append('width', String(width));
  form.append('height', String(height));
  form.append('guidance', String(GUIDANCE));
  if (Number.isInteger(seed)) form.append('seed', String(seed));

  // FormData 必须经 Request/Response 序列化后才能拿到带 boundary 的 Content-Type
  const formResponse = new Response(form);
  const body = formResponse.body;
  const contentType = formResponse.headers.get('content-type');

  let out;
  try {
    out = await env.AI.run(MODELS[tier], {
      multipart: { body, contentType },
    }, options.rejectIfBusy ? { rejectIfBusy: true } : undefined);
  } catch (e) {
    const msg = e?.message ?? String(e);
    // rejectIfBusy 模式下 GPU 繁忙会立即返回：交给调用方重试
    if (options.rejectIfBusy && /busy|overloaded|capacity|unavailable|503/i.test(msg)) {
      throw { status: 503, busy: true, message: 'AI 繁忙' };
    }
    // 免费神经元耗尽时 Cloudflare 返回 402/429 类错误，给出友好提示
    if (/quota|credit|neuron|429|rate/i.test(msg)) {
      throw { status: 429, message: '今日云端 AI 免费额度已用完（每天 10000 neurons，UTC 0 点重置），明天再来' };
    }
    throw { status: 502, message: 'AI 生成失败：' + msg };
  }

  if (!out || !out.image) {
    throw { status: 502, message: 'AI 返回内容为空' + (out?.errors ? '：' + JSON.stringify(out.errors).slice(0, 200) : '') };
  }
  return dataUriToBytes('data:application/octet-stream;base64,' + out.image);
}

// ---------- 入口 ----------

export async function handleStyleTransfer(request, env) {
  await ensureQuotaTable(env);

  const auth = await getAuth(request, env);
  const isAdmin = !!auth && auth.role === 'admin';
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonFail('请求体不是合法 JSON');
  }

  const style = STYLES[body.style] ? body.style : null;
  const tier = MODELS[body.tier] ? body.tier : null;
  if (!style) return jsonFail('未知的风格类型');
  if (!tier) return jsonFail('未知的生成档位');
  const fix = body.fix && STYLES[style].fixes[body.fix] ? body.fix : null;

  const image = body.image;
  if (typeof image !== 'string' || !/^data:image\/(png|jpe?g|webp|bmp);base64,/.test(image)) {
    return jsonFail('缺少 image 参数（需为 base64 data URI 图片）');
  }
  if (image.length > MAX_DATAURI_LEN) {
    return jsonFail('参考图过大，请压缩到 512px 以内再试', 413);
  }

  const width = Number(body.width);
  const height = Number(body.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) ||
      width < 256 || width > 1536 || height < 256 || height > 1536) {
    return jsonFail('输出尺寸不合法（需在 256~1536 之间）');
  }

  let seed = null;
  if (body.seed != null) {
    seed = parseInt(body.seed, 10);
    if (!Number.isInteger(seed)) seed = null;
  }

  // 先校验后扣额度，避免非法请求浪费次数
  let quota = null;
  if (!isAdmin) {
    quota = await checkAndConsumeQuota(env, ip, tier);
    if (!quota.allowed) {
      const label = tier === 'hd' ? '高质量' : '快速';
      return jsonFail(`今日${label}档额度已用完（每天 ${DAILY_LIMIT[tier]} 张，UTC 0 点重置），明天再来或换另一档`, 429);
    }
  }

  try {
    const prompt = buildPrompt(style, fix);
    const inputBytes = dataUriToBytes(image);
    const { width: w, height: h } = fitSize(width, height, tier);
    // 先用 rejectIfBusy 抢空闲 GPU；最多重试 3 次，之后降级正常排队
    let outBytes;
    let busyTries = 0;
    for (;;) {
      try {
        outBytes = await runKlein(env, tier, prompt, inputBytes, w, h, seed,
          { rejectIfBusy: busyTries < 3 });
        break;
      } catch (e) {
        if (e?.busy && busyTries < 3) { busyTries++; continue; }
        throw e;
      }
    }
    const mime = sniffMime(outBytes);

    return new Response(outBytes, {
      status: 200,
      headers: {
        'Content-Type': mime,
        'Cache-Control': 'no-store',
        'X-Quota-Remaining': quota ? String(quota.remaining) : 'unlimited',
        'X-Style': style,
        'X-Tier': tier,
      },
    });
  } catch (e) {
    if (quota) await refundQuota(env, ip, tier);
    return jsonFail(e?.message ?? '风格化失败', e?.status ?? 502);
  }
}

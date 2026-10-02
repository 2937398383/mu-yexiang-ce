// 分享落地页（Pages Functions 约定式路由，匹配 /s/:id）
// 作用：社交软件/微信爬虫抓取时返回 OG 卡片 meta（相册名 + 封面图）；
//       真人浏览器访问时跳转到前端 hash 路由 /#/share/:id（老链接 hash 直开不受影响）。
// 部署：随 web 目录一起 wrangler pages deploy，无需额外配置。

const API_ORIGIN = 'https://api.cdc2937398383qqcom.dpdns.org';
const SITE_NAME = '牧野云相册';
const DEFAULT_DESC = '点击查看分享的相册照片';
const DEFAULT_ICON = 'https://album-web.pages.dev/icons/icon-512.png';

function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// 拉取分享元信息：
// 无密码 → 200 { album:{name,description}, kind }
// 有密码 → 401 { needsPassword:true, kind }（不返回相册名，避免泄露）
// 失效/异常 → null（兜底通用卡片）
async function fetchShareMeta(id) {
  try {
    const resp = await fetch(`${API_ORIGIN}/api/share/${encodeURIComponent(id)}`, {
      headers: { Accept: 'application/json' },
      cf: { cacheTtl: 0 },
    });
    const data = await resp.json();
    if (resp.ok && data?.ok && data.album) {
      return { name: data.album.name, description: data.album.description, kind: data.kind, locked: false };
    }
    if (resp.status === 401 && data?.needsPassword) {
      return { name: null, description: null, kind: data.kind, locked: true };
    }
    return null;
  } catch {
    return null;
  }
}

function renderHtml(id, meta) {
  const shareUrl = `https://album-web.pages.dev/s/${id}`;
  const ogImage = `${API_ORIGIN}/api/og/${id}`;
  const kind = meta?.kind;
  const title = meta?.name
    ? `${meta.name} - ${SITE_NAME}`
    : meta?.locked
      ? (kind === 'collect' ? `📥 加密的求照片 - ${SITE_NAME}` : `🔒 加密相册 - ${SITE_NAME}`)
      : SITE_NAME;
  const description = meta?.name
    ? (meta.description || (kind === 'collect' ? '主人邀请你向这个相册上传照片' : DEFAULT_DESC))
    : (meta?.locked ? '输入访问密码即可查看' : DEFAULT_DESC);
  const cta = kind === 'collect' ? '进入上传照片' : '进入相册';

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${escHtml(SITE_NAME)}">
<meta property="og:title" content="${escHtml(title)}">
<meta property="og:description" content="${escHtml(description)}">
<meta property="og:url" content="${escHtml(shareUrl)}">
<meta property="og:image" content="${escHtml(ogImage)}">
<meta property="og:image:width" content="512">
<meta property="og:image:height" content="512">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escHtml(title)}">
<meta name="twitter:description" content="${escHtml(description)}">
<meta name="twitter:image" content="${escHtml(ogImage)}">
<link rel="icon" type="image/png" href="/icons/icon-192.png">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: linear-gradient(160deg, #0f8a4d 0%, #0a6b3b 100%); color: #fff; padding: 24px; }
  .card { background: rgba(255,255,255,.08); backdrop-filter: blur(8px);
          border-radius: 20px; padding: 36px 28px; text-align: center; max-width: 360px;
          box-shadow: 0 12px 40px rgba(0,0,0,.25); }
  .logo { width: 72px; height: 72px; border-radius: 18px; margin: 0 auto 18px;
          background: #fff url(${escHtml(DEFAULT_ICON)}) center/cover; }
  h1 { font-size: 20px; margin-bottom: 10px; word-break: break-all; }
  p { font-size: 14px; opacity: .85; line-height: 1.6; margin-bottom: 24px;
       word-break: break-all; }
  .btn { display: inline-block; background: #fff; color: #0f8a4d; text-decoration: none;
         font-size: 16px; font-weight: 600; padding: 12px 36px; border-radius: 999px; }
  .tip { margin-top: 16px; font-size: 12px; opacity: .6; }
</style>
</head>
<body>
  <div class="card">
    <div class="logo"></div>
    <h1>${escHtml(meta?.name || (meta?.locked ? '🔒 加密分享' : SITE_NAME))}</h1>
    <p>${escHtml(description)}</p>
    <a class="btn" href="/#/share/${escHtml(id)}">${escHtml(cta)}</a>
    <div class="tip">正在打开…如未自动跳转请点上方按钮</div>
  </div>
  <script>location.replace('/#/share/' + ${JSON.stringify(id)});</script>
</body>
</html>`;
}

export async function onRequestGet({ params }) {
  const raw = params.id;
  const id = Array.isArray(raw) ? raw[0] : raw;
  // share id 固定 16 位 hex，非法直接兜底（同样跳前端由前端提示失效）
  if (!/^[0-9a-f]{16}$/i.test(String(id ?? ''))) {
    return new Response(renderHtml(String(id ?? ''), null), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  const meta = await fetchShareMeta(id);
  return new Response(renderHtml(id, meta), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

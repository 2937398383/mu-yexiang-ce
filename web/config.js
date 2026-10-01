// 部署前唯一必改的一行：填入你的 Worker 地址（部署 Worker 后控制台会显示）
// 例：window.API_BASE = "https://album-api.xxxxx.workers.dev/api";
window.API_BASE = "https://api.cdc2937398383qqcom.dpdns.org/api";

// Cloudflare Turnstile 站点密钥（公开值，安全）。留空 = 未启用人机验证（登录/解锁照常，无验证码）。
// 启用方式：Cloudflare 控制台 → Turnstile → 新建 Widget，把 Site Key 填到这里，并把 Secret Key 用
// `wrangler secret put TURNSTILE_SECRET` 配到后端（前后端需同时启用）。
window.TURNSTILE_SITE_KEY = "0x4AAAAAAFKu6kKmymO96fQc";

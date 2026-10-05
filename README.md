# 牧野云相册

![CI](https://github.com/2937398383/mu-yexiang-ce/actions/workflows/ci.yml/badge.svg)

基于 **Cloudflare 全家桶**（Workers + R2 + D1 + Pages + Workers AI）的零服务器成本自托管相册。无构建步骤，前端纯原生 HTML/CSS/JS，数据存储在你自己的 Cloudflare 账户中。

## 特性

### 相册基础
- **R2 直传**：浏览器拿预签名 URL 直传 R2，Worker 不转发文件流量
- **三级图片**：原图 + 1600px 中图 + 400px 缩略图（WebP），网格秒开
- **游标分页**：每页 60 张，IntersectionObserver 无限滚动
- **EXIF 保留**：拍摄时间、相机镜头、GPS，按拍摄时间排序
- **HEIC/HEIF 支持**：iPhone 默认格式浏览器端自动转 JPEG（heic2any 按需加载），EXIF 转换前提取不丢失
- **服务端搜索**：标签 / 文件名全量搜索（不再只过滤已加载页），热门标签云一键检索
- **照片收藏**：⭐ 收藏标记 + 「只看收藏」筛选；大图查看器可写**照片备注**（≤500 字）
- **相册封面** / 相册内**时间线分组**
- **往年今日**：按拍摄日期回顾历史照片
- **回收站**：软删除 10 天内可恢复（超量自动淘汰最早删除的），Cron 自动真删
- **有限视频支持**：mp4/webm/mov/m4v 原样上传（≤500MB，不转码），前端 canvas 抽帧，Worker Media 绑定兜底
- **多选批量操作**：批量删除、移动相册、规则重命名（管理员）
- **PWA**：可添加到主屏，支持拖拽 / 粘贴上传，2–3 路文件级并发
- **SHA-256 去重**：同相册相同文件自动跳过

### 分享
- **整相册分享** / **单张照片分享** / **求照片链接**（访客匿名上传，婚礼聚会收图）
- 有效期 1 / 7 / 30 天可选，支持设置访问密码
- **分享二维码**：每条链接可一键生成二维码（投屏/打印，手机扫码即开）
- **社交分享卡片**：`/s/:id` 落地页由 Pages Functions 服务端渲染 OG/Twitter meta，微信等 IM 内分享显示相册名与封面（加密/失效链接不泄露封面）
- 求照片链接按 IP 每小时限流

### AI 工具
- **AI 证件照**：本地（WebGPU 加速抠图）+ 云端（Cloudflare Images BiRefNet）双引擎
- **AI 换风格**：FLUX.2 [klein] 图生图，8 种风格，`rejectIfBusy` 抢空闲 GPU
- **AI 换背景**：本地抠图 + 自定义背景合成
- **AI 自动标签**：照片入库后视觉模型异步打标签

## 架构

```
浏览器 (Cloudflare Pages, 纯静态)
  │ ① 申请上传：POST /api/albums/:id/photos
  ▼
Cloudflare Worker (album-api)
  ├── D1 绑定 (DB)        元数据 / 分享 / 配额 / 限流
  ├── R2 绑定 (R2)        私有读取、文件操作
  ├── IMAGES 绑定         云端抠图（每月 5000 次免费）
  ├── AI 绑定             FLUX.2 换风格 + 视觉打标（10000 neurons/天免费）
  └── MEDIA 绑定          视频抽封面帧
  │ ② 返回 SigV4 预签名 URL
  ▼
浏览器 PUT 直传 ──────────► R2 (album-photos)
  │ ③ POST /photos/:id/confirm
  ▼
D1 置为 ready，异步 AI 打标
```

## 目录结构

```
├── web/                     # 前端静态站点（Pages 直接托管）
│   ├── index.html
│   ├── app.js               # 主应用（路由/相册/查看器/分享/多选）
│   ├── upload-util.js       # EXIF/缩略图/视频抽帧
│   ├── idphoto.js           # 证件照工具
│   ├── style-transfer.js    # 换风格页
│   ├── bg-replace.js        # 换背景页
│   ├── sw.js                # Service Worker (PWA)
│   ├── functions/s/[[id]].js # Pages Functions：/s/:id 分享 OG 卡片落地页
│   └── vendor/              # 自托管第三方资源（exifr / onnxruntime / imgly / heic2any / qrcode）
└── worker/
    ├── src/
    │   ├── index.js         # Worker 入口、路由、ensurePhotoSchema 自动迁移
    │   ├── presign.js       # R2 SigV4 预签名（零 SDK，Content-Type 纳入签名）
    │   ├── auth.js          # JWT / 密码哈希 / 常量时间比较
    │   ├── auth-guard.js    # 解锁态与失败锁定（原子计数）
    │   ├── quota.js         # 原子配额/计数工具（单语句「检查+自增」）
    │   ├── util.js          # 公共工具（json/fail/UTC 窗口/data URI 解码）
    │   ├── album-version.js # 相册版本号（列表 ETag 失效）
    │   ├── cost-guard.js    # 成本护栏（R2/Images 免费额度监控与熔断）
    │   ├── edge-guard.js    # 边缘防护（方法白名单/扫描拦截/内存+D1 分级限流）
    │   ├── share.js         # 分享链接（album/photo/collect）
    │   ├── ai-tags.js       # AI 自动标签
    │   ├── video-thumb.js   # Media 绑定视频抽帧
    │   ├── trash.js         # 回收站 / Cron 清理 / R2 孤儿清理
    │   ├── idphoto.js       # 云端证件照接口
    │   ├── style-transfer.js# 云端换风格接口
    │   └── backfill.js      # 缩略图回填
    ├── schema.sql           # D1 参考建表脚本
    └── wrangler.toml
```

## 部署

### 1. 准备 Cloudflare 资源
- 创建 R2 存储桶：`album-photos`
- 创建 D1 数据库：`album-db`
- 把 D1 的 Database ID 填入 `worker/wrangler.toml` 的 `database_id`
- 把你的 Account ID 填入 `R2_ACCOUNT_ID`（或作为 Worker 环境变量）

### 2. 设置 R2 CORS（浏览器直传必需）
编辑 `worker/r2-cors.json` 后执行：
```bash
node worker/apply-cors.cjs
```

### 3. 下载本地 AI 资源（自托管，无第三方 CDN）
```bash
node worker/download-imgly-resources.mjs
```

### 4. 部署 Worker
```bash
cd worker
npx wrangler secret put ADMIN_PASSWORD        # 管理员登录密码
npx wrangler secret put JWT_SECRET            # 随机长字符串
npx wrangler secret put R2_ACCESS_KEY_ID      # R2 API Token
npx wrangler secret put R2_SECRET_ACCESS_KEY
npx wrangler deploy
```
首次部署后访问任意 API，`ensurePhotoSchema()` 会自动完成建表与列迁移；
也可手动执行参考脚本：
```bash
npx wrangler d1 execute album-db --remote --file=./schema.sql
```

### 5. 部署 Pages
创建 Pages 项目（如 `album-web`），上传目录指向 `web/`。
编辑 `web/config.js` 中的 API 地址即可。

## 换域名清单
自托管换自己的域名时，共需改动以下几处（其余代码无需动）：
1. `worker/wrangler.toml`：`routes` 的 API 域名 + `[vars]` 的 `SITE_URL`（分享链接/OG 图标由它拼接）
2. `web/config.js`：`API_BASE` 指向新 Worker 域名
3. `web/functions/s/[[id]].js`：`apiOrigin()`/`siteUrl()` 中的默认值（或在 Pages 环境变量配 `API_ORIGIN`/`SITE_URL` 覆盖）
4. `web/index.html`：`preconnect` 的 R2 与 API 域名
5. Cloudflare 侧：R2 CORS 白名单（`worker/r2-cors.json`）与 Worker CORS 白名单（`worker/src/index.js` 的 `ORIGIN_WHITELIST`）

## 安全说明
- CORS 已收紧为域名白名单
- 管理员登录、相册解锁、分享解锁均有按 IP 失败计数与临时锁定（原子计数，并发下不失效）
- 密码比较使用常量时间算法（先 SHA-256 归一化再用 `timingSafeEqual`），无时序侧信道
- 上传扩展名白名单严格校验（不含 SVG），R2 对象 Content-Type 由服务端按扩展名锁定（纳入 SigV4 签名 + confirm 兜底校验），杜绝存储型 XSS
- 加密相册在所有接口（含往年今日/地图/智能相册等聚合视图）一律排除，未解锁不可见
- 500 错误对客户端脱敏，细节仅写日志
- 加密相册不向前端返回封面签名 URL
- 更换管理员密码：`wrangler secret put ADMIN_PASSWORD`，旧 token 最长 12 小时后自然过期

## 成本护栏（免费额度内运行）
- **R2**：每日 Cron 检查用量，超过 9.5GB（免费 10GB 的 95%）自动冻结访客上传并在统计页告警
- **Images**：月度用量计量（app_meta 原子计数），达到 4500 次（免费 5000 的 90%）熔断云端抠图与缩略图回填
- **Workers AI**：全站每日 200 张打标限额 + 换风格按档位限额，天然在 10000 neurons/天内
- **D1**：读请求限流走内存窗口（不写 D1），写操作原子计数，远低于 10 万行/天
- 统计页（管理员）实时显示各资源免费额度进度条，支持一键清理 R2 孤儿文件

## 测试与部署
```bash
cd worker
npm test            # node --test：加密协议 roundtrip、上传白名单、访问控制矩阵
npx wrangler deploy # 部署 Worker
```
Pages 部署后把 `web/config.js` 的 API 地址指向 Worker 域名。

## 许可证

[MIT](LICENSE)

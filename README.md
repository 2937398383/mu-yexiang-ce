# 牧野云相册

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
- **回收站**：软删除 30 天内可恢复，Cron 自动真删
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
    │   ├── presign.js       # R2 SigV4 预签名（零 SDK）
    │   ├── auth.js          # JWT / 密码哈希
    │   ├── auth-guard.js    # 解锁态与失败锁定
    │   ├── share.js         # 分享链接（album/photo/collect）
    │   ├── ai-tags.js       # AI 自动标签
    │   ├── video-thumb.js   # Media 绑定视频抽帧
    │   ├── trash.js         # 回收站 / Cron 清理
    │   ├── idphoto.js       # 云端证件照接口
    │   └── style-transfer.js# 云端换风格接口
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

## 安全说明
- CORS 已收紧为域名白名单
- 管理员登录、相册解锁、分享解锁均有按 IP 失败计数与临时锁定
- 500 错误对客户端脱敏，细节仅写日志
- 加密相册不向前端返回封面签名 URL

## 许可证

[MIT](LICENSE)

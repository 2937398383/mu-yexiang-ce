-- 相册云存储 D1 建表脚本（仓库参考文档）
-- 线上库由 Worker 启动时 ensurePhotoSchema() 自动建表/补列，本脚本供全新部署参考。
-- 执行：npx wrangler d1 execute album-db --remote --file=./schema.sql

-- ---------- 相册 ----------
CREATE TABLE IF NOT EXISTS album (
  id             TEXT PRIMARY KEY,                     -- UUID
  name           TEXT NOT NULL,                        -- 相册名（事件/主题）
  description    TEXT NOT NULL DEFAULT '',             -- 相册描述
  password_hash  TEXT,                                 -- 6位数字密码哈希，NULL = 公开相册
  cover_photo_id TEXT,                                 -- 相册封面照片 ID
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 照片 / 视频 ----------
CREATE TABLE IF NOT EXISTS photo (
  id           TEXT PRIMARY KEY,                       -- UUID
  album_id     TEXT NOT NULL,
  filename     TEXT NOT NULL,                          -- 用户上传时的原始文件名
  object_key   TEXT NOT NULL,                          -- R2 对象键：albums/<albumId>/<uuid>.<ext>
  thumb_key    TEXT,                                   -- 缩略图键：<uuid>.s.<webp|jpg>（400px）
  large_key    TEXT,                                   -- 中图键：<uuid>.m.<fmt>（1600px）
  thumb_avif_key TEXT,                                 -- AVIF 缩略图键：<uuid>.s.avif（Chrome/Edge 加载，WebP 兜底）
  large_avif_key TEXT,                                 -- AVIF 中图键（预留）
  proxy_key    TEXT,                                   -- 视频 H.264 代理键：<uuid>.proxy.mp4（跨浏览器播放）
  exif         TEXT,                                   -- 全量 EXIF 曝光参数（JSON：快门/光圈/ISO/焦距/镜头）
  content_type TEXT,
  size         INTEGER,
  status       TEXT NOT NULL DEFAULT 'uploading',      -- uploading | ready | trashed
  kind         TEXT NOT NULL DEFAULT 'image',          -- image | video
  duration     INTEGER,                                -- 视频时长（秒）
  taken_at     TEXT,                                   -- EXIF 拍摄时间
  camera       TEXT,                                   -- EXIF 相机/镜头
  gps_lat      REAL,                                   -- EXIF 纬度
  gps_lng      REAL,                                   -- EXIF 经度
  tags         TEXT,                                   -- AI 标签（JSON 数组）
  is_favorite  INTEGER NOT NULL DEFAULT 0,             -- 用户收藏标记：0 | 1
  caption      TEXT,                                   -- 用户照片备注（≤500 字）
  sha256       TEXT,                                   -- 上传体 SHA-256（同相册去重）
  trashed_at   TEXT,                                   -- 软删除时间（回收站，30 天后真删）
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------- 分享链接 ----------
-- kind: album 整相册 | photo 单张 | collect 求照片（访客匿名上传）
CREATE TABLE IF NOT EXISTS share_link (
  id            TEXT PRIMARY KEY,
  album_id      TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at    TEXT NOT NULL,
  revoked       INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  kind          TEXT NOT NULL DEFAULT 'album',
  photo_id      TEXT,                                  -- kind=photo 时指定的单张照片
  password_hash TEXT                                   -- 可选访问密码哈希
);

-- ---------- 登录/解锁失败计数（防爆破） ----------
CREATE TABLE IF NOT EXISTS auth_fail (
  scope        TEXT NOT NULL,                          -- admin | album:<id> | share:<id>
  ip           TEXT NOT NULL,
  fails        INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (scope, ip)
);

-- ---------- AI 打标每日全局限额 ----------
CREATE TABLE IF NOT EXISTS ai_tag_daily (
  day    TEXT PRIMARY KEY,                             -- YYYYMMDD
  count  INTEGER NOT NULL DEFAULT 0
);

-- ---------- 标签语义归组：标签词向量缓存（bge-m3，跨相册复用） ----------
CREATE TABLE IF NOT EXISTS tag_emb (
  tag       TEXT PRIMARY KEY,
  model     TEXT NOT NULL,                            -- 如 bge-m3-1024
  embedding TEXT NOT NULL                             -- JSON 数组
);

-- ---------- 全局限流计数（ip + 分钟窗口） ----------
CREATE TABLE IF NOT EXISTS rate_event (
  ip     TEXT NOT NULL,
  minute TEXT NOT NULL,                                -- YYYYMMDDHHMM
  count  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ip, minute)
);

-- ---------- 求照片链接上传计数（每链接每 IP 每小时） ----------
CREATE TABLE IF NOT EXISTS collect_event (
  share_id TEXT NOT NULL,
  ip       TEXT NOT NULL,
  hour     TEXT NOT NULL,                              -- YYYYMMDDHH
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (share_id, ip, hour)
);

-- ---------- 云端 AI 工具限额 ----------
CREATE TABLE IF NOT EXISTS style_quota (
  ip         TEXT NOT NULL,
  day        TEXT NOT NULL,                            -- YYYYMMDD
  tier       TEXT NOT NULL,                            -- 风格迁移档位
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ip, day, tier)
);

CREATE TABLE IF NOT EXISTS idphoto_quota (
  ip         TEXT NOT NULL,
  day        TEXT NOT NULL,                            -- YYYYMMDD
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (ip, day)
);

-- ---------- 索引 ----------
CREATE INDEX IF NOT EXISTS idx_photo_album   ON photo(album_id);
CREATE INDEX IF NOT EXISTS idx_photo_status  ON photo(album_id, status);
CREATE INDEX IF NOT EXISTS idx_photo_trashed ON photo(status, trashed_at);
-- WHERE/ORDER BY 必须使用与此索引完全相同的表达式才能命中
CREATE INDEX IF NOT EXISTS idx_photo_sort
  ON photo (COALESCE(taken_at, created_at) DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_photo_sha    ON photo(album_id, sha256);
-- 收藏筛选（部分索引，仅收藏行入索引）
CREATE INDEX IF NOT EXISTS idx_photo_favorite ON photo(album_id) WHERE is_favorite = 1;
CREATE INDEX IF NOT EXISTS idx_share_album  ON share_link(album_id);
CREATE INDEX IF NOT EXISTS idx_share_photo  ON share_link(photo_id);

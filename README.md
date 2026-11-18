# PicVault

PicVault 是一套基于 Docker Compose 部署的图床系统，包含 Web 管理端、后端 API、PostgreSQL、Redis 和图片处理队列。

## 功能

- 图片上传、图片库、相册、回收站、链接管理
- 用户注册、登录、账户设置、找回密码
- 管理中心、用户管理、系统状态、存储配置
- 本机存储和 S3 兼容对象存储
- Telegram Bot 集成
- 图片缩略图、WebP/AVIF、元数据处理、水印配置
- API Key 上传

## 技术栈

- 前端：Vue 3、Vite、Element Plus、Pinia、Vue Router
- 后端：NestJS、Prisma、PostgreSQL、Redis、BullMQ、sharp
- 存储：本机存储、S3 兼容对象存储
- 部署：Docker Compose

## 一键安装

root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/vmenzo/PicVault/main/scripts/install.sh | bash
```

非 root 用户执行：

```bash
curl -fsSL https://raw.githubusercontent.com/vmenzo/PicVault/main/scripts/install.sh | sudo bash
```

指定端口和公开域名：

```bash
curl -fsSL https://raw.githubusercontent.com/vmenzo/PicVault/main/scripts/install.sh | PICVAULT_PORT=7899 APP_PUBLIC_URL=https://img.example.com bash
```

默认安装目录：`/opt/picvault`（权限 700，`.env` 权限 600）

默认访问地址：`http://服务器IP:7899`

安装脚本会先做预检（端口是否空闲、磁盘是否 ≥2GB、Docker/Compose 版本、已有的 `picvault-*` 容器、URL/端口合法性、`.env` 中是否为占位密码），失败时会给出可操作的错误信息。更新已安装的实例时，如果安装目录有本地修改，脚本会拒绝覆盖，请先提交/暂存，或用 `PICVAULT_GIT_RESET=1` 显式丢弃本地修改。

默认只监听回环地址：`APP_BIND_ADDRESS` 默认是 `127.0.0.1`，应用不直接暴露到局域网或公网。如需直接暴露，可在 `.env` 中改回 `0.0.0.0`（不推荐），或为容器化反向代理指定 Docker 网桥地址（例如 `172.17.0.1`）。

## 反向代理（HTTPS）

生产环境请用 nginx 或 Caddy 做反向代理，示例配置见 `ops/nginx.conf` 和 `ops/Caddyfile`（说明见 `ops/README.md`）。基本步骤（以域名 `img.example.com` 为例）：

```bash
# 1. .env 中设置公开地址（安装时用 APP_PUBLIC_URL=https://img.example.com 传入也可）
#    APP_PUBLIC_URL=https://img.example.com
#    https 地址会自动启用 ENABLE_HSTS=true 和 TRUST_PROXY_HEADERS=true
#    （全新安装由 install.sh 自动设置；手动改 APP_PUBLIC_URL 时请自行设置这两项）

# 2a. nginx + Certbot：
sudo cp ops/nginx.conf /etc/nginx/sites-available/picvault
sudo sed -i 's/img\.example\.com/你的域名/g' /etc/nginx/sites-available/picvault
sudo ln -s /etc/nginx/sites-available/picvault /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
# Certbot 会签发证书、配置 443 并设置自动续期（systemd timer）。
# 续期验证走 80 端口，请保持 80 端口可达。

# 2b. 或者 Caddy（自动签发并续期证书，无需 Certbot）：
sudo cp ops/Caddyfile /etc/caddy/Caddyfile   # 先把 img.example.com 换成你的域名
sudo systemctl reload caddy
```

健康检查：`GET /healthz`（与 `/readyz` 相同）只有在后端存活且 Postgres + Redis 均可用时才返回 200 `{"status":"ok"}`，否则返回 503。后端另有未鉴权的 `GET /api/system/ready`（检查 Postgres + Redis）和仅管理员可用的 `GET /api/system/health`（完整状态）。

## systemd（可选）

如需开机自启整个 Compose 栈，请使用 `ops/picvault.service`（Compose 包装单元），不要直接运行 `node`：

```bash
sudo cp ops/picvault.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now picvault.service
```

旧的 `ops/picvault-backend.service` / `ops/picvault-frontend.service` 已删除：它们以裸 `node` 进程运行，与 Compose 容器抢端口（7899）、没有 `EnvironmentFile`/`User`、工作目录也不对。

新用户注册默认关闭。管理员可以在“控制中心 → 图片处理与安全”中随时开启或关闭，保存后立即生效。

第一个注册用户自动成为管理员。

## 手动部署

```bash
git clone https://github.com/vmenzo/PicVault.git picvault
cd picvault
cp .env.production.example .env
chmod 600 .env
nano .env   # 务必把 POSTGRES_PASSWORD 换成随机密码，并把 APP_PUBLIC_URL 改成你的域名
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:7899/healthz   # 200 且 status=ok 才算健康（会检查后端 + 数据库 + Redis）
```

## 更新

```bash
cd /opt/picvault
git pull          # 本地有修改时会失败，请先提交/暂存，或 PICVAULT_GIT_RESET=1
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:7899/healthz   # 200 且 status=ok 才算健康
```

也可以重新运行一键安装脚本完成更新（它会做同样的预检和 `git pull`）。

## 备份与恢复

备份：

```bash
cd /opt/picvault
bash scripts/backup.sh
```

备份目录为 `<安装目录>/backups/<时间戳>/`，包含：

- `postgres.sql`：PostgreSQL 全量备份
- `local-storage.tar.gz`：本机存储文件（`backend_storage` 卷）
- `.env`：生产配置的**明文副本**（权限 600，包含数据库密码等机密——请像保管机密一样保管备份目录；如需异地保存，请先加密，例如 `tar -czf - <备份目录> | openssl enc -aes-256-cbc -salt -pbkdf2 -out backup.tar.gz.enc`）
- `manifest.json`、`SHA256SUMS`：备份元数据与校验和

Redis 不备份：其中只有临时的任务队列和限流计数，重启后自动重建。备份保留 14 天，过期目录自动删除。

备份路径说明：`.env` 中的 `PICVAULT_BACKUP_DIR` 是**容器内**路径（默认 `/app/backups`，对应宿主机的 `<安装目录>/backups`），后端站内备份视图也用这个值；宿主机脚本 `backup.sh`/`restore.sh` 会读取 `.env` 并自动把容器路径映射到宿主机路径。如需指定宿主机绝对路径，可设置环境变量 `PICVAULT_BACKUP_DIR_HOST`。

定时备份可用 `ops/picvault-backup.service` + `ops/picvault-backup.timer`（每天 03:30）：

```bash
sudo cp ops/picvault-backup.service ops/picvault-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now picvault-backup.timer
```

恢复（会**覆盖**现有数据库和本机存储，操作前请先备份）：

```bash
cd /opt/picvault
bash scripts/restore.sh backups/20261119-033000        # 完整恢复：数据库 + 存储 + .env
bash scripts/restore.sh --postgres-only backups/20261119-033000  # 仅恢复数据库
bash scripts/restore.sh --yes backups/20261119-033000  # 跳过确认提示
```

`restore.sh` 会校验备份目录与校验和、停止后端、重建数据库并导入 `postgres.sql`、把存储压缩包恢复到 `backend_storage` 卷、恢复 `.env`（旧 `.env` 另存为 `.env.pre-restore-<时间戳>`，权限 600）、重启后端并验证 `GET /api/system/ping` 返回正常。旧的 `scripts/restore-postgres.sh` 已改为仅恢复单个 SQL 文件的兼容包装，建议使用 `restore.sh`。

## 本地开发

```bash
cp .env.example .env
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
npm install
docker compose up -d postgres redis
npm run prisma:migrate -w backend
npm run start:dev -w backend
npm run dev -w frontend
```

## 生产配置

- 默认宿主端口：`7899`，默认仅监听 `127.0.0.1`
- 前端入口：`http://服务器IP:7899`（经反向代理后为 `https://你的域名`）
- 后端 API：`/api`
- 健康检查：`GET /healthz`、`/readyz`（需后端 + Postgres + Redis 均正常）；后端 `GET /api/system/ready` 未鉴权，`GET /api/system/health` 仅管理员可用
- PostgreSQL、Redis、后端服务默认不暴露到公网
- 容器以非 root 的 `node` 用户运行；`.env` 权限 600，安装目录权限 700
- 新安装默认使用本机存储，可直接上传
- 第三方存储支持 Cloudflare R2、AWS S3、阿里云 OSS S3 兼容接口、腾讯云 COS S3 兼容接口
- 使用第三方存储时，存储桶需要允许浏览器 `PUT` 请求的 CORS
- 反向代理 HTTPS 时，将 `.env` 中的 `APP_PUBLIC_URL` 设置为公开域名
- Swagger 默认关闭，仅在可信环境中设置 `ENABLE_SWAGGER=true`

## 常用文件

- `.env.production.example`：生产环境配置模板
- `docker-compose.yml`：生产编排配置
- `scripts/install.sh`：一键安装脚本
- `scripts/backup.sh`：备份脚本（Postgres + 本机存储 + `.env`）
- `scripts/restore.sh`：恢复脚本（数据库 + 存储 + `.env`，带校验）
- `ops/nginx.conf`、`ops/Caddyfile`：反向代理示例；`ops/picvault.service`：Compose 开机自启单元

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

默认安装目录：`/opt/picvault`

默认访问地址：`http://服务器IP:7899`

生产环境使用反向代理时，可通过 `.env` 的 `APP_BIND_ADDRESS` 将端口限制在回环地址或 Docker 网桥地址，避免绕过 HTTPS 直接访问。例如 Nginx Proxy Manager 运行在默认 Docker 网桥时：

```env
APP_BIND_ADDRESS=172.17.0.1
TRUST_PROXY_HEADERS=true
ENABLE_HSTS=true
```

新用户注册默认关闭。管理员可以在“控制中心 → 图片处理与安全”中随时开启或关闭，保存后立即生效。

第一个注册用户自动成为管理员。

## 手动部署

```bash
git clone https://github.com/vmenzo/PicVault.git picvault
cd picvault
cp .env.production.example .env
nano .env
docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:7899/healthz
```

## 更新

```bash
cd /opt/picvault
git pull
docker compose up -d --build
docker compose ps
```

## 备份

```bash
cd /opt/picvault
bash scripts/backup.sh
```

备份内容包括 PostgreSQL 数据和本机存储文件。

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

- 默认宿主端口：`7899`
- 前端入口：`http://服务器IP:7899`
- 后端 API：`/api`
- PostgreSQL、Redis、后端服务默认不暴露到公网
- 新安装默认使用本机存储，可直接上传
- 第三方存储支持 Cloudflare R2、AWS S3、阿里云 OSS S3 兼容接口、腾讯云 COS S3 兼容接口
- 使用第三方存储时，存储桶需要允许浏览器 `PUT` 请求的 CORS
- 反向代理 HTTPS 时，将 `.env` 中的 `APP_PUBLIC_URL` 设置为公开域名
- Swagger 默认关闭，仅在可信环境中设置 `ENABLE_SWAGGER=true`

## 常用文件

- `.env.production.example`：生产环境配置模板
- `docker-compose.yml`：生产编排配置
- `scripts/install.sh`：一键安装脚本
- `scripts/backup.sh`：备份脚本

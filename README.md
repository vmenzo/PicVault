# PicVault

A full-stack image hosting starter built with Vue 3, Element Plus, NestJS, PostgreSQL, Redis, BullMQ, sharp, and S3-compatible object storage.

## Stack

- Frontend: Vue 3, Vite, Element Plus, Pinia, Vue Router
- Backend: NestJS, Prisma, PostgreSQL, Redis, BullMQ, sharp
- Storage: third-party S3-compatible object storage, with optional local disk storage
- Deployment base: Docker Compose

## Production Deploy

One-command Docker installation on a fresh VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/vmenzo/image-bed/main/scripts/install.sh | bash
```

If the current shell is not root:

```bash
curl -fsSL https://raw.githubusercontent.com/vmenzo/image-bed/main/scripts/install.sh | sudo bash
```

Optional custom port or public URL:

```bash
curl -fsSL https://raw.githubusercontent.com/vmenzo/image-bed/main/scripts/install.sh | PICVAULT_PORT=7899 APP_PUBLIC_URL=https://img.example.com bash
```

After the repository is pushed to GitHub, deploy from a VPS with Docker and Docker Compose:

```bash
git clone https://github.com/YOUR_NAME/YOUR_REPO.git image-bed
cd image-bed
cp .env.production.example .env

# edit .env before first start
nano .env

docker compose up -d --build
docker compose ps
curl -fsS http://127.0.0.1:7899/healthz
```

Frontend: `http://SERVER_IP:7899`

Backend API: proxied at `/api`.

Swagger is disabled by default. Set `ENABLE_SWAGGER=true` only for trusted environments.

PostgreSQL, Redis, and the backend are internal Compose services and are not exposed to the public host.

Fresh installs default to local disk storage so uploads work immediately. Configure a third-party S3-compatible provider in `.env` or in Control Center when you want browser direct-to-object-storage uploads. Supported examples include Cloudflare R2, AWS S3, Alibaba OSS S3-compatible endpoints, Tencent COS S3-compatible endpoints, and other compatible services. The bucket must allow browser `PUT` requests through CORS.

To update an existing deployment:

```bash
cd image-bed
git pull
docker compose up -d --build
docker compose ps
```

To back up PostgreSQL and local storage:

```bash
bash scripts/backup.sh
```

## Local Development

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

## Notes

- The first registered user automatically becomes `ADMIN`.
- Uploads use presigned PUT URLs, so the browser sends image bytes directly to the configured object-storage provider.
- The image processing queue is wired with BullMQ and sharp; the current worker marks uploaded images as ready and is the extension point for thumbnails, WebP/AVIF, watermarks, and moderation.
- Prisma is pinned to v6 because Prisma v7 changes datasource configuration and requires a different setup.

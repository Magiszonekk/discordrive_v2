# Discordrive v2

Self-hosted cloud storage that uses Discord as free unlimited backend. Zero-knowledge encryption - everything happens in your browser.

> **200% vibe coded** - Built with mass cursor-tabbing, mass prompting, and mass amounts of coffee. Don't trust, verify.

## Features

- **Zero-knowledge encryption** - AES-256-GCM, keys never leave your device
- **Server-side encryption** - Optional PBKDF2-derived AES-256-GCM (per-chunk, independent IVs)
- **Video/audio streaming** - HTTP Range support for seeking without downloading entire file
- **Multi-bot parallelism** - Unlimited Discord bots with automatic load balancing
- **Multi-channel support** - Spread storage across multiple Discord channels
- **File & folder management** - Organize, move, rename, share publicly
- **Password protection** - Lock files/folders with additional password
- **Public sharing** - Share with password or embedded key in URL
- **Discord embeds** - Shared videos/images show as playable embeds
- **ZIP export** - Download folders as ZIP
- **@discordrive/core** - Reusable npm package for programmatic access
- **Bug reporting** - Built-in bug report form
- **Mobile friendly** - Responsive UI with touch controls

## Architecture

```
discordrive/
  apps/
    backend/       Express API server (Node.js)
    frontend/      Web UI (Next.js)
    gallery/       Media gallery app
  packages/
    core/          @discordrive/core — shared library (TypeScript)
    shared/        @discordrive/shared — shared constants & types
```

Monorepo managed with **pnpm workspaces** + **Turborepo**.

## Quick Start

### 1. Install

```bash
git clone <repo>
cd discordrive_v2
pnpm install
pnpm build
```

### 2. Configure `.env`

```env
# Discord — at least one token + one channel required
DISCORD_CHANNEL_ID=your_channel_id
DISCORD_TOKEN=your_bot_token

# Multiple bots/channels (optional)
DISCORD_TOKEN_2=second_bot_token
DISCORD_CHANNEL_2_ID=second_channel_id
BOTS_PER_CHANNEL=6

# Server
HOST=0.0.0.0
PORT=3000                                # Backend (Express)
FRONTEND_PORT=3001                       # Frontend (Next.js)
PUBLIC_BASE_URL=https://your-domain.com
FRONTEND_URL=https://your-domain.com

# Encryption (optional — omit for client-only encryption)
ENCRYPTION_KEY=your-secret-passphrase
# DISCORDRIVE_ENCRYPT=false              # disable server-side encryption

# Upload
UPLOAD_TEMP_DIR=./data/temp
UPLOAD_BATCH_SIZE=5
CHUNK_SIZE=8387584                       # ~8MB per chunk (max 25MB for Discord)
MAX_FILE_SIZE=32212254720                # ~30GB

# Download
DOWNLOAD_CONCURRENCY=6

# Bot init
BOT_INIT_RETRIES=5

# Email (SMTP) — for signup/password reset
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=user@example.com
SMTP_PASS=password
EMAIL_FROM=Discordrive <user@example.com>
```

### 3. Run

```bash
# Development (frontend + backend)
pnpm dev

# Backend only
pnpm dev:backend

# Frontend only
pnpm dev:frontend

# Production
pnpm build && pnpm start
```

## Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all apps in dev mode |
| `pnpm dev:backend` | Start backend only |
| `pnpm dev:frontend` | Start frontend only |
| `pnpm build` | Build all packages and apps |
| `pnpm start` | Start in production mode |
| `pnpm discordrive:clear` | Wipe ALL files from Discord + database (keeps users) |
| `pnpm clean` | Remove build artifacts and node_modules |

## Multi-bot Setup

Add multiple bots for parallel uploads:

```env
DISCORD_TOKEN=bot1_token
DISCORD_TOKEN_2=bot2_token
DISCORD_TOKEN_3=bot3_token
# ...up to as many as you want
```

Multiple channels:

```env
DISCORD_CHANNEL_ID=channel_1
DISCORD_CHANNEL_2_ID=channel_2
BOTS_PER_CHANNEL=6
```

## Encryption

Two encryption modes:

**Client-side (zero-knowledge):** Browser encrypts with WebCrypto before upload. Server never sees plaintext. No `ENCRYPTION_KEY` needed.

**Server-side:** Set `ENCRYPTION_KEY` in `.env`. Each file chunk gets:
- Unique salt (PBKDF2, 100k iterations)
- Unique IV (12 bytes)
- Unique auth tag (16 bytes)
- AES-256-GCM encryption

Per-chunk independent encryption enables Range-based video streaming with seeking.

## Video Streaming

Share links for video/audio support HTTP Range requests:

```html
<video controls src="https://your-domain.com/s/TOKEN/stream"></video>
```

The backend downloads and decrypts **only the chunks needed** for the requested byte range — seeking to minute 30 doesn't require downloading minutes 0-29.

## @discordrive/core

The core package can be used as a standalone library:

```typescript
import Discordrive from '@discordrive/core';

const drive = new Discordrive({
  discordTokens: ['bot-token'],
  channelIds: ['channel-id'],
  encrypt: true,
  encryptionKey: 'my-secret',
});

await drive.init();

// Upload & share
const { share } = await drive.uploadAndShare('./video.mp4');
console.log(share.url);

// Download
await drive.download(fileId, './output.mp4');

// Stream
const stream = await drive.downloadStream(fileId);

await drive.destroy();
```

## API Endpoints

### Files
- `GET /api/files` - List files & folders
- `POST /api/files` - Upload file
- `PATCH /api/files/:id` - Update file (move/rename)
- `DELETE /api/files/:id` - Delete file
- `GET /api/files/:id/download` - Download file

### Folders
- `GET /api/folders` - List folders
- `POST /api/folders` - Create folder
- `PATCH /api/folders/:id` - Update folder
- `DELETE /api/folders/:id` - Delete folder
- `GET /api/folders/:id/download` - Download as ZIP

### Shares
- `GET /api/shares` - List shares
- `POST /api/shares` - Create share
- `DELETE /api/shares/:id` - Revoke share
- `GET /s/:token` - Public share page
- `GET /s/:token/stream` - Stream video/audio (Range support)

### Other
- `GET /api/health` - Health check
- `GET /api/gallery/media` - Media files
- `POST /api/bugs` - Submit bug report

## Tech Stack

**Backend:** Express.js, Discord.js, SQLite (better-sqlite3), Nodemailer
**Frontend:** Next.js, React, WebCrypto API, Tailwind CSS, Radix UI
**Core:** TypeScript, tsup (CJS + ESM dual build)
**Tooling:** pnpm, Turborepo

## License

MIT

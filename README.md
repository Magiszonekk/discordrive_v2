# Discordrive v2

Self-hosted cloud storage that uses Discord as free unlimited backend. Zero-knowledge encryption - everything happens in your browser.

> **200% vibe coded** - Built with mass cursor-tabbing, mass prompting, and mass amounts of coffee. Don't trust, verify.

## Features

- **Zero-knowledge encryption** - AES-256-GCM in browser, keys never leave your device
- **Cloud Key Backup** - Optional password-locked key sync for multi-device use
- **Multi-bot parallelism** - Unlimited Discord bots with automatic load balancing
- **File & folder management** - Organize, move, rename, share publicly
- **Password protection** - Lock files/folders with additional password
- **Public sharing** - Share with password or embedded key in URL
- **Discord embeds** - Shared videos/images show as playable embeds on Discord
- **ZIP export** - Download folders as ZIP (client-side decryption)
- **Bug reporting** - Built-in bug report form stored in database
- **Mobile friendly** - Responsive UI with touch controls

## Quick Start

### 1. Clone & install
```bash
git clone <repo>
cd discordrive_v2
npm install
cd frontend && npm install && npm run build && cd ..
```

### 2. Configure `.env`
```env
# Discord
DISCORD_CHANNEL_ID=your_channel_id
DISCORD_TOKEN=your_bot_token

# Server
PORT=3001
HOST=localhost
PUBLIC_BASE_URL=http://localhost:3001

# Upload settings
UPLOAD_TEMP_DIR=./data/temp
UPLOAD_BATCH_SIZE=3
MAX_FILE_SIZE=0
CHUNK_SIZE=8388608
DOWNLOAD_CONCURRENCY=6

# Email (optional - for signup/reset)
SMTP_HOST=smtp.example.com
SMTP_PORT=465
SMTP_USER=user@example.com
SMTP_PASS=password
EMAIL_FROM=noreply@example.com
```

### 3. Run
```bash
npm start
```

Open `http://localhost:3001` in your browser.

## Multi-bot Setup

Add multiple bots for parallel uploads:
```env
DISCORD_TOKEN=bot1_token
DISCORD_TOKEN_2=bot2_token
DISCORD_TOKEN_3=bot3_token
```

## Discord Embeds

When sharing videos or images with "embed key in link" option:
- Media dimensions are automatically detected during upload
- Shared links generate Open Graph meta tags
- Discord displays playable video/image previews inline
- Works with any platform that reads OG tags (Twitter, Slack, etc.)

## API Endpoints

### Files
- `GET /api/files` - List files & folders
- `POST /api/files` - Start upload session
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

### Bug Reports
- `POST /api/bugs` - Submit bug report (public)
- `GET /api/bugs` - List reports (auth required)
- `PATCH /api/bugs/:id/status` - Update status (auth required)

### Other
- `GET /api/health` - Health check
- `GET /api/stats` - Storage stats
- `GET /api/config` - Client config

## Tech Stack

**Backend:** Express.js, Discord.js, SQLite (better-sqlite3), Nodemailer
**Frontend:** Next.js, React, WebCrypto API, Web Workers, Tailwind CSS, Radix UI

## License

MIT

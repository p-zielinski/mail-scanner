# Mail Scanner

Scan your mailbox for scam/phishing emails and automatically move detected scams to the provider's Spam/Junk folder. Works for multiple accounts defined in a JSON file and scans only the `INBOX` folder.

## Features

- **Scam detection** using `EmailAnalyzer` and moves suspicious emails to Spam/Junk.
- **Multi-account support** via one config file.
- **Historical backfill** starting from `emailsAnalyzedUntil` per account.
- **Real-time watching** for new messages; processed messages update the config date.
- **Provider-aware Spam/Junk mapping** (tries common folder names, creates `Spam` if needed).
- **Resilient connection** with reconnection and keepalive.

## Requirements

- Node.js 18+
- An Anthropic API key for `EmailAnalyzer`.
- Path to accounts configuration JSON.

Set required env vars in `.env` or your shell:

```bash
ANTHROPIC_API_KEY=your-anthropic-api-key
ACCOUNTS_CONFIG_PATH=./accounts.json
# Optional: limit the number of characters from email body sent to AI (default 3000)
ANALYZER_BODY_MAX_CHARS=3000
```

## Install

```bash
npm install
```

## Run

Developer mode (watcher):

```bash
npm run watch
```

This starts the watcher at `src/emailWatcher.ts` for all accounts from `ACCOUNTS_CONFIG_PATH`.

## Configuration: `accounts.json`

Use `accounts.example.json` as a template. Example:

```json
[
  {
    "label": "Yahoo Primary",
    "user": "your-email@yahoo.com",
    "password": "your-generated-app-password",
    "host": "imap.mail.yahoo.com",
    "port": 993,
    "tls": true,
    "scamThreshold": 80,
    "emailsAnalyzedUntil": null
  },
  {
    "label": "Gmail Work",
    "user": "your-email@gmail.com",
    "password": "your-app-password-or-oauth-token",
    "host": "imap.gmail.com",
    "port": 993,
    "tls": true,
    "scamThreshold": 85,
    "emailsAnalyzedUntil": "2025-11-01T00:00:00.000Z"
  }
]
```

### About `emailsAnalyzedUntil`

- If `"emailsAnalyzedUntil": null` or the field is missing, the app will backfill and analyze the entire `INBOX`.
- If you want to limit historical scanning, set `emailsAnalyzedUntil` to an ISO date string (e.g., `"2025-11-01T00:00:00.000Z"`). The watcher will analyze emails `SINCE` that date.
- After a backfill finishes and after each batch of newly received emails is processed, the watcher will update this field to the current time in your `ACCOUNTS_CONFIG_PATH` file.

### Only `INBOX`

The scanner and watcher operate on the `INBOX` folder only (see `openBox("INBOX")` in the code). Detected scam emails are moved to an appropriate Spam/Junk folder for your provider.

### Analyzer body size limit

- You can control how many characters from the plain-text body are sent to the AI by setting `ANALYZER_BODY_MAX_CHARS` (default: 3000).
- The text is sanitized to remove control characters and collapse excessive whitespace before truncation.

## How it works

- On startup, the watcher connects to IMAP, opens `INBOX`, and begins listening for new mail.
- On the initial event, instead of skipping, it triggers a **historical backfill** using IMAP `SINCE` search from `emailsAnalyzedUntil` for each account.
- Each email is analyzed; suspicious ones are moved to Spam/Junk, legitimate ones are logged.
- After backfill and after processing new mail, `emailsAnalyzedUntil` is set to the current time in your `accounts.json`.
## Troubleshooting

- If you see normal connection closes: providers (e.g., Yahoo) may close idle sessions periodically. The watcher automatically keeps the session alive and reconnects.
- Ensure `ANTHROPIC_API_KEY` and `ACCOUNTS_CONFIG_PATH` are set; otherwise startup will fail with a clear error.
- Verify credentials and IMAP host/port/tls per provider.

## Scripts

- `npm run build` – build TypeScript to `dist/` (if you later add CLI entrypoints).
- `npm run watch` – run the live watcher (`src/emailWatcher.ts`).

## Docker

The provided `Dockerfile` uses a multi-stage build based on `node:22-alpine`.

### Build the image

```bash
docker build -t mail-scanner:latest .
```

### Prepare configuration

- **Create an `.env` file** (or export variables) with at least:
  ```bash
  ANTHROPIC_API_KEY=your-anthropic-api-key
  # We will mount a writable data directory at /app/data
  ACCOUNTS_CONFIG_PATH=./accounts.json
  # Optional, default is 3000
  ANALYZER_BODY_MAX_CHARS=3000
  ```
- **Create a local `data/` directory** and place your `accounts.json` inside it (based on `accounts.example.json`):
  ```bash
  mkdir -p data
  cp accounts.example.json data/accounts.json  # then edit the file
  ```

### Run the container

Recommended: mount a writable `data/` directory and point `ACCOUNTS_CONFIG_PATH` to it.

```bash
docker run \
  --name mail-scanner \
  --env-file ./.env \
  -e ACCOUNTS_CONFIG_PATH=/app/data/accounts.json \
  -v "$(pwd)/data:/app/data" \
  --restart unless-stopped \
  mail-scanner:latest
```

Notes:

- **Writable config**: The watcher updates `emailsAnalyzedUntil` in `ACCOUNTS_CONFIG_PATH`. Using a directory volume avoids read-only errors.
- The container entrypoint runs `node dist/emailWatcher.js` and will keep watching for new mail.
- You can override env directly instead of `--env-file` with, e.g., `-e ANTHROPIC_API_KEY=... -e ACCOUNTS_CONFIG_PATH=/app/data/accounts.json`.
- Logs are printed to stdout/stderr; use `docker logs -f mail-scanner` to follow.

### Alternative: named Docker volume

If you prefer data inside Docker (not on the host):

```bash
docker volume create mail_scanner_data
# One-time seed of the accounts file
docker run --rm \
  -v mail_scanner_data:/app/data \
  -v "$(pwd)/data:/seed:ro" \
  alpine sh -c 'mkdir -p /app/data && cp -n /seed/accounts.json /app/data/accounts.json'

docker run \
  --name mail-scanner \
  --env-file ./.env \
  -e ACCOUNTS_CONFIG_PATH=/app/data/accounts.json \
  -v mail_scanner_data:/app/data \
  --restart unless-stopped \
  mail-scanner:latest
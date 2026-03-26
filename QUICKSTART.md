# factuur-labeler Quick Start

## Step 1 — Install dependencies

```bash
cd factuur-labeler
bun install
```

## Step 2 — Google Cloud setup (one time)

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or select an existing one)
3. Go to **APIs & Services → Library** → search "Gmail API" → Enable it
4. Go to **APIs & Services → Credentials** → Create Credentials → OAuth 2.0 Client ID
5. Application type: **Desktop app**
6. Download the JSON → save as `~/.config/factuur-labeler/credentials.json`

> Or set env vars: `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET`

## Step 3 — Authenticate

```bash
bun run factuur-labeler.ts auth
```

Your browser opens. Approve Gmail access. Done.

## Step 4 — Preview (dry run)

```bash
bun run factuur-labeler.ts scan --dry-run
```

See which emails would be labeled — no changes made.

## Step 5 — Label invoices

```bash
bun run factuur-labeler.ts scan
```

All matching emails get the `factuur` label in Gmail.

## Run again anytime

The tool only labels emails that don't have the `factuur` label yet.
Safe to re-run as often as you want.

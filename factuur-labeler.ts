#!/usr/bin/env bun
/**
 * factuur-labeler - Gmail Invoice Label Tool
 *
 * Automatically finds emails containing invoices (PDF attachments or invoice
 * keywords in subject/body) and applies the 'factuur' label in Gmail.
 */

import { google } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createServer } from 'http';
import { URL } from 'url';

// ============================================================================
// Types & Interfaces
// ============================================================================

interface Credentials {
  client_id: string;
  client_secret: string;
}

interface TokenData {
  access_token?: string | null;
  refresh_token?: string | null;
  expiry_date?: number | null;
  token_type?: string | null;
  scope?: string;
}

interface ScanResult {
  total_found: number;
  labeled: number;
  message_ids: string[];
  dry_run: boolean;
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_DIR = join(homedir(), '.config', 'factuur-labeler');
const TOKENS_PATH = join(CONFIG_DIR, 'tokens.json');
const CREDENTIALS_PATH = join(CONFIG_DIR, 'credentials.json');
const LABEL_NAME = 'factuur';
const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
];

// Gmail search queries for invoice detection
// Each query targets a different signal; results are deduplicated
const INVOICE_QUERIES = [
  // PDFs with invoice-related terms anywhere in the message
  'has:attachment filename:pdf (factuur OR invoice OR rekening OR nota OR BTW OR receipt OR "order" OR "bestelling")',
  // Subject-line matches (catches non-PDF invoices too)
  'subject:(factuur OR invoice OR rekening OR nota OR "uw factuur" OR "your invoice" OR "pro forma")',
];

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function loadCredentials(): Credentials {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (clientId && clientSecret) {
    return { client_id: clientId, client_secret: clientSecret };
  }

  if (existsSync(CREDENTIALS_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
      // Google's downloaded JSON wraps under "installed" or "web"
      const creds = raw.installed ?? raw.web ?? raw;
      return {
        client_id: creds.client_id,
        client_secret: creds.client_secret,
      };
    } catch {
      console.error(`Error: Could not parse ${CREDENTIALS_PATH}`);
      process.exit(1);
    }
  }

  console.error('Error: No Google credentials found.\n');
  console.error('Option 1 — environment variables:');
  console.error('  export GMAIL_CLIENT_ID=your_client_id');
  console.error('  export GMAIL_CLIENT_SECRET=your_client_secret\n');
  console.error('Option 2 — credentials.json:');
  console.error(`  Copy your credentials.json to: ${CREDENTIALS_PATH}\n`);
  console.error('See README.md for full setup instructions.');
  process.exit(1);
}

function loadTokens(): TokenData | null {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens: TokenData): void {
  ensureConfigDir();
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 });
}

// ============================================================================
// OAuth2
// ============================================================================

function createOAuth2Client(): OAuth2Client {
  const { client_id, client_secret } = loadCredentials();
  return new google.auth.OAuth2(client_id, client_secret, REDIRECT_URI);
}

async function getAuthenticatedClient(): Promise<OAuth2Client> {
  const oauth2Client = createOAuth2Client();
  const tokens = loadTokens();

  if (!tokens) {
    console.error('Error: Not authenticated. Run: factuur-labeler auth');
    process.exit(1);
  }

  oauth2Client.setCredentials(tokens);

  // Refresh if expired
  if (tokens.expiry_date && tokens.expiry_date < Date.now()) {
    try {
      const { credentials } = await oauth2Client.refreshAccessToken();
      saveTokens(credentials);
      oauth2Client.setCredentials(credentials);
    } catch {
      console.error('Error: Token refresh failed. Run: factuur-labeler auth');
      process.exit(1);
    }
  }

  return oauth2Client;
}

// ============================================================================
// Commands
// ============================================================================

async function cmdAuth(): Promise<void> {
  const oauth2Client = createOAuth2Client();

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\nStarting Gmail authorization...\n');
  console.log('Opening browser. If it does not open, visit this URL:\n');
  console.log(authUrl);
  console.log('');

  // Try to open browser (macOS)
  Bun.spawn(['open', authUrl], { stderr: 'pipe' });

  // Start local callback server to capture the auth code
  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) return;

      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);

      if (url.pathname !== '/callback') {
        res.writeHead(404);
        res.end();
        return;
      }

      const error = url.searchParams.get('error');
      const authCode = url.searchParams.get('code');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authorization failed</h1><p>${error}</p><p>Close this tab.</p></body></html>`);
        server.close();
        reject(new Error(`Authorization failed: ${error}`));
        return;
      }

      if (authCode) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body><h1>Authorization successful!</h1><p>You can close this tab.</p></body></html>');
        server.close();
        resolve(authCode);
        return;
      }

      res.writeHead(400);
      res.end();
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Waiting for browser authorization on port ${REDIRECT_PORT}...`);
    });

    server.on('error', reject);

    // 5-minute timeout
    setTimeout(() => {
      server.close();
      reject(new Error('Timeout: No response within 5 minutes'));
    }, 5 * 60 * 1000);
  });

  const { tokens } = await oauth2Client.getToken(code);
  saveTokens(tokens);

  console.log('\n✓ Authentication successful!');
  console.log(`  Tokens saved to: ${TOKENS_PATH}`);
  console.log('\nRun next: factuur-labeler scan --dry-run\n');
}

async function getOrCreateLabel(auth: OAuth2Client): Promise<string> {
  const gmail = google.gmail({ version: 'v1', auth });

  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = (data.labels ?? []).find(
    (l) => l.name?.toLowerCase() === LABEL_NAME.toLowerCase()
  );

  if (existing?.id) return existing.id;

  const { data: created } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name: LABEL_NAME,
      messageListVisibility: 'show',
      labelListVisibility: 'labelShow',
    },
  });

  if (!created.id) throw new Error('Failed to create Gmail label');
  console.log(`✓ Created label: ${LABEL_NAME}`);
  return created.id;
}

async function searchMessages(auth: OAuth2Client, query: string): Promise<string[]> {
  const gmail = google.gmail({ version: 'v1', auth });
  const ids: string[] = [];
  let pageToken: string | undefined;

  do {
    const { data } = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 500,
      pageToken,
    });

    for (const msg of data.messages ?? []) {
      if (msg.id) ids.push(msg.id);
    }

    pageToken = data.nextPageToken ?? undefined;
  } while (pageToken);

  return ids;
}

async function applyLabel(
  auth: OAuth2Client,
  messageIds: string[],
  labelId: string
): Promise<number> {
  const gmail = google.gmail({ version: 'v1', auth });
  let count = 0;
  const batchSize = 10;

  for (let i = 0; i < messageIds.length; i += batchSize) {
    const batch = messageIds.slice(i, i + batchSize);

    await Promise.all(
      batch.map((id) =>
        gmail.users.messages.modify({
          userId: 'me',
          id,
          requestBody: { addLabelIds: [labelId] },
        })
      )
    );

    count += batch.length;
    process.stderr.write(`\r  Labeled ${count}/${messageIds.length}...`);

    // Avoid hitting Gmail rate limits between batches
    if (i + batchSize < messageIds.length) {
      await Bun.sleep(100);
    }
  }

  if (messageIds.length > 0) process.stderr.write('\n');
  return count;
}

async function cmdScan(options: { dryRun: boolean; verbose: boolean }): Promise<void> {
  const auth = await getAuthenticatedClient();

  console.log(`\nScanning Gmail for invoices${options.dryRun ? ' (dry run — no changes)' : ''}...\n`);

  const labelId = await getOrCreateLabel(auth);

  // Run all queries and collect unique message IDs
  const seen = new Set<string>();

  for (const baseQuery of INVOICE_QUERIES) {
    // Exclude already-labeled messages from search
    const query = `${baseQuery} -label:${LABEL_NAME}`;

    if (options.verbose) console.log(`Query: ${query}`);

    const ids = await searchMessages(auth, query);

    for (const id of ids) seen.add(id);

    if (options.verbose) console.log(`  → ${ids.length} matches\n`);
  }

  const messageIds = [...seen];

  const result: ScanResult = {
    total_found: messageIds.length,
    labeled: 0,
    message_ids: messageIds,
    dry_run: options.dryRun,
  };

  if (messageIds.length === 0) {
    console.log('No unlabeled invoice emails found.\n');
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(`Found ${messageIds.length} invoice email(s) to label.`);

  if (!options.dryRun) {
    result.labeled = await applyLabel(auth, messageIds, labelId);
    console.log(`✓ Applied label '${LABEL_NAME}' to ${result.labeled} email(s)\n`);
  } else {
    console.log(`[Dry run] Would label ${messageIds.length} email(s) with '${LABEL_NAME}'\n`);
    result.labeled = messageIds.length;
  }

  console.log(JSON.stringify(result, null, 2));
}

async function cmdStatus(): Promise<void> {
  const tokens = loadTokens();

  console.log('\nfactuur-labeler status');
  console.log('======================\n');

  if (!tokens) {
    console.log('Authentication : Not authenticated');
    console.log('\nRun: factuur-labeler auth\n');
    return;
  }

  const expired = tokens.expiry_date != null && tokens.expiry_date < Date.now();
  console.log(`Authentication : ${expired ? 'Expired — run auth again' : 'Active'}`);

  if (tokens.expiry_date) {
    console.log(`Token expires  : ${new Date(tokens.expiry_date).toLocaleString()}`);
  }

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });

    const { data } = await gmail.users.labels.list({ userId: 'me' });
    const factuurLabel = (data.labels ?? []).find(
      (l) => l.name?.toLowerCase() === LABEL_NAME.toLowerCase()
    );

    if (factuurLabel?.id) {
      const { data: details } = await gmail.users.labels.get({
        userId: 'me',
        id: factuurLabel.id,
      });
      console.log(`Label          : '${LABEL_NAME}' exists (${details.messagesTotal ?? 0} emails)`);
    } else {
      console.log(`Label          : '${LABEL_NAME}' not yet created (created on first scan)`);
    }
  } catch (err) {
    console.log(`Gmail API      : Connection error — ${err}`);
  }

  console.log('');
}

// ============================================================================
// Help & Version
// ============================================================================

function showHelp(): void {
  console.log(`
factuur-labeler - Gmail Invoice Label Tool
==========================================

Finds emails containing invoices and applies the 'factuur' label in Gmail.
Detects: PDF attachments with invoice terms, invoice keywords in subject.

USAGE:
  factuur-labeler <command> [options]

COMMANDS:
  auth                    Authenticate with Gmail (run once)
  scan                    Find and label invoice emails
  scan --dry-run          Preview what would be labeled (no changes)
  scan --verbose          Show each search query and match count
  status                  Show auth status and label info
  help, --help, -h        Show this help
  version, --version, -v  Show version

EXAMPLES:
  factuur-labeler auth              # First-time setup
  factuur-labeler scan --dry-run    # Safe preview
  factuur-labeler scan              # Label invoice emails
  factuur-labeler scan --verbose    # Debug mode
  factuur-labeler status            # Check everything is working

DETECTION LOGIC:
  Query 1: PDF attachments with terms: factuur, invoice, rekening, nota, BTW
  Query 2: Subject contains: factuur, invoice, rekening, nota, pro forma

CONFIGURATION:
  Credentials : ${CREDENTIALS_PATH}
               or GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET env vars
  Tokens      : ${TOKENS_PATH}

OUTPUT:
  JSON to stdout, status messages to stderr
  Exit 0 on success, 1 on error

Version: 1.0.0
`);
}

function showVersion(): void {
  console.log('factuur-labeler version 1.0.0');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';

  if (['help', '--help', '-h'].includes(cmd)) {
    showHelp();
    return;
  }

  if (['version', '--version', '-v'].includes(cmd)) {
    showVersion();
    return;
  }

  switch (cmd) {
    case 'auth':
      await cmdAuth();
      break;

    case 'scan':
      await cmdScan({
        dryRun: args.includes('--dry-run'),
        verbose: args.includes('--verbose'),
      });
      break;

    case 'status':
      await cmdStatus();
      break;

    default:
      console.error(`Error: Unknown command '${cmd}'`);
      console.error('Run "factuur-labeler --help" for usage.');
      process.exit(1);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err?.message ?? err);
  process.exit(1);
});

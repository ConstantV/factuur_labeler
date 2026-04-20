#!/usr/bin/env bun
/**
 * factuur-labeler - Gmail Invoice Label & Archiver
 *
 * 1. Scans Gmail for invoice emails (current + previous quarter)
 * 2. Labels matches as 'factuur'
 * 3. For trusted sender domains: downloads or generates PDF
 * 4. Saves PDF to quarterly folder (e.g. 2026Q2)
 * 5. Removes 'factuur' label, applies 'Verwerkt' label
 *
 * Skips any mail already labelled 'Verwerkt'.
 *
 * PDF generation (for mails without attachment): Puppeteer (headless Chrome)
 * Runs on macOS and headless Linux VMs.
 *
 * Auth note for Linux VMs:
 *   Run `factuur-labeler auth` once on your Mac, then copy
 *   ~/.config/factuur-labeler/tokens.json to the same path on the VM.
 */

import { google } from 'googleapis';
import type { gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir, platform } from 'os';
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

interface Config {
  output_base: string;
  trusted_domains: string[];
}

interface ScanResult {
  total_found: number;
  labeled: number;
  processed: number;
  skipped: number;
  dry_run: boolean;
}

interface Quarter {
  year: number;
  q: number;
  start: Date;
  end: Date;
  label: string; // e.g. "2026Q2"
}

// ============================================================================
// Configuration
// ============================================================================

const CONFIG_DIR = join(homedir(), '.config', 'factuur-labeler');
const TOKENS_PATH = join(CONFIG_DIR, 'tokens.json');
const CREDENTIALS_PATH = join(CONFIG_DIR, 'credentials.json');
const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

const LABEL_FACTUUR = 'factuur';
const LABEL_VERWERKT = 'Verwerkt';
const REDIRECT_PORT = 3000;
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/callback`;

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
];

// Gmail search queries for invoice detection
const INVOICE_QUERIES = [
  'has:attachment filename:pdf (factuur OR invoice OR rekening OR nota OR BTW OR receipt OR "order" OR "bestelling")',
  'subject:(factuur OR invoice OR rekening OR nota OR "uw factuur" OR "your invoice" OR "pro forma")',
];

// ============================================================================
// Quarter Helpers
// ============================================================================

function getQuarter(date: Date): Quarter {
  const year = date.getFullYear();
  const q = Math.floor(date.getMonth() / 3) + 1;
  const start = new Date(year, (q - 1) * 3, 1);
  const end = new Date(year, q * 3, 0, 23, 59, 59, 999);
  return { year, q, start, end, label: `${year}Q${q}` };
}

function getPreviousQuarter(q: Quarter): Quarter {
  const date = new Date(q.start);
  date.setDate(date.getDate() - 1); // Go back one day to previous quarter
  return getQuarter(date);
}

function getQuarterForDate(date: Date): Quarter {
  return getQuarter(date);
}

/**
 * Returns Gmail after: date string for the start of the previous quarter.
 * Format: YYYY/MM/DD
 */
function getSearchAfterDate(): string {
  const now = new Date();
  const currentQ = getQuarter(now);
  const prevQ = getPreviousQuarter(currentQ);
  const d = prevQ.start;
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}/${mm}/${dd}`;
}

// ============================================================================
// Config File
// ============================================================================

function loadConfig(): Config {
  const defaultConfig: Config = {
    output_base: join(homedir(), 'Facturen'),
    trusted_domains: [],
  };

  if (!existsSync(CONFIG_PATH)) {
    ensureConfigDir();
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    console.log(`✓ Created default config at: ${CONFIG_PATH}`);
    console.log('  Edit trusted_domains and output_base before running scan.\n');
    return defaultConfig;
  }

  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    return { ...defaultConfig, ...raw };
  } catch {
    console.error(`Error: Could not parse ${CONFIG_PATH}`);
    process.exit(1);
  }
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
  }
}

function ensureOutputDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

// ============================================================================
// Credentials & Tokens
// ============================================================================

function loadCredentials(): Credentials {
  const clientId = process.env.GMAIL_CLIENT_ID;
  const clientSecret = process.env.GMAIL_CLIENT_SECRET;

  if (clientId && clientSecret) {
    return { client_id: clientId, client_secret: clientSecret };
  }

  if (existsSync(CREDENTIALS_PATH)) {
    try {
      const raw = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
      const creds = raw.installed ?? raw.web ?? raw;
      return { client_id: creds.client_id, client_secret: creds.client_secret };
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
// Gmail Label Helpers
// ============================================================================

async function getOrCreateLabel(
  gmail: gmail_v1.Gmail,
  name: string
): Promise<string> {
  const { data } = await gmail.users.labels.list({ userId: 'me' });
  const existing = (data.labels ?? []).find(
    (l) => l.name?.toLowerCase() === name.toLowerCase()
  );

  if (existing?.id) return existing.id;

  const { data: created } = await gmail.users.labels.create({
    userId: 'me',
    requestBody: {
      name,
      messageListVisibility: 'show',
      labelListVisibility: 'labelShow',
    },
  });

  if (!created.id) throw new Error(`Failed to create Gmail label: ${name}`);
  console.log(`✓ Created label: ${name}`);
  return created.id;
}

async function modifyMessageLabels(
  gmail: gmail_v1.Gmail,
  messageId: string,
  addLabelIds: string[],
  removeLabelIds: string[]
): Promise<void> {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { addLabelIds, removeLabelIds },
  });
}

// ============================================================================
// Gmail Search
// ============================================================================

async function searchMessages(
  gmail: gmail_v1.Gmail,
  query: string
): Promise<string[]> {
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

async function getMessageDetails(
  gmail: gmail_v1.Gmail,
  messageId: string
): Promise<gmail_v1.Schema$Message> {
  const { data } = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });
  return data;
}

// ============================================================================
// Email Parsing Helpers
// ============================================================================

function getSenderDomain(message: gmail_v1.Schema$Message): string | null {
  const headers = message.payload?.headers ?? [];
  const from = headers.find((h) => h.name?.toLowerCase() === 'from')?.value ?? '';
  // Extract email address from "Name <email@domain.com>" or "email@domain.com"
  const match = from.match(/<([^>]+)>/) ?? from.match(/([^\s]+@[^\s]+)/);
  if (!match) return null;
  const email = match[1];
  const parts = email.split('@');
  return parts.length === 2 ? parts[1].toLowerCase() : null;
}

function getMessageDate(message: gmail_v1.Schema$Message): Date | null {
  const ts = message.internalDate;
  if (!ts) return null;
  return new Date(parseInt(ts, 10));
}

function getMessageSubject(message: gmail_v1.Schema$Message): string {
  const headers = message.payload?.headers ?? [];
  return headers.find((h) => h.name?.toLowerCase() === 'subject')?.value ?? '(geen onderwerp)';
}

/**
 * Recursively find all parts with a given mimeType
 */
function findParts(
  payload: gmail_v1.Schema$MessagePart | undefined,
  mimeType: string
): gmail_v1.Schema$MessagePart[] {
  if (!payload) return [];
  const results: gmail_v1.Schema$MessagePart[] = [];

  if (payload.mimeType === mimeType) results.push(payload);

  for (const part of payload.parts ?? []) {
    results.push(...findParts(part, mimeType));
  }

  return results;
}

/**
 * Returns the first PDF attachment part, or null if none.
 */
function findPdfAttachment(
  message: gmail_v1.Schema$Message
): gmail_v1.Schema$MessagePart | null {
  const payload = message.payload;
  if (!payload) return null;

  const allParts = getAllParts(payload);
  return (
    allParts.find(
      (p) =>
        p.mimeType === 'application/pdf' ||
        p.filename?.toLowerCase().endsWith('.pdf')
    ) ?? null
  );
}

function getAllParts(payload: gmail_v1.Schema$MessagePart): gmail_v1.Schema$MessagePart[] {
  const parts: gmail_v1.Schema$MessagePart[] = [payload];
  for (const part of payload.parts ?? []) {
    parts.push(...getAllParts(part));
  }
  return parts;
}

/**
 * Build an HTML string from the message body (prefers text/html, falls back to text/plain).
 */
function extractHtmlBody(message: gmail_v1.Schema$Message): string | null {
  const payload = message.payload;
  if (!payload) return null;

  // Try text/html first
  const htmlParts = findParts(payload, 'text/html');
  if (htmlParts.length > 0 && htmlParts[0].body?.data) {
    return Buffer.from(htmlParts[0].body.data, 'base64').toString('utf-8');
  }

  // Fall back to text/plain wrapped in <pre>
  const textParts = findParts(payload, 'text/plain');
  if (textParts.length > 0 && textParts[0].body?.data) {
    const text = Buffer.from(textParts[0].body.data, 'base64').toString('utf-8');
    return `<html><body><pre style="font-family:sans-serif">${text}</pre></body></html>`;
  }

  return null;
}

// ============================================================================
// PDF Generation via Puppeteer
// ============================================================================

async function htmlToPdf(html: string, outputPath: string): Promise<void> {
  // Dynamically import puppeteer to avoid hard dependency if not installed
  let puppeteer: typeof import('puppeteer');
  try {
    puppeteer = await import('puppeteer');
  } catch {
    throw new Error(
      'Puppeteer not installed. Run: bun add puppeteer\n' +
      'On Linux you may also need: bunx puppeteer browsers install chrome'
    );
  }

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'], // Required on Linux VMs
  });

  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: outputPath,
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
      printBackground: true,
    });
  } finally {
    await browser.close();
  }
}

// ============================================================================
// PDF Download from Gmail Attachment
// ============================================================================

async function downloadPdfAttachment(
  gmail: gmail_v1.Gmail,
  messageId: string,
  part: gmail_v1.Schema$MessagePart,
  outputPath: string
): Promise<void> {
  let data: string | null = null;

  if (part.body?.data) {
    // Inline base64 data
    data = part.body.data;
  } else if (part.body?.attachmentId) {
    // Fetch from Gmail
    const { data: attachment } = await gmail.users.messages.attachments.get({
      userId: 'me',
      messageId,
      id: part.body.attachmentId,
    });
    data = attachment.data ?? null;
  }

  if (!data) throw new Error('Could not retrieve PDF attachment data');

  const buffer = Buffer.from(data, 'base64');
  writeFileSync(outputPath, buffer);
}

// ============================================================================
// Filename Sanitization
// ============================================================================

function sanitizeFilename(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 100);
}

function buildPdfFilename(subject: string, domain: string, date: Date): string {
  const iso = date.toISOString().slice(0, 10); // YYYY-MM-DD
  const safeSubject = sanitizeFilename(subject);
  const safeDomain = sanitizeFilename(domain);
  return `${iso}_${safeDomain}_${safeSubject}.pdf`;
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
  console.log('If browser does not open, visit this URL manually:\n');
  console.log(authUrl);
  console.log('');

  // Open browser — macOS uses 'open', Linux uses 'xdg-open'
  const opener = platform() === 'darwin' ? 'open' : 'xdg-open';
  Bun.spawn([opener, authUrl], { stderr: 'pipe' }).catch(() => {
    // Ignore errors — user can open URL manually
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      if (!req.url) return;
      const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

      const error = url.searchParams.get('error');
      const authCode = url.searchParams.get('code');

      if (error) {
        res.writeHead(400, { 'Content-Type': 'text/html' });
        res.end(`<html><body><h1>Authorization failed</h1><p>${error}</p></body></html>`);
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

      res.writeHead(400); res.end();
    });

    server.listen(REDIRECT_PORT, () => {
      console.log(`Waiting for browser authorization on port ${REDIRECT_PORT}...`);
    });

    server.on('error', reject);

    setTimeout(() => {
      server.close();
      reject(new Error('Timeout: No response within 5 minutes'));
    }, 5 * 60 * 1000);
  });

  const { tokens } = await oauth2Client.getToken(code);
  saveTokens(tokens);

  console.log('\n✓ Authentication successful!');
  console.log(`  Tokens saved to: ${TOKENS_PATH}`);
  console.log('\nFor Linux VM: copy tokens.json to the same path on the VM.');
  console.log('Run next: factuur-labeler scan --dry-run\n');
}

async function cmdScan(options: { dryRun: boolean; verbose: boolean }): Promise<void> {
  const auth = await getAuthenticatedClient();
  const config = loadConfig();
  const gmail = google.gmail({ version: 'v1', auth });

  if (config.trusted_domains.length === 0) {
    console.warn('Warning: trusted_domains is empty in config.json — no PDFs will be saved.\n');
  }

  const afterDate = getSearchAfterDate();
  const now = new Date();
  const currentQ = getQuarter(now);
  const prevQ = getPreviousQuarter(currentQ);

  console.log(`\nfactuur-labeler scan${options.dryRun ? ' (dry run — no changes)' : ''}`);
  console.log(`Scope: ${prevQ.label} + ${currentQ.label} (after ${afterDate})\n`);

  // Get label IDs (create if needed)
  const labelFactuurId = await getOrCreateLabel(gmail, LABEL_FACTUUR);
  const labelVerwerktId = await getOrCreateLabel(gmail, LABEL_VERWERKT);

  // ── Step 1: Label new invoice emails ──────────────────────────────────────

  console.log('Step 1: Scanning for unlabeled invoices...');
  const seen = new Set<string>();

  for (const baseQuery of INVOICE_QUERIES) {
    // Exclude already-labeled (factuur OR Verwerkt) and restrict to date range
    const query = `${baseQuery} after:${afterDate} -label:${LABEL_FACTUUR} -label:${LABEL_VERWERKT}`;
    if (options.verbose) console.log(`  Query: ${query}`);

    const ids = await searchMessages(gmail, query);
    for (const id of ids) seen.add(id);
    if (options.verbose) console.log(`  → ${ids.length} matches`);
  }

  const toLabel = [...seen];
  console.log(`  Found ${toLabel.length} new invoice email(s) to label.`);

  if (!options.dryRun && toLabel.length > 0) {
    let count = 0;
    const batchSize = 10;
    for (let i = 0; i < toLabel.length; i += batchSize) {
      const batch = toLabel.slice(i, i + batchSize);
      await Promise.all(
        batch.map((id) => modifyMessageLabels(gmail, id, [labelFactuurId], []))
      );
      count += batch.length;
      process.stderr.write(`\r  Labeled ${count}/${toLabel.length}...`);
      if (i + batchSize < toLabel.length) await Bun.sleep(100);
    }
    if (toLabel.length > 0) process.stderr.write('\n');
    console.log(`  ✓ Applied '${LABEL_FACTUUR}' to ${count} email(s)\n`);
  } else if (options.dryRun && toLabel.length > 0) {
    console.log(`  [Dry run] Would label ${toLabel.length} email(s)\n`);
  }

  // ── Step 2: Process labeled-but-not-yet-Verwerkt emails ──────────────────

  console.log(`Step 2: Processing '${LABEL_FACTUUR}' emails from trusted domains...`);

  const processQuery = `label:${LABEL_FACTUUR} -label:${LABEL_VERWERKT} after:${afterDate}`;
  if (options.verbose) console.log(`  Query: ${processQuery}`);

  const toProcess = await searchMessages(gmail, processQuery);
  console.log(`  Found ${toProcess.length} email(s) with label '${LABEL_FACTUUR}' to process.`);

  const result: ScanResult = {
    total_found: toLabel.length,
    labeled: options.dryRun ? toLabel.length : toLabel.length,
    processed: 0,
    skipped: 0,
    dry_run: options.dryRun,
  };

  for (const messageId of toProcess) {
    let message: gmail_v1.Schema$Message;
    try {
      message = await getMessageDetails(gmail, messageId);
    } catch (err) {
      console.error(`  Error fetching message ${messageId}: ${err}`);
      result.skipped++;
      continue;
    }

    const subject = getMessageSubject(message);
    const domain = getSenderDomain(message);
    const date = getMessageDate(message);

    if (!domain || !date) {
      if (options.verbose) console.log(`  Skip ${messageId}: could not determine domain or date`);
      result.skipped++;
      continue;
    }

    // Check if domain is trusted
    const isTrusted = config.trusted_domains.some(
      (d) => domain === d.toLowerCase() || domain.endsWith(`.${d.toLowerCase()}`)
    );

    if (!isTrusted) {
      if (options.verbose) console.log(`  Skip: ${domain} not in trusted_domains — "${subject}"`);
      result.skipped++;
      continue;
    }

    // Determine output quarter folder
    const quarter = getQuarterForDate(date);
    const outputDir = join(config.output_base, quarter.label);
    const filename = buildPdfFilename(subject, domain, date);
    const outputPath = join(outputDir, filename);

    console.log(`  → ${domain} | ${quarter.label} | "${subject}"`);

    if (options.dryRun) {
      console.log(`    [Dry run] Would save: ${outputPath}`);
      result.processed++;
      continue;
    }

    // Ensure output directory exists
    ensureOutputDir(outputDir);

    // Check for PDF attachment
    const pdfPart = findPdfAttachment(message);

    try {
      if (pdfPart) {
        // Download existing PDF attachment
        await downloadPdfAttachment(gmail, messageId, pdfPart, outputPath);
        console.log(`    ✓ Downloaded PDF → ${outputPath}`);
      } else {
        // No PDF — render HTML body to PDF via Puppeteer
        const html = extractHtmlBody(message);
        if (!html) {
          console.log(`    Skip: no HTML body found for ${messageId}`);
          result.skipped++;
          continue;
        }
        await htmlToPdf(html, outputPath);
        console.log(`    ✓ Generated PDF → ${outputPath}`);
      }

      // Update labels: remove 'factuur', add 'Verwerkt'
      await modifyMessageLabels(gmail, messageId, [labelVerwerktId], [labelFactuurId]);
      console.log(`    ✓ Labels updated: -factuur +Verwerkt`);

      result.processed++;
    } catch (err) {
      console.error(`    Error processing ${messageId}: ${err}`);
      result.skipped++;
    }

    // Small delay to avoid Gmail rate limits
    await Bun.sleep(200);
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  console.log('\n── Summary ─────────────────────────────────────────────');
  console.log(`  New invoices labeled : ${result.labeled}`);
  console.log(`  PDFs saved           : ${result.processed}`);
  console.log(`  Skipped              : ${result.skipped}`);
  if (options.dryRun) console.log('  Mode                 : DRY RUN (no changes made)');
  console.log('────────────────────────────────────────────────────────\n');

  console.log(JSON.stringify(result, null, 2));
}

async function cmdStatus(): Promise<void> {
  const tokens = loadTokens();
  const config = loadConfig();
  const now = new Date();
  const currentQ = getQuarter(now);
  const prevQ = getPreviousQuarter(currentQ);

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

  console.log(`Current scope  : ${prevQ.label} + ${currentQ.label}`);
  console.log(`Output base    : ${config.output_base}`);
  console.log(`Trusted domains: ${config.trusted_domains.length === 0 ? '(none configured)' : config.trusted_domains.join(', ')}`);

  try {
    const auth = await getAuthenticatedClient();
    const gmail = google.gmail({ version: 'v1', auth });
    const { data } = await gmail.users.labels.list({ userId: 'me' });
    const labels = data.labels ?? [];

    for (const name of [LABEL_FACTUUR, LABEL_VERWERKT]) {
      const found = labels.find((l) => l.name?.toLowerCase() === name.toLowerCase());
      console.log(`Label '${name}' : ${found ? 'exists' : 'will be created on first scan'}`);
    }
  } catch (err) {
    console.log(`Gmail API      : Connection error — ${err}`);
  }

  console.log('');
}

async function cmdConfig(): Promise<void> {
  const config = loadConfig();
  console.log('\nCurrent config:\n');
  console.log(JSON.stringify(config, null, 2));
  console.log(`\nEdit: ${CONFIG_PATH}\n`);
}

// ============================================================================
// Help & Version
// ============================================================================

function showHelp(): void {
  console.log(`
factuur-labeler - Gmail Invoice Label & Archiver
================================================

Scans Gmail for invoices in the current and previous quarter,
labels them as 'factuur', and saves PDFs for trusted senders.

USAGE:
  factuur-labeler <command> [options]

COMMANDS:
  auth                    Authenticate with Gmail (run once; on Mac for VMs)
  scan                    Label invoices and save PDFs
  scan --dry-run          Preview actions without making any changes
  scan --verbose          Show query details and per-message decisions
  status                  Show auth status, config, and label info
  config                  Show current config and config file path
  help, --help, -h        Show this help
  version, --version, -v  Show version

WORKFLOW:
  Step 1 — Labels new invoice emails as 'factuur' (keyword/attachment scan)
  Step 2 — For each 'factuur' email from a trusted domain:
             • Has PDF attachment? → download it
             • No PDF? → render HTML to PDF via Puppeteer
             → Save to output_base/<YYYY>Q<Q>/
             → Remove 'factuur' label, add 'Verwerkt' label

SCOPE:
  Only processes emails from the current and previous quarter.
  Emails already labelled 'Verwerkt' are always skipped.

CONFIGURATION:
  Config file : ~/.config/factuur-labeler/config.json
  Example:
    {
      "output_base": "/path/to/Facturen_IN",
      "trusted_domains": ["apple.com", "google.com", "exact.nl"]
    }

LINUX VM SETUP:
  1. Run 'factuur-labeler auth' on your Mac
  2. Copy ~/.config/factuur-labeler/tokens.json to the VM
  3. Install puppeteer: bun add puppeteer
  4. Install Chrome: bunx puppeteer browsers install chrome

Version: 2.0.0
`);
}

function showVersion(): void {
  console.log('factuur-labeler version 2.0.0');
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0] ?? 'help';

  if (['help', '--help', '-h'].includes(cmd)) { showHelp(); return; }
  if (['version', '--version', '-v'].includes(cmd)) { showVersion(); return; }

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
    case 'config':
      await cmdConfig();
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
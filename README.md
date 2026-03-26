# factuur-labeler

Gmail tool dat automatisch factuur-emails opspoort en voorziet van het label **`factuur`**.

Detecteert:
- PDF-bijlagen met termen als `factuur`, `invoice`, `rekening`, `nota`, `BTW`
- Onderwerpen met factuur-gerelateerde trefwoorden (NL + EN)

---

## Vereisten

- [Bun](https://bun.sh) runtime
- Een Google-account met Gmail
- Toegang tot [Google Cloud Console](https://console.cloud.google.com/)

---

## Installatie

### 1. Repository klonen en dependencies installeren

```bash
git clone <repo-url>
cd factuur-labeler
bun install
```

### 2. Google Cloud instellen (eenmalig)

1. Ga naar [console.cloud.google.com](https://console.cloud.google.com/)
2. Maak een nieuw project aan (of selecteer een bestaand project)
3. Ga naar **APIs & Services → Library** → zoek op `Gmail API` → klik **Enable**
4. Ga naar **APIs & Services → Credentials** → klik **Create Credentials → OAuth 2.0 Client ID**
5. Kies applicatietype: **Desktop app**
6. Download het JSON-bestand

### 3. Credentials opslaan

**Optie A — credentials.json (aanbevolen)**

```bash
mkdir -p ~/.config/factuur-labeler
cp ~/Downloads/client_secret_*.json ~/.config/factuur-labeler/credentials.json
```

**Optie B — omgevingsvariabelen**

Kopieer `.env.example` naar `.env` en vul je gegevens in:

```bash
cp .env.example .env
```

```env
GMAIL_CLIENT_ID=jouw_client_id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=jouw_client_secret
```

### 4. Authenticeren

```bash
bun run factuur-labeler.ts auth
```

Je browser opent automatisch. Keur de Gmail-toegang goed. Tokens worden opgeslagen in `~/.config/factuur-labeler/tokens.json`.

---

## Gebruik

```bash
# Bekijk welke emails gelabeld zouden worden (geen wijzigingen)
bun run factuur-labeler.ts scan --dry-run

# Label alle factuur-emails
bun run factuur-labeler.ts scan

# Toon auth-status en labelinfo
bun run factuur-labeler.ts status

# Uitgebreide output met zoekopdrachten
bun run factuur-labeler.ts scan --verbose
```

Of via de package scripts:

```bash
bun run dry-run    # scan --dry-run
bun run scan       # scan
bun run status     # status
bun run auth       # auth
```

---

## Hoe het werkt

De tool voert twee Gmail-zoekopdrachten uit en dedupliceert de resultaten:

1. **PDF-bijlagen** met termen: `factuur`, `invoice`, `rekening`, `nota`, `BTW`, `receipt`, `order`, `bestelling`
2. **Onderwerp** met termen: `factuur`, `invoice`, `rekening`, `nota`, `uw factuur`, `your invoice`, `pro forma`

Emails die al het label `factuur` hebben worden overgeslagen. Veilig om meerdere keren te draaien.

---

## Bestandslocaties

| Bestand | Locatie |
|---|---|
| Credentials | `~/.config/factuur-labeler/credentials.json` |
| OAuth tokens | `~/.config/factuur-labeler/tokens.json` |

---

## Output

Stdout geeft JSON terug met het resultaat. Statusberichten gaan naar stderr.

```json
{
  "total_found": 42,
  "labeled": 42,
  "message_ids": ["..."],
  "dry_run": false
}
```

Exit code `0` bij succes, `1` bij fout.

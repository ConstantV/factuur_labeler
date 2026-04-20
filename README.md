# factuur-labeler

Gmail tool dat automatisch factuur-emails opspoort, labelt en als PDF archiveert per kwartaal.

**Wat het doet:**
1. Scant Gmail op factuur-emails (huidig + vorig kwartaal)
2. Labelt matches als `factuur`
3. Voor afzenders in je `trusted_domains`: downloadt de PDF-bijlage of genereert een PDF van de mail
4. Slaat de PDF op in een kwartaalmap (`2026Q2/`)
5. Vervangt het label `factuur` door `Verwerkt`

Emails met het label `Verwerkt` worden altijd overgeslagen. Veilig om meerdere keren te draaien.

---

## Vereisten

- [Bun](https://bun.sh) runtime
- Een Google-account met Gmail
- Toegang tot [Google Cloud Console](https://console.cloud.google.com/)
- Puppeteer (voor HTML→PDF bij mails zonder bijlage)

---

## Installatie

### 1. Repository klonen en dependencies installeren

```bash
git clone <repo-url>
cd factuur-labeler
bun install
bun add puppeteer
```

**Op Linux (VM zonder GUI):** installeer ook Chrome voor Puppeteer:
```bash
bunx puppeteer browsers install chrome
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

```env
GMAIL_CLIENT_ID=jouw_client_id.apps.googleusercontent.com
GMAIL_CLIENT_SECRET=jouw_client_secret
```

### 4. Authenticeren

```bash
bun run factuur-labeler.ts auth
```

Je browser opent automatisch. Keur de Gmail-toegang goed. Tokens worden opgeslagen in `~/.config/factuur-labeler/tokens.json`.

> **Linux VM (headless):** voer `auth` eenmalig uit op je Mac, kopieer daarna
> `~/.config/factuur-labeler/tokens.json` naar hetzelfde pad op de VM.

### 5. Config instellen

Bij de eerste `scan` of `config` wordt automatisch een config aangemaakt:

```bash
bun run factuur-labeler.ts config
```

Pas `~/.config/factuur-labeler/config.json` aan:

```json
{
  "output_base": "/pad/naar/Facturen_IN",
  "trusted_domains": [
    "apple.com",
    "google.com",
    "exact.nl",
    "jouwleverancier.nl"
  ]
}
```

| Veld | Omschrijving |
|---|---|
| `output_base` | Basismap voor kwartaalmappen (`2026Q2/` etc.) |
| `trusted_domains` | Domeinen waarvan PDFs worden opgeslagen |

---

## Gebruik

```bash
# Bekijk config en config-pad
bun run factuur-labeler.ts config

# Toon auth-status, labels en scope
bun run factuur-labeler.ts status

# Dry run — geen wijzigingen, wel volledige output
bun run factuur-labeler.ts scan --dry-run

# Dry run met detailinformatie per mail
bun run factuur-labeler.ts scan --dry-run --verbose

# Verwerk facturen (labelen + PDF opslaan)
bun run factuur-labeler.ts scan

# Herautenticeren (bijv. na verlopen token)
bun run factuur-labeler.ts auth
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

### Scope
Alleen emails van het **huidige en vorige kwartaal** worden verwerkt.
Emails met label `Verwerkt` worden altijd overgeslagen.

### Stap 1 — Labelen
De tool voert twee Gmail-zoekopdrachten uit en dedupliceert de resultaten:

1. **PDF-bijlagen** met termen: `factuur`, `invoice`, `rekening`, `nota`, `BTW`, `receipt`, `order`, `bestelling`
2. **Onderwerp** met termen: `factuur`, `invoice`, `rekening`, `nota`, `uw factuur`, `your invoice`, `pro forma`

Matches krijgen het label `factuur`.

### Stap 2 — Archiveren
Voor elke mail met label `factuur` (maar nog niet `Verwerkt`):

- Staat het afzenderdomein in `trusted_domains`?
  - **Ja + PDF-bijlage** → bijlage downloaden
  - **Ja + geen PDF** → HTML van de mail renderen naar PDF via Puppeteer
  - **Nee** → overslaan (behoudt label `factuur`)
- PDF opslaan in `output_base/<YYYY>Q<Q>/YYYY-MM-DD_domein_onderwerp.pdf`
- Label wisselen: `factuur` verwijderen, `Verwerkt` toevoegen

### Labels in Gmail

| Label | Betekenis |
|---|---|
| `factuur` | Herkend als factuur, nog niet gearchiveerd |
| `Verwerkt` | PDF opgeslagen, klaar |

---

## Bestandslocaties

| Bestand | Locatie |
|---|---|
| Credentials | `~/.config/factuur-labeler/credentials.json` |
| OAuth tokens | `~/.config/factuur-labeler/tokens.json` |
| Config | `~/.config/factuur-labeler/config.json` |

---

## Output

Stdout geeft JSON terug met het resultaat. Statusberichten gaan naar stderr.

```json
{
  "total_found": 12,
  "labeled": 8,
  "processed": 6,
  "skipped": 2,
  "dry_run": false
}
```

Exit code `0` bij succes, `1` bij fout.

---

## Automatisch draaien (cron / systemd)

**macOS — launchd (elk uur):**
```bash
# ~/Library/LaunchAgents/nl.factuur-labeler.plist
# Zie QUICKSTART.md voor volledig voorbeeld
```

**Linux VM — cron (elk uur):**
```bash
0 * * * * cd /pad/naar/factuur-labeler && bun run factuur-labeler.ts scan >> /var/log/factuur-labeler.log 2>&1
```

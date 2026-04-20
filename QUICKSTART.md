# factuur-labeler Quick Start

## Stap 1 — Dependencies installeren

```bash
cd factuur-labeler
bun install
bun add puppeteer
```

**Op Linux VM (headless):** installeer ook Chrome:
```bash
bunx puppeteer browsers install chrome
```

## Stap 2 — Google Cloud instellen (eenmalig)

1. Ga naar [Google Cloud Console](https://console.cloud.google.com/)
2. Maak een project aan (of selecteer bestaand)
3. **APIs & Services → Library** → zoek "Gmail API" → Enable
4. **APIs & Services → Credentials** → Create Credentials → OAuth 2.0 Client ID
5. Applicatietype: **Desktop app**
6. Download JSON → sla op als `~/.config/factuur-labeler/credentials.json`

> Of stel env vars in: `GMAIL_CLIENT_ID` + `GMAIL_CLIENT_SECRET`

## Stap 3 — Authenticeren

```bash
bun run factuur-labeler.ts auth
```

Browser opent automatisch. Keur Gmail-toegang goed. Klaar.

> **Linux VM:** voer dit eenmalig uit op je Mac, kopieer daarna
> `~/.config/factuur-labeler/tokens.json` naar de VM.

## Stap 4 — Config instellen

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
    "jouwleverancier.nl"
  ]
}
```

## Stap 5 — Dry run (veilige preview)

```bash
bun run factuur-labeler.ts scan --dry-run --verbose
```

Zie precies wat er zou gebeuren — geen wijzigingen in Gmail, geen bestanden opgeslagen.

## Stap 6 — Verwerken

```bash
bun run factuur-labeler.ts scan
```

- Nieuwe factuur-emails krijgen label `factuur`
- Emails van `trusted_domains` → PDF opgeslagen in kwartaalmap
- Label gewisseld naar `Verwerkt`

## Nogmaals draaien

Emails met label `Verwerkt` worden altijd overgeslagen. Veilig om zo vaak te draaien als je wilt.

---

## Handige commando's

```bash
bun run factuur-labeler.ts status        # auth-status + labelinfo
bun run factuur-labeler.ts scan --verbose # gedetailleerde output
bun run factuur-labeler.ts config        # toon config-pad en inhoud
```

---

## Mapstructuur output

```
output_base/
├── 2026Q1/
│   ├── 2026-01-15_apple.com_Uw_aankoop.pdf
│   └── 2026-03-02_exact.nl_Factuur_maart.pdf
└── 2026Q2/
    └── 2026-04-20_google.com_Google_One.pdf
```

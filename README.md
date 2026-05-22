# Vitnas AI — Sovereign Partner

Unified AI chat interface with intent routing, vault integration, and BYOK.

## Files

```
index.html          — Chat interface
vitnas-ai.css       — Styles
vitnas-ai.js        — Intent detection, routing, API calls, vault, persona key
transparency.html   — Monthly transparency report
api-key-guide.html  — Plain-language API key guide
vercel.json         — Routing config
api/
  relay.js          — Server-side AI API relay (Anthropic, OpenAI, Google)
  dfbss.js          — DFBSS benchmark endpoint
```

## Deploy to Vercel

```bash
vercel --prod
```

## Environment Variables (set in Vercel dashboard)

| Variable | Description |
|---|---|
| `VITNAS_FREE_KEY` | Google AI API key for free tier users |
| `VITNAS_FREE_MODEL` | Model for free tier (default: gemini-1.5-flash) |

## Intent Keywords

| User types | Module triggered |
|---|---|
| audit | Delta-First audit → Railway backend |
| save | Witness Vault save → Supabase |
| load | Witness Vault load → Supabase |
| strategy | StrategOS → AI model |
| benchmark | DFBSS → /api/dfbss |
| remember me | Persona Key modal |
| anything else | Direct AI chat → /api/relay |

## BYOK

User pastes their API key in the toolbar. Stored in localStorage only. Never sent to Vitnas servers — passed directly to the relay which forwards to the provider.

## Free Tier

10 requests/day per device (localStorage). Uses `VITNAS_FREE_KEY` env variable with `gemini-1.5-flash`.

## Security

- User API keys: localStorage only, never logged
- Relay: no logging, no storage, forwards and returns
- Vault: requires Witness Vault login (vitnas.org/login)
- Persona Key: localStorage only, downloadable as JSON

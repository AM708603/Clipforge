# ✂️ ClipForge — YouTube Podcast to Shorts

**100% Free. No credit card. No server to manage.**

AI finds the best moments in any YouTube podcast, you download the clips free.

## Stack
| Layer | Service | Cost |
|---|---|---|
| Frontend | Netlify | Free |
| Backend / AI | Cloudflare Worker + Gemini Flash | Free |
| Video Download | cobalt.tools | Free |

## Folder Structure
```
clipforge/
├── frontend/           → Deploy on Netlify
│   ├── index.html
│   └── netlify.toml
├── worker/             → Deploy on Cloudflare Workers
│   ├── index.js
│   └── wrangler.toml
└── DEPLOY_GUIDE.html   → Open this for full step-by-step guide
```

## Quick Start
1. Open `DEPLOY_GUIDE.html` — it has full visual instructions
2. Get free Gemini API key: https://aistudio.google.com/app/apikey
3. Deploy `worker/index.js` to Cloudflare Workers (free account)
4. Add `GEMINI_API_KEY` as a secret in the Worker settings
5. Update `API` URL in `frontend/index.html`
6. Deploy `frontend/` on Netlify

# QuickPredict landing page

A static marketing site for the QuickPredict Telegram bot. No build step, no
dependencies — just three files (`index.html`, `styles.css`, `script.js`).

## Preview locally

Open `index.html` directly in a browser, or serve the folder:

```bash
# from the web/ directory
python3 -m http.server 8080
# → http://localhost:8080
```

## Configure the bot link

Every “Open in Telegram” button points to `https://t.me/QuickPredictBot`.
Search-and-replace that URL in `index.html` with your real bot username (from
[@BotFather](https://t.me/BotFather)). It appears 3 times.

## Deploy

Because it’s static, it deploys anywhere for free:

### GitHub Pages
1. Push the `web/` folder to your repo.
2. Repo **Settings → Pages → Source**: `Deploy from a branch`, branch `main`,
   folder `/web`. Save.
3. Your site goes live at `https://<user>.github.io/QuickPredict/`.

### Cloudflare Pages / Netlify / Vercel
1. New project → connect the repo.
2. Build command: *(none)*. Output directory: `web`.
3. Deploy.

## What’s on the page

- Hero with a mock Telegram trade-preview bubble (recreates the PRD format)
- Problem → features grid → 3-step “how it works”
- Full command reference (tap a row to copy)
- Security architecture section (AES-256-GCM, PBKDF2, short-lived signing)
- Footer with links to GitHub, PRD, and deploy guide

The visual style is a white and green editorial treatment with restrained
cards, dense command references, and the same plain-English command glossary as
the bot.

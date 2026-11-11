# Kayline — blood pressure tracker

A private, no-account blood pressure tracker that works out your **true baseline**. Installable as an app (PWA) and works offline.

- Log readings with context: arm, position, 2–3 readings averaged, and tap-to-select conditions (caffeine, exercise, stress, poor sleep, …)
- Only standard-condition readings (seated, no stimulants) feed your baseline; everything else is compared against it
- Today, Trends and Insights views: baseline with confidence ring, 7-day goal strip, trend charts (7d / 30d / 90d / all), pulse, category breakdown, "what moves your numbers", highlights
- **Optional Claude AI** (bring your own Anthropic API key): a written report and a chat about your readings
- Light and dark mode, mobile-first, accessible table view, reduced-motion support
- **Your data never leaves your device.** Readings live in your browser's localStorage. Export and import JSON or CSV for backups.

Plain HTML, CSS and JavaScript. No build step, no dependencies.

## Privacy and the AI feature
The AI feature is off until you add a key in Settings and accept a disclosure. When you tap Generate or Send, a summary of your readings (dates, numbers, arm, position, context tags; notes only if you opt in) is sent from your browser directly to `api.anthropic.com` with your key. There is no Kayline server. The key is stored in your browser (or kept for the session if you turn off "Remember key"). Use a key with a low spend limit.

## Run locally
Serve the folder (a service worker needs http): `python -m http.server`, then open http://localhost:8000.

## Deploy
GitHub Pages: Settings → Pages → Deploy from branch `main` / root. For a custom subdomain, add a `CNAME` file containing the hostname and a DNS CNAME record pointing to `<user>.github.io`.

## Files
`index.html` shell · `styles.css` design tokens and components · `app.js` data, analytics, views · `ai.js` optional Claude features · `sw.js` offline cache · `manifest.webmanifest` + `icons/` for install

## Disclaimer
Not a medical device and not medical advice. Categories follow the AHA/ACC guideline (unchanged in 2025).

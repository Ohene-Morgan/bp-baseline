# Baseline — blood pressure tracker

A private, no-account blood pressure tracker that works out your **true baseline**.

- Log readings with context: arm, position, 2–3 readings averaged, and tap-to-select conditions (caffeine, exercise, stress, poor sleep, …)
- Only standard-condition readings (seated, no stimulants) feed your baseline; everything else is compared against it
- Dashboard: baseline ± range with confidence, trend chart (7d / 30d / 90d / all), pulse, category breakdown, "what moves your numbers", weekly insights
- Dark mode, mobile-first, accessible table view
- **Your data never leaves your device.** Readings live in your browser's localStorage. Export / import JSON and CSV for backups.

Plain HTML, CSS and JavaScript. No build step, no dependencies, no network calls.

## Run locally
Open `index.html`, or serve the folder: `python -m http.server`.

## Deploy
GitHub Pages: Settings → Pages → Deploy from branch `main` / root. For a custom subdomain, add a `CNAME` file containing the hostname and a DNS CNAME record pointing to `<user>.github.io`.

## Disclaimer
Not a medical device and not medical advice. Categories follow the AHA/ACC guideline (unchanged in 2025).

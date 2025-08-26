# COL Territory Suite

Progressive Web App (PWA) for sales and service.

## Structure
- index.html (home)
- map.html (interactive rep/shop map)
- service.html (service request form)
- manifest.json + service-worker.js (PWA install/offline)
- assets/logo.png
- icons/icon-192.png, icon-512.png
- data/ (all datasets)
- netlify.toml
- netlify/functions/send-quote.js + package.json (serverless email PDF)

## Deploy
1. Push to GitHub
2. Connect repo to Netlify (set Publish dir = ., Functions dir = netlify/functions)
3. Add SMTP_* environment variables for email.

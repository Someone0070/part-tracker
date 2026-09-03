# Part Tracker

Appliance parts tracking web app for repair business + eBay reselling.

## Stack

- **Frontend:** React, TypeScript, Tailwind CSS, Vite
- **Backend:** Express, TypeScript, Drizzle ORM, PostgreSQL
- **AI:** Qwen 3.5 via OpenRouter -- adaptive template learning for invoice parsing
- **Deploy:** Railway (backend + DB), Cloudflare Pages (frontend)

## Setup

```bash
# Backend
cd backend
cp .env.example .env   # fill in DATABASE_URL, OPENROUTER_API_KEY, etc.
npm install
npm run dev

# Frontend
cd frontend
npm install
npm run dev
```

## Features

- Part inventory with search, quantities, and eBay listing tracking
- PDF invoice import with adaptive template learning (learns vendor formats, reuses regex templates)
- URL import with headless browser scraping
- Cross-reference lookups for interchangeable part numbers
- eBay integration for listing sync and sold-item depletion
- Appliance tracking with photo uploads to R2

## Image ingestion

Part-label and appliance-label scans are converted in the browser to an
orientation-corrected, bounded JPEG and uploaded as multipart binary data. The
backend independently validates and normalizes the bytes before calling OCR or
R2. Failed network requests retain the selected photo and can be retried.

Persistent appliance photos are enabled automatically when all four `R2_*`
variables in `backend/.env.example` are configured. OCR requires `ZAI_API_KEY`.

Image attempts are recorded without filenames or image bytes. Authenticated
upload-health counts are available from:

```text
GET /api/settings/image-attempts/summary?days=7
```

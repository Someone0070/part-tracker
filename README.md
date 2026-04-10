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

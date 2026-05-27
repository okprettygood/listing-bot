# Listing Bot

AI-powered resale listing generator with Facebook Marketplace auto-publishing.

## What it does

- Snap photos of an item
- AI generates title, description, and price using Claude vision
- Pulls market comps from OfferUp and Facebook Marketplace
- Auto-fills Facebook Marketplace listing form
- You review and publish with one click

## Setup

1. Clone the repo
2. `npm install`
3. `npx playwright install chromium`
4. Copy `.env.example` to `.env.local` and add your Anthropic API key
5. Run: `npx tsx scripts/fb-login.ts` (one-time FB session setup)
6. `npm run dev`
7. Open http://localhost:3000

## Requirements

- Node 20+
- Anthropic API key (console.anthropic.com)

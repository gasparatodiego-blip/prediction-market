This is a [Next.js](https://nextjs.org/) project bootstrapped with [`create-next-app`](https://github.com/vercel/next.js/tree/canary/packages/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/basic-features/font-optimization) to automatically optimize and load Inter, a custom Google Font.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js/) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/deployment) for more details.

## Sports Arbitrage Scanner (agent12-sports.js)

`agents/agent12-sports.js` is a **one-shot snapshot scanner** — it runs, writes results, and exits. It is **not** in PM2 autostart.

### Scheduled via system crontab (UTC)

```
0 6  * * *   node /root/prediction-market/agents/agent12-sports.js
0 18 * * *   node /root/prediction-market/agents/agent12-sports.js
```

Both runs append stdout+stderr to `logs/sports-cron.log` with a timestamp header per run.

### Budget guards

- **Per-scan floor** (`CREDIT_SAFETY_FLOOR = 30`): stops mid-scan if remaining credits would hit the floor.
- **Monthly floor** (same threshold): checked at startup before any HTTP call — if `data/sports/credits.json` shows `remaining ≤ 30`, the run exits immediately without spending any credits. The cron becomes a no-op until credits reset at the start of the next billing cycle.

OddsAPI key: read from `.env.local` (`ODDS_API_KEY`). Never hardcoded.

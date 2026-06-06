# Launch Checklist — PredMarket Scanner v1.0.0

## Infrastructure
- [ ] Domain purchased and DNS A record pointed to server IP (167.233.63.218)
- [ ] SSL certificate installed: `certbot --nginx -d yourdomain.com`
- [ ] Nginx config live: `/etc/nginx/sites-enabled/predmarket` ✅
- [ ] Nginx proxying port 80 → localhost:3000 ✅

## Environment
- [ ] `DATABASE_URL` set in `.env` ✅
- [ ] `NEXTAUTH_SECRET` set in `.env` ✅
- [ ] `NEXTAUTH_URL` updated to production domain (currently localhost:3000)
- [ ] `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` set for Google OAuth (optional)
- [ ] `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` set ✅
- [ ] All secrets kept out of git (`.env` in `.gitignore`) ✅

## Database
- [ ] PostgreSQL running ✅
- [ ] Database `predmarket` created ✅
- [ ] Prisma migrations applied ✅
- [ ] Automated PostgreSQL backup configured (pg_dump cron)

## PM2 Processes
- [ ] `dashboard` online ✅
- [ ] `agent-kalshi` online ✅
- [ ] `agent-polymarket` online ✅
- [ ] `agent-manifold` online ✅
- [ ] `agent-predictit` online ✅
- [ ] `agent-metaculus` online ✅
- [ ] `agent-master` online ✅
- [ ] `agent-monitor` online ✅
- [ ] `agent-marketmaker` online ✅
- [ ] `agent-liquidity` online ✅
- [ ] `agent10-binance` online ✅
- [ ] All 11 processes stable for 24h

## Application
- [ ] Landing page live at `/` ✅
- [ ] Dashboard accessible at `/dashboard` ✅
- [ ] User registration working at `/auth/register` ✅
- [ ] User login working at `/auth/login` ✅
- [ ] Portfolio tracker working at `/dashboard/portfolio` ✅
- [ ] Preferences page working at `/dashboard/preferences` ✅
- [ ] Telegram alerts working ✅

## Security
- [ ] Security headers via next.config.mjs ✅
- [ ] Rate limiting (100 req/min per IP) via middleware ✅
- [ ] Input validation with zod on all user API routes ✅
- [ ] No secrets committed to git ✅

## Post-Launch
- [ ] Update `NEXTAUTH_URL` to production domain
- [ ] Configure Google OAuth redirect URIs for production domain
- [ ] Set up monitoring/alerting
- [ ] Test registration → login → portfolio flow end-to-end

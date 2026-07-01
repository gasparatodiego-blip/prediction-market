#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

// ── Load .env (pm2 doesn't auto-load project env files) ────────────────────
// Read every candidate file (don't stop at the first one that merely exists —
// .env.local exists but only carries ODDS_API_KEY; TELEGRAM_* live in .env).
for (const envFile of ['.env.local', '.env']) {
  try {
    const envPath = path.join(__dirname, '..', envFile);
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z0-9_]+)="?([^"]*?)"?\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* try next */ }
}

// ===== CONFIGURAZIONE =====
const INITIAL_CAPITAL = 10000;
const SPREAD_CENTS = 2;
const ORDER_SIZE = 100;
const MAX_POSITIONS = 5;
const MAX_PER_MARKET = 2000;
const MIN_VOLUME = 5000;
const MIN_LIQUIDITY_SCORE = 60;

const HB_FILE = '/tmp/agent-heartbeats.json';
const PM_RAW = '/tmp/polymarket-raw.json';
const STATE_FILE = '/tmp/lp-poly-sim-state.json';
const TRADES_FILE = '/tmp/lp-poly-sim-trades.json';
const STATS_FILE = '/tmp/lp-poly-sim-stats.json';

const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;

let state = {
    capital: INITIAL_CAPITAL,
    usdtBalance: INITIAL_CAPITAL,
    positions: [],
    trades: [],
    totalTrades: 0,
    feesCollected: 0,
    startTime: Date.now()
};

function beat() {
    let hb = {};
    try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
    hb['agent-lp-poly-sim'] = Date.now();
    fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

function sendTelegram(text) {
    if (process.env.TELEGRAM_ALERTS_ENABLED === 'false') return;
    const body = JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' });
    const req = https.request({
        hostname: 'api.telegram.org',
        path: `/bot${TG_TOKEN}/sendMessage`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
    });
    req.on('error', () => {});
    req.write(body);
    req.end();
}

function readJson(path) {
    try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function writeJson(path, data) {
    try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } catch {}
}

function loadState() {
    try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        state = { ...state, ...data };
        console.log('[LP-SIM] Stato caricato');
    } catch {
        console.log('[LP-SIM] Nuova simulazione avviata');
    }
}

function saveState() {
    writeJson(STATE_FILE, {
        ...state,
        lastSaved: Date.now()
    });
    writeJson(TRADES_FILE, { trades: state.trades.slice(-200) });
}

function calculateLiquidityScore(market) {
    let score = 0;
    
    const volume = Number(market.volume24hr || market.volume || 0);
    if (volume >= 50000) score += 40;
    else if (volume >= 20000) score += 30;
    else if (volume >= MIN_VOLUME) score += 20;
    else return 0;
    
    let price = null;
    try {
        const prices = typeof market.outcomePrices === 'string' 
            ? JSON.parse(market.outcomePrices) 
            : market.outcomePrices;
        if (Array.isArray(prices) && prices[0]) {
            price = parseFloat(prices[0]) * 100;
        }
    } catch {}
    
    if (price) {
        const distanceFrom50 = Math.abs(price - 50);
        if (distanceFrom50 < 10) score += 35;
        else if (distanceFrom50 < 20) score += 20;
        else if (distanceFrom50 < 30) score += 10;
    }
    
    if (market.active) score += 10;
    if (market.closed === false) score += 5;
    
    return Math.min(score, 100);
}

function findBestMarkets(polymarketData) {
    const candidates = [];
    if (!polymarketData?.markets) return candidates;
    
    for (const market of polymarketData.markets) {
        const score = calculateLiquidityScore(market);
        if (score < MIN_LIQUIDITY_SCORE) continue;
        
        let price = null;
        try {
            const prices = typeof market.outcomePrices === 'string' 
                ? JSON.parse(market.outcomePrices) 
                : market.outcomePrices;
            if (Array.isArray(prices) && prices[0]) {
                price = parseFloat(prices[0]) * 100;
            }
        } catch {}
        
        if (!price) continue;
        
        candidates.push({
            id: market.id,
            slug: market.slug,
            question: (market.question || '').slice(0, 80),
            price: price,
            volume24h: Number(market.volume24hr || market.volume || 0),
            liquidityScore: score,
            url: market.slug ? `https://polymarket.com/event/${market.slug}` : null
        });
    }
    
    return candidates.sort((a, b) => b.liquidityScore - a.liquidityScore);
}

function calculateProfitEstimate(market, amountUSD) {
    const dailyVolume = market.volume24h;
    const feeRate = 0.001;
    const lpShare = 0.5;
    
    const dailyFees = dailyVolume * feeRate * lpShare;
    const marketShare = amountUSD / (dailyVolume || 1);
    const estimatedDailyProfit = dailyFees * marketShare;
    const estimatedAPY = (estimatedDailyProfit / amountUSD) * 365 * 100;
    
    return {
        daily: estimatedDailyProfit,
        monthly: estimatedDailyProfit * 30,
        yearly: estimatedDailyProfit * 365,
        apy: Math.min(estimatedAPY, 500)
    };
}

async function openPosition(market, amountUSD) {
    const profitEstimate = calculateProfitEstimate(market, amountUSD);
    
    const position = {
        id: market.id,
        slug: market.slug,
        question: market.question,
        entryPrice: market.price,
        amountUSD: amountUSD,
        entryTime: Date.now(),
        status: 'active',
        volume24h: market.volume24h,
        estimatedDailyProfit: profitEstimate.daily,
        estimatedAPY: profitEstimate.apy,
        feesCollected: 0,
        lastUpdate: Date.now()
    };
    
    state.positions.push(position);
    state.usdtBalance -= amountUSD;
    state.totalTrades++;
    
    console.log(`[LP-SIM] 🟢 APERTA: ${market.question.slice(0, 50)}`);
    console.log(`[LP-SIM]    $${amountUSD} | APY: ${profitEstimate.apy.toFixed(0)}%`);
    
    sendTelegram(`🟢 LP SIM APERTA\n${market.question.slice(0, 50)}\n$${amountUSD}\nAPY: ${profitEstimate.apy.toFixed(0)}%`);
    
    saveState();
    return position;
}

async function updatePositions() {
    const now = Date.now();
    let totalFeesToday = 0;
    
    for (const pos of state.positions) {
        if (pos.status !== 'active') continue;
        
        const hoursHeld = (now - pos.entryTime) / (1000 * 3600);
        const dailyFeeRate = pos.estimatedDailyProfit / pos.amountUSD;
        const earnedFees = pos.amountUSD * dailyFeeRate * (hoursHeld / 24);
        
        pos.feesCollected = earnedFees;
        totalFeesToday += earnedFees;
        pos.lastUpdate = now;
    }
    
    state.feesCollected += totalFeesToday;
    state.usdtBalance += totalFeesToday;
    
    return totalFeesToday;
}

async function checkAndClosePositions() {
    const now = Date.now();
    const toClose = [];
    
    for (let i = 0; i < state.positions.length; i++) {
        const pos = state.positions[i];
        const hoursHeld = (now - pos.entryTime) / (1000 * 3600);
        
        if (hoursHeld >= 24 || pos.estimatedAPY < 10) {
            toClose.push(pos);
        }
    }
    
    for (const pos of toClose) {
        const pnl = pos.feesCollected;
        state.positions = state.positions.filter(p => p.id !== pos.id);
        state.usdtBalance += pos.amountUSD;
        
        console.log(`[LP-SIM] 🔴 CHIUSA: ${pos.question.slice(0, 40)} | PnL: $${pnl.toFixed(2)}`);
        sendTelegram(`🔴 LP SIM CHIUSA\n${pos.question.slice(0, 50)}\nPnL: $${pnl.toFixed(2)}`);
    }
}

async function scanAndOpenPositions() {
    const polymarketData = readJson(PM_RAW);
    if (!polymarketData) {
        console.log('[LP-SIM] In attesa dati Polymarket...');
        return;
    }
    
    const bestMarkets = findBestMarkets(polymarketData);
    const activeCount = state.positions.filter(p => p.status === 'active').length;
    const availableSlots = MAX_POSITIONS - activeCount;
    
    if (availableSlots <= 0) return;
    
    let opened = 0;
    for (const market of bestMarkets) {
        if (opened >= availableSlots) break;
        
        const alreadyExists = state.positions.some(p => p.id === market.id);
        if (alreadyExists) continue;
        
        const positionSize = Math.min(MAX_PER_MARKET, state.usdtBalance / 2);
        if (positionSize < 100) break;
        
        await openPosition(market, positionSize);
        opened++;
        await new Promise(r => setTimeout(r, 1000));
    }
}

function calculateStats() {
    const totalExposure = state.positions.reduce((s, p) => s + p.amountUSD, 0);
    const totalFees = state.feesCollected;
    const totalValue = state.usdtBalance + totalExposure;
    const pnl = totalValue - INITIAL_CAPITAL;
    const roi = (pnl / INITIAL_CAPITAL) * 100;
    const runtime = (Date.now() - state.startTime) / 1000 / 3600;
    const hourlyReturn = runtime > 0 ? roi / runtime : 0;
    
    const avgAPY = state.positions.length > 0 
        ? state.positions.reduce((s, p) => s + p.estimatedAPY, 0) / state.positions.length 
        : 0;
    
    return {
        timestamp: Date.now(),
        totalValue: Math.round(totalValue),
        pnl: Math.round(pnl),
        roi: roi.toFixed(2),
        hourlyReturn: hourlyReturn.toFixed(2),
        activePositions: state.positions.length,
        totalExposure: Math.round(totalExposure),
        totalFeesCollected: Math.round(totalFees),
        avgAPY: Math.round(avgAPY),
        usdtBalance: Math.round(state.usdtBalance),
        capitalLeft: Math.round(state.usdtBalance),
        runtime: runtime.toFixed(1)
    };
}

async function run() {
    console.log(`[LP-SIM] Scan @ ${new Date().toISOString()}`);
    beat();
    
    await updatePositions();
    await checkAndClosePositions();
    await scanAndOpenPositions();
    
    const stats = calculateStats();
    writeJson(STATS_FILE, stats);
    saveState();
    
    console.log(`[LP-SIM] 📊 Value: $${stats.totalValue} | PnL: $${stats.pnl} (${stats.roi}%) | Active: ${stats.activePositions}`);
}

async function tick() {
    try { await run(); } catch (e) { console.error('[LP-SIM] error:', e.message); }
    setTimeout(tick, 5 * 60 * 1000);
}

console.log(`[LP-SIM] 🏦 Polymarket LP Simulator v1.1`);
console.log(`[LP-SIM] Capitale iniziale: $${INITIAL_CAPITAL.toLocaleString()}`);
console.log(`[LP-SIM] Max posizioni: ${MAX_POSITIONS} | Max per mercato: $${MAX_PER_MARKET}`);

loadState();
tick();

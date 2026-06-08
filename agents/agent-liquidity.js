#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');

// ===== CONFIGURAZIONE =====
const DRY_RUN = true;

const TG_TOKEN = '8920675182:AAExM7SaLI-t7j3_QgkfGb46MqEJkHRlmJ4';
const TG_CHAT = '8844610430';
const HB_FILE = '/tmp/agent-heartbeats.json';
const PM_RAW = '/tmp/polymarket-raw.json';

const POSITIONS_FILE = '/tmp/liquidity-positions.json';
const HISTORY_FILE = '/tmp/liquidity-history.json';

const INTERVAL_MS = 5 * 60 * 1000;
const MAX_POSITIONS = 5;
const MAX_PER_MARKET = 2000;
const MAX_TOTAL_EXPOSURE = 10000;
const VOLUME_THRESHOLD = 10000;
const MIN_LP_APY = 15;
const PRICE_RANGE = [35, 65];

function beat() {
    let hb = {};
    try { hb = JSON.parse(fs.readFileSync(HB_FILE, 'utf8')); } catch {}
    hb['agent-liquidity'] = Date.now();
    fs.writeFileSync(HB_FILE, JSON.stringify(hb, null, 2));
}

function sendTelegram(text) {
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

function calculateLPAPY(volume24h, notionalUSD) {
    let vol = Number(volume24h) || 0;
    let notional = Number(notionalUSD) || 0;
    if (vol <= 0 || notional <= 0) return 0;
    const dailyFees = vol * 0.001 * 0.5;
    const dailyReturn = dailyFees / notional;
    return Math.min(dailyReturn * 365 * 100, 200);
}

function findBestLPMarkets(polymarketData) {
    const candidates = [];
    if (!polymarketData?.markets) return candidates;
    
    for (const market of polymarketData.markets) {
        if (!market.active) continue;
        
        let currentPrice = null;
        try {
            const prices = typeof market.outcomePrices === 'string' 
                ? JSON.parse(market.outcomePrices) 
                : market.outcomePrices;
            if (Array.isArray(prices) && prices[0]) {
                currentPrice = parseFloat(prices[0]) * 100;
            }
        } catch {}
        
        if (!currentPrice) continue;
        if (currentPrice < PRICE_RANGE[0] || currentPrice > PRICE_RANGE[1]) continue;
        
        let volume24h = Number(market.volume24hr) || Number(market.volume) || 0;
        if (volume24h < VOLUME_THRESHOLD) continue;
        
        const estimatedAPY = calculateLPAPY(volume24h, 1000);
        if (estimatedAPY < MIN_LP_APY) continue;
        
        candidates.push({
            source: 'polymarket',
            id: market.id,
            slug: market.slug,
            question: (market.question || '').slice(0, 100),
            currentPrice: currentPrice,
            volume24h: volume24h,
            estimatedAPY: estimatedAPY,
            url: market.slug ? `https://polymarket.com/event/${market.slug}` : null,
            score: estimatedAPY * (1 - Math.abs(currentPrice - 50) / 50)
        });
    }
    
    return candidates.sort((a, b) => b.score - a.score).slice(0, MAX_POSITIONS * 2);
}

function calculateOptimalPosition(market, totalCapital, existingExposure) {
    const edge = (market.estimatedAPY / 100) / 365;
    const kellyFraction = Math.min(edge, 0.25);
    const remainingCapital = Math.max(0, totalCapital - existingExposure);
    const suggestedSize = remainingCapital * kellyFraction;
    return Math.max(100, Math.min(suggestedSize, MAX_PER_MARKET, remainingCapital));
}

async function executeLPPosition(market, amountUSD) {
    console.log(`[LP] OPEN: ${(market.question || '').slice(0, 40)}... $${amountUSD}`);
    sendTelegram(`🟢 LP OPEN\n\n${(market.question || '').slice(0, 50)}\n$${amountUSD} at ${market.currentPrice}¢\nAPY: ${market.estimatedAPY.toFixed(1)}%`);
    
    return {
        marketId: market.id,
        question: market.question,
        source: market.source,
        entryPrice: market.currentPrice,
        amountUSD: amountUSD,
        estimatedAPY: market.estimatedAPY,
        volume24h: market.volume24h,
        enteredAt: Date.now(),
        status: 'active',
        feesEarned: 0
    };
}

async function run() {
    console.log(`[LP] Scan @ ${new Date().toISOString()} | DRY_RUN: ${DRY_RUN}`);
    beat();
    
    const polymarketData = readJson(PM_RAW);
    if (!polymarketData) {
        console.log(`[LP] No Polymarket data yet`);
        return;
    }
    
    const bestMarkets = findBestLPMarkets(polymarketData);
    console.log(`[LP] Found ${bestMarkets.length} candidates`);
    
    let positions = readJson(POSITIONS_FILE);
    if (!positions || !Array.isArray(positions)) {
        positions = [];
    }
    
    const totalExposure = positions.reduce((s, p) => s + (Number(p.amountUSD) || 0), 0);
    const activeCount = positions.filter(p => p.status === 'active').length;
    const remainingCapital = MAX_TOTAL_EXPOSURE - totalExposure;
    
    console.log(`[LP] Active: ${activeCount}/${MAX_POSITIONS} | Exposure: $${totalExposure} | Left: $${remainingCapital}`);
    
    if (remainingCapital > 500 && activeCount < MAX_POSITIONS && bestMarkets.length > 0) {
        const market = bestMarkets[0];
        const alreadyExists = positions.some(p => p.marketId === market.id);
        
        if (!alreadyExists) {
            const size = calculateOptimalPosition(market, MAX_TOTAL_EXPOSURE, totalExposure);
            if (size >= 100) {
                const newPos = await executeLPPosition(market, size);
                positions.push(newPos);
                writeJson(HISTORY_FILE, { trades: positions.slice(-20) });
            }
        }
    }
    
    writeJson(POSITIONS_FILE, positions);
}

async function tick() {
    try { 
        await run(); 
    } catch (e) { 
        console.error('[lp] error:', e.message); 
    }
    setTimeout(tick, INTERVAL_MS);
}

console.log('[LP] Starting v3.0 - DRY RUN Mode');
tick();

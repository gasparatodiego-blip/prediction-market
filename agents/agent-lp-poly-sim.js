#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');

const CONFIG = {
    capital: 10000,
    maxPositions: 5,
    maxPerMarket: 2000,
    minVolume: 5000,
    minAPY: 15,
    priceRange: [35, 65],
    autoRebalance: true,
    rebalanceThreshold: 3.0  // IL > 3% → rebalance
};

const TG_TOKEN = '8920675182:AAExM7SaLI-t7j3_QgkfGb46MqEJkHRlmJ4';
const TG_CHAT = '8844610430';
const PM_RAW = '/tmp/polymarket-raw.json';
const STATE_FILE = '/tmp/lp-poly-sim-state.json';
const STATS_FILE = '/tmp/lp-poly-sim-stats.json';

let state = {
    capital: CONFIG.capital,
    usdtBalance: CONFIG.capital,
    positions: [],
    trades: [],
    totalTrades: 0,
    feesCollected: 0,
    startTime: Date.now()
};

function writeJson(path, data) {
    try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } catch {}
}

function readJson(path) {
    try { return JSON.parse(fs.readFileSync(path, 'utf8')); } catch { return null; }
}

function loadState() {
    try {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        state = { ...state, ...data };
    } catch {}
}

function saveState() {
    writeJson(STATE_FILE, state);
}

function calculateLiquidityScore(market) {
    let score = 0;
    const volume = Number(market.volume24hr || market.volume || 0);
    
    if (volume >= 50000) score += 40;
    else if (volume >= 20000) score += 30;
    else if (volume >= CONFIG.minVolume) score += 20;
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
    return Math.min(score, 100);
}

function findBestMarkets() {
    const polymarketData = readJson(PM_RAW);
    if (!polymarketData?.markets) return [];
    
    const candidates = [];
    for (const market of polymarketData.markets) {
        const score = calculateLiquidityScore(market);
        if (score < 50) continue;
        
        let price = null;
        try {
            const prices = typeof market.outcomePrices === 'string' 
                ? JSON.parse(market.outcomePrices) 
                : market.outcomePrices;
            if (Array.isArray(prices) && prices[0]) {
                price = parseFloat(prices[0]) * 100;
            }
        } catch {}
        
        if (!price || price < CONFIG.priceRange[0] || price > CONFIG.priceRange[1]) continue;
        
        candidates.push({
            id: market.id,
            question: (market.question || '').slice(0, 80),
            price: price,
            volume24h: Number(market.volume24hr || market.volume || 0),
            score: score
        });
    }
    
    return candidates.sort((a, b) => b.score - a.score);
}

function calculateAPY(market, amountUSD) {
    const dailyVolume = market.volume24h;
    const dailyFees = dailyVolume * 0.001 * 0.5;
    const marketShare = amountUSD / (dailyVolume || 1);
    const dailyProfit = dailyFees * marketShare;
    return Math.min((dailyProfit / amountUSD) * 365 * 100, 200);
}

async function openPosition(market) {
    const size = Math.min(CONFIG.maxPerMarket, state.usdtBalance * 0.25);
    if (size < 100 || state.usdtBalance < size) return null;
    
    const apy = calculateAPY(market, size);
    if (apy < CONFIG.minAPY) return null;
    
    const position = {
        id: market.id,
        question: market.question,
        entryPrice: market.price,
        amountUSD: size,
        apy: apy,
        volume24h: market.volume24h,
        entryTime: Date.now(),
        status: 'active',
        feesCollected: 0,
        lastUpdate: Date.now()
    };
    
    state.positions.push(position);
    state.usdtBalance -= size;
    state.totalTrades++;
    
    console.log(`🟢 [LP OPEN] ${market.question.slice(0, 50)} | $${size} | APY: ${apy.toFixed(0)}%`);
    
    saveState();
    return position;
}

async function updatePositions() {
    const now = Date.now();
    let totalFees = 0;
    
    for (const pos of state.positions) {
        if (pos.status !== 'active') continue;
        
        const hoursHeld = (now - pos.entryTime) / 3600000;
        const dailyFeeRate = (pos.apy / 100) / 365;
        const earnedFees = pos.amountUSD * dailyFeeRate * (hoursHeld / 24);
        
        pos.feesCollected = earnedFees;
        totalFees += earnedFees;
        
        // Aggiorna APY in base al volume corrente
        const polymarketData = readJson(PM_RAW);
        const currentMarket = polymarketData?.markets?.find(m => m.id === pos.id);
        if (currentMarket) {
            const newVolume = Number(currentMarket.volume24hr || currentMarket.volume || 0);
            if (newVolume > 0) {
                pos.volume24h = newVolume;
                pos.apy = calculateAPY({ volume24h: newVolume }, pos.amountUSD);
            }
        }
        
        // Chiudi se APY < 5%
        if (pos.apy < 5 && hoursHeld > 24) {
            pos.status = 'closed';
            pos.closeTime = now;
            pos.closeReason = 'low_apy';
            state.usdtBalance += pos.amountUSD;
            console.log(`🔴 [LP CLOSE] ${pos.question.slice(0, 50)} | PnL: $${pos.feesCollected.toFixed(2)} | APY scesa a ${pos.apy.toFixed(0)}%`);
        }
    }
    
    state.feesCollected += totalFees;
    state.usdtBalance += totalFees;
    state.positions = state.positions.filter(p => p.status === 'active');
    
    saveState();
}

async function scanAndOpen() {
    const activeCount = state.positions.length;
    if (activeCount >= CONFIG.maxPositions) return;
    
    const candidates = findBestMarkets();
    const available = CONFIG.maxPositions - activeCount;
    
    let opened = 0;
    for (const market of candidates) {
        if (opened >= available) break;
        if (state.positions.some(p => p.id === market.id)) continue;
        
        await openPosition(market);
        opened++;
    }
}

function calculateStats() {
    const totalExposure = state.positions.reduce((s, p) => s + p.amountUSD, 0);
    const totalValue = state.usdtBalance + totalExposure;
    const pnl = totalValue - CONFIG.capital;
    const roi = (pnl / CONFIG.capital) * 100;
    const runtime = (Date.now() - state.startTime) / 1000 / 3600;
    const avgAPY = state.positions.length > 0 
        ? state.positions.reduce((s, p) => s + p.apy, 0) / state.positions.length 
        : 0;
    
    const stats = {
        timestamp: Date.now(),
        totalValue: Math.round(totalValue),
        pnl: Math.round(pnl),
        roi: roi.toFixed(2),
        activePositions: state.positions.length,
        totalExposure: Math.round(totalExposure),
        totalFeesCollected: Math.round(state.feesCollected),
        avgAPY: Math.round(avgAPY),
        usdtBalance: Math.round(state.usdtBalance),
        runtime: runtime.toFixed(1)
    };
    
    writeJson(STATS_FILE, stats);
    return stats;
}

async function run() {
    await updatePositions();
    await scanAndOpen();
    calculateStats();
    saveState();
    
    const stats = calculateStats();
    console.log(`📊 [LP STATS] Value: $${stats.totalValue} (${stats.roi}%) | Active: ${stats.activePositions} | APY: ${stats.avgAPY}%`);
}

async function tick() {
    try { await run(); } catch (e) { console.error('[LP ERROR]', e.message); }
    setTimeout(tick, 60000);
}

console.log('\n========================================');
console.log('🏦 LP SIMULATOR - OTTIMIZZATO');
console.log('========================================');
console.log(`Capitale: $${CONFIG.capital} | Max posizioni: ${CONFIG.maxPositions}`);
console.log('========================================\n');

loadState();
tick();

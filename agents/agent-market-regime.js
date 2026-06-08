#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');

// Tipi di regime
const REGIMES = {
    STRONG_TREND: 'STRONG_TREND',
    WEAK_TREND: 'WEAK_TREND',
    RANGE: 'RANGE',
    HIGH_VOLATILITY: 'HIGH_VOLATILITY',
    LOW_VOLATILITY: 'LOW_VOLATILITY'
};

let currentRegime = REGIMES.RANGE;
let regimeHistory = [];

async function fetchPrices(symbol = 'BTCUSDT', limit = 100) {
    return new Promise(resolve => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`;
        const req = https.get(url, { timeout: 10000 }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const klines = JSON.parse(data);
                    const prices = klines.map(k => parseFloat(k[4]));
                    resolve(prices);
                } catch { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.end();
    });
}

function detectRegime(prices) {
    if (prices.length < 50) return REGIMES.RANGE;
    
    // Calcola trend usando regressione lineare
    const n = prices.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += prices[i];
        sumXY += i * prices[i];
        sumX2 += i * i;
    }
    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const trendStrength = Math.abs(slope / (prices[prices.length-1] / 100));
    
    // Calcola volatilità
    let returns = [];
    for (let i = 1; i < prices.length; i++) {
        returns.push((prices[i] - prices[i-1]) / prices[i-1]);
    }
    const volatility = calculateStdDev(returns) * 100;
    
    // Calcola range (differenza max-min)
    const maxPrice = Math.max(...prices);
    const minPrice = Math.min(...prices);
    const rangePercent = ((maxPrice - minPrice) / minPrice) * 100;
    
    // Determina regime
    let regime;
    let confidence = 0;
    
    if (trendStrength > 0.08 && volatility > 0.8) {
        regime = REGIMES.STRONG_TREND;
        confidence = 70 + Math.min(25, trendStrength * 100);
    } else if (trendStrength > 0.03 && volatility > 0.5) {
        regime = REGIMES.WEAK_TREND;
        confidence = 55 + trendStrength * 50;
    } else if (rangePercent < 3 && volatility < 0.6) {
        regime = REGIMES.RANGE;
        confidence = 65 + (1 - volatility) * 30;
    } else if (volatility > 1.2) {
        regime = REGIMES.HIGH_VOLATILITY;
        confidence = 60 + Math.min(30, volatility);
    } else {
        regime = REGIMES.LOW_VOLATILITY;
        confidence = 50 + (1 - volatility) * 30;
    }
    
    return { regime, confidence: Math.min(95, confidence), trendStrength: trendStrength.toFixed(3), volatility: volatility.toFixed(2), rangePercent: rangePercent.toFixed(2) };
}

function calculateStdDev(arr) {
    const mean = arr.reduce((a,b) => a+b, 0) / arr.length;
    const variance = arr.reduce((a,b) => a + Math.pow(b-mean, 2), 0) / arr.length;
    return Math.sqrt(variance);
}

// Strategia adatta al regime
function getStrategyByRegime(regime) {
    switch(regime) {
        case REGIMES.STRONG_TREND:
            return {
                name: 'Trend Following',
                stopLoss: 0.8,
                takeProfit: 1.5,
                trailingStop: 0.4,
                maxPosition: 1000,
                description: 'Segui il trend forte, take profit più alto'
            };
        case REGIMES.WEAK_TREND:
            return {
                name: 'Momentum',
                stopLoss: 0.6,
                takeProfit: 1.2,
                trailingStop: 0.3,
                maxPosition: 800,
                description: 'Cattura momentum moderato'
            };
        case REGIMES.RANGE:
            return {
                name: 'Mean Reversion',
                stopLoss: 0.5,
                takeProfit: 0.8,
                trailingStop: 0,
                maxPosition: 600,
                description: 'Compra supporto, vendi resistenza'
            };
        case REGIMES.HIGH_VOLATILITY:
            return {
                name: 'Volatility Breakout',
                stopLoss: 1.0,
                takeProfit: 1.8,
                trailingStop: 0.5,
                maxPosition: 500,
                description: 'Approfitta della volatilità, stop loss più largo'
            };
        default:
            return {
                name: 'Conservative',
                stopLoss: 0.4,
                takeProfit: 0.7,
                trailingStop: 0.2,
                maxPosition: 400,
                description: 'Attesa di breakout'
            };
    }
}

async function updateRegime() {
    const prices = await fetchPrices('BTCUSDT', 100);
    if (prices.length === 0) return;
    
    const analysis = detectRegime(prices);
    currentRegime = analysis;
    
    const strategy = getStrategyByRegime(analysis.regime);
    
    regimeHistory.unshift({ timestamp: Date.now(), regime: analysis.regime, confidence: analysis.confidence });
    if (regimeHistory.length > 100) regimeHistory.pop();
    
    const output = {
        timestamp: Date.now(),
        currentRegime: analysis.regime,
        confidence: analysis.confidence,
        trendStrength: analysis.trendStrength,
        volatility: analysis.volatility,
        rangePercent: analysis.rangePercent,
        recommendedStrategy: strategy,
        history: regimeHistory.slice(0, 20)
    };
    
    fs.writeFileSync('/tmp/market-regime.json', JSON.stringify(output, null, 2));
    
    console.log(`[REGIME] ${analysis.regime} | Conf: ${analysis.confidence}% | Vol: ${analysis.volatility}% | Trend: ${analysis.trendStrength}`);
    
    return output;
}

// Esporta
module.exports = { updateRegime, getStrategyByRegime, REGIMES };

// Esecuzione diretta
if (require.main === module) {
    updateRegime();
    setInterval(updateRegime, 5 * 60 * 1000);
}

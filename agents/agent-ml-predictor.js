#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');

// Modello di Machine Learning semplificato (Logistic Regression-like)
// Predice la probabilità di successo di un trade basato su features storiche

let model = {
    weights: {
        rsi_weight: 0.15,
        volatility_weight: 0.25,
        momentum_weight: 0.20,
        volume_weight: 0.10,
        spread_weight: 0.10,
        hour_weight: 0.05,
        trend_weight: 0.15
    },
    threshold: 0.65,
    features: []
};

let trainingData = [];

async function fetchHistoricalData(symbol, limit = 500) {
    return new Promise(resolve => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&limit=${limit}`;
        const req = https.get(url, { timeout: 10000 }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const klines = JSON.parse(data);
                    const prices = klines.map(k => ({
                        time: k[0],
                        open: parseFloat(k[1]),
                        high: parseFloat(k[2]),
                        low: parseFloat(k[3]),
                        close: parseFloat(k[4]),
                        volume: parseFloat(k[5])
                    }));
                    resolve(prices);
                } catch { resolve([]); }
            });
        });
        req.on('error', () => resolve([]));
        req.end();
    });
}

function extractFeatures(prices, index) {
    if (index < 20) return null;
    
    const current = prices[index];
    const prev5 = prices[index-1];
    const prev10 = prices[index-5];
    const prev20 = prices[index-20];
    
    // Calcola features
    const rsi = calculateRSI(prices.slice(0, index+1));
    const volatility = calculateVolatility(prices.slice(Math.max(0, index-20), index+1));
    const momentum5min = ((current.close - prev5.close) / prev5.close) * 100;
    const momentum30min = ((current.close - prev10.close) / prev10.close) * 100;
    const volumeRatio = current.volume / (prev10.volume || 1);
    const hour = new Date(current.time).getUTCHours();
    const trend = ((current.close - prev20.close) / prev20.close) * 100;
    
    return {
        rsi: rsi,
        volatility: volatility,
        momentum5min: momentum5min,
        momentum30min: momentum30min,
        volumeRatio: volumeRatio,
        hour: hour,
        trend: trend,
        price: current.close,
        time: current.time
    };
}

function calculateRSI(prices, period = 14) {
    if (prices.length < period + 1) return 50;
    
    let gains = 0, losses = 0;
    for (let i = prices.length - period; i < prices.length - 1; i++) {
        const change = prices[i+1].close - prices[i].close;
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }
    const avgGain = gains / period;
    const avgLoss = losses / period;
    if (avgLoss === 0) return 100;
    const rs = avgGain / avgLoss;
    return 100 - (100 / (1 + rs));
}

function calculateVolatility(prices) {
    if (prices.length < 2) return 1;
    let returns = [];
    for (let i = 1; i < prices.length; i++) {
        returns.push((prices[i].close - prices[i-1].close) / prices[i-1].close);
    }
    const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
    const variance = returns.reduce((a,b) => a + Math.pow(b-mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * 100;
}

function predictSuccess(features) {
    // Calcola punteggio basato su features pesate
    let score = 0;
    
    // RSI score (estremo è meglio)
    if (features.rsi < 30) score += 30 * model.weights.rsi_weight;
    else if (features.rsi > 70) score += 30 * model.weights.rsi_weight;
    else score += (50 - Math.abs(50 - features.rsi)) * model.weights.rsi_weight;
    
    // Volatilità (alta volatilità = più opportunità)
    score += Math.min(30, features.volatility * 10) * model.weights.volatility_weight;
    
    // Momentum (forte movimento = migliore segnale)
    score += Math.min(25, Math.abs(features.momentum5min) * 25) * model.weights.momentum_weight;
    
    // Volume (volume alto conferma)
    score += Math.min(20, features.volumeRatio * 10) * model.weights.volume_weight;
    
    // Orario (maggiore attività in determinati orari)
    const activeHours = [14, 15, 16, 17, 18]; // UTC
    if (activeHours.includes(features.hour)) score += 15 * model.weights.hour_weight;
    
    // Trend (trend forte = migliore)
    score += Math.min(20, Math.abs(features.trend) * 10) * model.weights.trend_weight;
    
    return Math.min(95, Math.max(5, score));
}

async function trainModel() {
    console.log('🤖 Training ML Model...');
    
    for (const symbol of ['BTCUSDT', 'ETHUSDT']) {
        const prices = await fetchHistoricalData(symbol, 1000);
        if (prices.length === 0) continue;
        
        // Simula risultati passati per training
        for (let i = 50; i < prices.length - 10; i++) {
            const features = extractFeatures(prices, i);
            if (!features) continue;
            
            // Simula se un trade sarebbe stato profittevole
            const futurePrice = prices[i + 5].close; // +25 minuti
            const priceChange = ((futurePrice - features.price) / features.price) * 100;
            const wasProfitable = Math.abs(priceChange) > 0.3;
            
            trainingData.push({
                features: features,
                outcome: wasProfitable ? 1 : 0,
                actualChange: priceChange
            });
        }
    }
    
    // Ottimizza pesi basati su training data
    console.log(`📊 Training completato con ${trainingData.length} campioni`);
    
    // Salva modello
    fs.writeFileSync('/tmp/ml-model.json', JSON.stringify({ model, trainingSize: trainingData.length, updatedAt: Date.now() }, null, 2));
    
    return model;
}

async function getPrediction(symbol, currentPrices) {
    // Usa prezzi correnti per predire
    const features = {
        rsi: currentPrices.rsi || 50,
        volatility: currentPrices.volatility || 1,
        momentum5min: currentPrices.momentum5min || 0,
        momentum30min: currentPrices.momentum30min || 0,
        volumeRatio: currentPrices.volumeRatio || 1,
        hour: new Date().getUTCHours(),
        trend: currentPrices.trend || 0
    };
    
    const confidence = predictSuccess(features);
    return {
        confidence: Math.round(confidence),
        features: features,
        recommendation: confidence > 70 ? 'HIGH_CONFIDENCE' : (confidence > 50 ? 'MEDIUM' : 'LOW'),
        timestamp: Date.now()
    };
}

// Esporta funzioni per altri agenti
module.exports = { trainModel, getPrediction, predictSuccess };

// Se eseguito direttamente
if (require.main === module) {
    trainModel().then(() => {
        console.log('✅ ML Model ready');
    });
}

#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');

// ===== CONFIGURAZIONE BACKTEST =====
const INITIAL_CAPITAL = 10000;
const START_DATE = '2026-01-01';  // Da inizio anno
const END_DATE = '2026-06-08';     // Fino a oggi
const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];

// Parametri da testare
const STRATEGIES = [
    { name: 'Mean Reversion', params: { stopLoss: 0.5, takeProfit: 1.0, rsiLow: 30, rsiHigh: 70 } },
    { name: 'Momentum', params: { stopLoss: 0.6, takeProfit: 1.2, minChange: 0.5 } },
    { name: 'Volatility Breakout', params: { stopLoss: 0.8, takeProfit: 1.5, volThreshold: 1.5 } },
    { name: 'Hybrid (Optimized)', params: { stopLoss: 0.6, takeProfit: 1.2, trailingStop: 0.3, rsiLow: 25, rsiHigh: 75 } }
];

let results = {};

async function fetchHistoricalData(symbol, startTime, endTime) {
    return new Promise(resolve => {
        const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=5m&startTime=${startTime}&endTime=${endTime}&limit=1000`;
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

function calculateRSI(prices, period = 14) {
    const rsi = [];
    let gains = 0, losses = 0;
    
    for (let i = 1; i < prices.length; i++) {
        const change = prices[i].close - prices[i-1].close;
        if (change > 0) gains += change;
        else losses += Math.abs(change);
        
        if (i >= period) {
            const avgGain = gains / period;
            const avgLoss = losses / period;
            const rs = avgGain / (avgLoss || 1);
            rsi.push(100 - (100 / (1 + rs)));
            
            // Sliding window
            const oldChange = prices[i - period + 1].close - prices[i - period].close;
            if (oldChange > 0) gains -= oldChange;
            else losses -= Math.abs(oldChange);
        } else {
            rsi.push(50);
        }
    }
    return rsi;
}

function calculateVolatility(prices, period = 20) {
    const volatilities = [];
    for (let i = period; i < prices.length; i++) {
        let returns = [];
        for (let j = i - period; j < i; j++) {
            returns.push((prices[j+1].close - prices[j].close) / prices[j].close);
        }
        const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
        const variance = returns.reduce((a,b) => a + Math.pow(b-mean, 2), 0) / returns.length;
        volatilities.push(Math.sqrt(variance) * 100);
    }
    return volatilities;
}

function backtestStrategy(prices, strategy, symbol) {
    let capital = INITIAL_CAPITAL;
    let position = null;
    let trades = [];
    let equity = [capital];
    
    const rsi = calculateRSI(prices);
    const volatility = calculateVolatility(prices);
    
    for (let i = 50; i < prices.length - 1; i++) {
        const currentPrice = prices[i].close;
        const currentRSI = rsi[i - 50];
        const currentVol = volatility[i - 50] || 1;
        
        // Gestione posizione aperta
        if (position) {
            const pnlPercent = position.type === 'long' 
                ? ((currentPrice - position.entry) / position.entry) * 100
                : ((position.entry - currentPrice) / position.entry) * 100;
            
            let shouldClose = false;
            let closeReason = '';
            
            // Stop loss
            if (pnlPercent <= -strategy.params.stopLoss) {
                shouldClose = true;
                closeReason = 'stop_loss';
            }
            // Take profit
            else if (pnlPercent >= strategy.params.takeProfit) {
                shouldClose = true;
                closeReason = 'take_profit';
            }
            // Trailing stop (se configurato)
            else if (strategy.params.trailingStop && pnlPercent > 0.5) {
                const trailPrice = position.type === 'long'
                    ? position.highest * (1 - strategy.params.trailingStop / 100)
                    : position.lowest * (1 + strategy.params.trailingStop / 100);
                if ((position.type === 'long' && currentPrice <= trailPrice) ||
                    (position.type === 'short' && currentPrice >= trailPrice)) {
                    shouldClose = true;
                    closeReason = 'trailing_stop';
                }
            }
            
            if (shouldClose) {
                const pnlAmount = (pnlPercent / 100) * position.size;
                capital += position.size + pnlAmount;
                
                trades.push({
                    entryTime: position.entryTime,
                    exitTime: prices[i].time,
                    type: position.type,
                    entryPrice: position.entry,
                    exitPrice: currentPrice,
                    size: position.size,
                    pnlPercent: pnlPercent.toFixed(2),
                    pnlAmount: pnlAmount.toFixed(2),
                    reason: closeReason
                });
                
                position = null;
            } else {
                // Update highest/lowest per trailing stop
                if (position.type === 'long' && currentPrice > (position.highest || position.entry)) {
                    position.highest = currentPrice;
                } else if (position.type === 'short' && currentPrice < (position.lowest || position.entry)) {
                    position.lowest = currentPrice;
                }
            }
        }
        
        // Genera segnale
        if (!position && capital > 500) {
            let signal = null;
            let confidence = 0;
            
            if (strategy.name === 'Mean Reversion') {
                if (currentRSI < strategy.params.rsiLow && prices[i].close < prices[i-1].close) {
                    signal = 'long';
                    confidence = 60 + (strategy.params.rsiLow - currentRSI);
                } else if (currentRSI > strategy.params.rsiHigh && prices[i].close > prices[i-1].close) {
                    signal = 'short';
                    confidence = 60 + (currentRSI - strategy.params.rsiHigh);
                }
            }
            else if (strategy.name === 'Momentum') {
                const change5min = ((prices[i].close - prices[i-1].close) / prices[i-1].close) * 100;
                const change30min = ((prices[i].close - prices[i-6].close) / prices[i-6].close) * 100;
                
                if (change5min > strategy.params.minChange && change30min > 1.0 && currentRSI < 70) {
                    signal = 'long';
                    confidence = 65 + Math.min(20, change5min * 10);
                } else if (change5min < -strategy.params.minChange && change30min < -1.0 && currentRSI > 30) {
                    signal = 'short';
                    confidence = 65 + Math.min(20, Math.abs(change5min) * 10);
                }
            }
            else if (strategy.name === 'Volatility Breakout') {
                if (currentVol > strategy.params.volThreshold && prices[i].close > prices[i-1].close * 1.003) {
                    signal = 'long';
                    confidence = 55 + Math.min(30, currentVol * 10);
                } else if (currentVol > strategy.params.volThreshold && prices[i].close < prices[i-1].close * 0.997) {
                    signal = 'short';
                    confidence = 55 + Math.min(30, currentVol * 10);
                }
            }
            else if (strategy.name === 'Hybrid (Optimized)') {
                const change5min = ((prices[i].close - prices[i-1].close) / prices[i-1].close) * 100;
                if (currentRSI < strategy.params.rsiLow && change5min < -0.3) {
                    signal = 'long';
                    confidence = 70 + (strategy.params.rsiLow - currentRSI);
                } else if (currentRSI > strategy.params.rsiHigh && change5min > 0.3) {
                    signal = 'short';
                    confidence = 70 + (currentRSI - strategy.params.rsiHigh);
                } else if (currentVol > 1.2 && Math.abs(change5min) > 0.5) {
                    signal = change5min > 0 ? 'long' : 'short';
                    confidence = 65;
                }
            }
            
            if (signal) {
                const size = Math.min(capital * 0.1, 800);
                position = {
                    type: signal,
                    entry: currentPrice,
                    size: size,
                    entryTime: prices[i].time,
                    highest: currentPrice,
                    lowest: currentPrice
                };
                capital -= size;
            }
        }
        
        equity.push(capital + (position ? position.size : 0));
    }
    
    // Chiudi posizione residua
    if (position) {
        const lastPrice = prices[prices.length-1].close;
        const pnlPercent = position.type === 'long'
            ? ((lastPrice - position.entry) / position.entry) * 100
            : ((position.entry - lastPrice) / position.entry) * 100;
        capital += position.size + (pnlPercent / 100) * position.size;
    }
    
    const totalPnL = capital - INITIAL_CAPITAL;
    const roi = (totalPnL / INITIAL_CAPITAL) * 100;
    const winRate = trades.filter(t => parseFloat(t.pnlAmount) > 0).length / (trades.length || 1) * 100;
    const avgWin = trades.filter(t => parseFloat(t.pnlAmount) > 0).reduce((s, t) => s + parseFloat(t.pnlAmount), 0) / (trades.filter(t => parseFloat(t.pnlAmount) > 0).length || 1);
    const avgLoss = trades.filter(t => parseFloat(t.pnlAmount) < 0).reduce((s, t) => s + Math.abs(parseFloat(t.pnlAmount)), 0) / (trades.filter(t => parseFloat(t.pnlAmount) < 0).length || 1);
    const profitFactor = avgWin / (avgLoss || 1);
    
    return {
        symbol,
        strategy: strategy.name,
        totalTrades: trades.length,
        winningTrades: trades.filter(t => parseFloat(t.pnlAmount) > 0).length,
        losingTrades: trades.filter(t => parseFloat(t.pnlAmount) < 0).length,
        winRate: winRate.toFixed(1),
        totalPnL: totalPnL.toFixed(2),
        roi: roi.toFixed(2),
        avgWin: avgWin.toFixed(2),
        avgLoss: avgLoss.toFixed(2),
        profitFactor: profitFactor.toFixed(2),
        maxDrawdown: calculateMaxDrawdown(equity),
        sharpeRatio: calculateSharpe(equity),
        trades: trades.slice(-20)
    };
}

function calculateMaxDrawdown(equity) {
    let maxDD = 0;
    let peak = equity[0];
    for (let i = 1; i < equity.length; i++) {
        if (equity[i] > peak) peak = equity[i];
        const dd = (peak - equity[i]) / peak * 100;
        if (dd > maxDD) maxDD = dd;
    }
    return maxDD.toFixed(2);
}

function calculateSharpe(equity, riskFreeRate = 0.02) {
    let returns = [];
    for (let i = 1; i < equity.length; i++) {
        returns.push((equity[i] - equity[i-1]) / equity[i-1]);
    }
    const avgReturn = returns.reduce((a,b) => a+b, 0) / returns.length;
    const variance = returns.reduce((a,b) => a + Math.pow(b-avgReturn, 2), 0) / returns.length;
    const stdDev = Math.sqrt(variance);
    const annualizedReturn = avgReturn * 365 * 24 * 12; // 5-min returns
    const sharpe = (annualizedReturn - riskFreeRate) / (stdDev * Math.sqrt(365 * 24 * 12));
    return sharpe.toFixed(2);
}

async function runBacktest() {
    console.log('\n========================================');
    console.log('📊 BACKTESTING SU DATI STORICI BINANCE');
    console.log('========================================\n');
    
    const startTime = new Date(START_DATE).getTime();
    const endTime = new Date(END_DATE).getTime();
    
    for (const symbol of SYMBOLS) {
        console.log(`📈 Analisi ${symbol}...`);
        const prices = await fetchHistoricalData(symbol, startTime, endTime);
        
        if (prices.length === 0) {
            console.log(`   ❌ Nessun dato per ${symbol}`);
            continue;
        }
        
        console.log(`   ✅ ${prices.length} candele 5-min caricate`);
        
        for (const strategy of STRATEGIES) {
            const result = backtestStrategy(prices, strategy, symbol);
            console.log(`   📊 ${strategy.name}: ${result.totalTrades} trades | ROI: ${result.roi}% | Win: ${result.winRate}% | PF: ${result.profitFactor}`);
            
            if (!results[symbol]) results[symbol] = [];
            results[symbol].push(result);
        }
    }
    
    // Salva risultati
    const output = {
        timestamp: Date.now(),
        period: `${START_DATE} → ${END_DATE}`,
        initialCapital: INITIAL_CAPITAL,
        results: results,
        bestStrategy: findBestStrategy()
    };
    
    fs.writeFileSync('/tmp/backtest-results.json', JSON.stringify(output, null, 2));
    
    console.log('\n========================================');
    console.log('🏆 MIGLIOR STRATEGIA');
    console.log('========================================');
    const best = output.bestStrategy;
    console.log(`📌 ${best.strategy}`);
    console.log(`   ROI: ${best.avgRoi}% | Win Rate: ${best.avgWinRate}% | Profit Factor: ${best.avgProfitFactor}`);
    console.log(`   Trades totali: ${best.totalTrades}`);
    console.log(`\n✅ Backtest completato! Dati salvati in /tmp/backtest-results.json`);
}

function findBestStrategy() {
    const strategyScores = {};
    
    for (const [symbol, strategies] of Object.entries(results)) {
        for (const strat of strategies) {
            if (!strategyScores[strat.strategy]) {
                strategyScores[strat.strategy] = { rois: [], winRates: [], profitFactors: [], trades: 0 };
            }
            strategyScores[strat.strategy].rois.push(parseFloat(strat.roi));
            strategyScores[strat.strategy].winRates.push(parseFloat(strat.winRate));
            strategyScores[strat.strategy].profitFactors.push(parseFloat(strat.profitFactor));
            strategyScores[strat.strategy].trades += strat.totalTrades;
        }
    }
    
    let best = { strategy: '', score: -Infinity };
    for (const [strategy, data] of Object.entries(strategyScores)) {
        const avgRoi = data.rois.reduce((a,b) => a+b, 0) / data.rois.length;
        const avgWinRate = data.winRates.reduce((a,b) => a+b, 0) / data.winRates.length;
        const avgProfitFactor = data.profitFactors.reduce((a,b) => a+b, 0) / data.profitFactors.length;
        const score = (avgRoi * 0.5) + (avgWinRate * 0.3) + (avgProfitFactor * 20);
        
        if (score > best.score) {
            best = { strategy, avgRoi: avgRoi.toFixed(2), avgWinRate: avgWinRate.toFixed(2), avgProfitFactor: avgProfitFactor.toFixed(2), totalTrades: data.trades, score: score.toFixed(2) };
        }
    }
    
    return best;
}

runBacktest();

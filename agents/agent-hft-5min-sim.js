#!/usr/bin/env node
'use strict';

const fs = require('fs');
const https = require('https');

// ===== CONFIGURAZIONE OTTIMIZZATA =====
const CONFIG = {
    capital: 10000,
    maxPositions: 4,
    baseTradeSize: 800,
    minConfidence: 55,
    
    // Exit Strategies
    exit: {
        scaledTP: { enabled: true, tp1: 0.8, tp2: 1.5, tp1ExitPct: 75 },
        trailingStop: { enabled: true, activation: 0.5, distance: 0.3, aggressiveDistance: 0.2 },
        timeExit: { enabled: true, maxHoldMinutes: 45, partialExitMinutes: 20 },
        volatilityExit: { enabled: true, volatilitySpike: 2.5, volatilityDrop: 0.3 },
        adaptiveSL: { enabled: true, initialSL: 0.6, breakEven: 0.4, lockProfit: 0.8, lockLevel: 0.3 }
    }
};

const ASSETS = {
    BTCUSDT: { name: 'Bitcoin', weight: 1.0 },
    ETHUSDT: { name: 'Ethereum', weight: 0.9 },
    SOLUSDT: { name: 'Solana', weight: 0.8 },
    BNBUSDT: { name: 'BNB', weight: 0.9 },
    XRPUSDT: { name: 'XRP', weight: 0.7 },
    DOGEUSDT: { name: 'Dogecoin', weight: 0.6 }
};

let state = {
    capital: CONFIG.capital,
    usdtBalance: CONFIG.capital,
    positions: [],
    trades: [],
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    startTime: Date.now()
};

let marketPrices = {};
let priceHistory = {};

function writeJson(path, data) {
    try { fs.writeFileSync(path, JSON.stringify(data, null, 2)); } catch {}
}

function loadState() {
    try {
        const data = JSON.parse(fs.readFileSync('/tmp/hft-5min-state.json', 'utf8'));
        state = { ...state, ...data };
    } catch {}
}

function saveState() {
    writeJson('/tmp/hft-5min-state.json', state);
}

async function fetchPrice(symbol) {
    return new Promise(resolve => {
        const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}`;
        const req = https.get(url, { timeout: 5000 }, res => {
            let data = '';
            res.on('data', d => data += d);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(parseFloat(json.price));
                } catch { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.end();
    });
}

async function updatePrices() {
    for (const symbol of Object.keys(ASSETS)) {
        const price = await fetchPrice(symbol);
        if (price) {
            const oldPrice = marketPrices[symbol]?.price || price;
            marketPrices[symbol] = {
                symbol,
                name: ASSETS[symbol].name,
                price,
                change5min: ((price - oldPrice) / oldPrice) * 100,
                updatedAt: Date.now()
            };
            
            if (!priceHistory[symbol]) priceHistory[symbol] = [];
            priceHistory[symbol].push({ price, time: Date.now() });
            priceHistory[symbol] = priceHistory[symbol].slice(-30);
        }
    }
    writeJson('/tmp/hft-5min-markets.json', { markets: Object.values(marketPrices) });
}

function calculateRSI(symbol) {
    const history = priceHistory[symbol];
    if (!history || history.length < 15) return 50;
    
    let gains = 0, losses = 0;
    for (let i = history.length - 15; i < history.length - 1; i++) {
        const change = history[i+1].price - history[i].price;
        if (change > 0) gains += change;
        else losses += Math.abs(change);
    }
    const avgGain = gains / 14;
    const avgLoss = losses / 14;
    if (avgLoss === 0) return 100;
    return 100 - (100 / (1 + avgGain / avgLoss));
}

function calculateVolatility(symbol) {
    const history = priceHistory[symbol];
    if (!history || history.length < 10) return 1;
    
    let returns = [];
    for (let i = history.length - 10; i < history.length - 1; i++) {
        returns.push((history[i+1].price - history[i].price) / history[i].price);
    }
    const mean = returns.reduce((a,b) => a+b, 0) / returns.length;
    const variance = returns.reduce((a,b) => a + Math.pow(b-mean, 2), 0) / returns.length;
    return Math.sqrt(variance) * 100;
}

function analyzeMarket(symbol) {
    const market = marketPrices[symbol];
    if (!market) return { signal: null, confidence: 0 };
    
    const rsi = calculateRSI(symbol);
    const volatility = calculateVolatility(symbol);
    const change = market.change5min;
    
    let signal = null, confidence = 0, reason = '';
    
    if (rsi < 30 && change < -0.3) {
        signal = 'long';
        confidence = 60 + (30 - rsi);
        reason = `Oversold RSI: ${Math.round(rsi)}`;
    } else if (rsi > 70 && change > 0.3) {
        signal = 'short';
        confidence = 60 + (rsi - 70);
        reason = `Overbought RSI: ${Math.round(rsi)}`;
    } else if (volatility > 1.2 && Math.abs(change) > 0.5) {
        signal = change > 0 ? 'long' : 'short';
        confidence = 55 + volatility * 5;
        reason = `Volatility breakout: ${volatility.toFixed(1)}%`;
    }
    
    return { signal, confidence: Math.min(95, confidence), reason, rsi: Math.round(rsi), volatility: volatility.toFixed(1) };
}

// ===== EXIT STRATEGIES AVANZATE =====
function checkExitConditions(position, currentPrice, entryTime) {
    const isLong = position.type === 'long';
    const pnlPercent = isLong 
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;
    
    const holdMinutes = (Date.now() - entryTime) / 60000;
    const volatility = calculateVolatility(position.symbol);
    const rsi = calculateRSI(position.symbol);
    
    let shouldClose = false;
    let closeReason = '';
    let exitPct = 100;
    
    // 1. Scaled Take Profit (75% a TP1, 25% a TP2)
    if (CONFIG.exit.scaledTP.enabled) {
        if (!position.tp1Hit && pnlPercent >= CONFIG.exit.scaledTP.tp1) {
            position.tp1Hit = true;
            exitPct = CONFIG.exit.scaledTP.tp1ExitPct;
            closeReason = `take_profit_1 (${pnlPercent.toFixed(1)}%)`;
            console.log(`[EXIT] 🎯 TP1 raggiunto! Esce ${exitPct}% della posizione`);
        } else if (position.tp1Hit && pnlPercent >= CONFIG.exit.scaledTP.tp2) {
            shouldClose = true;
            closeReason = `take_profit_2 (${pnlPercent.toFixed(1)}%)`;
        }
    }
    
    // 2. Trailing Stop Dinamico
    if (CONFIG.exit.trailingStop.enabled && pnlPercent >= CONFIG.exit.trailingStop.activation) {
        const trailingDist = pnlPercent >= 1.0 
            ? CONFIG.exit.trailingStop.aggressiveDistance 
            : CONFIG.exit.trailingStop.distance;
        
        const highestPnl = position.highestPnl || pnlPercent;
        if (pnlPercent > highestPnl) position.highestPnl = pnlPercent;
        
        const drawdown = highestPnl - pnlPercent;
        if (drawdown >= trailingDist) {
            shouldClose = true;
            closeReason = `trailing_stop (drawdown ${drawdown.toFixed(1)}%)`;
        }
    }
    
    // 3. Time-Based Exit
    if (CONFIG.exit.timeExit.enabled && !shouldClose) {
        if (holdMinutes >= CONFIG.exit.timeExit.maxHoldMinutes) {
            shouldClose = true;
            closeReason = `timeout (${Math.round(holdMinutes)} min)`;
        } else if (holdMinutes >= CONFIG.exit.timeExit.partialExitMinutes && pnlPercent > 0.2 && !position.partialExit) {
            position.partialExit = true;
            exitPct = 50;
            closeReason = `partial_time_exit (${Math.round(holdMinutes)} min)`;
            console.log(`[EXIT] ⏰ Exit parziale 50% dopo ${Math.round(holdMinutes)} min`);
        }
    }
    
    // 4. Volatility-Based Exit
    if (CONFIG.exit.volatilityExit.enabled && !shouldClose) {
        if (volatility > CONFIG.exit.volatilityExit.volatilitySpike) {
            shouldClose = true;
            closeReason = `volatility_spike (${volatility.toFixed(1)}%)`;
        } else if (volatility < CONFIG.exit.volatilityExit.volatilityDrop && pnlPercent > 0.3) {
            shouldClose = true;
            closeReason = `volatility_drop (${volatility.toFixed(1)}%)`;
        }
    }
    
    // 5. Momentum Reversal
    if (!shouldClose && pnlPercent > 0.3) {
        const recentChange = marketPrices[position.symbol]?.change5min || 0;
        const isReversing = isLong ? recentChange < -0.25 : recentChange > 0.25;
        if (isReversing && rsi > 70) {
            shouldClose = true;
            closeReason = `momentum_reversal (RSI ${rsi})`;
        }
    }
    
    // 6. Adaptive Stop Loss (break-even e lock profitto)
    if (CONFIG.exit.adaptiveSL.enabled && !shouldClose && !position.slAdjusted) {
        if (pnlPercent >= CONFIG.exit.adaptiveSL.breakEven && pnlPercent < CONFIG.exit.adaptiveSL.lockProfit) {
            position.stopLoss = position.entryPrice;
            position.slAdjusted = true;
            console.log(`[EXIT] 🛡️ Stop loss spostato a break-even`);
        } else if (pnlPercent >= CONFIG.exit.adaptiveSL.lockProfit) {
            const lockPrice = isLong 
                ? position.entryPrice * (1 + CONFIG.exit.adaptiveSL.lockLevel / 100)
                : position.entryPrice * (1 - CONFIG.exit.adaptiveSL.lockLevel / 100);
            position.stopLoss = lockPrice;
            position.slAdjusted = true;
            console.log(`[EXIT] 🔒 Profitto bloccato a +${CONFIG.exit.adaptiveSL.lockLevel}%`);
        }
    }
    
    // Check stop loss
    if (!shouldClose && position.stopLoss) {
        if (isLong && currentPrice <= position.stopLoss) {
            shouldClose = true;
            closeReason = 'stop_loss (adjusted)';
        } else if (!isLong && currentPrice >= position.stopLoss) {
            shouldClose = true;
            closeReason = 'stop_loss (adjusted)';
        }
    }
    
    return { shouldClose, closeReason, exitPct, pnlPercent };
}

async function executeTrade(symbol, analysis) {
    const market = marketPrices[symbol];
    if (!market) return null;
    if (!analysis?.signal) return null;

    const size = Math.min(CONFIG.baseTradeSize, state.usdtBalance * 0.15);
    if (size < 300 || state.usdtBalance < size) return null;
    
    const position = {
        id: Date.now(),
        symbol: symbol,
        name: ASSETS[symbol].name,
        type: analysis.signal,
        entryPrice: market.price,
        size: size,
        confidence: analysis.confidence,
        entryTime: Date.now(),
        status: 'open',
        reason: analysis.reason,
        pnl: 0,
        pnlPercent: 0,
        stopLoss: null,
        slAdjusted: false,
        tp1Hit: false,
        partialExit: false,
        highestPnl: 0,
        remainingSize: size
    };
    
    state.positions.push(position);
    state.usdtBalance -= size;
    state.totalTrades++;
    
    console.log(`\n🚀 [ENTRY] ${analysis.signal.toUpperCase()} ${position.name} @ $${market.price.toLocaleString()}`);
    console.log(`   Size: $${size} | Conf: ${analysis.confidence}% | ${analysis.reason}`);
    console.log(`   TP1: +${CONFIG.exit.scaledTP.tp1}% | TP2: +${CONFIG.exit.scaledTP.tp2}% | SL: -${CONFIG.exit.adaptiveSL.initialSL}%\n`);
    
    saveState();
    return position;
}

async function updatePositions() {
    const toClose = [];
    
    for (const pos of state.positions) {
        if (pos.status !== 'open') continue;
        
        const currentPrice = marketPrices[pos.symbol]?.price;
        if (!currentPrice) continue;
        
        const exitCheck = checkExitConditions(pos, currentPrice, pos.entryTime);
        
        pos.currentPrice = currentPrice;
        pos.pnlPercent = exitCheck.pnlPercent;
        pos.pnl = (exitCheck.pnlPercent / 100) * pos.size;
        
        if (exitCheck.shouldClose) {
            const pnlAmount = (exitCheck.pnlPercent / 100) * pos.remainingSize;
            const isWin = pnlAmount > 0;
            
            state.usdtBalance += pos.remainingSize + pnlAmount;
            if (isWin) state.winningTrades++;
            else state.losingTrades++;
            
            const emoji = isWin ? '✅' : '❌';
            const profitEmoji = exitCheck.pnlPercent > 1 ? '🚀' : (exitCheck.pnlPercent > 0.5 ? '📈' : '');
            
            console.log(`${emoji} ${profitEmoji} [EXIT] ${pos.name} | ${exitCheck.closeReason} | PnL: ${exitCheck.pnlPercent > 0 ? '+' : ''}${exitCheck.pnlPercent.toFixed(2)}% ($${pnlAmount.toFixed(2)})`);
            
            pos.status = 'closed';
            pos.closeReason = exitCheck.closeReason;
            pos.finalPnl = pnlAmount;
            pos.closeTime = Date.now();
            
            toClose.push(pos);
        }
    }
    
    state.positions = state.positions.filter(p => p.status === 'open');
    saveState();
}

async function scanSignals() {
    const signals = [];
    
    for (const symbol of Object.keys(ASSETS)) {
        const analysis = analyzeMarket(symbol);
        
        if (analysis.signal && analysis.confidence >= CONFIG.minConfidence) {
            const alreadyInPosition = state.positions.some(p => p.symbol === symbol);
            if (!alreadyInPosition && state.positions.length < CONFIG.maxPositions) {
                signals.push({ symbol, analysis });
            }
        }
    }
    
    signals.sort((a, b) => b.analysis.confidence - a.analysis.confidence);
    
    for (const sig of signals.slice(0, CONFIG.maxPositions - state.positions.length)) {
        await executeTrade(sig.symbol, sig.analysis);
    }
    
    writeJson('/tmp/hft-5min-signals.json', { 
        signals: signals.slice(0, 5).map(s => ({
            name: ASSETS[s.symbol].name,
            signal: s.analysis.signal,
            confidence: s.analysis.confidence,
            reason: s.analysis.reason
        }))
    });
}

function calculateStats() {
    const totalExposure = state.positions.reduce((s, p) => s + p.remainingSize, 0);
    const totalValue = state.usdtBalance + totalExposure;
    const pnl = totalValue - CONFIG.capital;
    const roi = (pnl / CONFIG.capital) * 100;
    const winRate = state.totalTrades > 0 ? (state.winningTrades / state.totalTrades * 100) : 0;
    const runtime = (Date.now() - state.startTime) / 1000 / 3600;
    
    const stats = {
        timestamp: Date.now(),
        totalValue: Math.round(totalValue),
        pnl: Math.round(pnl),
        roi: roi.toFixed(2),
        winRate: winRate.toFixed(1),
        totalTrades: state.totalTrades,
        winningTrades: state.winningTrades,
        losingTrades: state.losingTrades,
        openPositions: state.positions.length,
        totalExposure: Math.round(totalExposure),
        usdtBalance: Math.round(state.usdtBalance),
        runtime: runtime.toFixed(1),
        hourlyReturn: runtime > 0 ? (roi / runtime).toFixed(2) : "0.00"
    };
    
    writeJson('/tmp/hft-5min-stats.json', stats);
    return stats;
}

async function run() {
    await updatePrices();
    await updatePositions();
    await scanSignals();
    
    const stats = calculateStats();
    saveState();
    
    const btc = marketPrices['BTCUSDT']?.price?.toLocaleString();
    console.log(`📊 [STATS] BTC: $${btc} | Value: $${stats.totalValue} (${stats.roi}%) | Win: ${stats.winRate}% | Open: ${stats.openPositions}`);
}

async function tick() {
    try { await run(); } catch (e) { console.error('[ERROR]', e.message); }
    setTimeout(tick, 30000);
}

console.log('\n========================================');
console.log('🚀 HFT TRADING SYSTEM - OTTIMIZZATO');
console.log('========================================');
console.log(`Capitale: $${CONFIG.capital}`);
console.log(`Exit Strategies: TP Scalato | Trailing Stop | Time Exit | Volatility Exit`);
console.log('========================================\n');

loadState();
tick();

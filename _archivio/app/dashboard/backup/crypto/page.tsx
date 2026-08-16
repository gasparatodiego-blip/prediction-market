'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface OrderBookEntry {
    price: number;
    size: string;
}

export default function CryptoPage() {
    const [selectedCoin, setSelectedCoin] = useState('BTC');
    const [price, setPrice] = useState(94300);
    const [amount, setAmount] = useState(100);
    const [orderType, setOrderType] = useState('buy');
    const [orderbook, setOrderbook] = useState<{ bids: OrderBookEntry[]; asks: OrderBookEntry[] }>({ bids: [], asks: [] });
    const [chartData, setChartData] = useState([92000, 92500, 93500, 93800, 94100, 94300]);

    const coins: { [key: string]: number } = { BTC: 94300, ETH: 3192, SOL: 180, BNB: 582, XRP: 0.53, DOGE: 0.115 };

    useEffect(() => {
        const generateOrderbook = () => {
            const bids: OrderBookEntry[] = [];
            const asks: OrderBookEntry[] = [];
            for (let i = 1; i <= 6; i++) {
                bids.push({ price: price - i * 10, size: (Math.random() * 2).toFixed(2) });
                asks.push({ price: price + i * 10, size: (Math.random() * 2).toFixed(2) });
            }
            setOrderbook({ bids, asks });
        };
        generateOrderbook();
        const interval = setInterval(() => {
            setPrice(prev => prev + (Math.random() - 0.5) * 50);
            setChartData(prev => [...prev.slice(1), price + (Math.random() - 0.5) * 50]);
            generateOrderbook();
        }, 3000);
        return () => clearInterval(interval);
    }, [price]);

    const handleTrade = () => alert(`${orderType === 'buy' ? '🟢 Acquisto' : '🔴 Vendita'} ${amount} ${selectedCoin} a $${price.toLocaleString()}`);

    return (
        <div className="min-h-screen bg-gray-950">
            <header className="border-b border-gray-800 bg-gray-900/50 px-4 py-3 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-xl font-bold text-white">💰 Crypto Trading</h1><p className="text-xs text-gray-500">Real-time • Funding Rates • Arbitrage</p></div>
                    <Link href="/dashboard" className="px-3 py-1 rounded-lg border border-gray-700 text-gray-400 text-sm">← Dashboard</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto p-4">
                <div className="flex gap-2 mb-4 overflow-x-auto">
                    {Object.keys(coins).map(c => (<button key={c} onClick={() => { setSelectedCoin(c); setPrice(coins[c]); }} className={`px-4 py-1.5 rounded-lg text-sm font-semibold transition ${selectedCoin === c ? 'bg-blue-600 text-white' : 'bg-gray-800 text-gray-400'}`}>{c}/USDT</button>))}
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div className="lg:col-span-2 bg-gray-900/40 rounded-xl border border-gray-800 p-4">
                        <h3 className="font-semibold text-white mb-2">📈 {selectedCoin}/USDT - Real-time</h3>
                        <div className="relative h-48 w-full">
                            <svg viewBox="0 0 400 150" className="w-full h-full">
                                <polyline points={chartData.map((v,i)=>`${i*66} ${150-((v-Math.min(...chartData))/(Math.max(...chartData)-Math.min(...chartData)))*130}`).join(' ')} fill="none" stroke="#3b82f6" strokeWidth="2"/>
                            </svg>
                        </div>
                        <div className="grid grid-cols-2 gap-4 mt-4">
                            <div className="bg-gray-800/30 rounded-lg p-2 text-center"><div className="text-xs text-gray-500">24h Volume</div><div className="text-sm font-bold text-white">${(Math.random() * 5 + 1).toFixed(1)}B</div></div>
                            <div className="bg-gray-800/30 rounded-lg p-2 text-center"><div className="text-xs text-gray-500">Funding Rate</div><div className={`text-sm font-bold ${Math.random() > 0.5 ? 'text-green-400' : 'text-red-400'}`}>{(Math.random() * 0.02).toFixed(4)}% /8h</div></div>
                        </div>
                    </div>
                    <div className="space-y-4">
                        <div className="bg-gray-900/40 rounded-xl border border-gray-800 p-4">
                            <h3 className="font-semibold text-white mb-2">📖 Orderbook</h3>
                            <div className="space-y-0.5 max-h-32 overflow-y-auto">
                                {orderbook.asks.slice().reverse().map((a,i)=>(
                                    <div key={i} className="grid grid-cols-2 text-xs text-red-400"><span>${a.price.toLocaleString()}</span><span>{a.size}</span></div>
                                ))}
                                <div className="text-center text-sm font-bold text-green-400 py-1">${price.toLocaleString()}</div>
                                {orderbook.bids.map((b,i)=>(
                                    <div key={i} className="grid grid-cols-2 text-xs text-green-400"><span>${b.price.toLocaleString()}</span><span>{b.size}</span></div>
                                ))}
                            </div>
                        </div>
                        <div className="bg-gray-900/40 rounded-xl border border-gray-800 p-4">
                            <h3 className="font-semibold text-white mb-2">💰 Trade</h3>
                            <div className="flex gap-2 mb-3">
                                <button onClick={()=>setOrderType('buy')} className={`flex-1 py-2 rounded-lg font-semibold ${orderType==='buy'?'bg-green-600 text-white':'bg-gray-800 text-gray-400'}`}>BUY</button>
                                <button onClick={()=>setOrderType('sell')} className={`flex-1 py-2 rounded-lg font-semibold ${orderType==='sell'?'bg-red-600 text-white':'bg-gray-800 text-gray-400'}`}>SELL</button>
                            </div>
                            <input type="number" value={amount} onChange={(e)=>setAmount(parseFloat(e.target.value))} className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white mb-3" placeholder="Amount"/>
                            <button onClick={handleTrade} className={`w-full py-2 rounded-lg font-bold text-white ${orderType==='buy'?'bg-green-600':'bg-red-600'}`}>{orderType==='buy'?'BUY':'SELL'} {selectedCoin}</button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

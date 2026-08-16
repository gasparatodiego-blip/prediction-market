'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';

interface Signal {
    type: string;
    confidence: number;
    price: number;
    time: string;
}

export default function HFTPage() {
    const [price, setPrice] = useState(94300);
    const [amount, setAmount] = useState(500);
    const [orderType, setOrderType] = useState('long');
    const [signals, setSignals] = useState<Signal[]>([]);
    const [chartData, setChartData] = useState([92000, 92500, 93500, 93800, 94100, 94300]);

    useEffect(() => {
        const interval = setInterval(() => {
            setPrice(prev => prev + (Math.random() - 0.5) * 80);
            setChartData(prev => [...prev.slice(1), price + (Math.random() - 0.5) * 80]);
            if (Math.random() > 0.7) {
                const signal: Signal = { type: Math.random() > 0.5 ? 'LONG' : 'SHORT', confidence: 65 + Math.random() * 25, price: price, time: new Date().toLocaleTimeString() };
                setSignals(prev => [signal, ...prev].slice(0, 5));
            }
        }, 2000);
        return () => clearInterval(interval);
    }, [price]);

    const handleTrade = () => alert(`${orderType === 'long' ? '🟢 LONG' : '🔴 SHORT'} ${amount} BTC a $${price.toLocaleString()}`);

    return (
        <div className="min-h-screen bg-gray-950">
            <header className="border-b border-gray-800 bg-gray-900/50 px-4 py-3 sticky top-0">
                <div className="max-w-7xl mx-auto flex justify-between items-center">
                    <div><h1 className="text-xl font-bold text-white">⚡ HFT 5-min Trading</h1><p className="text-xs text-gray-500">High Frequency • Mean Reversion • Momentum</p></div>
                    <Link href="/dashboard" className="px-3 py-1 rounded-lg border border-gray-700 text-gray-400 text-sm">← Dashboard</Link>
                </div>
            </header>
            <div className="max-w-7xl mx-auto p-4">
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                    <div className="lg:col-span-2 bg-gray-900/40 rounded-xl border border-gray-800 p-4">
                        <h3 className="font-semibold text-white mb-2">📈 BTC/USDT - HFT 5-min Chart</h3>
                        <div className="relative h-48 w-full">
                            <svg viewBox="0 0 400 150" className="w-full h-full">
                                <polyline points={chartData.map((v,i)=>`${i*66} ${150-((v-Math.min(...chartData))/(Math.max(...chartData)-Math.min(...chartData)))*130}`).join(' ')} fill="none" stroke="#f59e0b" strokeWidth="2"/>
                            </svg>
                        </div>
                        <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                            <div className="bg-gray-800/30 rounded-lg p-2"><div className="text-xs text-gray-500">Stop Loss</div><div className="text-sm font-bold text-red-400">-0.6%</div></div>
                            <div className="bg-gray-800/30 rounded-lg p-2"><div className="text-xs text-gray-500">Take Profit</div><div className="text-sm font-bold text-green-400">+1.2%</div></div>
                            <div className="bg-gray-800/30 rounded-lg p-2"><div className="text-xs text-gray-500">Trailing Stop</div><div className="text-sm font-bold text-blue-400">0.3%</div></div>
                        </div>
                    </div>
                    <div className="space-y-4">
                        <div className="bg-gray-900/40 rounded-xl border border-gray-800 p-4"><h3 className="font-semibold text-white mb-2">⚡ Segnali HFT</h3><div className="space-y-2 max-h-48 overflow-y-auto">{signals.map((s,i)=>(
                            <div key={i} className="bg-gray-800/30 rounded-lg p-2"><div className="flex justify-between"><span className={`font-bold ${s.type === 'LONG' ? 'text-green-400' : 'text-red-400'}`}>{s.type}</span><span className="text-xs text-gray-500">{s.time}</span></div><div className="text-xs text-gray-400">Price: ${s.price.toLocaleString()} | Conf: {s.confidence.toFixed(0)}%</div></div>
                        ))}</div></div>
                        <div className="bg-gray-900/40 rounded-xl border border-gray-800 p-4"><h3 className="font-semibold text-white mb-2">💰 Trade</h3><div className="flex gap-2 mb-3"><button onClick={()=>setOrderType('long')} className={`flex-1 py-2 rounded-lg font-semibold ${orderType==='long'?'bg-green-600 text-white':'bg-gray-800 text-gray-400'}`}>LONG</button><button onClick={()=>setOrderType('short')} className={`flex-1 py-2 rounded-lg font-semibold ${orderType==='short'?'bg-red-600 text-white':'bg-gray-800 text-gray-400'}`}>SHORT</button></div><input type="number" value={amount} onChange={(e)=>setAmount(parseFloat(e.target.value))} className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white mb-3"/><button onClick={handleTrade} className={`w-full py-2 rounded-lg font-bold text-white ${orderType==='long'?'bg-green-600':'bg-red-600'}`}>{orderType==='long'?'LONG':'SHORT'} BTC</button></div>
                    </div>
                </div>
            </div>
        </div>
    );
}

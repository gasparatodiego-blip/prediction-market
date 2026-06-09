'use client';

import { useState, useEffect } from 'react';

export default function HFTPage() {
    const [price, setPrice] = useState(94300);
    const [amount, setAmount] = useState(500);
    const [orderType, setOrderType] = useState('long');

    useEffect(() => {
        const interval = setInterval(() => {
            setPrice(prev => prev + (Math.random() - 0.5) * 100);
        }, 2500);
        return () => clearInterval(interval);
    }, []);

    const handleTrade = () => {
        alert(`${orderType === 'long' ? '🟢 LONG' : '🔴 SHORT'} ${amount} BTC a $${price.toLocaleString()}`);
    };

    return (
        <div>
            <div className="max-w-7xl mx-auto p-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <div className="bg-gray-900/40 rounded-xl border border-gray-800 p-4">
                        <h3 className="font-semibold text-white mb-2">📈 BTC/USDT - HFT 5-min</h3>
                        <div className="text-3xl font-bold text-white">${price.toLocaleString()}</div>
                        <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                            <div className="bg-gray-800/30 rounded-lg p-2"><div className="text-xs text-gray-500">Stop Loss</div><div className="text-sm font-bold text-red-400">-0.6%</div></div>
                            <div className="bg-gray-800/30 rounded-lg p-2"><div className="text-xs text-gray-500">Take Profit</div><div className="text-sm font-bold text-green-400">+1.2%</div></div>
                            <div className="bg-gray-800/30 rounded-lg p-2"><div className="text-xs text-gray-500">Trailing</div><div className="text-sm font-bold text-blue-400">0.3%</div></div>
                        </div>
                    </div>
                    <div className="bg-gray-900/40 rounded-xl border border-gray-800 p-4">
                        <h3 className="font-semibold text-white mb-2">💰 Trade Panel</h3>
                        <div className="flex gap-2 mb-3">
                            <button onClick={() => setOrderType('long')} className={`flex-1 py-2 rounded-lg font-semibold ${orderType === 'long' ? 'bg-green-600 text-white' : 'bg-gray-800 text-gray-400'}`}>LONG</button>
                            <button onClick={() => setOrderType('short')} className={`flex-1 py-2 rounded-lg font-semibold ${orderType === 'short' ? 'bg-red-600 text-white' : 'bg-gray-800 text-gray-400'}`}>SHORT</button>
                        </div>
                        <input type="number" value={amount} onChange={(e) => setAmount(parseFloat(e.target.value) || 0)} className="w-full px-3 py-2 rounded-lg bg-gray-800 border border-gray-700 text-white mb-3" placeholder="Size (USD)" />
                        <button onClick={handleTrade} className={`w-full py-2 rounded-lg font-bold text-white ${orderType === 'long' ? 'bg-green-600' : 'bg-red-600'}`}>
                            {orderType === 'long' ? 'LONG' : 'SHORT'} BTC
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

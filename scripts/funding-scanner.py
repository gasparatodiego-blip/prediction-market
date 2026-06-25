#!/usr/bin/env python3
import urllib.request
import json
from datetime import datetime

def fetch_binance_funding():
    """Ottiene funding rate da Binance"""
    try:
        url = "https://fapi.binance.com/fapi/v1/premiumIndex"
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode())
            results = []
            for item in data:
                symbol = item.get('symbol', '')
                if 'USDT' in symbol:
                    funding_rate = float(item.get('lastFundingRate', 0)) * 100
                    if abs(funding_rate) > 0.005:
                        results.append({
                            'symbol': symbol,
                            'exchange': 'Binance',
                            'funding_rate': round(funding_rate, 4),
                            'annualized': round(funding_rate * 365 * 3, 2)
                        })
            return sorted(results, key=lambda x: abs(x['funding_rate']), reverse=True)[:20]
    except Exception as e:
        return []

def fetch_hyperliquid_funding():
    """Ottiene funding rate da Hyperliquid (DEX)"""
    try:
        url = "https://api.hyperliquid.xyz/info"
        headers = {'Content-Type': 'application/json'}
        data = json.dumps({"type": "allMids"}).encode()
        req = urllib.request.Request(url, data=data, headers=headers, method='POST')
        with urllib.request.urlopen(req, timeout=10) as response:
            mids = json.loads(response.read().decode())
        
        # Ottieni funding rates
        data2 = json.dumps({"type": "fundingHistory", "limit": 200}).encode()
        req2 = urllib.request.Request(url, data=data2, headers=headers, method='POST')
        with urllib.request.urlopen(req2, timeout=10) as response2:
            funding = json.loads(response2.read().decode())
        
        results = []
        for coin, price in mids.items():
            for f in funding:
                if f.get('coin') == coin and f.get('fundingRate'):
                    rate = float(f['fundingRate']) * 100
                    if abs(rate) > 0.005:
                        results.append({
                            'symbol': coin,
                            'exchange': 'Hyperliquid (DEX)',
                            'funding_rate': round(rate, 4),
                            'annualized': round(rate * 365 * 3, 2)
                        })
                        break
        return sorted(results, key=lambda x: abs(x['funding_rate']), reverse=True)[:20]
    except Exception as e:
        return []

def fetch_bybit_funding():
    """Ottiene funding rate da Bybit"""
    try:
        url = "https://api.bybit.com/v5/market/tickers?category=linear"
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode())
            results = []
            for item in data.get('result', {}).get('list', []):
                funding_rate = float(item.get('fundingRate', 0)) * 100
                if abs(funding_rate) > 0.005:
                    results.append({
                        'symbol': item.get('symbol', ''),
                        'exchange': 'Bybit',
                        'funding_rate': round(funding_rate, 4),
                        'annualized': round(funding_rate * 365 * 3, 2)
                    })
            return sorted(results, key=lambda x: abs(x['funding_rate']), reverse=True)[:20]
    except Exception as e:
        return []

def fetch_okx_funding():
    """Ottiene funding rate da OKX"""
    try:
        url = "https://www.okx.com/api/v5/public/funding-rate?instId=BTC-USDT-SWAP"
        with urllib.request.urlopen(url, timeout=10) as response:
            data = json.loads(response.read().decode())
            results = []
            # OKX richiede chiamate per ogni simbolo, limitiamo a BTC/ETH
            symbols = ['BTC-USDT-SWAP', 'ETH-USDT-SWAP', 'SOL-USDT-SWAP']
            for sym in symbols:
                url2 = f"https://www.okx.com/api/v5/public/funding-rate?instId={sym}"
                with urllib.request.urlopen(url2, timeout=10) as response2:
                    data2 = json.loads(response2.read().decode())
                    rate = float(data2.get('data', [{}])[0].get('fundingRate', 0)) * 100
                    if abs(rate) > 0.005:
                        results.append({
                            'symbol': sym.replace('-USDT-SWAP', ''),
                            'exchange': 'OKX',
                            'funding_rate': round(rate, 4),
                            'annualized': round(rate * 365 * 3, 2)
                        })
            return results
    except Exception as e:
        return []

def main():
    print("🔍 Scansione funding rate CEX + DEX...", file=sys.stderr)
    
    all_opportunities = []
    all_opportunities.extend(fetch_binance_funding())
    all_opportunities.extend(fetch_bybit_funding())
    all_opportunities.extend(fetch_okx_funding())
    all_opportunities.extend(fetch_hyperliquid_funding())
    
    # Rimuovi duplicati per simbolo
    seen = set()
    unique_opps = []
    for opp in all_opportunities:
        key = f"{opp['symbol']}_{opp['exchange']}"
        if key not in seen:
            seen.add(key)
            unique_opps.append(opp)
    
    output = {
        "timestamp": datetime.now().isoformat(),
        "exchanges_scanned": ["Binance", "Bybit", "OKX", "Hyperliquid (DEX)"],
        "opportunities_found": len(unique_opps),
        "opportunities": unique_opps[:30]
    }
    
    print(json.dumps(output, indent=2))

if __name__ == "__main__":
    import sys
    main()

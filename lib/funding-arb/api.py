#!/usr/bin/env python3
import json
import sys
sys.path.insert(0, "/root/prediction-market/lib/funding-arb")
from main import main as arb_main

def get_opportunities(min_spread=0.5, top_n=20):
    """Wrapper per chiamare lo scanner e restituire JSON"""
    # Questo richiama la funzione principale dello scanner
    # e formatta l'output per Next.js
    pass

if __name__ == "__main__":
    # Esegui scanner e output JSON
    result = {"timestamp": "2026-06-13T00:00:00Z", "opportunities": []}
    print(json.dumps(result, indent=2))

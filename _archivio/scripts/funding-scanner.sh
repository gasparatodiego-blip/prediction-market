#!/bin/bash
cd /root/prediction-market/lib/funding-arb
python3 main.py --min_spread 0.5 --top_n 20 > /root/prediction-market/public/funding-opportunities.json 2>/dev/null
echo "{\"timestamp\": \"$(date -Iseconds)\", \"source\": \"funding-arb\"}" >> /root/prediction-market/public/funding-opportunities.json

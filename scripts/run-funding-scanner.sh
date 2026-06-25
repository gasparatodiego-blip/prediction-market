#!/bin/bash
cd /root/prediction-market
python3 scripts/funding-scanner.py > public/funding-opportunities.json 2>/dev/null

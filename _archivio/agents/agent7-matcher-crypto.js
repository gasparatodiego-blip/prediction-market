#!/usr/bin/env node
'use strict';

/**
 * Matcher Agent 3 — Crypto & Finance (dedicated high-volume agent)
 *
 * Categories covered:
 *   - Crypto prices & dominance: BTC, ETH, SOL, XRP, altcoins
 *   - DeFi, NFT, Web3, blockchain
 *   - Crypto regulation & ETF decisions
 *   - Traditional finance: forex, commodities, derivatives
 *   - Corporate finance: IPOs, M&A, dividends, credit ratings
 */

const { buildRunner } = require('./shared-matcher');

const KEYWORDS = [
  // Major crypto assets
  'bitcoin', 'btc', 'ethereum', 'eth', 'solana', 'sol', 'ripple', 'xrp',
  'cardano', 'ada', 'dogecoin', 'doge', 'shiba', 'litecoin', 'ltc',
  'polkadot', 'dot', 'avalanche', 'avax', 'chainlink', 'link',
  'bnb', 'binance', 'coinbase', 'kraken', 'bybit',
  // Crypto concepts
  'crypto', 'cryptocurrency', 'blockchain', 'defi', 'nft', 'web3',
  'stablecoin', 'usdt', 'usdc', 'dai', 'staking', 'mining', 'halving',
  'etf', 'spot etf', 'bitcoin etf', 'altcoin', 'memecoin', 'token',
  'wallet', 'exchange', 'decentralized', 'protocol',
  // Crypto regulation
  'sec', 'cftc', 'crypto regulation', 'crypto ban', 'crypto law',
  'satoshi', 'whale', 'bull run', 'bear market', 'all-time high',
  // Traditional finance
  'forex', 'eur/usd', 'gbp/usd', 'usd/jpy', 'dollar', 'euro', 'pound',
  'commodity', 'crude oil', 'brent', 'natural gas', 'silver', 'gold',
  'ipo ', 'spac', 'merger', 'acquisition', 'dividend', 'buyback',
  'credit rating', 'moody', 'fitch', 's&p rating', 'debt ceiling',
  'hedge fund', 'private equity', 'venture capital',
];

const BOOST = [
  'bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'bitcoin etf',
  'halving', 'sec', 'coinbase', 'solana', 'ripple', 'xrp',
  'gold price', 'oil price', 'ipo', 'merger',
];

buildRunner({
  agentName:     'matcher-crypto',
  outFile:       '/tmp/matches-crypto.json',
  categoryLabel: 'Crypto & Finance',
  keywords:      KEYWORDS,
  boostKeywords: BOOST,
  interval:      100_000,
});

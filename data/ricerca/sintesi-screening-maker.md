# Screening dei maker da liquidity rewards — 14 giorni, sola lettura

Generato 2026-08-15T13:37:34.288Z. Finestra **2026-08-02 … 2026-08-15** (14 date di pagamento).
Fonti: `data-api.polymarket.com` (`/activity`, `/positions`, `/value`), `lb-api.polymarket.com/profit`,
`gamma-api.polymarket.com/markets`, RPC Polygon (ricevuta della tx e `balanceOf` pUSD). **Nessuna transazione.**

## L'imbuto

| passo | wallet |
|---|---|
| destinatari del batch indicato | 400 |
| destinatari dell'intera giornata (6 batch) | 2320 |
| ricorrenza ≥10/14 · mediana ≥$1 · >1 pagamento | 1302 |
| due-lateralità ≥30% · \|P&L 7g\| ≤ rewards 7g | **65** |
| …di cui nel batch dei 400 | 10 |

## I primi 20 per rewards nei 14 giorni

| # | wallet | rewards 14g | mediana/g | mercati quotati | capitale stimato | 2 lati | P&L 7g |
|---|---|---|---|---|---|---|---|
| 1 | `0x30fb41b5a08fff5d3dd983f6323e3343931a7db4` | $49.457,73 | $2893,22 | 495+ / 211 | $72.290 | 39% | $-12.380 |
| 2 | `0x403f2471f8aaa1e8a224f1338b073bfa3fdb94f1` | $9851,04 | $414,17 | 105 / 75 | $45.862 | 33% | $1273 |
| 3 | `0x5c0af092b533934008144d223d704b4cbebfa2c3` | $8220,03 | $405,42 | 11 / 109 | $13.057 | 31% | $-1416 |
| 4 | `0xeed8c2be411025120fb511ea2332dd0a1f6135f0` | $8182,22 | $644,26 | 80 / 215 | $3255 | 62% | $-3559 |
| 5 | `0xf7aa193b1d7c880db7f8e2bde9177c4559a8ddd6` | $5146,03 | $331,81 | 7+ / 140 | $1639 | 84% | $-1115 |
| 6 | `0x4b8ae011176b76888949476d7fb7a56985faf4a4` | $4773,90 | $181,07 | 392+ / 120 | $16.630 | 31% | $-23 |
| 7 | `0x4c9affa3a4f5ba6b9ab3dd272c20e47ea47e0cd4` | $3987,47 | $352,24 | 416+ / 273 | $21.512 | 33% | $-3275 |
| 8 | `0x2d6ce0b703efb60f8f356246bcdb98544a54e3f5` | $3808,37 | $237,16 | 129 / 158 | $7727 | 52% | $-1249 |
| 9 | `0x44354bfba2a60adacb5c80f09952ed9cbeb8786f` | $3283,43 | $185,78 | 2 / 137 | $3107 | 31% | $-1025 |
| 10 | `0x9edafdc25b112e399374f72863eb5231e7d86e19` | $3033,97 | $165,68 | 2 / 135 | $2470 | 30% | $-848 |
| 11 | `0xd49829353a5e33f4d29bf976ac9be8bde744a6c5` | $2955,37 | $99,07 | 0 / 74 | $3342 | 32% | $-532 |
| 12 | `0x204b382df532a8106768ccceaf699a89c4ed8ca3` | $2475,82 | $174,75 | 0 / 98 | $20.800 | 41% | $-288 |
| 13 | `0x41e6de55cf3bd608b50952f681dfb562187466b7` | $1827,22 | $86,82 | 121 / 135 | $4264 | 56% | $-243 |
| 14 | `0xc50c05d454f0681ea57b254df8ad97bc210f3017` | $1734,58 | $89,70 | 5 / 167 | $33.432 | 68% | $-804 |
| 15 | `0xa6dcc89a31d7d68c961969eed282690ed41912ec` | $1662,36 | $91,89 | 5 / 45 | $2700 | 56% | $-299 |
| 16 | `0x52870486f74fcd2fe707821b9aa8da0f6d8c3a16` | $1626,98 | $65,61 | 0 / 20 | $4119 | 75% | $21 |
| 17 | `0x87ec6cd961d326bd6caa54b8a2a194440522138f` | $1616,54 | $117,94 | 25 / 93 | $117.748 | 71% | $-987 |
| 18 | `0xf2f2df41cd3ff33147e622869ac052ce5ad2d1f0` | $1520,80 | $95,22 | 7 / 198 | $1047 | 35% | $-375 |
| 19 | `0x6d7f75befd422de6225ad7b4e256622a7b4d1d58` | $1353,66 | $102,02 | 13 / 35 | $995 | 51% | $15 |
| 20 | `0x71df28d9c7adf5e158b5f6c579c69ab9058c9aa0` | $982,92 | $25,39 | 2 / 142 | $653 | 83% | $-64 |

«mercati quotati» = mercati con posizione ≥$5 **/** mercati distinti nel campione degli ultimi 500 trade.
`+` = elenco posizioni troncato a 500 righe ordinate per valore. «capitale stimato» = pUSD nel wallet + valore delle posizioni.

## I mercati più quotati dal gruppo

| maker | con posizione | con trade | minSize | maxSpread | mercato |
|---|---|---|---|---|---|
| **13** | 4 | 11 | 200 | 4.5 | Will there be no change in Fed interest rates after the September 2026 meeting? |
| **11** | 3 | 10 | 50 | 4.5 | Will Harry Kane win the 2026 Ballon d'Or? |
| **11** | 2 | 10 | 20 | 4.5 | Clarity Act (H.R.3633) signed into law in 2026? |
| **10** | 2 | 9 | 50 | 4.5 | Will no Fed rate cuts happen in 2026? |
| **9** | 4 | 8 | 100 | 4.5 | Will the highest temperature in Dallas be between 100-101°F on August 15? |
| **9** | 4 | 8 | 50 | 4.5 | Will no qualifying diplomatic US-Iran meeting occur by September 30, 2026? |
| **9** | 2 | 7 | 200 | 2.5 | Israel x Iran ceasefire continues through August 31? |
| **9** | 2 | 7 | 200 | 4.5 | Will the Fed increase interest rates by 25 bps after the September 2026 meeting? |
| **8** | 5 | 6 | 50 | 4.5 | Will the total domestic gross for The Odyssey be between 530m and 550m by August 31? |
| **8** | 4 | 6 | 100 | 4.5 | Will the highest temperature in Paris be 34°C on August 15? |
| **8** | 4 | 8 | 20 | 4.5 | Will the highest temperature in Madrid be 35°C on August 16? |
| **8** | 3 | 5 | 20 | 4.5 | Will Thomas Chalifoux be the Republican nominee for FL-09? |
| **8** | 3 | 7 | 20 | 5.5 | Will Åsa Johansson be the next Regional Board Chair of Region Värmland? |
| **8** | 3 | 6 | 200 | 4.5 | US announces end of Iranian blockade by August 31, 2026? |
| **8** | 1 | 8 | 100 | 4.5 | Fed rate hike in 2026? |
| **8** | 1 | 8 | 200 | 4.5 | Fed Rate Hike by September 2026 Meeting? |
| **7** | 4 | 4 | 50 | 4.5 | Will there be no next Google Gemini Pro model release by August 31, 2026? |
| **7** | 4 | 6 | 50 | 4.5 | Will Rodri join Barcelona? |
| **7** | 4 | 6 | 20 | 4.5 | Will the highest temperature in Shanghai be 31°C on August 16? |
| **7** | 4 | 7 | 20 | 4.5 | Will the highest temperature in Ankara be 27°C on August 16? |
| **7** | 3 | 6 | 20 | 4.5 | Will the highest temperature in London be 26°C on August 15? |
| **7** | 3 | 7 | 100 | 4.5 | Will the highest temperature in Los Angeles be between 76-77°F on August 15? |
| **7** | 3 | 7 | 20 | 4.5 | Will the highest temperature in Paris be 30°C on August 16? |
| **7** | 3 | 5 | 20 | 4.5 | Will the highest temperature in Munich be 35°C on August 15? |
| **7** | 3 | 5 | 20 | 4.5 | Will the highest temperature in Tokyo be 29°C on August 15? |
| **7** | 3 | 5 | 20 | 4.5 | Will JOLTS Job Openings be between 7.3M and 7.4M in July? |
| **7** | 3 | 5 | 20 | 4.5 | Will Catalina Lauf be the Republican nominee for FL-19? |
| **7** | 3 | 7 | 20 | 5.5 | Will the number of Democratic House members who retire in 2026 be between 24 and 27 inclusive? |
| **7** | 3 | 7 | 100 | 4.5 | Will the highest temperature in Wellington be 10°C on August 16? |
| **7** | 2 | 5 | 50 | 4.5 | Will the next Google Gemini Pro model be released by August 31, 2026? |
| **7** | 2 | 6 | 20 | 4.5 | Will Eric Barlow win the 2026 Wyoming Governor Republican primary election? |
| **7** | 2 | 7 | 20 | 4.5 | Will the highest temperature in Singapore be 32°C on August 16? |
| **7** | 2 | 6 | 20 | 4.5 | Will Canada's GDP growth rate MoM in June 2026 be between 0.2% and 0.3%? |
| **7** | 2 | 7 | 20 | 4.5 | Will the highest temperature in Chengdu be 35°C or higher on August 16? |
| **7** | 2 | 7 | 20 | 4.5 | Will the highest temperature in Helsinki be 22°C on August 16? |
| **7** | 2 | 7 | 20 | 4.5 | Will the highest temperature in London be 26°C on August 16? |
| **7** | 2 | 7 | 50 | 6.5 | Will Kamu Kirk be evicted in Big Brother season 28 (Week 6)? |
| **7** | 2 | 7 | 20 | 4.5 | Will the highest temperature in Wuhan be 33°C on August 16? |
| **7** | 2 | 5 | 50 | 4.5 | Will WTI Crude Oil (WTI) hit (LOW) $70 in August? |
| **7** | 2 | 6 | 50 | 4.5 | Will Avengers: Doomsday have the best domestic opening weekend in 2026? |

## Per famiglia

| famiglia | mercati | presenze |
|---|---|---|
| altro | 1613 | 2249 |
| meteo | 1231 | 2183 |
| politica | 591 | 969 |
| macro-finanza | 322 | 599 |
| cripto | 569 | 570 |
| ai-tech | 230 | 476 |
| sport | 297 | 415 |
| geopolitica | 226 | 394 |
| intrattenimento | 158 | 304 |

## Per `minSize` del venue (sui 120 mercati più quotati)

| minSize | presenze |
|---|---|
| 20 | 464 |
| 50 | 145 |
| 100 | 88 |
| 200 | 79 |

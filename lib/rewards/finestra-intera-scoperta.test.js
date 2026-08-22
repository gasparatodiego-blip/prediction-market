#!/usr/bin/env node
'use strict';
// ═══ LA FINESTRA DEVE ESSERE LETTA PER INTERO — difetto J, 22 agosto 2026 ═════════════════════════
//
// IL FATTO. `agent24` dichiarava a ogni giro «BUDGET ESAURITO a 120p: le fette oltre +36h non sono
// state lette». Le fette 36-42 h e 42-48 h non venivano interrogate MAI, ed è dove sta il grosso dei
// mercati premianti corti. Ma il budget era il sintomo, non la causa: Gamma tronca OGNI query a 2.100
// record e una fetta da 6 h ne contiene di più, quindi anche una fetta letta per intero è troncata.
//
// LA PROPRIETÀ CHE SI DIFENDE QUI — ed è di COMPORTAMENTO, non di sorgente:
//   «un mercato premiante nella finestra 36-48 h, che l'enumerazione di Gamma non raggiunge, DEVE
//    comparire nel censimento.»
// Il finto Gamma qui sotto riproduce il taglio vero: le fette rispondono al più `TETTO_GAMMA` record e
// il mercato buono sta OLTRE quel taglio — esattamente come in produzione. Sul sorgente non corretto
// questo test è ROSSO su tutti e tre i blocchi ①②③: le due passate esistenti non hanno alcun modo di
// raggiungerlo.
//
// ⚠ Non si asserisce su una stringa del sorgente né su un numero di pagine: si guarda cosa ESCE.

const A = require('../../agents/agent24-liquidity-rewards.js');
const { fetchRewardMarkets, FAST_WINDOW_DAYS, GAMMA_PAGE_SIZE } = A;

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const NOW = Date.parse('2026-08-22T12:00:00Z');
const fraOre = (h) => new Date(NOW + h * 3_600_000).toISOString();
const TETTO_GAMMA = 2100;   // il taglio vero della API, misurato: offset ≥ 2100 risponde 422

function mercato(id, ore, rate, over = {}) {
  return {
    conditionId: '0x' + String(id).padStart(64, '0'),
    question: `Mercato ${id}`, slug: null, events: [{ slug: `ev-${id}` }],
    clobRewards: [{ rewardsDailyRate: String(rate), assetAddress: '0xaa' }],
    rewardsMaxSpread: '4.5', rewardsMinSize: '20',
    clobTokenIds: JSON.stringify([`t${id}a`, `t${id}b`]),
    endDate: fraOre(ore),
    lastTradePrice: '0.5', bestBid: '0.49', bestAsk: '0.51', negRisk: false, volume24hr: 1000,
    ...over,
  };
}
/** La riga come la pubblica `/sampling-markets`: dice CHI ha un montepremi, non com'è fatta la riga. */
function campione(m) {
  return {
    condition_id: m.conditionId, end_date_iso: m.endDate,
    rewards: { rates: [{ rewards_daily_rate: Number(m.clobRewards[0].rewardsDailyRate) }],
      min_size: Number(m.rewardsMinSize), max_spread: Number(m.rewardsMaxSpread) },
    active: true, closed: false, accepting_orders: true,
  };
}

/**
 * Un finto venue che riproduce IL TAGLIO VERO.
 *  · Gamma a finestra: ordina come il venue (per id, cioè i più vecchi prima) e taglia a TETTO_GAMMA.
 *  · Gamma per condition_ids: risponde esattamente ciò che gli si chiede — è l'unica strada che
 *    raggiunge un mercato oltre il taglio.
 *  · CLOB /sampling-markets: l'elenco dei premiati, a pagine col cursore.
 */
function venue({ listino = [], dentroFinestra = [], oltreIlTaglio = [], samplingRotto = false, pagineSampling = 1 } = {}) {
  const chiamate = [];
  const perId = new Map();
  for (const m of [...listino, ...dentroFinestra, ...oltreIlTaglio]) perId.set(m.conditionId, m);
  // L'elenco del CLOB conosce TUTTI i premiati, anche quelli che l'enumerazione non raggiunge.
  const elenco = [...dentroFinestra, ...oltreIlTaglio].map(campione);

  return {
    chiamate,
    httpGet: async (url) => {
      chiamate.push(url);

      if (/sampling-markets/.test(url)) {
        if (samplingRotto) throw new Error('CLOB giù');
        const per = Math.ceil(elenco.length / pagineSampling) || 1;
        const cur = (url.match(/next_cursor=([^&]+)/) || [])[1];
        const i = cur ? Number(decodeURIComponent(cur)) : 0;
        const fetta = elenco.slice(i * per, (i + 1) * per);
        const ultima = (i + 1) * per >= elenco.length;
        return { status: 200, data: { data: fetta, next_cursor: ultima ? 'LTE=' : String(i + 1), count: fetta.length } };
      }

      const ids = [...url.matchAll(/condition_ids=([^&]+)/g)].map((m) => decodeURIComponent(m[1]));
      if (ids.length) {
        return { status: 200, data: ids.map((c) => perId.get(c)).filter(Boolean) };
      }

      const off = Number((url.match(/offset=(\d+)/) || [])[1] || 0);
      const mMin = url.match(/end_date_min=([^&]+)/), mMax = url.match(/end_date_max=([^&]+)/);
      if (!mMin || !mMax) {
        const p = listino.slice(off, off + GAMMA_PAGE_SIZE);
        return { status: 200, data: p };
      }
      const da = Date.parse(decodeURIComponent(mMin[1])), a = Date.parse(decodeURIComponent(mMax[1]));
      const dentro = (m) => { const t = Date.parse(m.endDate); return Number.isFinite(t) && t >= da && t <= a; };
      // IL TAGLIO: prima la zavorra (che il venue restituisce per prima), poi — se ci sta — il resto.
      // Ciò che cade oltre TETTO_GAMMA non è raggiungibile da NESSUN offset, come in produzione.
      const zavorra = oltreIlTaglio.filter(dentro).length ? Array.from({ length: TETTO_GAMMA }, (_, i) =>
        ({ ...mercato('zav' + i, 40, 5), clobRewards: null })) : [];
      const visibili = [...zavorra, ...dentroFinestra.filter(dentro)].slice(0, TETTO_GAMMA);
      if (off >= TETTO_GAMMA) return { status: 422, data: null };
      return { status: 200, data: visibili.slice(off, off + GAMMA_PAGE_SIZE) };
    },
  };
}

(async () => {

// ══ ① LA PROPRIETÀ — un ammissibile fra 36 e 48 h DEVE comparire ════════════════════════════════
console.log('\n══ ① UN MERCATO AMMISSIBILE NELLA FINESTRA 36-48h COMPARE NEL CENSIMENTO');
{
  // 39,9 h è l'ora in cui si addensavano gli 80 mercati misurati il 22 agosto; minSize 20 e banda 4,5
  // sono i valori del gruppo. Passa i due cancelli duri (≥ 24 h, minSize ≤ 50), quindi se non compare
  // qui non è la selezione a perderlo: non è mai stato visto.
  const buono = mercato('corto3990', 39.9, 12, { question: 'Will Houthis successfully target shipping on August 24?' });
  const v = venue({ listino: [mercato('lontano', 24 * 100, 47)], oltreIlTaglio: [buono] });
  const out = await fetchRewardMarkets({ httpGet: v.httpGet, nowMs: NOW });

  const trovato = out.find((m) => /Houthis/.test(m.question));
  ok('il mercato a 39,9 h è nel censimento', !!trovato,
    trovato ? `${out.length} mercati` : `NON TROVATO — ${out.length} mercati: ${out.map((m) => m.question).join(', ')}`);
  if (trovato) {
    // Non basta che ci sia: dev'essere una riga USABILE, cioè indistinguibile da una di Gamma.
    ok('  porta il montepremi', trovato.rewardsDailyRate === 12, String(trovato.rewardsDailyRate));
    ok('  porta la banda premiante', trovato.rewardsMaxSpread === 4.5, String(trovato.rewardsMaxSpread));
    ok('  porta la size minima del venue', trovato.rewardsMinSize === 20, String(trovato.rewardsMinSize));
    ok('  porta ENTRAMBI i token: senza il NO non si costruisce la coppia',
      typeof trovato.tokenId === 'string' && typeof trovato.tokenIdNo === 'string');
    ok('  porta la scadenza, ed è quella vera', trovato.endDate === fraOre(39.9), String(trovato.endDate));
    ok('  e la provenienza della scadenza è dichiarata, non inventata',
      trovato.endDateSource === 'market' || trovato.endDateSource === 'event', String(trovato.endDateSource));
  }
  ok('  e il lontano della prima passata non è stato perso', out.some((m) => /lontano/.test(m.question)));
}

// ══ ② L'INTERA FINESTRA, ORA PER ORA — non solo la banda che il budget raggiungeva ═══════════════
console.log('\n══ ② OGNI ORA DELLA FINESTRA È COPERTA, COMPRESE LE ULTIME DODICI');
{
  const oltre = [];
  for (let h = 1; h < FAST_WINDOW_DAYS * 24; h += 3) oltre.push(mercato('h' + h, h + 0.5, 10));
  const v = venue({ oltreIlTaglio: oltre });
  const out = await fetchRewardMarkets({ httpGet: v.httpGet, nowMs: NOW });
  const ore = out.map((m) => (Date.parse(m.endDate) - NOW) / 3_600_000);

  ok('nessuna ora della finestra manca', out.length === oltre.length, `${out.length} di ${oltre.length}`);
  ok('  la banda 36-48 h — quella che il budget non raggiungeva — è presente',
    ore.filter((o) => o >= 36 && o < 48).length === oltre.filter((m) => {
      const o = (Date.parse(m.endDate) - NOW) / 3_600_000; return o >= 36 && o < 48;
    }).length, `${ore.filter((o) => o >= 36 && o < 48).length} mercati fra 36 e 48 h`);
  ok('  e non entra nulla OLTRE la finestra', ore.every((o) => o <= FAST_WINDOW_DAYS * 24 + 0.001));
}

// ══ ③ NON SI CHIEDE DUE VOLTE CIÒ CHE GAMMA HA GIÀ DATO ═════════════════════════════════════════
console.log('\n══ ③ L\'UNIONE NON DUPLICA, E NON RICHIEDE IL GIÀ NOTO');
{
  const gia = mercato('gia', 5, 30);
  const nuovo = mercato('nuovo', 40, 30);
  const v = venue({ dentroFinestra: [gia], oltreIlTaglio: [nuovo] });
  const out = await fetchRewardMarkets({ httpGet: v.httpGet, nowMs: NOW });

  ok('i due mercati ci sono entrambi, una volta ciascuno', out.length === 2, `${out.length}`);
  const perIdQuery = v.chiamate.filter((u) => /condition_ids=/.test(u));
  const idsChiesti = perIdQuery.flatMap((u) => [...u.matchAll(/condition_ids=([^&]+)/g)].map((m) => decodeURIComponent(m[1])));
  ok('  il mercato che Gamma aveva già dato NON viene richiesto per id',
    !idsChiesti.includes(gia.conditionId), `${idsChiesti.length} id chiesti`);
  ok('  quello che mancava sì', idsChiesti.includes(nuovo.conditionId));
}

// ══ ④ FAIL-OPEN NEI DUE VERSI — una passata che cade non azzera le altre ════════════════════════
console.log('\n══ ④ SE UNA PASSATA CADE, LE ALTRE RESTANO');
{
  const v = venue({ listino: [mercato('listino', 24 * 100, 5)], dentroFinestra: [mercato('fetta', 3, 5)],
    oltreIlTaglio: [mercato('perso', 40, 5)], samplingRotto: true });
  const out = await fetchRewardMarkets({ httpGet: v.httpGet, nowMs: NOW });
  ok('CLOB giù ⇒ il board non è vuoto, restano listino e fette',
    out.length === 2 && out.some((m) => /listino/.test(m.question)) && out.some((m) => /fetta/.test(m.question)),
    `${out.length} mercati`);

  // …e viceversa: Gamma a finestra giù, la terza passata porta comunque i corti.
  const base = venue({ oltreIlTaglio: [mercato('corto', 40, 5)] });
  const soloTerza = {
    httpGet: async (url) => {
      if (/end_date_min=/.test(url)) throw new Error('Gamma finestre giù');
      return base.httpGet(url);
    },
  };
  const out2 = await fetchRewardMarkets({ httpGet: soloTerza.httpGet, nowMs: NOW });
  ok('  fette giù ⇒ la terza passata porta comunque il corto',
    out2.length === 1 && /corto/.test(out2[0].question), `${out2.length} mercati`);
}

// ══ ⑤ MONOTONA — la terza passata può solo AGGIUNGERE ═══════════════════════════════════════════
console.log('\n══ ⑤ LA TERZA PASSATA NON TOGLIE E NON FILTRA');
{
  // Lo stesso universo, con e senza il canale del venue: l'insieme senza è un SOTTOINSIEME di quello con.
  const listino = [mercato('L1', 24 * 90, 5), mercato('L2', 24 * 91, 5)];
  const dentro = [mercato('F1', 2, 5), mercato('F2', 8, 5)];
  const oltre = [mercato('O1', 44, 5)];

  const conVenue = venue({ listino, dentroFinestra: dentro, oltreIlTaglio: oltre });
  const senzaVenue = venue({ listino, dentroFinestra: dentro, oltreIlTaglio: oltre, samplingRotto: true });
  const A1 = new Set((await fetchRewardMarkets({ httpGet: conVenue.httpGet, nowMs: NOW })).map((m) => m.conditionId));
  const B1 = new Set((await fetchRewardMarkets({ httpGet: senzaVenue.httpGet, nowMs: NOW })).map((m) => m.conditionId));
  ok('senza il canale del venue si vede un sottoinsieme, mai qualcosa in più',
    [...B1].every((c) => A1.has(c)), `con ${A1.size} · senza ${B1.size}`);
  ok('  e con il canale si vede di più, non uguale', A1.size > B1.size, `${A1.size} > ${B1.size}`);

  // Nessun filtro NUOVO: un montepremi zero resta escluso anche se il venue lo elenca.
  const zero = mercato('zero', 40, 0);
  const v = venue({ oltreIlTaglio: [zero, mercato('vivo', 40, 7)] });
  const out = await fetchRewardMarkets({ httpGet: v.httpGet, nowMs: NOW });
  ok('  montepremi zero resta escluso anche per la terza strada',
    out.length === 1 && /vivo/.test(out[0].question), `${out.length} mercati`);
}

// ══ ⑥ NON SI INVENTA UNA SCADENZA ═══════════════════════════════════════════════════════════════
console.log('\n══ ⑥ SENZA SCADENZA PUBBLICATA IL MERCATO NON ENTRA NELLA FINESTRA');
{
  // Il venue elenca un premiato senza `end_date_iso`. «Non ho letto la data» non è «la data è vicina»:
  // è la famiglia `Number(null) === 0` di §5.3, e qui il ramo sbagliato aprirebbe un cancello.
  const cieco = mercato('cieco', 40, 50);
  const v = venue({ oltreIlTaglio: [cieco] });
  const g = {
    httpGet: async (url) => {
      const r = await v.httpGet(url);
      if (/sampling-markets/.test(url) && r.data && Array.isArray(r.data.data)) {
        r.data.data = r.data.data.map((x) => ({ ...x, end_date_iso: null }));
      }
      return r;
    },
  };
  const out = await fetchRewardMarkets({ httpGet: g.httpGet, nowMs: NOW });
  ok('un premiato senza scadenza pubblicata non viene collocato nella finestra',
    out.length === 0, `${out.length} mercati`);
}

console.log(`\nfinestra intera scoperta: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);
})();

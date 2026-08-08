#!/usr/bin/env node
'use strict';
// I MERCATI CHE NON VENIVANO MAI CHIESTI.
//
// Il board di agent24 aveva 115 mercati e il più corto scadeva fra 2,41 giorni, mentre i 21 maker di
// riferimento entrano con mediana 5,3 ore. Non era un filtro di categoria: era la PAGINAZIONE.
// `active=true&closed=false` viene troncata da Gamma a ~2.100 record — misurato: offset 2100 risponde
// vuoto sia sul listino intero sia su una finestra di tre giorni — e l'ordinamento di difetto è per
// `id` crescente, cioè dal mercato più vecchio. I mercati a scadenza rapida sono i più recenti, quindi
// cadevano oltre il taglio e non sono MAI stati interrogati.
//
// La seconda passata chiede lo stesso universo da un capo diverso (`order=endDate&ascending=true` con
// `end_date_min=adesso`) e cammina in avanti fermandosi appena supera la finestra.
//
// Qui l'HTTP è iniettato: si prova la LOGICA — due passate, unione, fermata — su pagine finte, senza
// toccare la rete e senza sfiorare `data/liquidity-rewards.json`.

const { fetchRewardMarkets, FAST_WINDOW_DAYS, FAST_SLICE_HOURS, FAST_MAX_PAGES, MAX_PAGES, GAMMA_PAGE_SIZE } =
  require('../../agents/agent24-liquidity-rewards.js');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const NOW = Date.parse('2026-08-08T14:00:00Z');
const fraOre = (h) => new Date(NOW + h * 3_600_000).toISOString();

/** Un record Gamma premiato, coi soli campi che `fetchRewardMarkets` legge davvero. */
function mercato(id, ore, rate, over = {}) {
  return {
    conditionId: '0x' + String(id).padStart(64, '0'),
    question: `Mercato ${id}`,
    slug: null, events: [{ slug: `ev-${id}` }],
    clobRewards: [{ rewardsDailyRate: String(rate), assetAddress: '0xaa' }],
    rewardsMaxSpread: '4.5', rewardsMinSize: '50',
    clobTokenIds: JSON.stringify([`t${id}a`, `t${id}b`]),
    endDate: fraOre(ore),
    lastTradePrice: '0.5', bestBid: '0.49', bestAsk: '0.51', negRisk: false, volume24hr: 1000,
    ...over,
  };
}
const pagina = (arr) => ({ status: 200, data: arr });
const VUOTA = pagina([]);

/** Un finto Gamma: due universi distinti, uno per passata, così si vede QUALE ha trovato cosa. */
function finto({ listino = [], vicine = [] } = {}) {
  const chiamate = [];
  return {
    chiamate,
    httpGet: async (url) => {
      chiamate.push(url);
      const off = Number((url.match(/offset=(\d+)/) || [])[1] || 0);
      // La seconda passata si riconosce dalla finestra: ogni fetta porta il suo end_date_min/max.
      const mMin = url.match(/end_date_min=([^&]+)/);
      const mMax = url.match(/end_date_max=([^&]+)/);
      if (!mMin || !mMax) {
        const p = listino.slice(off, off + GAMMA_PAGE_SIZE);
        return p.length ? pagina(p) : VUOTA;
      }
      // Il finto Gamma rispetta la finestra come quello vero: fuori dai suoi estremi non risponde.
      const da = Date.parse(decodeURIComponent(mMin[1])), a2 = Date.parse(decodeURIComponent(mMax[1]));
      const dentro = vicine.filter((m) => { const t = Date.parse(m.endDate); return Number.isFinite(t) && t >= da && t <= a2; });
      const p = dentro.slice(off, off + GAMMA_PAGE_SIZE);
      return p.length ? pagina(p) : VUOTA;
    },
  };
}

(async () => {

// ══ 1 · LE NUOVE CATEGORIE ENTRANO, E CON I DATI COMPLETI ═══════════════════════════════════════
console.log('\n══ LA SECONDA PASSATA TROVA CIÒ CHE LA PRIMA NON VEDE');
{
  // Il listino contiene solo mercati lontani, come il board vero dell'8 agosto.
  const listino = [mercato('lontano1', 24 * 144, 47), mercato('lontano2', 24 * 145, 30)];
  // La camminata ordinata trova i veri casi misurati quel giorno.
  const vicine = [
    mercato('solana', 0.4, 833.33, { question: 'Solana Up or Down - August 8, 10:15AM-10:30AM ET', rewardsMaxSpread: '1.5' }),
    mercato('doge', 0.4, 416.67, { question: 'Dogecoin Up or Down - August 8, 10:15AM-10:30AM ET', rewardsMaxSpread: '1.5' }),
    mercato('hi01a', 9.6, 51, { question: 'Will Jarrett Keohokalole be the HI-01 Democratic nominee?' }),
    mercato('hi01b', 9.6, 50, { question: 'Will Ed Case be the HI-01 Democratic nominee?' }),
    mercato('houthi', 33.6, 1, { question: 'Will Houthis successfully target shipping on August 9?' }),
  ];
  const g = finto({ listino, vicine });
  const out = await (fetchRewardMarkets({ httpGet: g.httpGet, nowMs: NOW }));

  ok('il board contiene sia i lontani sia i vicini', out.length === 7, `${out.length} mercati`);
  const q = new Set(out.map((m) => m.question));
  ok('  «Solana Up or Down» c\'è', [...q].some((x) => /Solana Up or Down/.test(x)));
  ok('  «Dogecoin Up or Down» c\'è', [...q].some((x) => /Dogecoin Up or Down/.test(x)));
  ok('  i due HI-01 a 9,6 ore ci sono', [...q].filter((x) => /HI-01/.test(x)).length === 2);
  ok('  e i lontani NON sono stati persi (la prima passata è intatta)',
    [...q].filter((x) => /lontano/.test(x)).length === 2);

  // ── NON «ciechi»: la pipeline a valle ha bisogno di questi campi, uno per uno.
  const sol = out.find((m) => /Solana/.test(m.question));
  ok('il mercato nuovo porta il montepremi', sol.rewardsDailyRate === 833.33, String(sol.rewardsDailyRate));
  ok('  la banda (serve al punteggio quadratico e al tetto di banda)', sol.rewardsMaxSpread === 1.5, String(sol.rewardsMaxSpread));
  ok('  la size minima premiante del venue', sol.rewardsMinSize === 50, String(sol.rewardsMinSize));
  ok('  ENTRAMBI i token id — senza il NO non si costruisce la coppia',
    typeof sol.tokenId === 'string' && typeof sol.tokenIdNo === 'string');
  ok('  la scadenza, che è il campo su cui il tetto orizzonte decide', typeof sol.endDate === 'string');
  ok('  e la sua provenienza dichiarata', sol.endDateSource === 'market' || sol.endDateSource === 'event',
    String(sol.endDateSource));
  ok('  il conditionId, chiave di tutto il resto della pipeline', /^0x[0-9a-z]+$/.test(sol.conditionId));
}

// ══ 2 · LE FETTE — è la partizione che aggira il tetto dei 2.100 di Gamma ══════════════════════
console.log('\n══ LA FINESTRA SI INTERROGA A FETTE, NON SI PERCORRE');
{
  // Un mercato premiato in ogni fetta della finestra, più uno appena oltre.
  const vicine = [];
  const fette = Math.ceil((FAST_WINDOW_DAYS * 24) / FAST_SLICE_HOURS);
  for (let i = 0; i < fette; i++) vicine.push(mercato('f' + i, i * FAST_SLICE_HOURS + 1, 10 + i));
  vicine.push(mercato('oltre', FAST_WINDOW_DAYS * 24 + 12, 999));

  const g = finto({ listino: [], vicine });
  const out = await (fetchRewardMarkets({ httpGet: g.httpGet, nowMs: NOW }));

  ok('ogni fetta della finestra viene interrogata', out.length === fette, `${out.length} di ${fette}`);
  ok('  e il mercato OLTRE la finestra non entra', !out.some((m) => /oltre/.test(m.question)));

  const conFinestra = g.chiamate.filter((u) => /end_date_min=/.test(u));
  const finestreDistinte = new Set(conFinestra.map((u) => (u.match(/end_date_min=([^&]+)/) || [])[1]));
  ok('  le query sono PARTIZIONATE: una finestra distinta per fetta',
    finestreDistinte.size === fette, `${finestreDistinte.size} finestre`);
  ok('  ognuna porta anche il suo estremo superiore', conFinestra.every((u) => /end_date_max=/.test(u)));
  ok('il budget di pagine è un tetto sull\'intera passata, non sulla singola fetta',
    conFinestra.length <= FAST_MAX_PAGES, `${conFinestra.length} pagine ≤ ${FAST_MAX_PAGES}`);
}

// ══ 3 · REGRESSIONE — la prima passata si comporta esattamente come prima ═══════════════════════
console.log('\n══ REGRESSIONE — il listino non è cambiato');
{
  const listino = [
    mercato('a', 24 * 100, 47),
    mercato('b', 24 * 100, 0),                                   // montepremi zero → scartato, come prima
    mercato('c', 24 * 100, 47, { rewardsMaxSpread: '0' }),       // senza banda → scartato, come prima
    mercato('d', 24 * 100, 47, { clobTokenIds: '[]' }),          // senza token → scartato, come prima
    mercato('e', 24 * 100, 0.005),                               // sotto la soglia 0,01 → scartato
  ];
  const g = finto({ listino, vicine: [] });
  const out = await (fetchRewardMarkets({ httpGet: g.httpGet, nowMs: NOW }));
  ok('dei cinque record solo quello valido entra', out.length === 1, `${out.length}`);
  ok('  montepremi zero ancora escluso', !out.some((m) => m.rewardsDailyRate === 0));
  ok('  banda assente ancora esclusa', !out.some((m) => m.rewardsMaxSpread === 0));

  // Nessun filtro di CATEGORIA è stato introdotto: era il sospetto iniziale, e la correzione non deve
  // averlo creato per sbaglio dall'altra parte.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', '..', 'agents', 'agent24-liquidity-rewards.js'), 'utf8');
  ok('nessun filtro su categoria nella scoperta', !/categoryFromText\([^)]*\)\s*(===|!==|\.includes)/.test(src));
  ok('  e nessun filtro sul montepremi minimo oltre la soglia storica di 0,01',
    (src.match(/rate <= 0\.01/g) || []).length === 1);

  // ── L'UNIONE non duplica: lo stesso mercato trovato da entrambe le passate conta una volta sola.
  const doppio = mercato('doppio', 10, 99);
  const g2 = finto({ listino: [doppio], vicine: [doppio] });
  const out2 = await (fetchRewardMarkets({ httpGet: g2.httpGet, nowMs: NOW }));
  ok('lo stesso mercato visto da entrambe le passate compare UNA volta', out2.length === 1, `${out2.length}`);
}

// ══ 4 · I CASI SCOMODI ══════════════════════════════════════════════════════════════════════════
console.log('\n══ QUELLO CHE NON DEVE SUCCEDERE');
{
  // SCADENZA ILLEGGIBILE — e qui c'è un limite VERO della seconda passata, che vale dichiarare invece
  // di nascondere: una query a finestra (`end_date_min`/`end_date_max`) per costruzione non può
  // restituire un mercato la cui scadenza il venue non pubblica. Quei mercati restano scopribili solo
  // dalla PRIMA passata, che non filtra sulle date. Nessuno viene perso; semplicemente il secondo
  // canale non li vede, ed è una proprietà della domanda che si fa, non un difetto da correggere qui.
  const ignoto = mercato('ignota', 1, 20, { endDate: null, events: [] });
  const g = finto({ listino: [ignoto], vicine: [mercato('dopo', 2, 20)] });
  const out = await (fetchRewardMarkets({ httpGet: g.httpGet, nowMs: NOW }));
  ok('un mercato senza scadenza arriva comunque, dalla prima passata',
    out.length === 2 && out.some((m) => m.endDate === null), `${out.length} mercati`);
  ok('  e la sua scadenza resta null: non viene inventata',
    out.find((m) => /ignota/.test(m.question)).endDate === null);

  // Una passata che fallisce non deve azzerare l'altra.
  const rotto = {
    httpGet: async (url) => {
      if (/end_date_min=/.test(url)) throw new Error('Gamma giù');
      const off = Number((url.match(/offset=(\d+)/) || [])[1] || 0);
      return off === 0 ? pagina([mercato('sopravvive', 24 * 50, 12)]) : VUOTA;
    },
  };
  const out2 = await (fetchRewardMarkets({ httpGet: rotto.httpGet, nowMs: NOW }));
  ok('se la seconda passata fallisce, la prima resta e il board non è vuoto',
    out2.length === 1 && /sopravvive/.test(out2[0].question), `${out2.length} mercati`);

  const rotto1 = {
    httpGet: async (url) => {
      if (!/end_date_min=/.test(url)) throw new Error('Gamma giù');
      const off = Number((url.match(/offset=(\d+)/) || [])[1] || 0);
      // Solo la prima fetta risponde: basta a provare che la passata 2 lavora da sola.
      return (off === 0 && /end_date_min/.test(url) && url.includes(encodeURIComponent(new Date(NOW).toISOString().slice(0, 19) + 'Z')))
        ? pagina([mercato('vicino', 5, 60)]) : VUOTA;
    },
  };
  const out3 = await (fetchRewardMarkets({ httpGet: rotto1.httpGet, nowMs: NOW }));
  ok('  e viceversa: se cade la prima, la seconda porta comunque i vicini',
    out3.length === 1 && /vicino/.test(out3[0].question), `${out3.length} mercati`);

  ok('il listino conserva il suo tetto di pagine storico', MAX_PAGES === 21, String(MAX_PAGES));
}

console.log(`\nscoperta scadenze vicine: ${pass} passati, ${fail} falliti`);
  process.exit(fail ? 1 : 0);
})();

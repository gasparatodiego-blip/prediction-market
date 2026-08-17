#!/usr/bin/env node
'use strict';
/**
 * I CINQUE MIGLIORI CON SCADENZA FRA 24 E 72 ORE — sola misura, nessuna scelta.
 *
 * ═══ LA DOMANDA DELL'OPERATORE (17 agosto 2026) ═════════════════════════════════════════════════════
 * «Oltre 7 giorni il lordo e' zero su tutti i candidati: ~62 share nostre contro decine di migliaia
 *  altrui. Il valore sta a ~1,3 giorni. Dammi i cinque migliori con scadenza fra 24 e 72 ore:
 *  netto/giorno, concorrenza, minSize, pavimento premiante, e per ognuno **cosa succede alla scadenza
 *  mentre il bot ci ha sopra una coppia aperta**.»
 *
 * ═══ DA DOVE VENGONO I NUMERI ═══════════════════════════════════════════════════════════════════════
 * Il netto/giorno viene da `allocator.planFromCollection`, cioe' dal PIANIFICATORE VERO girato al
 * capitale vero col tetto per mercato vero. Non e' una formula riscritta qui. I cancelli di
 * candidabilita' sono le funzioni vere: `concentration.pavimentoPremiante`,
 * `selezione-mercati.valutaAmmissibilita`, `horizon`.
 *
 * ⚠ LA SCADENZA NON SI LEGGE DA `candidate.horizon`: su questi board quel campo e' `undefined` per
 * decine di righe, e filtrarci sopra fa uscire «zero candidabili» — un `Number(null)` travestito da
 * misura (§5.3, ed e' successo davvero il 17 agosto). Si legge dal BOARD, ancorata al venue (§4.7).
 *
 * ═══ LA SECONDA META' DELLA DOMANDA, E VIENE DAL CODICE ═════════════════════════════════════════════
 * «Cosa succede alla scadenza con una coppia aperta» non e' un'opinione: e' una sequenza di meccanismi
 * che esistono, con le loro costanti. Questo script le LEGGE dai moduli veri (`modalita-chiusura`,
 * `market-clock`, `auto-reprice-config`, `selezione-mercati`) e le mette in fila per ogni mercato, con
 * l'ora esatta in cui ognuna scatta. Niente e' scritto a mano qui dentro.
 *
 * ⚠ E LA RISPOSTA DIPENDE DA UNA COSA SOLA — se la coppia e' COMPLETA o no — perche' i due casi hanno
 * esiti opposti: una coppia completa vale $1/share alla risoluzione qualunque sia l'esito, una gamba
 * nuda vale $1 o $0. Lo script dice entrambi.
 *
 * Uso:  node scripts/ricerca/mercati-corti-24-72h.js [--capitale N]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data', 'ricerca', 'mercati-corti-24-72h.json');

const A = require(path.join(ROOT, 'lib/rewards/allocator'));
const CONC = require(path.join(ROOT, 'lib/rewards/concentration'));
const SELM = require(path.join(ROOT, 'lib/maker/selezione-mercati'));
const HOR = require(path.join(ROOT, 'lib/rewards/horizon'));
const CHIUS = require(path.join(ROOT, 'lib/maker/modalita-chiusura'));
const CLOCK = require(path.join(ROOT, 'lib/maker/market-clock'));
const ARC = require(path.join(ROOT, 'lib/maker/auto-reprice-config'));
const { fileRuntime } = require(path.join(ROOT, 'lib/percorsi-runtime'));
const { raggioBandaCents } = require(path.join(ROOT, 'lib/banda-premiante'));

const iCap = process.argv.indexOf('--capitale');
const CAPITALE = iCap > 0 && Number.isFinite(Number(process.argv[iCap + 1])) ? Number(process.argv[iCap + 1]) : 147;
const ORE_MIN = 24;
const ORE_MAX = 72;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const usd = (x) => (x == null ? '—' : `$${Number(x).toFixed(2)}`);
const ora2 = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + 'Z';

(async () => {
  // ⚠ IL BOARD GREZZO DI agent24, NON QUELLO NORMALIZZATO — e la prima stesura sbagliava, con un
  // sintomo che vale la pena lasciare scritto: l'imbuto usciva «141 valutati, 141 senza minSize
  // leggibile, ZERO candidabili». Sembrava una misura («nessun mercato passa il primo cancello») ed era
  // un mismatch di SCHEMA: `rewards-normalize` rinomina i campi (`conditionId`→`marketId`,
  // `rewardsMinSize`→`minSize`, `mid`→`midpoint`), quindi ogni riga cadeva sul primo `get`. Un imbuto
  // che attribuisce tutto al primo cancello e' il segnale da cui insospettirsi.
  // Qui servono i campi del venue (`rewardsMinSize`, `rewardsMaxSpread`, `existing_depth_usd`), che
  // sono quelli del grezzo — lo stesso file che legge `allocator`.
  const fileBoard = path.join(require(path.join(ROOT, 'lib/safety/store')).DATA_DIR, 'liquidity-rewards.json');
  const grezzo = JSON.parse(fs.readFileSync(fileBoard, 'utf8'));
  const righeBoard = Array.isArray(grezzo) ? grezzo : (grezzo.markets || []);
  const perId = new Map(righeBoard.map((r) => [String(r.conditionId || r.marketId || '').toLowerCase(), r]));
  const ora = Date.now();
  const tettoMercato = CONC.capPerMarketUsd(CAPITALE);
  const etaBoardMin = grezzo.meta && grezzo.meta.generatedAt
    ? +((ora - Date.parse(grezzo.meta.generatedAt)) / 60000).toFixed(1) : null;

  const piano = A.planFromCollection({ capital: CAPITALE, maxPerMarketUsd: tettoMercato, horizonFilter: true });

  // ⚠ SI PRETENDE CHE LE DUE FONTI SI PARLINO: se il pianificatore e il board non condividono nemmeno
  // una chiave, l'imbuto direbbe «zero candidabili» invece di «non ho potuto misurare». Fail-closed
  // rumoroso, non silenzioso — e' lo stesso principio di `percorsi-critici`.
  const chiaviPiano = (piano.candidates || []).map((c) => String(c.marketId || '').toLowerCase());
  const incroci = chiaviPiano.filter((k) => perId.has(k)).length;
  if (chiaviPiano.length && incroci === 0) {
    console.error(`\n🔴 il piano e il board non hanno NESSUNA chiave in comune (${chiaviPiano.length} candidati, ${righeBoard.length} righe).`);
    console.error('   Non e\' una misura: e\' uno schema che non combacia. Non proseguo con un imbuto che darebbe zero.\n');
    process.exit(1);
  }

  // ── L'IMBUTO, contato: senza, «cinque su N» non dice cosa ha tolto cosa ──────────────────────────
  const imbuto = { valutati: 0, senzaMinSize: 0, pavimentoOltreIlTetto: 0, selezione: 0,
    scadenzaIgnota: 0, fuoriFinestra: 0, nettoNonCalcolabile: 0, superstiti: 0 };
  const dentro = [];
  for (const c of piano.candidates || []) {
    imbuto.valutati += 1;
    const id = String(c.marketId || '').toLowerCase();
    const b = perId.get(id);
    if (!b) { imbuto.senzaMinSize += 1; continue; }
    const minSize = Number(b.rewardsMinSize);
    if (!fin(minSize) || minSize <= 0) { imbuto.senzaMinSize += 1; continue; }
    const pavimento = CONC.pavimentoPremiante(minSize);
    if (!(fin(pavimento) && pavimento <= tettoMercato)) { imbuto.pavimentoOltreIlTetto += 1; continue; }
    const amm = SELM.valutaAmmissibilita(b, { ora, orizzonteMassimoOre: HOR.maxHorizonDays() * 24 });
    if (amm.ammissibile !== true) { imbuto.selezione += 1; continue; }
    const scadMs = Date.parse(b.endDate || b.endDateClob || b.endDateGamma || '');
    if (!Number.isFinite(scadMs)) { imbuto.scadenzaIgnota += 1; continue; }
    const ore = (scadMs - ora) / 3_600_000;
    if (!(ore >= ORE_MIN && ore <= ORE_MAX)) { imbuto.fuoriFinestra += 1; continue; }
    if (!fin(c.bestNetPerDay)) { imbuto.nettoNonCalcolabile += 1; continue; }
    imbuto.superstiti += 1;
    dentro.push({ c, b, minSize, pavimento, scadMs, ore });
  }
  dentro.sort((x, y) => y.c.bestNetPerDay - x.c.bestNetPerDay);
  const primi = dentro.slice(0, 5);

  // ── COSA SUCCEDE ALLA SCADENZA, letto dai moduli veri ────────────────────────────────────────────
  // Le costanti NON sono ricopiate: si chiedono ai moduli che le applicano.
  const COST = {
    oreChiusuraForzata: CHIUS.ORE_CHIUSURA_FORZATA,
    minutiMinimiAllaChiusura: CLOCK.minMinutesToClose(),
    gtdSecondi: ARC.RESTING_GTD_SECONDS,
    margineRinnovoSecondi: ARC.REFRESH_MARGIN_SECONDS,
    orizzonteMinimoOreSelezione: SELM.ORIZZONTE_MINIMO_ORE,
    orizzonteMinimoGiorniPiano: HOR.MIN_HORIZON_DAYS,
  };

  function sequenzaAllaScadenza(scadMs) {
    // Ogni voce: quando scatta, cosa fa, e da quale modulo viene la costante.
    const tappe = [
      // ⚠ LA PRIMA TAPPA E' LA SELEZIONE, NON L'ORIZZONTE DEL PIANO, e su un mercato corto e' quella
      // che arriva per prima di parecchio: 24 ore contro 12. Ometterla — come faceva la prima stesura —
      // significava dire all'operatore che «non succede niente» per le prime dodici ore in cui invece
      // il mercato viene gia' RILASCIATO dallo slot.
      { istanteMs: scadMs - COST.orizzonteMinimoOreSelezione * 3_600_000,
        cosa: `la SELEZIONE lo rilascia: scende sotto le ${COST.orizzonteMinimoOreSelezione} ore di orizzonte minimo`,
        modulo: 'lib/maker/selezione-mercati (ORIZZONTE_MINIMO_ORE) + scadenzeFuoriPerimetro',
        effetto: 'lo slot si libera e ne entra un altro; `rilasciaDallaSelezione` spegne l\'INGRESSO, non l\'uscita — '
          + 'la posizione resta gestita da §4.8 (uscita automatica, riprezzo, merge)' },
      { istanteMs: scadMs - COST.orizzonteMinimoGiorniPiano * 86_400_000,
        cosa: `esce dall'universo del PIANO: sotto ${COST.orizzonteMinimoGiorniPiano} giorni il filtro d'orizzonte non lo ammette piu'`,
        modulo: 'lib/rewards/horizon (MIN_HORIZON_DAYS)',
        effetto: 'nessuna riga nuova nel piano — quello che e\' gia\' a libro NON viene toccato da questo' },
      { istanteMs: scadMs - COST.oreChiusuraForzata * 3_600_000,
        cosa: `CHIUSURA FORZATA a ${COST.oreChiusuraForzata} ore dalla risoluzione`,
        modulo: 'lib/maker/modalita-chiusura (ORE_CHIUSURA_FORZATA)',
        effetto: 'una coppia COMPLETA non si forza (vale $1 comunque); una gamba NUDA viene spinta all\'uscita' },
      { istanteMs: scadMs - COST.minutiMinimiAllaChiusura * 60_000,
        cosa: `il venue smette di essere quotabile: ${COST.minutiMinimiAllaChiusura} minuti alla chiusura`,
        modulo: 'lib/maker/market-clock (minMinutesToClose)',
        effetto: 'gate `market-too-close-to-close`: nessun ordine nuovo, nemmeno un rinnovo' },
      { istanteMs: scadMs,
        cosa: 'chiusura del mercato al venue',
        modulo: 'venue',
        effetto: 'gli ordini a riposo non rinnovati muoiono per GTD entro '
          + `${Math.round(COST.gtdSecondi / 60)} minuti; il mercato esce dal perimetro (scadenzeFuoriPerimetro)` },
      { istanteMs: null,
        cosa: 'RISOLUZIONE — e non e\' la chiusura: l\'oracolo riporta l\'esito ORE dopo',
        modulo: 'lib/maker/riscatto-automatico (payoutDenominator on-chain)',
        effetto: 'il riscatto scatta su `payoutDenominator(conditionId) > 0` letto ON-CHAIN, mai su `closed`' },
    ];
    return tappe.map((t) => ({ ...t, istante: t.istanteMs ? ora2(t.istanteMs) : null,
      fraOre: t.istanteMs ? +((t.istanteMs - ora) / 3_600_000).toFixed(2) : null,
      giaPassato: t.istanteMs ? t.istanteMs <= ora : null }));
  }

  const cinque = primi.map(({ c, b, minSize, pavimento, scadMs, ore }) => {
    const banda = Number(b.rewardsMaxSpread);
    const Q = fin(pavimento) ? Math.floor((tettoMercato / 0.98) * 100) / 100 : null;
    return {
      conditionId: b.conditionId,
      question: String(b.question || '').slice(0, 60),
      categoria: b.category || null,
      oreAllaScadenza: +ore.toFixed(2),
      scadenza: b.endDate || null,
      nettoGiornoUsd: +c.bestNetPerDay.toFixed(4),
      // ⚠ IL LORDO ACCANTO AL NETTO, SEMPRE: un netto negativo da solo non dice se il problema e' il
      // reward (lordo minuscolo) o il costo del fill avverso. Sono due cure diverse.
      lordoGiornoUsd: fin(c.bestGrossPerDay) ? +c.bestGrossPerDay.toFixed(4) : null,
      quotaDelMontepremi: fin(c.quotaCapata) ? +c.quotaCapata.toFixed(6) : (fin(c.quotaCeiling) ? +c.quotaCeiling.toFixed(6) : null),
      // «Concorrenza» ha due misure e sono diverse: le SHARE altrui in banda (contro cui si divide il
      // montepremi) e il capitale altrui a libro (quanto e' profondo il mercato). Si danno entrambe.
      concorrenzaShareInBanda: fin(c.competitorShares) ? +c.competitorShares.toFixed(1) : null,
      profonditaAltruiUsd: fin(Number(b.existing_depth_usd)) ? Math.round(Number(b.existing_depth_usd)) : null,
      montepremiGiornoUsd: fin(c.pot) ? c.pot : (fin(Number(b.rewardsDailyRate)) ? Number(b.rewardsDailyRate) : null),
      minSize,
      pavimentoPremianteUsd: +pavimento.toFixed(2),
      tettoPerMercatoUsd: +tettoMercato.toFixed(2),
      sharePerLatoAlTetto: Q,
      superaIlMinimoPremiante: Q != null ? Q >= minSize : null,
      bandaCents: fin(banda) ? banda : null,
      raggioBandaCents: raggioBandaCents(banda),
      mid: fin(Number(b.mid)) ? +Number(b.mid).toFixed(4) : null,
      // Il rendimento sul capitale VERO impegnato, che e' il numero confrontabile fra mercati di
      // scaglioni diversi: $/g su un mercato da $61,25 e su uno da $24,50 non sono la stessa cosa.
      nettoSuCapitalePctGiorno: fin(c.bestNetPerDay) && tettoMercato > 0
        ? +((c.bestNetPerDay / Math.min(tettoMercato, CAPITALE)) * 100).toFixed(3) : null,
      // E il totale incassabile PRIMA che scada: e' il numero che conta su un mercato corto.
      nettoFinoAllaScadenzaUsd: fin(c.bestNetPerDay) ? +(c.bestNetPerDay * (ore / 24)).toFixed(2) : null,
      allaScadenza: sequenzaAllaScadenza(scadMs),
    };
  });

  const referto = {
    generatoIl: new Date(ora).toISOString(),
    capitaleUsd: CAPITALE, tettoPerMercatoUsd: +tettoMercato.toFixed(2),
    board: { file: fileBoard, righe: righeBoard.length, etaMinuti: etaBoardMin },
    finestra: { oreMin: ORE_MIN, oreMax: ORE_MAX },
    costantiDelCicloDiVita: COST,
    imbuto, cinque,
  };
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(referto, null, 2)); } catch { /* referto non scritto */ }

  // ── STAMPA ──────────────────────────────────────────────────────────────────────────────────────
  console.log(`\n════ I MIGLIORI CON SCADENZA FRA ${ORE_MIN} E ${ORE_MAX} ORE ════`);
  console.log(`board ${path.basename(fileBoard)} · ${righeBoard.length} righe · eta' ${etaBoardMin == null ? '?' : etaBoardMin} min`);
  console.log(`capitale $${CAPITALE} · tetto per mercato ${usd(tettoMercato)}\n`);
  console.log('IMBUTO');
  console.log(`  valutati dal pianificatore        ${imbuto.valutati}`);
  console.log(`  − senza minSize leggibile         ${imbuto.senzaMinSize}`);
  console.log(`  − pavimento premiante > tetto     ${imbuto.pavimentoOltreIlTetto}`);
  console.log(`  − vincoli della SELEZIONE         ${imbuto.selezione}`);
  console.log(`  − scadenza non determinabile      ${imbuto.scadenzaIgnota}`);
  console.log(`  − fuori dalla finestra ${ORE_MIN}-${ORE_MAX} h   ${imbuto.fuoriFinestra}`);
  console.log(`  − netto non calcolabile           ${imbuto.nettoNonCalcolabile}`);
  console.log(`  ⇒ candidabili nella finestra      ${imbuto.superstiti}\n`);

  if (!cinque.length) {
    console.log('🔴 NESSUN CANDIDABILE nella finestra. Non e\' «i mercati sono brutti»: e\' che nessuno');
    console.log('   supera i cancelli. L\'imbuto qui sopra dice quale cancello ha tolto cosa.\n');
  }
  for (const [i, m] of cinque.entries()) {
    console.log(`${i + 1}. ${m.question}`);
    console.log(`   ${m.conditionId.slice(0, 14)}… · ${m.categoria || 'categoria ignota'} · scade fra ${m.oreAllaScadenza} h (${m.scadenza})`);
    console.log(`   netto ${usd(m.nettoGiornoUsd)}/g · lordo ${usd(m.lordoGiornoUsd)}/g · quota del montepremi ${m.quotaDelMontepremi == null ? '—' : (m.quotaDelMontepremi * 100).toFixed(4) + '%'}`);
    console.log(`   montepremi ${usd(m.montepremiGiornoUsd)}/g · concorrenza ${m.concorrenzaShareInBanda == null ? '—' : m.concorrenzaShareInBanda + ' share in banda'} · profondita' altrui ${usd(m.profonditaAltruiUsd)}`);
    console.log(`   minSize ${m.minSize} · pavimento premiante ${usd(m.pavimentoPremianteUsd)} · al tetto ${usd(m.tettoPerMercatoUsd)} fanno ${m.sharePerLatoAlTetto} share/lato (minimo ${m.superaIlMinimoPremiante ? 'SUPERATO' : 'NON superato'})`);
    console.log(`   ⇒ ${usd(m.nettoFinoAllaScadenzaUsd)} netti da qui alla scadenza (${m.nettoSuCapitalePctGiorno}%/g sul capitale impegnato)`);
    console.log('   ALLA SCADENZA, con una coppia aperta:');
    for (const t of m.allaScadenza) {
      const q = t.istante ? `${t.istante} (fra ${t.fraOre} h)` : 'ore DOPO la chiusura, non si sa quando';
      console.log(`     · ${q}`);
      console.log(`       ${t.cosa}`);
      console.log(`       ⇒ ${t.effetto}`);
    }
    console.log('');
  }
  console.log(`referto → ${path.relative(ROOT, OUT)}\n`);
})();

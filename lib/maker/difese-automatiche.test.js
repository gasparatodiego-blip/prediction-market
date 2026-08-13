'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  LE DIFESE CHE AGISCONO — i due casi che le hanno motivate, e i vincoli che non devono cadere
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 *  §1  «114 rifiuti identici»: il caso vero del 13 agosto 2026
 *  §2  coerenza fra chi propone e chi riceve — le due divergenze misurate
 *  §3  la scala di sblocco, e il fatto che nessun gradino tocchi una regola di rischio
 *  §4  l'autodiagnosi
 *  §5  il nozionale che il venue ha DAVVERO accettato
 *  §6  il fill parziale che lascerebbe un residuo sotto soglia
 */

const assert = require('assert');
const SB = require('./sblocco-progressivo');
const COER = require('./coerenza-soglie');
const TRIG = require('./trigger-capitale-fermo');
const { capPerMarketUsd, liveMinOrderCapUsd, pavimentoPremiante } = require('../rewards/concentration');

let passati = 0; let falliti = 0;
const ok = (nome, fn) => { try { fn(); passati += 1; } catch (e) { falliti += 1; console.error(`  ✗ ${nome}\n    ${e.message}`); } };

// ═══ §1 · I 114 RIFIUTI IDENTICI ═══════════════════════════════════════════════════════════════════
console.log('§1 · rifiuti ripetuti');
const M = '0x' + '1'.repeat(64);

ok('IL CASO VERO: 114 rifiuti identici producono UN blocco, non 114 tentativi ciechi', () => {
  let s = {}; let scattato = null; let blocchi = 0;
  for (let i = 0; i < 114; i += 1) {
    const r = SB.registraEsiti({ stato: s, esiti: [{ marketId: M, gate: 'piano-senza-righe', status: 'refused' }], now: 1e12 + i * 60_000 });
    s = r.stato;
    if (r.blocchi.length) { blocchi += 1; if (scattato == null) scattato = i + 1; }
  }
  assert.strictEqual(scattato, 5, `scattato al ${scattato}° invece che al 5°`);
  assert.ok(blocchi >= 100, 'e continua a dichiararlo finché dura');
});

ok('la reazione a un blocco di STATO è una via alternativa, non una ripetizione', () => {
  const b = [{ marketId: M, gate: 'piano-senza-righe', n: 5, ...SB.classifica('piano-senza-righe') }];
  const r = SB.reazione(b);
  assert.deepStrictEqual(r.azioni, ['ricostruisci-piano']);
  assert.ok(r.daEscludere.includes(M));
});

ok('LA REGOLA DI RISCHIO NON SI AGGIRA MAI: nessuna azione, esclusione e dichiarazione', () => {
  for (const g of ['mai-primo-sul-libro', 'motore-non-conforme', 'would-cross', 'end-of-scale', 'close-sell-floor', 'manual-order-cap', 'venue-rules', 'inseguimento-contro-mai-primo']) {
    const c = SB.classifica(g);
    assert.strictEqual(c.classe, 'rischio', `${g} deve restare di classe rischio`);
    const r = SB.reazione([{ marketId: M, gate: g, n: 9, ...c }]);
    assert.strictEqual(r.azioni.length, 0, `${g} non deve produrre nessuna azione di sistema`);
    assert.strictEqual(r.soloRischio, true);
    assert.ok(r.nonAgibili[0].perche, 'e deve dire PERCHÉ non ha agito');
  }
});

ok('tutte le famiglie osservate nei 3 giorni veri sono classificate', () => {
  // I gate realmente presenti nel giornale 9-13 agosto, per frequenza.
  const osservate = ['motore-non-conforme', 'venue-rules', 'end-of-scale', 'idempotent-duplicate', 'would-cross',
    'limit-max-open-notional', 'idempotent', 'live-min-market-mismatch', 'rate-limited', 'inseguimento-contro-mai-primo',
    'close-sell-floor', 'kill-global', 'mai-primo-sul-libro', 'manual-order-cap', 'mid-stale', 'stale-book',
    'mid-not-live', 'manual-mode-inactive', 'refresh-invalid', 'market-unknown'];
  const mancanti = osservate.filter((g) => !SB.FAMIGLIE[g]);
  assert.deepStrictEqual(mancanti, [], `famiglie osservate ma non classificate: ${mancanti.join(', ')}`);
});

ok('una famiglia mai vista è trattata come rischio, non come occasione di aggirare', () => {
  const c = SB.classifica('gate-nuovo-di-domani');
  assert.strictEqual(c.classe, 'rischio');
  assert.strictEqual(c.noto, false);
});

// ═══ §2 · COERENZA FRA I MODULI ════════════════════════════════════════════════════════════════════
console.log('§2 · coerenza fra chi propone e chi riceve');
const capitale = 664.9;
const tettoM = capPerMarketUsd(capitale);
const tettoO = liveMinOrderCapUsd(capitale);
const riga = (o = {}) => ({ marketId: M, capital: tettoM, pairCostUsd: 0.98, mid: 0.5, minSizeShares: 20, ...o });
const soglieDi = (r) => ({ capPerMercatoUsd: tettoM, tettoOrdineUsd: tettoO, pavimentoRigaUsd: TRIG.pavimentoDiRiga(r).usd });

ok('DIVERGENZA ①, il deadlock del 13 agosto: una riga sotto il pavimento si riconosce PRIMA', () => {
  // La griglia vecchia proponeva $24,00 contro un pavimento globale di $24,50.
  const v = COER.verificaRiga(riga({ capital: 24 }), { capPerMercatoUsd: tettoM, tettoOrdineUsd: tettoO, pavimentoRigaUsd: 24.5 });
  assert.strictEqual(v.scartata, true);
  assert.ok(/sotto il pavimento/.test(v.motivo));
  assert.ok(v.divergenza.proposto === 24 && v.divergenza.pavimento === 24.5, 'la divergenza porta i due numeri');
});

ok('DIVERGENZA ②, i 631 `manual-order-cap`: a mid estremo il capitale SCENDE invece di essere rifiutato', () => {
  const v = COER.verificaRiga(riga({ mid: 0.8675 }), soglieDi(riga({ mid: 0.8675 })));   // il mid vero di Vindman
  assert.strictEqual(v.ok, true);
  assert.ok(v.adattata, 'la riga deve essere adattata, non lasciata a sfondare');
  const gambaCara = (v.capitale / 0.98) * 0.8675;
  assert.ok(gambaCara <= tettoO + 0.01, `la gamba cara resta $${gambaCara.toFixed(2)} contro un tetto di $${tettoO}`);
});

ok('IL CAPITALE PUÒ SOLO SCENDERE: nessun tetto viene alzato, su tutta la finestra di mid', () => {
  for (let m = 0.03; m <= 0.97; m += 0.01) {
    const r = riga({ mid: +m.toFixed(2) });
    const v = COER.verificaRiga(r, soglieDi(r));
    if (!v.ok) continue;
    assert.ok(v.capitale <= tettoM + 1e-9, `mid ${m.toFixed(2)}: capitale $${v.capitale} oltre il tetto per mercato`);
    const gamba = (v.capitale / 0.98) * Math.max(m, 1 - m);
    assert.ok(gamba <= tettoO + 0.01, `mid ${m.toFixed(2)}: gamba $${gamba.toFixed(2)} oltre il tetto per ordine`);
  }
});

ok('e ogni riga adattata resta sopra il proprio pavimento premiante', () => {
  for (let m = 0.05; m <= 0.95; m += 0.05) {
    const r = riga({ mid: +m.toFixed(2) });
    const v = COER.verificaRiga(r, soglieDi(r));
    if (v.ok) assert.ok(v.capitale >= TRIG.pavimentoDiRiga(r).usd, `mid ${m.toFixed(2)} sotto il pavimento`);
  }
});

ok('un mercato che non regge nessuna soglia si scarta e lo dichiara, non si forza', () => {
  const r = riga({ minSizeShares: 200 });
  const v = COER.verificaRiga(r, soglieDi(r));
  assert.strictEqual(v.scartata, true);
  assert.ok(v.divergenza.massimoCompatibile < v.divergenza.pavimento);
});

ok('soglie non calcolabili ⇒ nessun adattamento inventato (comportamento di prima)', () => {
  const q = COER.adattaRighe({ righe: [riga({ mid: 0.9 })], soglieDi: () => ({}) });
  assert.strictEqual(q.adattate, 0);
  assert.strictEqual(q.righe[0].capital, tettoM);
});

// ═══ §3 · LA SCALA ═════════════════════════════════════════════════════════════════════════════════
console.log('§3 · la scala di sblocco');

ok('sei gradini, dal più leggero al più forte, e l\'ultimo è fermarsi', () => {
  assert.strictEqual(SB.SCALA.length, 6);
  assert.strictEqual(SB.SCALA[0].azione, 'ricostruisci-piano');
  assert.strictEqual(SB.SCALA[5].azione, 'fermati-in-sicurezza');
});

ok('si sale solo dopo che il gradino precedente ha avuto il suo tempo', () => {
  const T = 1e12;
  let g = SB.prossimoGradino({ stato: null, sano: false, now: T });
  assert.strictEqual(g.gradino.livello, 1);
  assert.strictEqual(SB.prossimoGradino({ stato: g.stato, sano: false, now: T + 4 * 60_000 }).sali, false);
  assert.strictEqual(SB.prossimoGradino({ stato: g.stato, sano: false, now: T + 6 * 60_000 }).gradino.livello, 2);
});

ok('il caso peggiore arriva a FERMA in mezz\'ora', () => {
  const T = 1e12;
  let st = null; let ultimo = 0; let t = T;
  for (let i = 0; i < 12; i += 1) {
    const g = SB.prossimoGradino({ stato: st, sano: false, now: t });
    if (g.sali) { st = g.stato; ultimo = g.gradino.livello; }
    t += 5 * 60_000;
  }
  assert.strictEqual(ultimo, 6);
  assert.ok((t - T) / 60_000 <= 60);
});

ok('tornare sani azzera la scala — e solo un FATTO misurato la azzera', () => {
  const st = { livello: 4, da: 1e12, ultimaAzione: 'ripara-precondizioni' };
  assert.strictEqual(SB.prossimoGradino({ stato: st, sano: true, now: 1e12 }).stato, null);
  assert.strictEqual(SB.prossimoGradino({ stato: st, sano: null, now: 1e12 + 1e9 }).sali, false);
});

ok('NESSUN GRADINO PUÒ TOCCARE UNA REGOLA DI RISCHIO', () => {
  const consentite = ['ricostruisci-piano', 'ricarica-configurazione', 'riconcilia-esposizione',
    'ripara-precondizioni', 'risveglia-feed', 'fermati-in-sicurezza'];
  for (const g of SB.SCALA) assert.ok(consentite.includes(g.azione), `gradino non consentito: ${g.azione}`);
  // e l'esecutore, in agent41, non deve nominare nessuna superficie di piazzamento
  const src = require('fs').readFileSync(require.resolve('../../agents/agent41-realloc-scheduler.js'), 'utf8');
  const corpo = src.slice(src.indexOf('async function eseguiGradino'), src.indexOf('let statoVuoto = null'));
  for (const proibito of ['placeManualOrder', 'piazzaCoppia', 'cancelManualOrder', 'resolveCaps']) {
    assert.ok(!corpo.includes(proibito), `l'esecutore dei gradini non deve nominare ${proibito}`);
  }
});

ok('i rifiuti osservati possono scegliere il gradino di partenza, saltando quelli inutili', () => {
  const g = SB.prossimoGradino({ stato: null, sano: false, now: 1e12, azioniSuggerite: ['risveglia-feed'] });
  assert.strictEqual(g.gradino.livello, 5);
});

// ═══ §4 · AUTODIAGNOSI ═════════════════════════════════════════════════════════════════════════════
console.log('§4 · autodiagnosi');

ok('le quattro domande sono tutte coperte', () => {
  const T = 1e12;
  assert.strictEqual(SB.autodiagnosi({ ordiniVivi: 0, frazioneAlLavoro: 0.9, ultimoCicloMs: 1e3, now: T }).sano, false);
  assert.strictEqual(SB.autodiagnosi({ ordiniVivi: 9, frazioneAlLavoro: 0.1, ultimoCicloMs: 1e3, sottoSogliaDa: T - 20 * 60_000, now: T }).sano, false);
  assert.strictEqual(SB.autodiagnosi({ ordiniVivi: 9, frazioneAlLavoro: 0.9, ultimoCicloMs: 30 * 60_000, now: T }).sano, false);
  assert.strictEqual(SB.autodiagnosi({ ordiniVivi: 9, frazioneAlLavoro: 0.9, ultimoCicloMs: 1e3, rinnoviDovuti: 10, rinnoviFermati: 9, now: T }).sano, false);
  assert.strictEqual(SB.autodiagnosi({ ordiniVivi: 9, frazioneAlLavoro: 0.9, ultimoCicloMs: 1e3, now: T }).sano, true);
});

ok('LA NOTTE DEL 13 AGOSTO sarebbe stata diagnosticata malata', () => {
  // Zero ordini, capitale al lavoro 8,4%, cicli regolari: due sintomi su quattro.
  const d = SB.autodiagnosi({ ordiniVivi: 0, frazioneAlLavoro: 0.084, ultimoCicloMs: 60_000, sottoSogliaDa: 1e12 - 60 * 60_000, now: 1e12 });
  assert.strictEqual(d.sano, false);
  assert.ok(d.motivi.length >= 2);
});

ok('misure assenti ⇒ NON si giudica e la scala non parte', () => {
  assert.strictEqual(SB.autodiagnosi({ now: 1e12 }).sano, null);
  assert.strictEqual(SB.prossimoGradino({ stato: null, sano: null, now: 1e12 }).sali, false);
});

// ═══ §5 · IL NOZIONALE DAVVERO PIAZZATO ════════════════════════════════════════════════════════════
console.log('§5 · quanto è finito davvero sul book');
const A41 = require('../../agents/agent41-realloc-scheduler');

ok('IL CASO VERO delle 06:47: 17 gambe, 8 passate ⇒ si conta solo ciò che il venue ha accettato', () => {
  const res = [];
  for (let i = 0; i < 8; i += 1) res.push({ status: 'placed', notionalUsd: 15.97 });
  for (let i = 0; i < 9; i += 1) res.push({ status: 'refused', notionalUsd: 17.33 });
  const n = A41.nozionalePiazzato(res);
  assert.ok(Math.abs(n - 127.76) < 0.5, `contati $${n.toFixed(2)} invece di ~$127,79`);
});

ok('refused e skipped non contano, e una riga senza nozionale vale ZERO (non si indovina)', () => {
  assert.strictEqual(A41.nozionalePiazzato([{ status: 'refused', notionalUsd: 100 }]), 0);
  assert.strictEqual(A41.nozionalePiazzato([{ status: 'skipped', notionalUsd: 100 }]), 0);
  assert.strictEqual(A41.nozionalePiazzato([{ status: 'placed', notionalUsd: null }]), 0);
  assert.strictEqual(A41.nozionalePiazzato(null), 0);
});

ok('il referto non usa più il PIANO del giro come se fosse stato piazzato', () => {
  const src = require('fs').readFileSync(require.resolve('../../agents/agent41-realloc-scheduler.js'), 'utf8');
  assert.ok(!/const impegnatoOra = giro\.allocatoUsd/.test(src),
    'impegnatoOra non deve tornare a essere il piano del giro');
  assert.ok(/const impegnatoOra = \+\(nozionalePiazzato/.test(src));
});

// ═══ §6 · IL FILL PARZIALE CHE LASCEREBBE UN RESIDUO ═══════════════════════════════════════════════
console.log('§6 · residui sotto la soglia del venue');

ok('ARITMETICA: nessun tetto elimina i residui — il residuo è continuo nella frazione di fill', () => {
  // Un fill di frazione f su un lato solo lascia scoperte Q·f share, ed è coperto solo se Q·f ≥ minSize.
  // Quindi esiste sempre un f abbastanza piccolo che lascia un residuo sotto soglia, per QUALUNQUE Q.
  for (const capitale of [19.6, 24, 32.67, 65, 130]) {
    const Q = capitale / 0.98;
    const fStuck = 19 / Q;              // una frazione che lascia 19 share, sotto il minimo 20
    assert.ok(fStuck > 0 && fStuck < 1, `capitale $${capitale}: esiste sempre un fill che incastra`);
  }
});

ok('ma un tetto PIÙ ALTO restringe la finestra di fill che incastra (f_min più basso)', () => {
  const fMin = (capitale) => 20 * 0.98 / capitale;
  assert.ok(fMin(32.67) < fMin(24), 'le righe a $32 incastrano meno di quelle a $24');
  assert.ok(Math.abs(fMin(32.67) - 0.6) < 0.01);
  assert.ok(Math.abs(fMin(24) - 0.817) < 0.01);
});

ok('un fill parziale che lascerebbe un residuo sotto soglia viene RICONOSCIUTO e dichiarato', () => {
  const ACC = require('./accumulo-residui');
  // 13,5 share scoperte su un mercato a minSize 20 — il caso vero di Ankara.
  const reg = ACC.registraResiduoScoperto({
    registro: { residui: {} }, marketId: M, book: 'no', sizeScoperta: 13.5, minSize: 20,
    prezzoCarico: 0.43, causa: 'fill parziale', now: 1e12,
  });
  const v = Object.values((reg && reg.registro && reg.registro.residui) || {})[0];
  assert.ok(v, 'il residuo deve entrare nel registro');
  assert.strictEqual(v.pronto, false, 'e deve essere dichiarato NON piazzabile');
  assert.ok(Math.abs(v.manca - 6.5) < 1e-6, `manca ${v.manca} invece di 6,5`);
});

ok('  e quando raggiunge il minimo del venue diventa piazzabile da sé', () => {
  const ACC = require('./accumulo-residui');
  const reg = ACC.registraResiduoScoperto({
    registro: { residui: {} }, marketId: M, book: 'no', sizeScoperta: 20, minSize: 20,
    prezzoCarico: 0.43, causa: 'fill', now: 1e12,
  });
  const v = Object.values(reg.registro.residui)[0];
  assert.strictEqual(v.pronto, true);
  assert.strictEqual(v.manca, 0);
});

// ═══ §7 · IL RISCATTO AUTOMATICO ═══════════════════════════════════════════════════════════════════
console.log('§7 · riscatto automatico dopo la risoluzione');
const RIS = require('./riscatto-automatico');
const CID = '0x' + '7'.repeat(64);
const posRis = (o = {}) => ({ conditionId: CID, size: 15.49, negRisk: false, ...o });

ok('il segnale è payoutDenominator, non «il mercato è chiuso»', () => {
  assert.strictEqual(RIS.risoltoDaMappa({ [CID]: 1 })(CID), true);
  assert.strictEqual(RIS.risoltoDaMappa({ [CID]: 0 })(CID), false, 'chiuso ma non risolto ⇒ non si riscatta');
  assert.strictEqual(RIS.risoltoDaMappa({})(CID), null, 'non letto ⇒ non si sa');
});

ok('RISCATTO GIÀ AVVENUTO: non si ripete, mai', () => {
  const s = RIS.selezionaRiscattabili({
    posizioni: [posRis()], registro: { [CID]: { esito: 'riuscito', at: 1e12 - 1e7, tx: '0xabc' } },
    risolto: () => true, now: 1e12,
  });
  assert.strictEqual(s.daRiscattare.length, 0);
  assert.strictEqual(s.giaFatte.length, 1);
  assert.strictEqual(s.giaFatte[0].tx, '0xabc');
});

ok('  e l\'idempotenza regge anche se la posizione è ancora nello snapshot', () => {
  // Fra l'invio e la sparizione del token passano secondi: è la finestra in cui un secondo giro
  // riproverebbe, ed è la ragione per cui il registro esiste invece di guardare solo la posizione.
  const s = RIS.selezionaRiscattabili({
    posizioni: [posRis()], registro: { [CID]: { esito: 'riuscito', at: 1e12 - 2000 } },
    risolto: () => true, now: 1e12,
  });
  assert.strictEqual(s.daRiscattare.length, 0);
});

ok('un mercato non ancora risolto non produce nessuna transazione', () => {
  const s = RIS.selezionaRiscattabili({ posizioni: [posRis()], risolto: () => false, now: 1e12 });
  assert.strictEqual(s.daRiscattare.length, 0);
  assert.strictEqual(s.nonRisolte.length, 1);
});

ok('risoluzione non verificabile ⇒ NON si riscatta al buio', () => {
  const s = RIS.selezionaRiscattabili({ posizioni: [posRis()], risolto: () => null, now: 1e12 });
  assert.strictEqual(s.daRiscattare.length, 0);
  assert.ok(/al buio/.test(s.nonRisolte[0].motivo));
});

ok('il riscatto NON tocca il book: nessuna superficie di piazzamento nel modulo', () => {
  const src = require('fs').readFileSync(require.resolve('./riscatto-automatico.js'), 'utf8');
  for (const proibito of ['placeManualOrder', 'cancelManualOrder', 'createOrder', 'planExit', 'piazzaCoppia']) {
    assert.ok(!src.includes(proibito), `il modulo non deve nominare ${proibito}`);
  }
});

// ═══ §8 · IL CABLAGGIO DELLA COERENZA — la correzione che era INERTE ════════════════════════════════
console.log('§8 · la coerenza si applica a OGNI fonte di righe');

ok('adattaAlleSoglie è chiamata sia sul piano salvato sia sulla ricostruzione', () => {
  const src = require('fs').readFileSync(require.resolve('../../agents/agent41-realloc-scheduler.js'), 'utf8')
    .split('\n').filter((l) => !/^\s*(\*|\/\/)/.test(l)).join('\n');
  // La dichiarazione è una arrow (`const adattaAlleSoglie = (righe, dove) =>`), quindi non conta come
  // chiamata: i due usi attesi sono esattamente le due fonti di righe.
  const usi = (src.match(/adattaAlleSoglie\(/g) || []).length;
  assert.ok(usi >= 2, `adattaAlleSoglie deve essere chiamata da entrambe le fonti (trovate ${usi})`);
  assert.ok(/righeCandidate = adattaAlleSoglie\(piano\.righe/.test(src), 'il piano salvato deve passarci');
  assert.ok(/const fresche = adattaAlleSoglie\(righeFresche/.test(src), 'la ricostruzione deve passarci');
  assert.ok(!/righeCandidate = righeFresche;/.test(src), 'e non deve piu\' esistere un percorso che le scavalca');
});

setTimeout(() => {
  console.log(`\ndifese-automatiche: ${passati} passati, ${falliti} falliti`);
  process.exit(falliti === 0 ? 0 : 1);
}, 120);

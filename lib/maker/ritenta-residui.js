'use strict';

/**
 * IL CONSUMATORE DEL REGISTRO DEI RESIDUI — CLAUDE.md §5.2 punto 17.
 *
 * ═══ IL BUCO CHE CHIUDE ═════════════════════════════════════════════════════════════════════════
 * `accumulo-residui.js` scrive `data/residui-scoperti.json` a ogni giro, tiene 17 voci aggiornate al
 * minuto e calcola correttamente il flag `pronto` — che il 13 agosto 2026 era **true su 6 voci per
 * $105,79 di nozionale**. Ma `residuiPronti` (accumulo-residui.js:157) e `capitaleFermoUsd` (riga 162)
 * avevano **zero chiamanti in produzione**: gli unici erano in un test. In agent40 il registro si
 * leggeva in due punti — la pulizia del mercato morto e il read-modify-write che REGISTRA — e in
 * nessuno dei due per **riprovare**. Il sistema misurava quando un residuo tornava piazzabile, lo
 * scriveva, e non agiva mai.
 *
 * ═══ COSA FA QUESTO MODULO, E SOPRATTUTTO COSA NON FA ═══════════════════════════════════════════
 * Restituisce **quali mercati vanno rivisitati**, e nient'altro. Non piazza, non prezza, non sceglie
 * una size: la riga del registro dice **solo** che la size è tornata sopra il minimo del venue, e
 * quello non è un lasciapassare. Il mercato torna nell'insieme che il ciclo di chiusura già visita, e
 * da lì in giù valgono tutte le regole di sempre — banda premiante, tetto della coppia, tetto per
 * mercato, «mai primo sul libro», profondità, tetto di perdita. **Il registro apre una porta, non
 * scavalca un muro.**
 *
 * ⚠ IL REGISTRO NON SI SCRIVE MAI DA QUI. Un tentativo fallito non cancella e non modifica la voce:
 * resta dov'è, e verrà ritentata al prossimo giro utile. L'unico scrittore resta `accumulo-residui`.
 *
 * Modulo PURO: nessun `require` di rete, di venue o di disco. Riceve il registro già letto e lo stato
 * dei tentativi, restituisce un elenco e lo stato nuovo.
 */

const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/**
 * Ogni quanto si ritenta lo stesso residuo, al minimo.
 *
 * ⚠ NON È UN CICLO STRETTO, ed è tarato su un fatto: il ciclo di chiusura di agent40 gira ogni pochi
 * secondi, quindi senza questo intervallo un residuo pronto ma bloccato a valle verrebbe ritentato
 * decine di volte al minuto, producendo esattamente la classe di rumore dei 114 rifiuti identici di
 * §5 p.120. Dieci minuti sono più della finestra GTD di un ordine (23 min è il rinnovo, 180 s la vita
 * base), quindi fra un tentativo e l'altro il libro è davvero cambiato.
 */
const INTERVALLO_RITENTATIVO_MS = 10 * 60_000;

/**
 * Il backoff quando lo stesso residuo fallisce ripetutamente **per lo stesso motivo**.
 *
 * Il motivo conta: fallire tre volte per `no-target` e fallire per tre gate diversi sono due storie
 * diverse. La prima è un blocco strutturale e va rallentata; la seconda è un libro che si muove, e
 * rallentarla vorrebbe dire smettere di provare proprio mentre le condizioni cambiano.
 */
const BACKOFF_MULT = 2;
const BACKOFF_MAX_MS = 2 * 3_600_000;   // due ore: oltre, si torna a provare comunque

/** Quanti residui si ritentano al massimo in un giro. È manutenzione, non la corsia principale. */
const MAX_PER_GIRO = 3;

/**
 * QUALI RESIDUI RITENTARE ADESSO.
 *
 * @param a.registro   il registro già letto (`leggiRegistroResidui().residui`)
 * @param a.stato      mappa chiave → `{ultimoAt, fallimenti, ultimoMotivo}` (la tiene il chiamante)
 * @param a.mercatiGiaVisitati  i mercati che il ciclo visiterebbe comunque: non si duplica il lavoro
 * @returns {{daRitentare:Array, stato:Map, motivo:string}}
 */
function residuiDaRitentare({
  registro = null, stato = null, mercatiGiaVisitati = null, ora = Date.now(),
  intervalloMs = INTERVALLO_RITENTATIVO_MS, maxPerGiro = MAX_PER_GIRO,
} = {}) {
  const st = stato instanceof Map ? new Map(stato) : new Map();
  const voci = registro && typeof registro === 'object' ? registro : null;
  if (!voci) return { daRitentare: [], stato: st, motivo: 'registro dei residui non leggibile: non si ritenta niente' };

  const gia = new Set((Array.isArray(mercatiGiaVisitati) ? mercatiGiaVisitati : [])
    .map((x) => String(x || '').trim().toLowerCase()).filter(Boolean));

  const candidati = [];
  for (const [chiave, v] of Object.entries(voci)) {
    if (!v || typeof v !== 'object') continue;
    // ⚠ SOLO `pronto === true`, e `=== true` e non truthy: il flag è il verdetto di `accumulo-residui`
    // — «la size ha raggiunto il minimo del venue» — e un valore che gli somiglia non è quel verdetto.
    if (v.pronto !== true) continue;
    const marketId = String(v.marketId || chiave.split(':')[0] || '').trim().toLowerCase();
    if (!marketId) continue;
    // Se il ciclo lo visita già, il residuo verrà rivalutato senza che serva chiedere niente.
    if (gia.has(marketId)) continue;

    const s = st.get(chiave) || { ultimoAt: null, fallimenti: 0, ultimoMotivo: null };
    // Il backoff cresce SOLO sui fallimenti ripetuti con lo stesso motivo; `fallimenti` viene azzerato
    // da chi registra l'esito quando il motivo cambia o il tentativo riesce.
    const attesa = Math.min(intervalloMs * (BACKOFF_MULT ** Math.max(0, s.fallimenti)), BACKOFF_MAX_MS);
    if (fin(s.ultimoAt) && ora - s.ultimoAt < attesa) continue;

    candidati.push({
      chiave, marketId, book: v.book || chiave.split(':')[1] || null,
      size: fin(Number(v.size)) ? Number(v.size) : null,
      minSize: fin(Number(v.minSize)) ? Number(v.minSize) : null,
      notionalUsd: fin(Number(v.notionalUsd)) ? Number(v.notionalUsd) : null,
      fallimenti: s.fallimenti, attesaApplicataMs: attesa,
    });
  }

  // I più grandi per primi: se il tetto per giro morde, si libera prima il capitale che pesa di più.
  candidati.sort((a, b) => (b.notionalUsd || 0) - (a.notionalUsd || 0));
  const daRitentare = candidati.slice(0, Math.max(0, maxPerGiro));
  for (const c of daRitentare) {
    const s = st.get(c.chiave) || { ultimoAt: null, fallimenti: 0, ultimoMotivo: null };
    st.set(c.chiave, { ...s, ultimoAt: ora });
  }
  return {
    daRitentare, stato: st,
    motivo: daRitentare.length
      ? `${daRitentare.length} residuo/i pronto/i da ritentare (${candidati.length} candidati, tetto ${maxPerGiro})`
      : `nessun residuo da ritentare (${Object.keys(voci).length} voci a registro)`,
  };
}

/**
 * L'ESITO DI UN TENTATIVO, per il backoff.
 *
 * ⚠ NON TOCCA IL REGISTRO. Aggiorna solo il contatore dei fallimenti, che vive accanto: la voce resta
 * dov'è comunque vada, ed è il requisito che impedisce a un tentativo fallito di far sparire un residuo.
 */
function registraEsito({ stato = null, chiave = null, riuscito = false, motivo = null, ora = Date.now() } = {}) {
  const st = stato instanceof Map ? new Map(stato) : new Map();
  if (!chiave) return st;
  const s = st.get(chiave) || { ultimoAt: null, fallimenti: 0, ultimoMotivo: null };
  if (riuscito === true) { st.delete(chiave); return st; }
  // Motivo DIVERSO ⇒ il contatore riparte: non è lo stesso blocco, è un libro che si muove.
  const stessoMotivo = s.ultimoMotivo !== null && s.ultimoMotivo === motivo;
  st.set(chiave, {
    ultimoAt: ora,
    fallimenti: stessoMotivo ? s.fallimenti + 1 : 1,
    ultimoMotivo: motivo === undefined ? null : motivo,
  });
  return st;
}

/** Prove interne. `node lib/maker/ritenta-residui.js` */
function selfcheck() {
  const esiti = [];
  const A = (nome, cond) => esiti.push({ nome, ok: !!cond });
  const T = 1_000_000_000;
  const reg = {
    '0xaaa:no': { marketId: '0xaaa', book: 'no', size: 20, minSize: 20, pronto: true, notionalUsd: 9.8 },
    '0xbbb:no': { marketId: '0xbbb', book: 'no', size: 77, minSize: 20, pronto: true, notionalUsd: 29.03 },
    '0xccc:yes': { marketId: '0xccc', book: 'yes', size: 6, minSize: 20, pronto: false, notionalUsd: 3 },
  };

  const r = residuiDaRitentare({ registro: reg, stato: null, ora: T });
  A('solo i pronti vengono ritentati', r.daRitentare.length === 2);
  A('  e mai quelli sotto il minimo', !r.daRitentare.some((x) => x.chiave === '0xccc:yes'));
  A('  i più grandi per primi', r.daRitentare[0].chiave === '0xbbb:no');

  const gia = residuiDaRitentare({ registro: reg, stato: null, ora: T, mercatiGiaVisitati: ['0xbbb'] });
  A('un mercato già visitato dal ciclo non si chiede due volte',
    gia.daRitentare.length === 1 && gia.daRitentare[0].chiave === '0xaaa:no');

  // La cadenza: subito dopo un tentativo non si ritenta.
  const subito = residuiDaRitentare({ registro: reg, stato: r.stato, ora: T + 60_000 });
  A('non si ritenta prima dell\'intervallo', subito.daRitentare.length === 0);
  const dopo = residuiDaRitentare({ registro: reg, stato: r.stato, ora: T + INTERVALLO_RITENTATIVO_MS + 1000 });
  A('si ritenta dopo l\'intervallo', dopo.daRitentare.length === 2);

  // Il backoff cresce sullo STESSO motivo e riparte su uno diverso.
  let s = new Map();
  s = registraEsito({ stato: s, chiave: '0xaaa:no', riuscito: false, motivo: 'no-target', ora: T });
  s = registraEsito({ stato: s, chiave: '0xaaa:no', riuscito: false, motivo: 'no-target', ora: T });
  A('due fallimenti con lo stesso motivo contano due', s.get('0xaaa:no').fallimenti === 2);
  s = registraEsito({ stato: s, chiave: '0xaaa:no', riuscito: false, motivo: 'venue-rules', ora: T });
  A('un motivo diverso azzera il contatore', s.get('0xaaa:no').fallimenti === 1);
  const conBackoff = residuiDaRitentare({ registro: reg, stato: s, ora: T + INTERVALLO_RITENTATIVO_MS + 1000 });
  A('con un fallimento il backoff raddoppia e non si ritenta ancora',
    !conBackoff.daRitentare.some((x) => x.chiave === '0xaaa:no'));

  // Il successo toglie la voce dallo stato dei tentativi (ma NON dal registro: qui non si scrive).
  const dopoOk = registraEsito({ stato: s, chiave: '0xaaa:no', riuscito: true, ora: T });
  A('il successo azzera lo stato del tentativo', !dopoOk.has('0xaaa:no'));
  A('e il registro non viene mai toccato da questo modulo',
    reg['0xaaa:no'].pronto === true && Object.keys(reg).length === 3);

  // Ingressi illeggibili.
  A('registro illeggibile ⇒ nessun tentativo', residuiDaRitentare({ registro: null }).daRitentare.length === 0);
  A('registro vuoto ⇒ nessun tentativo', residuiDaRitentare({ registro: {} }).daRitentare.length === 0);
  const sporco = residuiDaRitentare({ registro: { x: null, y: 'boh', 'z:no': { pronto: 'si', marketId: '0xz' } }, ora: T });
  A('voci malformate o `pronto` non booleano non producono tentativi', sporco.daRitentare.length === 0);

  // Il tetto per giro.
  const tanti = {};
  for (let i = 0; i < 10; i++) tanti[`0x${i}:no`] = { marketId: `0x${i}`, book: 'no', size: 20, minSize: 20, pronto: true, notionalUsd: i };
  A(`non più di ${MAX_PER_GIRO} per giro`, residuiDaRitentare({ registro: tanti, ora: T }).daRitentare.length === MAX_PER_GIRO);

  const rossi = esiti.filter((e) => !e.ok);
  for (const e of esiti) console.log(`${e.ok ? '  ok' : 'FAIL'}  ${e.nome}`);
  console.log(`\n${esiti.length - rossi.length}/${esiti.length} verdi`);
  return rossi.length === 0;
}

module.exports = {
  residuiDaRitentare, registraEsito, selfcheck,
  INTERVALLO_RITENTATIVO_MS, BACKOFF_MULT, BACKOFF_MAX_MS, MAX_PER_GIRO,
};

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

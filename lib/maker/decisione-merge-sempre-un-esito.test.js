'use strict';
// lib/maker/decisione-merge-sempre-un-esito.test.js
// UNA DECISIONE DI MERGE PRESA DEVE PRODURRE UN ESITO SCRITTO. SEMPRE.
//
// ═══ IL FATTO CHE HA MOTIVATO QUESTO FILE — 12 agosto 2026, dati vivi ═══════════════════════════════
// Il bot ha girato con capitale reale dalle 17:50:28 alle 18:23 UTC. Alle ~17:58:0x un fill ha lasciato
// **24 share NO scoperte** su «Will Alexander Vindman be the Democratic nominee for Senate in Florida?»
// (`cid_b73f32c2…`), carico 0,124, per $2,976. Da quel momento, ogni ~60 secondi, il giornale maker ha
// registrato ESATTAMENTE questa coppia di righe:
//
//     auto-close | merge-livello-2   «l ask di YES e' sopra il tetto di 86.6¢: ci si mette da MAKER
//                                      su YES per 24 share…»            ← LA DECISIONE
//     auto-close | skip-no-target    «la banda premiante corrente (fino a 0.115) e' gia' sotto il
//                                      prezzo di carico (0.124)…»       ← E BASTA
//
// **14 decisioni, 14 skip, ZERO esiti.** Nessun `merge-livello-2-piazzato`, nessun
// `merge-livello-2-reject-*`, nessun `merge-saltato-*`. `data/modalita-chiusura.json` non è mai stato
// creato e `data/residui-scoperti.json` è rimasto fermo alle 09:48 — cioè nemmeno il registro dei lati
// scoperti ha saputo che esisteva una gamba scoperta.
//
// ═══ LE DUE COSE CHE QUESTO TEST DIFENDE, E SONO DIVERSE ════════════════════════════════════════════
// **A · IL COMPORTAMENTO.** `decideClose` rispondeva `skip/no-target` — correttamente: `planExit` si
// rifiuta di quotare un'uscita in perdita quando la banda premiante sta sotto il carico. Ma il ramo
// `skip` di `runAutoCloseCycle` faceva `continue` PRIMA del blocco che tenta il completamento della
// coppia. «Non posso VENDERE in guadagno» veniva letto come «non c'è niente da fare», mentre la domanda
// «posso COMPRARE l'altro lato?» non era nemmeno posta. È la quarta occorrenza dello stesso difetto
// (§5 punti 27 e 34: `already-covered` e `close-at-market` erano stati corretti l'8 agosto).
//
// **B · IL SILENZIO, che è il difetto più grave dei due.** Anche col comportamento corretto, la classe
// del guasto resterebbe: una decisione registrata poteva uscire senza che nessun ramo fosse obbligato a
// dire com'era finita. Chi legge l'audit non poteva distinguere «non è stato tentato» da «è stato
// tentato e il venue ha rifiutato». La garanzia non è una promessa in un commento: è un OBBLIGO che si
// apre nella stessa istruzione che scrive la decisione e che qualcuno deve chiudere.
//
// ═══ COSA SI VERIFICA ═══════════════════════════════════════════════════════════════════════════════
//   1 · la scena vera di Vindman riprodotta numero per numero, e il completamento che ORA parte
//   2 · LA PROPRIETÀ: su ogni scenario, ogni riga di decisione ha una riga di esito. Nessuna eccezione.
//   3 · i gate su cui il completamento NON è tentabile lo DICHIARANO invece di tacere
//   4 · la rete di sicurezza: una decisione che sfugge a ogni ramo produce `merge-esito-mancante`
//   5 · i vincoli duri non sono stati toccati

const AC = require('./auto-close');
const { MERGE_STRATEGY_ENABLED } = require('./strategia-merge');

let passati = 0; let falliti = 0;
function ok(nome, cond, extra) {
  if (cond) { passati += 1; console.log(`  ✓ ${nome}${extra ? ` — ${extra}` : ''}`); }
  else { falliti += 1; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ''}`); }
}

// ── I NUMERI VERI DEL 12 AGOSTO, NON UN'IMITAZIONE ─────────────────────────────────────────────────
const VINDMAN = '0xb73f32c2884c65f5dae192c33bef3f7ce3faeec4ad313d2d3a6ad62ea2c95caf';
const TOK_YES = '106508022466137478395505267074792640977169027657821102995174653260850467876591';
const TOK_NO = '115197996950158595571592910109656095517681096550218045956704295481142826982547';
const CARICO = 0.124;   // avgPrice letto dal venue
const SIZE = 24;        // share NO possedute
const T0 = 1_786_557_578_624; // 2026-08-12T17:59:38.624Z — la prima delle 14 decisioni

// Book letto dal venue alle 18:12: YES bid 0,901 / ask 0,913 · NO bid 0,087 / ask 0,099.
const REGOLE_VINDMAN = {
  readable: true, tokenId: TOK_YES, tokenIdNo: TOK_NO, tick: 0.001, minSize: 20, maxSpreadCents: 4.5,
  books: { yes: { scoringMid: 0.907, bestBid: 0.901 }, no: { scoringMid: 0.093, bestBid: 0.087 } },
};

function registroFinto(iniziale = {}) {
  const m = new Map(Object.entries(iniziale));
  return { leggi: (k) => m.get(k) || null, segna: (k, r) => m.set(k, r), pulisci: (k) => m.delete(k), _m: m };
}

/**
 * Il ciclo VERO, con ogni effetto iniettato: nessun venue, nessuna rete, nessun file di produzione.
 * Raccoglie le righe d'audit così come le scriverebbe `appendMakerAudit`.
 */
async function ciclo({
  rules = REGOLE_VINDMAN, posizioni, ordini = [], depth, registro = registroFinto(),
  placeOk = true, now = T0, marketId = VINDMAN, venue = { readable: true, closed: false, acceptingOrders: true },
} = {}) {
  const righe = [];
  const piazzati = [];
  const cancellati = [];
  const res = await AC.runAutoCloseCycle({
    now: () => now,
    marketIds: [marketId],
    killStatus: () => ({ effectivelyKilled: false, readable: true }),
    isEnabled: () => ({ enabled: true }),
    isManual: () => ({ manual: true, readable: true }),
    resolveRules: () => rules,
    readVenue: async () => venue,
    readPositions: async () => ({ ok: true, positions: posizioni }),
    listOrders: async () => ({ ok: true, orders: ordini }),
    readDepth: () => depth,
    attesaMerge: registro,
    placeOrder: async (spec) => {
      piazzati.push(spec);
      return placeOk ? { ok: true, sent: true, orderId: `ord-${piazzati.length}` }
        : { ok: false, gate: 'mai-primo-sul-libro', reason: 'rifiutato dal gate (finto)' };
    },
    cancelOrder: async (spec) => { cancellati.push(spec); return { ok: true }; },
    audit: (r) => righe.push(r),
  });
  return { res, righe, piazzati, cancellati };
}

/** La PROPRIETÀ, in una funzione sola: ogni decisione ha il suo esito. */
const DECISIONE = /^merge-livello-([123])(-osservato)?$/;
const ESITO = /^(merge-livello-[123]-(piazzato|reject-.*)|merge-saltato-.*|merge-in-attesa|merge-onchain-.*|merge-esito-mancante|merge-timeout-.*|modalita-chiusura-sorella-.*|riposizionamento-scoperto-.*|rimasuglio-.*)$/;
function verificaProprieta(righe) {
  const decisioni = righe.filter((r) => DECISIONE.test(String(r.outcome)));
  const esiti = righe.filter((r) => ESITO.test(String(r.outcome)));
  return { decisioni: decisioni.length, esiti: esiti.length, ok: decisioni.length === 0 || esiti.length >= decisioni.length,
    outcomes: righe.map((r) => r.outcome) };
}

(async () => {
  // ══ 1 · LA SCENA VERA DI VINDMAN ═══════════════════════════════════════════════════════════════
  console.log('\n── 1 · LA SCENA DEL 12 AGOSTO, RIPRODOTTA NUMERO PER NUMERO');
  {
    // Prima: il verdetto di `decideClose` deve essere IDENTICO a quello che la produzione ha scritto.
    const d = AC.decideClose({
      position: { tokenId: TOK_NO, size: SIZE, avgPrice: CARICO },
      restingOrders: [], rules: REGOLE_VINDMAN, book: 'no',
      venue: { readable: true, closed: false, acceptingOrders: true },
    });
    ok('il verdetto è quello vero: skip/no-target', d.action === 'skip' && d.gate === 'no-target', `${d.action}/${d.gate}`);
    ok('  con il motivo testuale della produzione',
      /banda premiante corrente \(fino a 0.115\).*sotto il prezzo di carico \(0.124\)/.test(d.reason), d.reason.slice(0, 80));

    // Ora il ciclo intero, con la gamba scoperta e nessuna copertura.
    const { righe, piazzati } = await ciclo({
      posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }],
      depth: { readable: true, yes: { asks: [{ price: 0.913, size: 96 }], bids: [{ price: 0.901, size: 126 }] },
        no: { asks: [{ price: 0.099, size: 126 }], bids: [{ price: 0.087, size: 96 }] } },
    });
    const outcomes = righe.map((r) => String(r.outcome));
    ok('la decisione viene presa (merge livello 2)', outcomes.some((o) => /^merge-livello-2$/.test(o)), outcomes.join(', '));

    // ── IL CUORE DEL TEST: PRIMA QUI NON C'ERA NIENTE ────────────────────────────────────────────
    const esiti = outcomes.filter((o) => ESITO.test(o));
    ok('E ADESSO ESISTE UN ESITO', esiti.length > 0, esiti.join(', ') || 'NESSUNO — è il difetto del 12 agosto');
    // E il completamento CONCLUDE la gestione, quindi lo skip non viene nemmeno raggiunto: è il verso
    // giusto — «non posso vendere in guadagno» non è più l'ultima parola su questa posizione.
    ok('  il completamento riuscito sostituisce lo skip', !outcomes.includes('skip-no-target'), outcomes.join(', '));

    // Se invece il venue RIFIUTA il completamento, lo skip torna — e dichiara di averlo tentato.
    const rifiutato = await ciclo({
      posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }],
      depth: { readable: true, yes: { asks: [{ price: 0.913, size: 96 }], bids: [{ price: 0.901, size: 126 }] },
        no: { asks: [{ price: 0.099, size: 126 }], bids: [{ price: 0.087, size: 96 }] } },
      placeOk: false,
    });
    const outRif = rifiutato.righe.map((r) => String(r.outcome));
    ok('completamento rifiutato ⇒ lo skip torna', outRif.includes('skip-no-target'), outRif.join(', '));
    ok('  e dichiara di aver tentato la coppia',
      rifiutato.righe.some((r) => r.outcome === 'skip-no-target' && r.observed && r.observed.coppiaTentata === true));
    ok('  con il rifiuto del venue a verbale, non un silenzio',
      outRif.some((o) => /^merge-livello-2-reject-/.test(o)), outRif.join(', '));

    // E il completamento della coppia parte davvero: BUY sull'altro lato, mai una vendita in perdita.
    ok('il completamento viene inviato', piazzati.length >= 1, `${piazzati.length} ordine/i`);
    const buy = piazzati.find((p) => p.side === 'BUY');
    ok('  è un BUY sul lato mancante (YES)', !!buy && buy.book === 'yes', buy ? `${buy.side}/${buy.book}` : 'nessun BUY');
    ok('  per le share che mancano alla coppia', !!buy && buy.size === SIZE, buy ? String(buy.size) : '—');
    ok('  al tetto del merge (86,6¢ = 100 − 12,4 − 1)', !!buy && buy.price <= 0.866 + 1e-9, buy ? String(buy.price) : '—');
    ok('  NON si vende il lato posseduto in perdita', !piazzati.some((p) => p.side === 'SELL'),
      piazzati.filter((p) => p.side === 'SELL').map((p) => p.price).join(','));
    ok('  ed è dichiarato come ordine che CHIUDE una posizione', !!buy && buy.chiudePosizione === true);
  }

  // ══ 2 · LA PROPRIETÀ, SU OGNI SCENARIO ═════════════════════════════════════════════════════════
  console.log('\n── 2 · LA PROPRIETÀ: OGNI DECISIONE HA UN ESITO, SU OGNI RAMO');
  {
    const bookPieno = { readable: true,
      yes: { asks: [{ price: 0.913, size: 96 }], bids: [{ price: 0.901, size: 126 }] },
      no: { asks: [{ price: 0.099, size: 126 }], bids: [{ price: 0.087, size: 96 }] } };
    const scenari = [
      { nome: 'banda sotto il carico (la scena vera)', arg: {
        posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }], depth: bookPieno } },
      { nome: 'il venue rifiuta il completamento', arg: {
        posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }], depth: bookPieno, placeOk: false } },
      { nome: 'scala ask non leggibile', arg: {
        posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }], depth: { readable: true, yes: {}, no: {} } },
      },
      { nome: 'profondità del tutto assente', arg: {
        posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }], depth: null } },
      { nome: 'coppia già completa (merge on-chain)', arg: {
        posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }, { tokenId: TOK_YES, size: SIZE, avgPrice: 0.86 }],
        depth: bookPieno } },
      { nome: 'uscita in guadagno possibile (banda sopra il carico)', arg: {
        posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: 0.070 }], depth: bookPieno } },
      { nome: 'completamento già a riposo (attesa aperta)', arg: {
        posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }], depth: bookPieno,
        registro: registroFinto({ [`${VINDMAN}:${TOK_NO}`]: { at: T0 - 10 * 60_000, orderId: 'ord-vecchio', size: SIZE, prezzo: 0.866 } }) } },
      { nome: 'un\'uscita è già a riposo (already-covered)', arg: {
        posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: 0.070 }], depth: bookPieno,
        ordini: [{ orderId: 'sell-vivo', tokenId: TOK_NO, side: 'SELL', price: 0.11, size: SIZE }] } },
    ];
    let tutteOk = true;
    for (const s of scenari) {
      const { righe } = await ciclo(s.arg);
      const v = verificaProprieta(righe);
      if (!v.ok) tutteOk = false;
      ok(`«${s.nome}»: ${v.decisioni} decisione/i ⇒ ${v.esiti} esito/i`, v.ok, v.ok ? '' : v.outcomes.join(', '));
    }
    ok('LA PROPRIETÀ REGGE SU TUTTI GLI SCENARI', tutteOk,
      tutteOk ? 'nessuna decisione senza esito' : 'ALMENO UNA DECISIONE È USCITA IN SILENZIO');
  }

  // ══ 3 · I GATE SU CUI IL COMPLETAMENTO NON È TENTABILE LO DICHIARANO ═══════════════════════════
  console.log('\n── 3 · «NON L\'HO TENTATO PERCHÉ NON POTEVO» È ANCH\'ESSO UN ESITO');
  {
    // Carico non leggibile: `completaCoppia` prezza il tetto sul carico, quindi non è tentabile. È il
    // caso vero delle 17:58:38, quando il venue non aveva ancora pubblicato l'avgPrice della posizione.
    const { righe, piazzati } = await ciclo({
      posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: 0 }],
      depth: { readable: true, yes: { asks: [{ price: 0.913, size: 96 }] }, no: {} },
    });
    const outcomes = righe.map((r) => String(r.outcome));
    ok('lo skip per carico illeggibile resta', outcomes.includes('skip-no-entry-price'), outcomes.join(', '));
    ok('  e adesso DICHIARA di non aver potuto tentare',
      outcomes.includes('merge-saltato-senza-ingressi'), outcomes.join(', '));
    ok('  con il motivo, non con un silenzio',
      righe.some((r) => r.outcome === 'merge-saltato-senza-ingressi' && /non tentabile/.test(String(r.reason))));
    ok('  e NON viene inviato nessun ordine', piazzati.length === 0, `${piazzati.length}`);
    ok('  non è un `merge-esito-mancante`: è una rinuncia motivata',
      !outcomes.includes('merge-esito-mancante'));
    const v = verificaProprieta(righe);
    ok('  la proprietà regge anche qui', v.ok, `${v.decisioni} decisioni / ${v.esiti} esiti`);
  }

  // ══ 4 · LA RETE DI SICUREZZA ═══════════════════════════════════════════════════════════════════
  console.log('\n── 4 · SE UN RAMO FUTURO SFUGGISSE, IL FLUSH LO PRENDE');
  {
    // La rete si prova per costruzione: `flushObblighi` gira in cima a ogni iterazione della posizione
    // e dopo il ciclo delle posizioni, quindi nessun `continue` può portarsi via un obbligo aperto.
    // Qui si verifica che i due punti di flush ESISTANO nel sorgente e che il ramo `skip` non torni a
    // uscire prima del tentativo — la regressione che questo file esiste per impedire.
    const src = require('fs').readFileSync(require.resolve('./auto-close.js'), 'utf8');
    const righeSrc = src.split('\n').filter((l) => !/^\s*\/\//.test(l)); // i commenti non sono codice
    const corpo = righeSrc.join('\n');
    ok('l\'obbligo si apre insieme alla decisione', /apriObbligo\(chiaveMerge/.test(corpo));
    ok('  e si chiude in `registraCoppia`', /registraCoppia = \(esito, ramo\) => \{[\s\S]{0,400}?chiudiObbligo\(chiaveMerge\)/.test(corpo));
    ok('ci sono DUE punti di flush', (corpo.match(/flushObblighi\(\);/g) || []).length >= 2,
      String((corpo.match(/flushObblighi\(\);/g) || []).length));
    ok('  uno in cima al ciclo delle posizioni',
      /for \(const pos of mine\) \{[\s\S]{0,300}?flushObblighi\(\);/.test(corpo));
    ok('  e uno prima di `markets.push`', /flushObblighi\(\);\s*\n\s*markets\.push\(m\);/.test(corpo));
    // ⚠ ANCORATA A `m.skipped++`, NON AL `continue`. Un regex fino al `continue` più vicino trovava
    // anche il `provaCoppia([])` dell'uscita ORDINARIA quaranta righe più sotto, quindi passava pure
    // sul codice pre-fix: verificato con `git stash`. `m.skipped++` è la prima istruzione del ramo
    // dopo il tentativo, quindi fra l'`if` e quella riga c'è solo ciò che il ramo `skip` fa davvero.
    const ramoSkip = corpo.match(/if \(d\.action === 'skip'\) \{([\s\S]*?)m\.skipped\+\+;/);
    ok('il ramo `skip` tenta la coppia PRIMA di rinunciare',
      !!ramoSkip && /provaCoppia\(\[\]\)/.test(ramoSkip[1]),
      ramoSkip ? `${ramoSkip[1].length} caratteri fra l'if e m.skipped++` : 'ramo non trovato');
    ok('  e registra l\'esito di quel tentativo',
      !!ramoSkip && /registraCoppia\(c, `skip-\$\{d\.gate\}`\)/.test(ramoSkip[1]));
    ok('  e la lista dei gate senza ingressi è esplicita',
      /SENZA_INGRESSI = new Set\(\['no-position', 'no-entry-price', 'rules-unreadable'/.test(corpo));
    ok('`non-applicabile` non è più un ramo muto',
      !/if \(esito\.esito !== 'non-applicabile'\) \{/.test(corpo));
  }

  // ══ 5 · I VINCOLI DURI NON SONO STATI TOCCATI ══════════════════════════════════════════════════
  console.log('\n── 5 · NIENTE È STATO ALLENTATO');
  {
    ok('l\'interruttore del merge è quello di prima', MERGE_STRATEGY_ENABLED === true);

    // Il KILL resta sovraordinato: nessun ciclo, quindi nessuna decisione e nessun ordine.
    const righe = [];
    const res = await AC.runAutoCloseCycle({
      now: () => T0, marketIds: [VINDMAN],
      killStatus: () => ({ effectivelyKilled: true, readable: true }),
      audit: (r) => righe.push(r),
    });
    ok('con il KILL attivo il ciclo non parte', res.ran === false && res.gate === 'kill', `${res.gate}`);
    ok('  e non scrive nessuna decisione', righe.length === 0, `${righe.length} righe`);

    // Il mercato chiuso continua a uscire prima, senza tentare niente.
    const { piazzati } = await ciclo({
      posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }],
      depth: { readable: true, yes: {}, no: {} },
      venue: { readable: true, closed: true, acceptingOrders: false },
    });
    ok('un mercato chiuso non riceve ordini', piazzati.length === 0, `${piazzati.length}`);

    // Il completamento è sempre un BUY sul lato mancante e mai una vendita sotto il carico.
    const { piazzati: p2 } = await ciclo({
      posizioni: [{ tokenId: TOK_NO, size: SIZE, avgPrice: CARICO }],
      depth: { readable: true, yes: { asks: [{ price: 0.913, size: 96 }], bids: [{ price: 0.901, size: 126 }] }, no: {} },
    });
    ok('nessun ordine sotto il prezzo di carico sul lato posseduto',
      !p2.some((p) => p.book === 'no' && p.side === 'SELL' && p.price < CARICO),
      p2.filter((p) => p.book === 'no').map((p) => `${p.side}@${p.price}`).join(',') || 'nessuno sul lato posseduto');
  }

  console.log(`\n${falliti === 0 ? '✅' : '❌'}  ${passati} passati, ${falliti} falliti`);
  if (falliti > 0) process.exitCode = 1;
})();

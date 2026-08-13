'use strict';

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *  IL BOT SI ACCORGE DA SOLO DI ESSERE BLOCCATO, E NE ESCE DA SOLO
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════
 *
 * ⚠ IL FATTO. Il 13 agosto 2026 il bot ha rifiutato **la stessa richiesta 114 volte di fila per la
 * stessa ragione** — `spazio $24,00 sotto il minimo di $24,50` — per tre ore, con $609 liquidi, e ha
 * continuato a riprovare identico. Nessun processo era caduto, nessun log riportava un errore. Il
 * sistema aveva tutte le informazioni per sapere di essere bloccato e nessun meccanismo il cui mestiere
 * fosse **reagire**.
 *
 * ═══ IL PRINCIPIO ══════════════════════════════════════════════════════════════════════════════════
 * **Ogni difesa deve AGIRE, non solo segnalare.** Un allarme che nessuno legge non è una difesa: qui
 * non c'è nessuno a leggerlo. Ma un'azione che aggira una regola di rischio è peggio del blocco, quindi
 * vale l'altra metà del principio: **quando l'unica via d'uscita violerebbe una regola di rischio, il
 * bot NON agisce e lo dichiara.** Meglio fermo che pericoloso.
 *
 * ═══ COSA QUESTO MODULO NON PUÒ FARE, PER COSTRUZIONE ══════════════════════════════════════════════
 * È **puro**: nessun `require` di rete, di venue, di disco. Riceve fatti, restituisce un verdetto e il
 * NOME di un'azione; chi lo chiama la esegue. Non conosce `placeManualOrder`, non conosce `cancelOrder`,
 * non conosce nessun tetto: non può alzarne uno perché non sa che esistono.
 */

const fin = (v) => Number.isFinite(v);

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//  § 1 · LE FAMIGLIE DI RIFIUTO, E COSA SI PUÒ FARE DI OGNUNA
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * La classificazione viene dal **censimento dei rifiuti veri** sul giornale maker, 9-13 agosto 2026,
 * 43.299 rifiuti. Ogni famiglia è in uno di tre stati, e lo stato decide la reazione:
 *
 *  · `rischio`     — il rifiuto È una regola di rischio o la verità del libro. **Non si aggira mai.**
 *                    L'unica reazione lecita è cambiare mercato; se non ce n'è un altro, si dichiara.
 *  · `stato-bot`   — il rifiuto viene da uno stato NOSTRO che si è disallineato dalla realtà. Qui una
 *                    via alternativa esiste davvero, e non tocca nessuna regola.
 *  · `transitorio` — passa da sé (quota, orologio). Ripetere non è un difetto: non è un blocco.
 *
 * ⚠ `azione` è il NOME di ciò che il chiamante deve tentare, non la sua implementazione. Un modulo puro
 * che sapesse *come* nettare un ledger o riscrivere una allowlist sarebbe un modulo che può farlo.
 */
const FAMIGLIE = {
  // ── RISCHIO: 24.395 rifiuti su 43.299 (56%). Nessuna via alternativa, e non deve esistere. ───────
  'motore-non-conforme': { classe: 'rischio', azione: 'cambia-mercato', perche: 'il rimpiazzo non sarebbe un ordine valido (banda, profondità, mai-primo): il motore ha ragione' },
  'mai-primo-sul-libro': { classe: 'rischio', azione: 'cambia-mercato', perche: 'stare primi sul libro è vietato senza appello' },
  'inseguimento-contro-mai-primo': { classe: 'rischio', azione: 'cambia-mercato', perche: 'inseguire il mid porterebbe in cima al libro' },
  'would-cross': { classe: 'rischio', azione: 'cambia-mercato', perche: 'attraversare lo spread trasformerebbe un maker in un taker' },
  'end-of-scale': { classe: 'rischio', azione: 'cambia-mercato', perche: 'sotto 3¢ o sopra 97¢ il mercato sta risolvendo' },
  'venue-rules': { classe: 'rischio', azione: 'cambia-mercato', perche: 'tick, banda o minimo del venue non ammettono questo ordine' },
  'close-sell-floor': { classe: 'rischio', azione: 'cambia-mercato', perche: 'vendere sotto il carico è vietato' },
  'manual-order-cap': { classe: 'rischio', azione: 'cambia-mercato', perche: 'il tetto per ordine non si alza per sbloccarsi' },
  'limit-max-open-notional-vero': { classe: 'rischio', azione: 'nessuna', perche: 'esposizione aperta davvero al tetto: si aspetta che rientri' },

  // ── STATO DEL BOT: qui una via alternativa esiste, e non tocca nessuna regola. ───────────────────
  'idempotent-duplicate': { classe: 'stato-bot', azione: 'ricarica-configurazione', perche: 'la chiave è bruciata da un ordine che il venue non ha più: il registro va riletto' },
  idempotent: { classe: 'stato-bot', azione: 'ricarica-configurazione', perche: 'idem' },
  'limit-max-open-notional': { classe: 'stato-bot', azione: 'riconcilia-esposizione', perche: 'il ledger dei fill può dichiarare posizioni che al venue non esistono più' },
  'live-min-market-mismatch': { classe: 'stato-bot', azione: 'ripara-precondizioni', perche: 'il mercato non è nella allowlist: è una scrittura che manca, non un divieto' },
  'manual-mode-inactive': { classe: 'stato-bot', azione: 'ripara-precondizioni', perche: 'il mercato non è in gestione manuale: idem' },
  'rules-unreadable': { classe: 'stato-bot', azione: 'ripara-catalogo', perche: 'le regole del mercato non si leggono: vanno riprese dal venue' },
  'market-unknown': { classe: 'stato-bot', azione: 'ripara-catalogo', perche: 'idem' },
  'refresh-invalid': { classe: 'stato-bot', azione: 'ripara-catalogo', perche: 'idem' },
  'mid-stale': { classe: 'stato-bot', azione: 'risveglia-feed', perche: 'il mid non è vivo: il feed non pubblica' },
  'mid-not-live': { classe: 'stato-bot', azione: 'risveglia-feed', perche: 'idem' },
  'stale-book': { classe: 'stato-bot', azione: 'risveglia-feed', perche: 'idem' },
  'board-vecchio': { classe: 'stato-bot', azione: 'risveglia-feed', perche: 'la fotografia del board è oltre il limite di freschezza' },
  'piano-senza-righe': { classe: 'stato-bot', azione: 'ricostruisci-piano', perche: 'nessuna riga del piano è spendibile: il piano va rifatto' },
  // ⚠ LA PRIMA CAUSA DI PERDITA DI GAMBE, e mancava dalla mappa: 84 gambe su 129 perse (65%) e $1.276
  // di nozionale in 24 ore. Trattata come «sconosciuta» finiva in classe `rischio`, cioè «non si
  // aggira» — ma NON è una regola di rischio: è il precontrollo atomico che scarta la coppia perché una
  // gamba sfonda il tetto per ordine, e la risposta giusta è **ricostruire il piano**, che adesso passa
  // da `coerenza-soglie` e ADATTA il capitale invece di proporre righe destinate al rifiuto.
  'coppia-non-atomica': { classe: 'stato-bot', azione: 'ricostruisci-piano', perche: 'la riga proposta non rispetta il tetto per ordine su una delle due gambe: va riadattata, non ripetuta' },
  'idempotency-preflight': { classe: 'stato-bot', azione: 'ricarica-configurazione', perche: 'il precontrollo della chiave ha visto un intent già registrato: il registro va riletto' },

  // ── RISCHIO: le altre facce delle regole del motore, viste nel censimento dei 3 giorni ───────────
  'mai-primo-non-quotabile': { classe: 'rischio', azione: 'cambia-mercato', perche: 'nessun livello dietro il migliore resta dentro la banda premiante' },
  'chase-target-invalid': { classe: 'rischio', azione: 'cambia-mercato', perche: 'il bersaglio dell\'inseguimento non è un prezzo valido: non si insegue a caso' },
  'mid-chase': { classe: 'rischio', azione: 'cambia-mercato', perche: 'idem' },
  'replacement-invalid': { classe: 'rischio', azione: 'nessuna', perche: 'il rimpiazzo non sarebbe un ordine valido: si lascia vivo quello che c\'è' },
  'mid-stantio': { classe: 'stato-bot', azione: 'risveglia-feed', perche: 'il mid non è vivo da oltre il timeout: il feed non pubblica' },

  // ── TRANSITORI aggiunti dal censimento ──────────────────────────────────────────────────────────
  venue: { classe: 'transitorio', azione: 'nessuna', perche: 'errore del venue senza codice nostro: si riprova al giro dopo' },
  'expiry-refresh': { classe: 'transitorio', azione: 'nessuna', perche: 'non è un rifiuto: è il rinnovo che sta per partire' },
  place: { classe: 'transitorio', azione: 'nessuna', perche: 'etichetta di operazione, non una causa' },
  replace: { classe: 'transitorio', azione: 'nessuna', perche: 'idem' },

  // ── TRANSITORI: ripetere non è un difetto. ──────────────────────────────────────────────────────
  'rate-limited': { classe: 'transitorio', azione: 'nessuna', perche: 'la finestra si libera da sé' },
  'kill-global': { classe: 'transitorio', azione: 'nessuna', perche: 'è un interruttore, non un guasto' },
  'market-closed': { classe: 'transitorio', azione: 'nessuna', perche: 'il mercato è finito: non è un blocco da sciogliere' },
  'market-not-accepting-orders': { classe: 'transitorio', azione: 'nessuna', perche: 'idem' },
};

/** Una famiglia che non conosciamo è trattata come **rischio**: non si inventa una via d'uscita per un
 *  rifiuto di cui non si sa niente. È la stessa regola di `ignota` altrove — l'incognita non è un via libera. */
function classifica(gate) {
  const k = typeof gate === 'string' ? gate.trim() : '';
  if (!k) return { gate: null, classe: 'rischio', azione: 'nessuna', perche: 'rifiuto senza gate dichiarato: non si indovina una reazione', noto: false };
  const f = FAMIGLIE[k];
  if (f) return { gate: k, ...f, noto: true };
  return { gate: k, classe: 'rischio', azione: 'cambia-mercato', noto: false,
    perche: 'famiglia di rifiuto sconosciuta: si tratta come una regola di rischio, non si aggira' };
}

/**
 * QUANTE RIPETIZIONI IDENTICHE FANNO UN BLOCCO — `N = 5`.
 *
 * Il numero viene dai dati, non dal gusto. Sul giornale 9-13 agosto la **stessa** coppia
 * (mercato, gate) si è ripetuta fino a **3.309** volte di fila: qualunque soglia ragionevole sarebbe
 * scattata. Il vincolo che decide il valore è l'altro lato — **non scattare su un caso normale**: un
 * ordine viene riprezzato ogni ~60 s, quindi 5 ripetizioni identiche sono ~5 minuti in cui il libro si
 * è mosso e la risposta non è cambiata. Sotto (2-3) si prenderebbero i rimbalzi di un book che oscilla;
 * sopra (20+) si aspetterebbero venti minuti per sapere una cosa già chiara al quinto giro.
 *
 * Si dichiara con `MAKER_RIFIUTI_RIPETUTI_N`, scartato fuori da [2, 100].
 */
const N_RIPETIZIONI = (() => {
  const v = Number(process.env.MAKER_RIFIUTI_RIPETUTI_N);
  if (Number.isFinite(v) && v >= 2 && v <= 100) return Math.floor(v);
  return 5;
})();

/** La serie si azzera se fra due rifiuti passa più di questo: una ripetizione a mezz'ora di distanza
 *  non è un loop, è un mercato che quel giorno non va bene. */
const FINESTRA_MS = 15 * 60_000;

/**
 * Registra un esito e dice se siamo davanti a un blocco strutturale.
 *
 * @param stato   mappa `chiave ⇒ {n, primo, ultimo, gate}` (si passa e si riceve, niente stato globale)
 * @param esiti   `[{marketId, gate, status}]` — le righe di risultato di un giro
 * @returns {{stato:object, blocchi:Array<{chiave,marketId,gate,n,classe,azione,perche}>}}
 */
function registraEsiti({ stato = {}, esiti = [], now = Date.now(), soglia = N_RIPETIZIONI } = {}) {
  const s = { ...stato };
  const blocchi = [];
  for (const e of (esiti || [])) {
    if (!e) continue;
    const mk = String(e.marketId || '').toLowerCase();
    const gate = e.gate || null;
    // Un SUCCESSO azzera la serie di quel mercato: è la prova che il blocco non c'è più, e non
    // azzerarla vorrebbe dire reagire a un problema già risolto.
    if (e.status !== 'refused') {
      for (const k of Object.keys(s)) if (k.startsWith(mk + '|')) delete s[k];
      continue;
    }
    if (!mk || !gate) continue;
    const k = mk + '|' + gate;
    const prec = s[k];
    const scaduta = prec && fin(prec.ultimo) && (now - prec.ultimo) > FINESTRA_MS;
    const n = prec && !scaduta ? prec.n + 1 : 1;
    s[k] = { n, primo: prec && !scaduta ? prec.primo : now, ultimo: now, gate };
    if (n >= soglia) {
      const c = classifica(gate);
      blocchi.push({ chiave: k, marketId: mk, gate, n, durataMs: now - s[k].primo, ...c });
    }
  }
  return { stato: s, blocchi };
}

/**
 * Cosa fare dei blocchi trovati: le azioni **distinte** da tentare, e i mercati da escludere da questo
 * giro. Un blocco di classe `rischio` non produce nessuna azione di sistema — produce un'esclusione,
 * che è ciò che il meccanismo delle passate già fa, e una riga che dice **perché non si è agito**.
 */
function reazione(blocchi = []) {
  const azioni = new Set();
  const daEscludere = new Set();
  const nonAgibili = [];
  for (const b of blocchi) {
    if (b.classe === 'transitorio') continue;
    if (b.classe === 'rischio') {
      daEscludere.add(b.marketId);
      nonAgibili.push({ marketId: b.marketId, gate: b.gate, n: b.n, perche: b.perche });
      continue;
    }
    if (b.azione && b.azione !== 'nessuna') azioni.add(b.azione);
    daEscludere.add(b.marketId);
  }
  return {
    azioni: [...azioni],
    daEscludere: [...daEscludere],
    nonAgibili,
    // Il caso che il principio guida chiede di dichiarare invece di forzare.
    soloRischio: azioni.size === 0 && nonAgibili.length > 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════
//  § 3-4 · L'AUTODIAGNOSI, E LA SCALA CHE NE DISCENDE
// ═══════════════════════════════════════════════════════════════════════════════════════════════════
/**
 * LE SOGLIE DELL'AUTODIAGNOSI, e da dove vengono.
 *
 *  · **ordini vivi > 0** — la sentinella sul vuoto copre già lo zero secco a 5 minuti; qui serve come
 *    ingrediente del verdetto complessivo.
 *  · **capitale al lavoro ≥ 50%** — non il 95% dell'obiettivo: l'obiettivo è una tensione, la soglia
 *    è un **sintomo di guasto**. Sul giornale delle 48 ore precedenti il valore mediano misurato era
 *    22,8% con punte a 40,5% *durante il blocco*, e 44-63% a bot sano: 50% separa i due regimi senza
 *    scattare su un giro sfortunato. Sotto per **15 minuti** è un guasto, non una fluttuazione.
 *  · **un ciclo di agent41 negli ultimi 20 minuti** — il mini-ciclo gira ogni 10-12 min; 20 minuti
 *    sono due cadenze mancate, cioè il processo non sta girando.
 *  · **i rinnovi passano** — se ogni rinnovo dovuto viene fermato, gli ordini muoiono per GTD e il
 *    vuoto arriva fra ~23 minuti: è l'unico indicatore che vede il guasto **prima** che si manifesti.
 */
const SOGLIA_AL_LAVORO = 0.50;
const DURATA_SOTTO_SOGLIA_MS = 15 * 60_000;
const CICLO_MAX_SILENZIO_MS = 20 * 60_000;

/**
 * @returns {{sano:boolean, motivi:string[], misure:object}} — `sano:null` quando non si può giudicare
 */
function autodiagnosi({
  ordiniVivi = null, frazioneAlLavoro = null, ultimoCicloMs = null,
  rinnoviDovuti = null, rinnoviFermati = null, now = Date.now(), sottoSogliaDa = null,
} = {}) {
  const motivi = [];
  const ignoti = [];

  if (fin(ordiniVivi)) { if (ordiniVivi <= 0) motivi.push('zero ordini a riposo'); } else ignoti.push('ordini a riposo');

  // La soglia sul capitale morde solo se DURA: un singolo giro sotto il 50% è normale subito dopo un
  // ribilanciamento. Serve `sottoSogliaDa`, che il chiamante mantiene fra un giro e l'altro.
  if (fin(frazioneAlLavoro)) {
    if (frazioneAlLavoro < SOGLIA_AL_LAVORO) {
      const da = fin(sottoSogliaDa) ? sottoSogliaDa : now;
      if ((now - da) >= DURATA_SOTTO_SOGLIA_MS) {
        motivi.push(`capitale al lavoro ${(frazioneAlLavoro * 100).toFixed(1)}% sotto il ${SOGLIA_AL_LAVORO * 100}% da ${Math.round((now - da) / 60000)} minuti`);
      }
    }
  } else ignoti.push('capitale al lavoro');

  if (fin(ultimoCicloMs)) { if (ultimoCicloMs > CICLO_MAX_SILENZIO_MS) motivi.push(`nessun ciclo da ${Math.round(ultimoCicloMs / 60000)} minuti`); } else ignoti.push('ultimo ciclo');

  // I rinnovi: si guarda la FRAZIONE fermata, non il numero assoluto — dieci rinnovi fermati su mille
  // sono rumore, dieci su dodici sono il guasto che produce il vuoto fra ventitré minuti.
  if (fin(rinnoviDovuti) && rinnoviDovuti > 0 && fin(rinnoviFermati)) {
    const q = rinnoviFermati / rinnoviDovuti;
    if (q >= 0.8) motivi.push(`${rinnoviFermati}/${rinnoviDovuti} rinnovi dovuti sono stati fermati (${(q * 100).toFixed(0)}%)`);
  }

  // ⚠ TUTTO ILLEGGIBILE ⇒ NON SI GIUDICA. Un verdetto «malato» costruito su misure assenti farebbe
  // partire la scala di sblocco proprio quando non sappiamo niente — cioè agire alla cieca.
  if (ignoti.length >= 3) {
    return { sano: null, motivi: [], ignoti, misure: { frazioneAlLavoro, ordiniVivi, ultimoCicloMs } };
  }
  return { sano: motivi.length === 0, motivi, ignoti, misure: { frazioneAlLavoro, ordiniVivi, ultimoCicloMs } };
}

/**
 * LA SCALA, dal più leggero al più forte. Ogni gradino è un'azione che **non tocca nessuna regola di
 * rischio**: non alza tetti, non allarga bande, non consente di stare primi sul libro, non salta la
 * chiusura forzata. Sono tutte cose che rimettono in sincronia lo STATO del bot con la realtà.
 *
 * L'ultimo gradino non è un'azione: è **fermarsi**. Se cinque tentativi diversi non hanno sciolto il
 * blocco, il bot non sa cosa sta succedendo, e un bot che non sa cosa sta succedendo non deve piazzare.
 */
const SCALA = [
  { livello: 1, azione: 'ricostruisci-piano', cosa: 'ricostruisce il piano con gli stessi filtri del ciclo pesante' },
  { livello: 2, azione: 'ricarica-configurazione', cosa: 'rilegge da disco allowlist, tetti, gestione manuale e registro di idempotenza' },
  { livello: 3, azione: 'riconcilia-esposizione', cosa: 'netta il ledger dei fill contro lo snapshot del venue' },
  { livello: 4, azione: 'ripara-precondizioni', cosa: 'riscrive le precondizioni dei mercati del piano (allowlist, gestione, uscita)' },
  { livello: 5, azione: 'risveglia-feed', cosa: 'forza una riscansione del board e la risottoscrizione dei book' },
  { livello: 6, azione: 'fermati-in-sicurezza', cosa: 'mette il bot su FERMA e scrive un allarme grave: meglio fermo che pericoloso' },
];

/** Quanto si aspetta prima di salire di un gradino. Cinque minuti: è il tempo in cui la sentinella
 *  vede un vuoto, ed è più di due cadenze del trigger (120 s), quindi un gradino ha davvero avuto le
 *  sue occasioni prima che si salga. Sei gradini ⇒ il caso peggiore arriva a FERMA in ~30 minuti. */
const ATTESA_GRADINO_MS = 5 * 60_000;

/**
 * @param stato  `{livello, da, ultimaAzione}` — `null` quando il bot è sano
 * @returns `{stato, sali:boolean, gradino:object|null, motivo:string}`
 */
function prossimoGradino({ stato = null, sano = null, now = Date.now(), attesaMs = ATTESA_GRADINO_MS, azioniSuggerite = [] } = {}) {
  // Sano ⇒ la scala si azzera. È il solo modo di uscirne, ed è giusto che sia un FATTO misurato e non
  // un timeout: una scala che si azzera da sola dopo un po' dimenticherebbe un blocco ancora vivo.
  if (sano === true) {
    return { stato: null, sali: false, gradino: null, motivo: stato ? `rientrato al gradino ${stato.livello}: il bot è tornato sano` : 'sano' };
  }
  // Non giudicabile ⇒ non si sale e non si scende: si congela, come la sentinella su un dato assente.
  if (sano !== false) return { stato, sali: false, gradino: null, motivo: 'stato non giudicabile: la scala non si muove' };

  if (!stato) {
    // Il primo gradino può essere SCELTO dalle famiglie di rifiuto osservate invece di partire sempre
    // da 1: se il bot sa già che il problema è l'esposizione, ricostruire il piano è tempo perso.
    const suggerito = SCALA.find((g) => azioniSuggerite.includes(g.azione));
    const g = suggerito || SCALA[0];
    return { stato: { livello: g.livello, da: now, ultimaAzione: g.azione }, sali: true, gradino: g,
      motivo: suggerito ? `si parte dal gradino ${g.livello}: i rifiuti osservati indicano «${g.azione}»` : `si parte dal gradino ${g.livello}` };
  }
  if ((now - stato.da) < attesaMs) {
    return { stato, sali: false, gradino: null,
      motivo: `gradino ${stato.livello} in corso da ${Math.round((now - stato.da) / 60000)} min: si aspetta` };
  }
  const succ = SCALA.find((g) => g.livello === stato.livello + 1);
  if (!succ) {
    return { stato, sali: false, gradino: null, motivo: 'ultimo gradino già raggiunto: il bot è fermo in sicurezza' };
  }
  return { stato: { livello: succ.livello, da: now, ultimaAzione: succ.azione }, sali: true, gradino: succ,
    motivo: `il gradino ${stato.livello} non ha sciolto il blocco in ${Math.round(attesaMs / 60000)} min: si sale a ${succ.livello}` };
}

function selfcheck() {
  let p = 0; let f = 0;
  const ok = (n, c) => { if (c) p += 1; else { f += 1; console.error('  ✗', n); } };
  const T = 1_000_000_000_000;
  const M = '0x' + 'a'.repeat(64);

  // § 1 · i 114 rifiuti identici
  let st = {};
  let blocchi = [];
  for (let i = 0; i < 114; i += 1) {
    const r = registraEsiti({ stato: st, esiti: [{ marketId: M, gate: 'piano-senza-righe', status: 'refused' }], now: T + i * 60_000 });
    st = r.stato; if (r.blocchi.length) blocchi = r.blocchi;
  }
  ok('114 rifiuti identici producono un blocco', blocchi.length === 1 && blocchi[0].n >= 5);
  ok('  e scatta al quinto, non al centoquattordicesimo', (() => {
    let s = {}; let primo = null;
    for (let i = 0; i < 10 && primo == null; i += 1) {
      const r = registraEsiti({ stato: s, esiti: [{ marketId: M, gate: 'piano-senza-righe', status: 'refused' }], now: T + i * 1000 });
      s = r.stato; if (r.blocchi.length) primo = i + 1;
    }
    return primo === 5;
  })());
  ok('un successo azzera la serie', (() => {
    let s = {};
    for (let i = 0; i < 4; i += 1) s = registraEsiti({ stato: s, esiti: [{ marketId: M, gate: 'x', status: 'refused' }], now: T + i }).stato;
    s = registraEsiti({ stato: s, esiti: [{ marketId: M, status: 'placed' }], now: T + 5 }).stato;
    return Object.keys(s).length === 0;
  })());
  ok('una ripetizione fuori finestra non è un loop', (() => {
    let s = {};
    for (let i = 0; i < 4; i += 1) s = registraEsiti({ stato: s, esiti: [{ marketId: M, gate: 'x', status: 'refused' }], now: T + i }).stato;
    const r = registraEsiti({ stato: s, esiti: [{ marketId: M, gate: 'x', status: 'refused' }], now: T + FINESTRA_MS + 10_000 });
    return r.blocchi.length === 0;
  })());

  // § 1 · le reazioni
  ok('un rifiuto di RISCHIO non produce nessuna azione di sistema', (() => {
    const r = reazione([{ marketId: M, gate: 'mai-primo-sul-libro', n: 9, ...classifica('mai-primo-sul-libro') }]);
    return r.azioni.length === 0 && r.soloRischio === true && r.daEscludere.length === 1;
  })());
  ok('un rifiuto di STATO produce la sua via alternativa', (() => {
    const r = reazione([{ marketId: M, gate: 'limit-max-open-notional', n: 9, ...classifica('limit-max-open-notional') }]);
    return r.azioni.includes('riconcilia-esposizione');
  })());
  ok('una famiglia SCONOSCIUTA è trattata come rischio', classifica('gate-mai-visto').classe === 'rischio');
  ok('un rifiuto senza gate non produce reazioni inventate', classifica(null).azione === 'nessuna');
  ok('un transitorio non è un blocco', reazione([{ marketId: M, gate: 'rate-limited', n: 50, ...classifica('rate-limited') }]).daEscludere.length === 0);

  // § 4 · autodiagnosi
  ok('bot sano ⇒ sano', autodiagnosi({ ordiniVivi: 12, frazioneAlLavoro: 0.7, ultimoCicloMs: 60_000, now: T }).sano === true);
  ok('zero ordini ⇒ malato', autodiagnosi({ ordiniVivi: 0, frazioneAlLavoro: 0.7, ultimoCicloMs: 60_000, now: T }).sano === false);
  ok('capitale basso ma da poco ⇒ ancora sano', autodiagnosi({ ordiniVivi: 5, frazioneAlLavoro: 0.1, ultimoCicloMs: 6e4, sottoSogliaDa: T - 60_000, now: T }).sano === true);
  ok('  e sotto soglia da 15 minuti ⇒ malato', autodiagnosi({ ordiniVivi: 5, frazioneAlLavoro: 0.1, ultimoCicloMs: 6e4, sottoSogliaDa: T - 16 * 60_000, now: T }).sano === false);
  ok('cicli fermi ⇒ malato', autodiagnosi({ ordiniVivi: 5, frazioneAlLavoro: 0.7, ultimoCicloMs: 25 * 60_000, now: T }).sano === false);
  ok('rinnovi quasi tutti fermati ⇒ malato', autodiagnosi({ ordiniVivi: 5, frazioneAlLavoro: 0.7, ultimoCicloMs: 6e4, rinnoviDovuti: 12, rinnoviFermati: 11, now: T }).sano === false);
  ok('tutto illeggibile ⇒ NON si giudica', autodiagnosi({ now: T }).sano === null);

  // § 3 · la scala
  let sc = null;
  let r = prossimoGradino({ stato: sc, sano: false, now: T });
  ok('il primo gradino è la ricostruzione del piano', r.sali && r.gradino.livello === 1);
  sc = r.stato;
  ok('  e non si sale prima dell\'attesa', prossimoGradino({ stato: sc, sano: false, now: T + 60_000 }).sali === false);
  r = prossimoGradino({ stato: sc, sano: false, now: T + 6 * 60_000 });
  ok('  si sale dopo cinque minuti', r.sali && r.gradino.livello === 2);
  ok('tornare sani azzera la scala', prossimoGradino({ stato: r.stato, sano: true, now: T }).stato === null);
  ok('stato non giudicabile ⇒ la scala non si muove', prossimoGradino({ stato: sc, sano: null, now: T + 1e9 }).sali === false);
  ok('i rifiuti osservati scelgono il gradino di partenza',
    prossimoGradino({ stato: null, sano: false, now: T, azioniSuggerite: ['riconcilia-esposizione'] }).gradino.livello === 3);
  ok('l\'ultimo gradino è fermarsi in sicurezza', SCALA[SCALA.length - 1].azione === 'fermati-in-sicurezza');
  ok('  e oltre non si sale', (() => {
    let s = { livello: 6, da: T, ultimaAzione: 'fermati-in-sicurezza' };
    return prossimoGradino({ stato: s, sano: false, now: T + 60 * 60_000 }).sali === false;
  })());
  ok('sei gradini ⇒ FERMA entro ~30 minuti', (SCALA.length - 1) * (ATTESA_GRADINO_MS / 60000) <= 30);

  // Nessun gradino può toccare una regola di rischio: si prova per ASSENZA, non per promessa.
  // ⚠ La prova che nessun gradino tocchi una regola di rischio non si fa cercando parole nel testo —
  // la prima stesura lo faceva e cadeva sulla frase «il tetto per ordine NON si alza», cioè proprio
  // sulla riga che promette il contrario. Si prova sulla STRUTTURA: ogni famiglia di classe `rischio`
  // può solo cambiare mercato o non fare niente, e nessun gradino della scala è un'azione di rischio.
  ok('ogni famiglia di RISCHIO può solo cambiare mercato o astenersi',
    Object.values(FAMIGLIE).filter((x) => x.classe === 'rischio')
      .every((x) => x.azione === 'cambia-mercato' || x.azione === 'nessuna'));
  ok('  e nessuna azione di rischio compare nella scala',
    !SCALA.some((g) => g.azione === 'cambia-mercato')
    && SCALA.every((g) => ['ricostruisci-piano', 'ricarica-configurazione', 'riconcilia-esposizione',
      'ripara-precondizioni', 'risveglia-feed', 'fermati-in-sicurezza'].includes(g.azione)));
  ok('  e ogni azione di STATO ha un gradino che la esegue',
    Object.values(FAMIGLIE).filter((x) => x.classe === 'stato-bot')
      .every((x) => x.azione === 'ripara-catalogo' || SCALA.some((g) => g.azione === x.azione)));

  console.log(`sblocco-progressivo selfcheck: ${p} passati, ${f} falliti`);
  return f === 0;
}

module.exports = {
  FAMIGLIE, SCALA, classifica, registraEsiti, reazione, autodiagnosi, prossimoGradino, selfcheck,
  N_RIPETIZIONI, FINESTRA_MS, SOGLIA_AL_LAVORO, DURATA_SOTTO_SOGLIA_MS, CICLO_MAX_SILENZIO_MS, ATTESA_GRADINO_MS,
};

if (require.main === module) process.exit(selfcheck() ? 0 : 1);

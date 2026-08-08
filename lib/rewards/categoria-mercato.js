'use strict';
// lib/rewards/categoria-mercato.js — A QUALE FAMIGLIA APPARTIENE UN MERCATO.
//
// ═══ PERCHE' ESISTE ══════════════════════════════════════════════════════════════════════════════════
// La ricerca sui 21 maker di riferimento aveva misurato con precisione QUANDO entrano (orizzonte
// mediano 0,22 giorni), QUANTO (nozionale ~$34) e A CHE DISTANZA dal mid (1,5¢ in acquisto). Non aveva
// mai misurato SU COSA. Senza una classificazione non si puo' rispondere alla domanda che conta per la
// scoperta: il board del bot assomiglia a quello che i 21 fanno davvero, o stiamo guardando un universo
// diverso dal loro?
//
// Questo modulo e' la definizione UNICA di «categoria», e serve a due letture che devono essere
// confrontabili: gli ingressi osservati dei 21 (data/maker-21-eventi.jsonl) e il board di agent24
// (data/liquidity-rewards.json). Due classificatori diversi renderebbero il confronto privo di senso.
//
// ═══ SI CLASSIFICA SULLO SLUG, NON SUL TITOLO — E IL MOTIVO E' MISURATO ═════════════════════════════
// Polymarket costruisce gli slug con un prefisso strutturato per famiglia: `efl-bro-rea-2026-08-08`,
// `btc-updown-5m-1786214100`, `highest-temperature-in-singapore-on-august-8-2026-32c`. Il titolo e'
// prosa e cambia forma («Will X win on…», «O/U 3.5», «Exact Score…») per lo STESSO evento sportivo; lo
// slug no. Il titolo resta come seconda passata, per i casi in cui lo slug non dice abbastanza.
//
// ═══ `altro` E' UN ESITO, NON UN CESTINO ════════════════════════════════════════════════════════════
// Ogni classificazione porta `motivo` (quale regola ha deciso) e `certezza`. Un mercato che finisce in
// `altro` viene DICHIARATO con il suo slug, cosi' la qualita' del classificatore si giudica leggendo
// cosa non ha saputo classificare invece di fidarsi di una percentuale. Un classificatore che manda
// tutto in `altro` senza dirlo produce esattamente lo stesso numero di un classificatore perfetto sulle
// categorie che riconosce.
//
// SOLA LETTURA E PURO: nessun file, nessuna rete, nessuno stato. Non e' importato da nessun percorso di
// piazzamento o di selezione — e' uno strumento di misura, non una regola del motore.

const CATEGORIE = Object.freeze([
  'crypto', 'sport', 'meteo', 'politica-elezioni', 'politica-nomine-locali',
  'cronaca-eventi', 'finanza-aziende', 'altro',
]);

// ── I CODICI DI LEGA E DISCIPLINA, dal campione vero ────────────────────────────────────────────────
// Presi dagli slug osservati nei 446 ingressi dei 21 maker piu' quelli del board: campionati nazionali
// di calcio (il grosso), esports, tennis, baseball, basket. La lista e' lunga per costruzione — e'
// letteralmente l'elenco dei prefissi che Polymarket usa — e allungarla e' un'operazione senza rischio.
const PREFISSI_SPORT = [
  // calcio per federazione/lega (il codice paese o il codice lega, seguito da '-')
  'efl', 'epl', 'eng', 'chi', 'jap', 'jpn', 'arg', 'argpn', 'per', 'per1', 'rou', 'rou1', 'bl1', 'bl2',
  'ere', 'hr1', 'nor', 'swe', 'den', 'fin', 'cze', 'cze1', 'est', 'est1', 'lva', 'lva1', 'ltu', 'ltu1',
  'kaz', 'kaz1', 'svk', 'svk1', 'pol', 'por', 'col', 'col1', 'ukr', 'ukr1', 'scop', 'sco', 'irl', 'irl1',
  'rus', 'sui', 'aut', 'bel', 'ned', 'tur', 'gre', 'isr', 'kor', 'aus', 'bra', 'mex', 'usa', 'mls',
  'ita', 'esp', 'fra', 'ger', 'lec', 'uecl', 'ucl', 'uel', 'cop', 'lib', 'sud', 'afc', 'caf', 'concacaf',
  // altri sport
  'mlb', 'nba', 'wnba', 'nfl', 'nhl', 'npb', 'kbo', 'nwsl', 'atp', 'wta', 'itf', 'ufc', 'mma', 'box',
  'golf', 'pga', 'f1', 'nascar', 'cricket', 'rugby', 'tennis',
  // esports
  'lol', 'dota2', 'dota', 'cs2', 'csgo', 'val', 'valorant', 'ow', 'rl', 'r6', 'sc2', 'kog',
];
const SET_SPORT = new Set(PREFISSI_SPORT);

// Termini che, dentro titolo o slug, identificano lo sport anche senza un prefisso riconosciuto.
const PAROLE_SPORT = /\b(fc|sc|cf|afc|utd|united|vs\.?|o\/u|over|under|handicap|halftime|1st half|exact score|both teams to score|to score first|total corners|draw|win on \d|bo3|bo5|map \d|game \d|games total|spread|moneyline|match|fixture|league|cup|tournament|playoff|série|serie [ab]|liga|bundesliga|premier|championship)\b/i;

// ── LE REGOLE, IN ORDINE. La prima che risponde decide. ─────────────────────────────────────────────
// L'ordine non e' arbitrario: le famiglie con uno slug tecnico e inequivocabile (crypto a finestra,
// meteo) vengono prima di quelle che si riconoscono da parole comuni, perche' «Bitcoin Up or Down»
// contiene «Up» e «Down» che altrove sono rumore.
const REGOLE = [
  // ── CRYPTO ──────────────────────────────────────────────────────────────────────────────────────
  { cat: 'crypto', motivo: 'crypto a finestra breve (up/down)', certezza: 'alta',
    slug: /^(btc|eth|sol|xrp|doge|ada|bnb|ltc|link|avax)-updown-/i },
  { cat: 'crypto', motivo: 'prezzo di una cripto a una data', certezza: 'alta',
    slug: /^(bitcoin|ethereum|solana|ripple|xrp|dogecoin|cardano|litecoin|chainlink|avalanche|binance-coin)\b/i },
  { cat: 'crypto', motivo: 'cripto nominata nel titolo con una soglia di prezzo', certezza: 'media',
    titolo: /\b(bitcoin|ethereum|solana|dogecoin|ripple|xrp|btc|eth)\b/i,
    conferma: /\b(price|above|below|hit|reach|close|dip|\$)\b/i },
  // ── METEO ───────────────────────────────────────────────────────────────────────────────────────
  { cat: 'meteo', motivo: 'temperatura/precipitazioni in una città a una data', certezza: 'alta',
    slug: /^(highest|lowest)-temperature-in-|^will-it-rain|^rainfall-in-|^snowfall-in-|-temperature-on-/i },
  { cat: 'meteo', motivo: 'meteo nel titolo', certezza: 'media',
    titolo: /\b(temperature|rainfall|snowfall|hurricane|tornado|heat index|will it rain)\b/i },
  // ── SPORT ───────────────────────────────────────────────────────────────────────────────────────
  { cat: 'sport', motivo: 'prefisso di lega/disciplina nello slug', certezza: 'alta', prefissoSport: true },
  // LA REGOLA STRUTTURALE, e vale piu' della lista qui sopra. Polymarket costruisce lo slug di un
  // incontro come `<lega>-<casa>-<ospite>-<AAAA-MM-GG>[-mercato]`: `chi2-sud-cha-2026-08-08`,
  // `bol1-ant-nap-2026-08-08`, `fr2-mon-dij-2026-08-08`. E' una forma cosi' specifica — tre segmenti
  // corti seguiti da una data ISO — che riconoscerla non richiede di sapere quale lega sia.
  //
  // Serve perche' la lista dei prefissi non finisce mai: alla prima passata sui 446 ingressi veri, 20
  // dei 25 mercati finiti in `altro` erano campionati di calcio con un codice che non avevo previsto
  // (chi1, chi2, bol1, clf, swe2, fr2, uru1, ecu1, fin1, bra2, slo, lal). Una regola sulla FORMA li
  // prende tutti, compresi quelli che nasceranno domani.
  { cat: 'sport', motivo: 'forma di un incontro: lega-casa-ospite-data', certezza: 'alta',
    slug: /^[a-z]{2,8}\d?-[a-z0-9]{2,8}-[a-z0-9]{2,8}-\d{4}-\d{2}-\d{2}/i },
  { cat: 'sport', motivo: 'premio, titolo o classifica sportiva di stagione', certezza: 'alta',
    slug: /^(ballon-dor|golden-boot|mvp|champions-league-winner|world-cup|super-bowl|the-ashes)|^\d{4}-f1-|-drivers-champion/i,
    titolo: /\b(ballon d'or|drivers' champion|f1 |formula 1|super bowl|world cup)\b/i },
  { cat: 'sport', motivo: 'lessico di scommessa sportiva nel titolo', certezza: 'media', titolo: PAROLE_SPORT },
  // ── FINANZA / AZIENDE ───────────────────────────────────────────────────────────────────────────
  { cat: 'finanza-aziende', motivo: 'ticker azionario con una soglia di prezzo', certezza: 'alta',
    slug: /^(aapl|amzn|msft|googl|goog|meta|nvda|tsla|nflx|abnb|coin|hood|pltr|amd|intc|spy|qqq)\b/i },
  { cat: 'finanza-aziende', motivo: 'prezzo/IPO/utili di un\'azienda', certezza: 'media',
    slug: /^what-price-will-|-ipo-|^ipos-before-|^will-.*-(ipo|earnings)\b|-closing-market-cap$/i,
    titolo: /\b(ipo|market cap|earnings|revenue)\b/i },
  { cat: 'finanza-aziende', motivo: 'materia prima a finestra (petrolio, oro, gas)', certezza: 'alta',
    slug: /^(wti|brent|oil|gold|silver|natgas|copper|wheat)-(up-or-down|above|below|price)/i },
  { cat: 'finanza-aziende', motivo: 'macro-finanza (Fed, inflazione, tassi)', certezza: 'alta',
    slug: /^(fed|fomc|cpi|inflation|interest-rate|recession|gdp|unemployment)\b/i,
    titolo: /\b(fed|fomc|cpi|inflation|interest rate|recession|gdp|jobs report)\b/i },
  // ── POLITICA ────────────────────────────────────────────────────────────────────────────────────
  // Due sottocategorie DISTINTE e non un'unica «politica», perche' hanno orizzonti diversissimi: una
  // nomina locale scade in giorni, un'elezione nazionale in mesi.
  // LOCALE ≠ NAZIONALE, e non è una distinzione accademica: un collegio scade in giorni (Matt Little
  // MN-02 e Schwartzel FL-19, i due mercati che questo bot ha davvero gestito), una corsa nazionale in
  // mesi. Metterle insieme cancellerebbe proprio la differenza di orizzonte che conta per un maker.
  { cat: 'politica-nomine-locali', motivo: 'corsa di collegio: sigla stato-numero', certezza: 'alta',
    slug: /^[a-z]{2}-\d{1,2}-(house|senate|district)|^[a-z]{2}-\d{1,2}-(election|race|nominee)/i,
    titolo: /\b[A-Z]{2}-\d{1,2}\b/ },
  { cat: 'politica-nomine-locali', motivo: 'nomination/primaria di collegio o carica locale', certezza: 'alta',
    titolo: /\b(nominee|nomination|primary)\b/i,
    conferma: /\b([a-z]{2}-\d{1,2}|senate|house|governor|mayor|district|seat)\b/i },
  { cat: 'politica-nomine-locali', motivo: 'carica di stato o città (governatore, sindaco)', certezza: 'alta',
    slug: /-(governor|mayor|attorney-general|secretary-of-state)-(winner|race|election)|^[a-z-]+-governor-winner/i,
    titolo: /\b(governor|mayor) (winner|race|election)\b/i },
  { cat: 'politica-elezioni', motivo: 'elezione nazionale o controllo di una camera', certezza: 'alta',
    slug: /^(presidential-election|next-president|election|who-will-win-the|balance-of-power|which-party-will-win|midterms)/i,
    titolo: /\b(election|elected|win the presidency|next president|prime minister|chancellor|balance of power|win the (house|senate)|midterms)\b/i },
  { cat: 'politica-elezioni', motivo: 'permanenza in carica di un leader / caduta di un regime', certezza: 'media',
    slug: /-(out|out-as|out-before|resign|regime-fall|step-down)-|^will-.*-(resign|be-removed|leave-office)|-regime-fall-/i,
    titolo: /\b(out (as|before|by)|resign from|step down|regime (to )?fall|be removed from office|impeach)\b/i },
  { cat: 'politica-elezioni', motivo: 'nomina/carica senza collegio (categoria generale)', certezza: 'media',
    titolo: /\b(nominee|nomination|cabinet|appointed|confirmed by the senate)\b/i },
  // `conferma` obbligatoria: senza, «will-the-us-confirm-that-aliens-exist» finiva in geopolitica solo
  // perché comincia con «will the US». Un prefisso non è un argomento.
  { cat: 'politica-elezioni', motivo: 'geopolitica: trattati, adesioni, conflitti fra stati', certezza: 'media',
    slug: /^(which-country|will-a-new-country)|-abraham-accords-|^will-the-(us|eu|un|nato)-/i,
    titolo: /\b(abraham accords|join nato|annex|sanctions on|treaty|summit between)\b/i,
    conferma: /\b(country|accords|nato|treaty|sanctions|annex|alliance|join|member)\b/i },
  // ── CRONACA / EVENTI ────────────────────────────────────────────────────────────────────────────
  // La categoria delle cose che «succedono»: dichiarazioni, incontri, lanci, rilasci di prodotto,
  // premi. E' la piu' eterogenea, quindi e' anche l'ultima prima di `altro`.
  { cat: 'cronaca-eventi', motivo: 'dichiarazione o apparizione di una persona pubblica', certezza: 'alta',
    slug: /^what-will-.*-say|^will-.*-(say|mention|tweet|post)\b/i,
    titolo: /\bwill .* (say|mention|tweet|post)\b/i },
  { cat: 'cronaca-eventi', motivo: 'conteggio di post/tweet in una finestra', certezza: 'alta',
    slug: /-of-tweets-|^elon-musk-|-tweets-/i },
  { cat: 'cronaca-eventi', motivo: 'rilascio di prodotto, lancio, modello AI', certezza: 'media',
    slug: /-(launch|release|debut|announce)|^next-(google|openai|anthropic|meta)-/i,
    titolo: /\b(launch|released|release|debut|unveil|announce)\b/i },
  { cat: 'cronaca-eventi', motivo: 'incontro, accordo, dimissioni, guerra, ostaggi', certezza: 'media',
    titolo: /\b(meet with|meeting|ceasefire|deal|agreement|resign|out as|out by|invade|strike|hostage|pardon|indicted|arrested)\b/i },
  { cat: 'cronaca-eventi', motivo: 'spettacolo, cinema, celebrità, guasti di servizi', certezza: 'media',
    slug: /-(wedding|outage|delayed|box-office)|^which-movie|^who-will-attend|^will-.*-be-delayed|^top-spotify|-artist-\d{4}$/i,
    titolo: /\b(movie|box office|opening week|wedding|outage|delayed|album|oscar|grammy|emmy|spotify)\b/i },
  // I «quanti X in una settimana»: terremoti, transiti, lanci. Sono conteggi di eventi naturali o
  // logistici — non meteo (non è previsione atmosferica) e non finanza. Stanno in cronaca perché è
  // esattamente ciò che sono: il conteggio di cose che accadono.
  { cat: 'cronaca-eventi', motivo: 'conteggio di eventi in una finestra (terremoti, transiti, lanci)', certezza: 'alta',
    slug: /^how-many-|^will-there-be-(exactly-)?\d+/i,
    titolo: /\bhow many\b|\bwill there be (exactly )?\d+/i },
  // I «will X be in the headlines this week» e i mercati di cronaca geopolitica sono la fetta che il
  // programma premi di Polymarket alimenta di piu' dopo il meteo: 22 dei 216 mercati premiati trovati
  // nelle 48 ore dell'8 agosto 2026 finivano in `altro` solo per questa mancanza.
  { cat: 'cronaca-eventi', motivo: 'parola nei titoli di giornale / conteggio mediatico', certezza: 'alta',
    slug: /-be-in-the-headlines-|^will-.*-say-.*-this-week/i,
    titolo: /\bin the headlines\b/i },
  { cat: 'cronaca-eventi', motivo: 'atto o dichiarazione di una figura pubblica', certezza: 'media',
    slug: /^will-(donald-trump|joe-biden|elon-musk|the-white-house|the-senate|the-house|congress)-/i,
    titolo: /\b(publicly insult|call a full lid|go into recess|sign an executive order|hold a press)\b/i },
  { cat: 'cronaca-eventi', motivo: 'conflitto, attacco, navigazione: cronaca internazionale', certezza: 'media',
    slug: /^(will-)?(houthis|iran|israel|russia|ukraine|china)-|-target-shipping|-strike-on-/i,
    titolo: /\b(successfully target|shipping|missile|drone strike|airstrike|blockade)\b/i },
  { cat: 'cronaca-eventi', motivo: 'scienza, spazio, rivelazioni, AI di frontiera', certezza: 'media',
    slug: /^will-the-(us|government)-confirm|aliens-exist|-rocket-launch-|^next-.*-model-|-arena-debut/i,
    titolo: /\b(aliens|rocket|spacex|nasa|arena leaderboard|gemini|gpt-\d)\b/i },
];

const pulisci = (v) => (typeof v === 'string' ? v.trim() : '');

/**
 * LA CLASSIFICAZIONE. Pura.
 *
 * @param {object} m  { slug, eventSlug, titolo/title/question, tags? }
 * @returns {{categoria:string, motivo:string, certezza:'alta'|'media'|'nessuna', chiave:string}}
 */
function categoriaDi(m = {}) {
  const slug = pulisci(m.slug) || pulisci(m.eventSlug);
  const eventSlug = pulisci(m.eventSlug) || slug;
  const titolo = pulisci(m.titolo) || pulisci(m.title) || pulisci(m.question) || '';
  const testoSlug = `${slug} ${eventSlug}`.toLowerCase();

  // I tag di Gamma, quando ci sono, sono la fonte piu' diretta — ma NON sono sempre presenti e non
  // sono normalizzati, quindi valgono come primo indizio e non come verdetto unico.
  const tags = Array.isArray(m.tags) ? m.tags.map((t) => String(t && (t.slug || t.label || t)).toLowerCase()) : [];
  if (tags.length) {
    if (tags.some((t) => /^(crypto|bitcoin|ethereum)$/.test(t))) return { categoria: 'crypto', motivo: 'tag Gamma', certezza: 'alta', chiave: eventSlug };
    if (tags.some((t) => /^(sports?|soccer|football|basketball|baseball|tennis|esports?|mma|hockey)$/.test(t))) return { categoria: 'sport', motivo: 'tag Gamma', certezza: 'alta', chiave: eventSlug };
    if (tags.some((t) => /^(weather|climate)$/.test(t))) return { categoria: 'meteo', motivo: 'tag Gamma', certezza: 'alta', chiave: eventSlug };
  }

  for (const r of REGOLE) {
    let colpito = false;
    if (r.prefissoSport) {
      // Il prefisso e' il primo segmento dello slug prima del trattino. `chi-bgu-xin-2026-08-08` → `chi`.
      const primo = testoSlug.split(/[-\s]/)[0];
      colpito = SET_SPORT.has(primo);
    } else {
      const suSlug = r.slug ? r.slug.test(slug) || r.slug.test(eventSlug) : false;
      const suTitolo = r.titolo ? r.titolo.test(titolo) : false;
      colpito = suSlug || suTitolo;
      // `conferma` esiste per le regole costruite su parole comuni: «nominee» da solo prenderebbe anche
      // un premio cinematografico, e senza un secondo segnale la regola non decide.
      if (colpito && r.conferma) colpito = r.conferma.test(titolo) || r.conferma.test(testoSlug);
    }
    if (colpito) return { categoria: r.cat, motivo: r.motivo, certezza: r.certezza, chiave: eventSlug };
  }
  return { categoria: 'altro', motivo: 'nessuna regola ha risposto', certezza: 'nessuna', chiave: eventSlug };
}

/**
 * LA FAMIGLIA RICORRENTE. Due mercati appartengono alla stessa famiglia se sono la stessa cosa che si
 * ripete: la partita di domani della stessa lega, la finestra di cinque minuti successiva, la
 * temperatura di domani nella stessa citta'.
 *
 * Serve a rispondere a una domanda operativa precisa: se i 21 tornano su famiglie note, il bot puo'
 * tenersi una watchlist invece di riscoprire l'universo da zero a ogni ciclo.
 *
 * Si ottiene TOGLIENDO dallo slug le parti che cambiano a ogni ripetizione — la data, il timestamp, i
 * codici delle due squadre — e tenendo quelle che identificano la serie.
 */
function famigliaDi(m = {}) {
  const slug = (pulisci(m.slug) || pulisci(m.eventSlug)).toLowerCase();
  const ev = (pulisci(m.eventSlug) || slug).toLowerCase();
  if (!ev) return { famiglia: null, tipo: 'ignota' };

  // 1 · crypto a finestra: `btc-updown-5m-1786214100` → `btc-updown-5m`
  let mm = ev.match(/^([a-z]+-updown-\d+m)-\d+$/);
  if (mm) return { famiglia: mm[1], tipo: 'finestra-ricorrente' };

  // 2 · sport: `chi-bgu-xin-2026-08-08-more-markets` → `chi` (la LEGA è la famiglia; le due squadre
  //    cambiano a ogni giornata, quindi tenerle spezzerebbe la ricorrenza che si sta cercando)
  const primo = ev.split('-')[0];
  if (SET_SPORT.has(primo)) return { famiglia: primo, tipo: 'lega-ricorrente' };

  // 3 · meteo: `highest-temperature-in-singapore-on-august-8-2026-32c` → `highest-temperature-in-singapore`
  mm = ev.match(/^((?:highest|lowest)-temperature-in-[a-z-]+?)-on-/);
  if (mm) return { famiglia: mm[1], tipo: 'serie-giornaliera' };

  // 4 · finanza: `amzn-week-august-7-2026` → `amzn-week` · `what-price-will-meta-hit-in-august-2026` → `what-price-will-meta-hit`
  mm = ev.match(/^([a-z]{1,6})-(week|above|below|close)\b/);
  if (mm) return { famiglia: `${mm[1]}-${mm[2]}`, tipo: 'serie-settimanale' };
  mm = ev.match(/^(what-price-will-[a-z]+-hit)-in-/);
  if (mm) return { famiglia: mm[1], tipo: 'serie-mensile' };

  // 5 · serie con data in coda: si toglie la data e quel che resta è la famiglia.
  mm = ev.match(/^(.*?)-(?:on-)?(?:january|february|march|april|may|june|july|august|september|october|november|december)-\d{1,2}(?:-\d{4})?/);
  if (mm && mm[1].length > 3) return { famiglia: mm[1], tipo: 'serie-datata' };
  mm = ev.match(/^(.*?)-\d{4}-\d{2}-\d{2}/);
  if (mm && mm[1].length > 3) return { famiglia: mm[1], tipo: 'serie-datata' };

  return { famiglia: ev, tipo: 'unica' };
}

/** La distribuzione per categoria di una lista, con i conteggi e le percentuali. */
function distribuzione(elementi, estrai = (x) => x) {
  const per = new Map(CATEGORIE.map((c) => [c, { categoria: c, n: 0, esempi: [], nonClassificati: [] }]));
  let tot = 0;
  for (const el of elementi || []) {
    const m = estrai(el);
    const c = categoriaDi(m);
    const riga = per.get(c.categoria);
    riga.n += 1; tot += 1;
    if (riga.esempi.length < 5) riga.esempi.push({ slug: m.eventSlug || m.slug, titolo: m.titolo || m.title || m.question, motivo: c.motivo });
    if (c.categoria === 'altro') riga.nonClassificati.push(m.eventSlug || m.slug || '(senza slug)');
  }
  const righe = [...per.values()].map((r) => ({ ...r, pct: tot ? +(r.n / tot * 100).toFixed(1) : 0 }))
    .sort((a, b) => b.n - a.n);
  return { totale: tot, righe };
}

module.exports = { categoriaDi, famigliaDi, distribuzione, CATEGORIE, PREFISSI_SPORT };

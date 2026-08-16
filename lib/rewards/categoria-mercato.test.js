'use strict';
// lib/rewards/categoria-mercato.test.js — IL CLASSIFICATORE NON PEGGIORA SULLE CATEGORIE CHE FUNZIONANO.
//
// Due livelli di verifica, e il secondo è quello che conta davvero:
//   1 · casi nominali, presi dagli slug VERI osservati nel campione dei 21 e nel board;
//   2 · la copertura misurata sui due corpus reali — se una modifica futura fa risalire `altro` sopra
//       la soglia, il test lo dice. Un classificatore si giudica da cosa NON sa classificare.
//
// Sola lettura: nessun venue, nessuna rete, nessuno stato. Run: node lib/rewards/categoria-mercato.test.js

const fs = require('fs');
const path = require('path');
const { categoriaDi, famigliaDi, distribuzione, CATEGORIE } = require('./categoria-mercato');

let pass = 0; let fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const cat = (slug, titolo = '') => categoriaDi({ slug, eventSlug: slug, titolo }).categoria;

console.log('\n1 · casi nominali, dagli slug veri');
{
  // ── SPORT. Il grosso del campione: campionati di calcio di mezzo mondo, esports, tennis, baseball.
  for (const [s, t] of [
    ['efl-bro-rea-2026-08-08-more-markets', 'Bromley FC vs. Reading FC: O/U 3.5'],
    ['chi-yun-ron-2026-08-08', 'Will Chengdu Rongcheng FC win on 2026-08-08?'],
    ['lol-t1-hle1-2026-08-08', 'Games Total: O/U 2.5'],
    ['atp-ruud-fonseca-2026-08-07', 'National Bank Open: Casper Ruud vs Joao Fonseca'],
    ['mlb-laa-mia-2026-08-07', 'Los Angeles Angels vs. Miami Marlins'],
    ['ballon-dor-winner-2026', 'Will Harry Kane win the 2026 Ballon d\'Or?'],
    ['2026-f1-drivers-champion', 'Will Kimi Antonelli be the 2026 F1 Drivers\' Champion?'],
  ]) ok(`sport: ${s.slice(0, 34)}`, cat(s, t) === 'sport', cat(s, t));
  // La regola STRUTTURALE: leghe che nessuna lista prevedeva.
  for (const s of ['chi2-sud-cha-2026-08-08', 'bol1-ant-nap-2026-08-08', 'fr2-mon-dij-2026-08-08',
    'uru1-tor-pen-2026-08-08', 'ecu1-sda-leo-2026-08-08', 'swe2-ost-lkb-2026-08-08']) {
    ok(`sport per FORMA (lega ignota): ${s}`, cat(s) === 'sport', cat(s));
  }

  ok('crypto: finestra a 5 minuti', cat('btc-updown-5m-1786214100', 'Bitcoin Up or Down - August 8, 2:35PM-2:40PM ET') === 'crypto');
  ok('crypto: soglia giornaliera', cat('ethereum-above-on-august-7-2026', 'Will the price of Ethereum be above $1,800 on August 7?') === 'crypto');
  ok('meteo: temperatura di una città', cat('highest-temperature-in-singapore-on-august-8-2026-32c', 'Will the highest temperature in Singapore be 32°C on August 8?') === 'meteo');
  ok('finanza: ticker con soglia', cat('amzn-week-august-7-2026', 'Will Amazon (AMZN) close at $265-$270…') === 'finanza-aziende');
  ok('finanza: materia prima intraday', cat('wti-up-or-down-on-august-7-2026', 'WTI Up or Down on August 7?') === 'finanza-aziende');
  ok('finanza: IPO', cat('openai-ipo-closing-market-cap', 'Will OpenAI not IPO by December 31, 2026?') === 'finanza-aziende');
  ok('cronaca: dichiarazione pubblica', cat('what-will-trump-say-during-friday-roundtable-2026', 'Will Trump say "Gold" or "Silver" during Friday roundtable?') === 'cronaca-eventi');
  ok('cronaca: parola nei titoli', cat('will-star-be-in-the-headlines-this-week', 'Will "star" be in the headlines this week?') === 'cronaca-eventi');
  ok('cronaca: conteggio di eventi', cat('how-many-5pt5-or-above-earthquakes-august-3-august-9', 'How many 5.5+ earthquakes…') === 'cronaca-eventi');
  ok('politica LOCALE: collegio', cat('tx-15-house-election-winner', 'TX-15 House Election Winner') === 'politica-nomine-locali');
  ok('politica LOCALE: governatore', cat('massachusetts-governor-winner-2026', 'Massachusetts Governor winner 2026') === 'politica-nomine-locali');
  ok('politica NAZIONALE: presidenziali', cat('presidential-election-winner-2028', 'Presidential Election Winner 2028') === 'politica-elezioni');
  ok('politica NAZIONALE: controllo della camera', cat('which-party-will-win-the-house-in-2026', 'Which party will win the House in 2026?') === 'politica-elezioni');

  // I DUE CASI CHE UNA VERSIONE PRECEDENTE SBAGLIAVA, tenuti come regressione esplicita:
  ok('«presidential-election-winner-2028» NON è sport', cat('presidential-election-winner-2028', 'Presidential Election Winner 2028') !== 'sport',
    'la regola sui premi sportivi prendeva qualunque «-winner-AAAA»');
  ok('«will-the-us-confirm-that-aliens-exist» NON è geopolitica', cat('will-the-us-confirm-that-aliens-exist-before-2027', 'Will the US confirm that aliens exist before 2027?') !== 'politica-elezioni',
    'un prefisso «will the US» non è un argomento');
}

console.log('\n2 · famiglie ricorrenti');
{
  ok('la finestra crypto è una famiglia sola', famigliaDi({ eventSlug: 'btc-updown-5m-1786214100' }).famiglia === 'btc-updown-5m');
  ok('  e due finestre diverse ci ricadono insieme',
    famigliaDi({ eventSlug: 'btc-updown-5m-1786191000' }).famiglia === famigliaDi({ eventSlug: 'btc-updown-5m-1786214100' }).famiglia);
  ok('la lega è la famiglia di un incontro', famigliaDi({ eventSlug: 'efl-bro-rea-2026-08-08-more-markets' }).famiglia === 'efl');
  ok('  e due giornate diverse ci ricadono insieme',
    famigliaDi({ eventSlug: 'efl-swa-bir-2026-08-08' }).famiglia === famigliaDi({ eventSlug: 'efl-bro-rea-2026-08-09' }).famiglia);
  ok('il meteo è per città, non per giorno',
    famigliaDi({ eventSlug: 'highest-temperature-in-singapore-on-august-8-2026' }).famiglia === 'highest-temperature-in-singapore');
  ok('  e due giorni diversi ci ricadono insieme',
    famigliaDi({ eventSlug: 'highest-temperature-in-singapore-on-august-9-2026' }).famiglia === 'highest-temperature-in-singapore');
}

console.log('\n3 · copertura misurata sui due corpus veri');
{
  const f21 = path.join(__dirname, '..', '..', 'data', 'maker-21-eventi.jsonl');
  if (fs.existsSync(f21)) {
    const ing = fs.readFileSync(f21, 'utf8').trim().split('\n')
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter((r) => r && r.tipo === 'ingresso');
    const d = distribuzione(ing);
    const altro = d.righe.find((r) => r.categoria === 'altro');
    ok(`ingressi dei 21: ${d.totale} classificati, ${altro.n} in «altro»`, altro.n / Math.max(1, d.totale) <= 0.02,
      `${(altro.n / Math.max(1, d.totale) * 100).toFixed(1)}% non classificato (limite 2%)`);
    const sport = d.righe.find((r) => r.categoria === 'sport');
    ok('  e lo sport resta la categoria dominante', sport.pct > 60, `${sport.pct}%`);
  } else ok('campione dei 21 assente: copertura non verificabile', true, 'saltato');

  const fb = path.join(__dirname, '..', '..', 'data', 'liquidity-rewards.json');
  if (fs.existsSync(fb)) {
    const rows = JSON.parse(fs.readFileSync(fb, 'utf8')).markets || [];
    const d = distribuzione(rows, (r) => ({ slug: r.slug || r.marketSlug, eventSlug: r.slug || r.marketSlug, titolo: r.question }));
    const altro = d.righe.find((r) => r.categoria === 'altro');
    ok(`board: ${d.totale} classificati, ${altro.n} in «altro»`, altro.n / Math.max(1, d.totale) <= 0.05,
      `${(altro.n / Math.max(1, d.totale) * 100).toFixed(1)}% non classificato (limite 5%)`);

    // LA VALIDAZIONE INDIPENDENTE: il board porta il `category` di Gamma, che questo modulo non legge.
    // È il solo modo di misurare l'accuratezza invece di assumerla.
    const mappa = {
      Weather: ['meteo'], Sports: ['sport'], Esports: ['sport'],
      Elections: ['politica-elezioni', 'politica-nomine-locali'], Politics: ['politica-elezioni', 'politica-nomine-locali'],
      Geopolitics: ['politica-elezioni', 'cronaca-eventi'], Economy: ['finanza-aziende'],
      Tech: ['cronaca-eventi', 'finanza-aziende'], 'Pop Culture': ['cronaca-eventi'], Crypto: ['crypto'],
    };
    let acc = 0; let tot = 0;
    for (const r of rows) {
      const att = mappa[r.category]; if (!att) continue;
      tot += 1;
      const mio = categoriaDi({ slug: r.slug || r.marketSlug, eventSlug: r.slug || r.marketSlug, titolo: r.question }).categoria;
      if (att.includes(mio)) acc += 1;
    }
    ok(`accordo col campo «category» di Gamma: ${acc}/${tot}`, tot > 0 && acc / tot >= 0.9, `${(acc / tot * 100).toFixed(1)}% (soglia 90%)`);
  } else ok('board assente: copertura non verificabile', true, 'saltato');
}

console.log('\n4 · il modulo è uno strumento di misura, non una regola del motore');
{
  const radice = path.join(__dirname, '..', '..');
  const cerca = (dir, out = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // ⚠ `_archivio` È ESCLUSO (15 agosto 2026): contiene i file che la riduzione ha messo da parte —
      // codice non servito da nessun processo, script di ricerca che cablano di proposito il valore che
      // stavano studiando. Scandirlo fa dire a un test strutturale che una costante è ricopiata «nel repo»
      // quando è ricopiata in un museo. Non è un allentamento: il perimetro difeso è il codice VIVO.
      if (e.name === 'node_modules' || e.name === '.next' || e.name === '.git' || e.name === '_archivio') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) cerca(p, out);
      else if (/\.(js|ts|tsx)$/.test(e.name)) out.push(p);
    }
    return out;
  };
  const file = [...cerca(path.join(radice, 'lib')), ...cerca(path.join(radice, 'agents')), ...cerca(path.join(radice, 'app'))];
  const importatori = file.filter((f) => !/categoria-mercato/.test(f) && /categoria-mercato/.test(fs.readFileSync(f, 'utf8')));
  ok('nessun modulo di lib/, agents/ o app/ lo importa', importatori.length === 0,
    importatori.length ? importatori.map((f) => path.relative(radice, f)).join(', ') : 'solo scripts/ricerca-categorie-21.js lo usa');
  const src = fs.readFileSync(path.join(__dirname, 'categoria-mercato.js'), 'utf8');
  ok('  e non legge file né rete', !/require\(['"](fs|https?|child_process)['"]\)/.test(src));
  ok('  le categorie dichiarate sono le otto attese', CATEGORIE.length === 8 && CATEGORIE.includes('altro'));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passati, ${fail} falliti`);
if (fail) process.exit(1);

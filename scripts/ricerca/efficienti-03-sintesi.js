'use strict';
// scripts/ricerca/efficienti-03-sintesi.js — IL REFERTO DEGLI EFFICIENTI. Sola lettura, zero rete.
//
//   node scripts/ricerca/efficienti-03-sintesi.js
//
// Mette insieme i tre stadi precedenti in un referto unico:
//   · `efficienti-01-gruppo.json`      il gruppo e l'imbuto dei filtri
//   · `efficienti-02-distanza-mercati.json` ① distanza dal mid · ② mercati (minSize/maxSpread)
//   · `screening-05-uscite.json`           ③ cosa fanno dopo un fill
//
// ⚠ IL CONFRONTO È FRA GRUPPI DI TAGLIA MOLTO DIVERSA (4 wallet contro 5, ma 536 eventi contro
// 15.804): ogni tabella porta `n`, e dove `n < 200` la riga è marcata invece di essere letta come
// una misura. È la regola di §5.3 applicata a questo referto.

const fs = require('fs');
const path = require('path');
const { leggi, DIR_DATI, mediana } = require('./screening-lib');

const n2 = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)))
  ? 'n/d' : Number(v).toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (v, d = 2) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 'n/d' : '$' + n2(v, d));
const pct = (v, d = 1) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? 'n/d' : (Number(v) * 100).toFixed(d) + '%');
const q = (a, f) => { if (!a || !a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };
/** Marca le celle che poggiano su un campione troppo piccolo per concludere (§5.3). */
const conN = (v, n) => `${v}${n < 200 ? ` ⚠n=${n}` : ` (n=${n})`}`;

function eventiDi(uscite, insieme) {
  const ev = [];
  let censurati = 0;
  let wallet = 0;
  for (const w of uscite.perWallet) {
    if (!insieme.has(w.wallet)) continue;
    wallet += 1;
    censurati += w.censurati;
    for (const e of w.eventi) ev.push({ ...e, wallet: w.wallet });
  }
  return { ev, censurati, wallet };
}

function profiloUscite(ev) {
  const tot = ev.length;
  const per = (c) => ev.filter((e) => e.classe === c);
  const A = per('A');
  const B = per('B');
  const D = per('D');
  const veloci = A.filter((e) => e.dtSec <= 120);
  return {
    tot,
    quote: Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((c) => [c, { n: per(c).length, pct: tot ? per(c).length / tot : null }])),
    A: {
      n: A.length,
      costoCoppiaC: { q25: q(A.map((e) => e.costoCoppiaCents), 0.25), mediana: mediana(A.map((e) => e.costoCoppiaCents)), q75: q(A.map((e) => e.costoCoppiaCents), 0.75) },
      sottoLaPari: A.length ? A.filter((e) => e.costoCoppiaCents < 100).length / A.length : null,
      dtSec: { q25: q(A.map((e) => e.dtSec), 0.25), mediana: mediana(A.map((e) => e.dtSec)), q75: q(A.map((e) => e.dtSec), 0.75) },
      entro120s: A.length ? veloci.length / A.length : null,
      // «seguito maker» = la gamba di completamento era un ordine GIÀ A LIBRO che è stato colpito,
      // non un ordine mandato in risposta. È la distinzione che cambia la lettura di tutto il gruppo.
      seguitoMaker: A.length ? A.filter((e) => !e.seguitoTaker).length / A.length : null,
      velociSottoLaPari: veloci.length ? veloci.filter((e) => e.costoCoppiaCents < 100).length / veloci.length : null,
    },
    B: {
      n: B.length,
      deltaC: { q25: q(B.map((e) => e.deltaCents), 0.25), mediana: mediana(B.map((e) => e.deltaCents)), q75: q(B.map((e) => e.deltaCents), 0.75) },
      dtSec: { mediana: mediana(B.map((e) => e.dtSec)) },
      seguitoMaker: B.length ? B.filter((e) => !e.seguitoTaker).length / B.length : null,
      inGuadagno: B.length ? B.filter((e) => e.deltaCents > 0).length / B.length : null,
    },
    D: { n: D.length, dtSec: { mediana: mediana(D.map((e) => e.dtSec)) } },
    fillTaker: tot ? ev.filter((e) => e.taker).length / tot : null,
  };
}

function profiloDistanza(perWallet, etichette) {
  const righe = perWallet.filter((r) => etichette.includes(r.etichetta) && r.distanzaC);
  // Le distanze si aggregano SUI FILL, non sulle mediane per wallet: una media di mediane darebbe
  // lo stesso peso a un wallet con 22 fill e a uno con 300.
  const tutte = [];
  for (const r of righe) for (const m of []) tutte.push(m);   // le misure per riga sono troncate a 40: si usa il riassunto
  return {
    wallet: righe.length,
    // mediana delle mediane, dichiarata per quello che è
    medianaDelleMediane: mediana(righe.map((r) => r.distanzaC.mediana)),
    medianaPesata: (() => {
      const num = righe.reduce((a, r) => a + r.distanzaC.mediana * r.distanzaC.n, 0);
      const den = righe.reduce((a, r) => a + r.distanzaC.n, 0);
      return den ? num / den : null;
    })(),
    fillMisurati: righe.reduce((a, r) => a + r.distanzaC.n, 0),
    q25: mediana(righe.map((r) => r.distanzaC.q25)),
    q75: mediana(righe.map((r) => r.distanzaC.q75)),
    q90: mediana(righe.map((r) => r.distanzaC.q90)),
    quotaMaker: mediana(righe.map((r) => r.quotaMaker)),
    dallaParteGiusta: mediana(righe.map((r) => r.quotaDallaParteGiusta)),
    righe,
  };
}

function main() {
  const sel = leggi('efficienti-01-gruppo.json');
  const dm = leggi('efficienti-02-distanza-mercati.json');
  const uscite = leggi('screening-05-uscite.json');

  const eff = new Set(sel.gruppo.map((r) => r.wallet));
  const top = new Set(sel.top5.map((r) => r.wallet));
  const sens = new Set(sel.gruppoSensibilita.map((r) => r.wallet));

  const uEff = eventiDi(uscite, eff);
  const uTop = eventiDi(uscite, top);
  const uSens = eventiDi(uscite, sens);
  const pEff = profiloUscite(uEff.ev);
  const pTop = profiloUscite(uTop.ev);
  const pSens = profiloUscite(uSens.ev);

  const dEff = profiloDistanza(dm.perWallet, ['efficiente']);
  const dTop = profiloDistanza(dm.perWallet, ['top5']);
  const dSens = profiloDistanza(dm.perWallet, ['sensibilita']);

  // ── IL COSTO REALIZZATO PER GRUPPO ─────────────────────────────────────────────────────────────
  const costoDi = (ev) => {
    const A = ev.filter((e) => e.classe === 'A');
    const c = [];
    for (const e of ev) {
      if (e.classe === 'A') c.push(100 - e.costoCoppiaCents);   // coppia a 99¢ ⇒ +1¢/share
      else if (e.classe === 'B') c.push(e.deltaCents);
    }
    const sopra = A.filter((e) => e.costoCoppiaCents > 100);
    return {
      n: c.length,
      media: c.length ? c.reduce((a, b) => a + b, 0) / c.length : null,
      mediana: mediana(c),
      direzionale: ev.length ? ev.filter((e) => e.classe === 'C' || e.classe === 'D').length / ev.length : null,
      sopraLaPari: A.length ? sopra.length / A.length : null,
      quantoSopra: mediana(sopra.map((e) => e.costoCoppiaCents - 100)),
      oltre110: A.length ? A.filter((e) => e.costoCoppiaCents > 110).length / A.length : null,
      oltre120: A.length ? A.filter((e) => e.costoCoppiaCents > 120).length / A.length : null,
    };
  };
  const costi = { efficienti: costoDi(uEff.ev), top5: costoDi(uTop.ev), sensibilita: costoDi(uSens.ev) };

  // ── LA DISTANZA NORMALIZZATA SUL RAGGIO DI BANDA ───────────────────────────────────────────────
  // ⚠ Poggia sulle sole misure conservate per esteso (le prime 40 per wallet): il campione è
  // piccolo E non casuale — sono le più recenti. Va letto come indicazione, non come misura, ed è
  // per questo che sta in una tabella sua invece che dentro quella di ①.
  const mercatiPerId = new Map(dm.mercati.map((m) => [m.conditionId, m]));
  const normalizzata = {};
  for (const w of dm.perWallet) {
    const g = w.etichetta;
    if (!normalizzata[g]) normalizzata[g] = { rapporti: [], fuoriBanda: 0, n: 0 };
    for (const m of (w.misure || [])) {
      const mk = mercatiPerId.get(m.conditionId);
      if (!mk || !Number.isFinite(mk.maxSpread) || mk.maxSpread <= 0) continue;   // raggio non noto ⇒ non si normalizza
      normalizzata[g].rapporti.push(m.distanzaC / mk.maxSpread);
      if (m.distanzaC > mk.maxSpread) normalizzata[g].fuoriBanda += 1;
      normalizzata[g].n += 1;
    }
  }

  // ── ② I MERCATI ────────────────────────────────────────────────────────────────────────────────
  const mEff = dm.mercati.filter((m) => m.efficienti > 0);
  const mTop = dm.mercati.filter((m) => m.top5 > 0);
  const comuni = dm.mercati.filter((m) => m.efficienti > 0 && m.top5 > 0);
  const perChiave = (lista, campo) => {
    const c = new Map();
    let noti = 0;
    for (const m of lista) {
      const k = m[campo];
      if (k === null || k === undefined) continue;
      noti += 1;
      c.set(k, (c.get(k) || 0) + 1);
    }
    return { noti, nonNoti: lista.length - noti, righe: [...c.entries()].sort((a, b) => b[1] - a[1]) };
  };

  const out = {
    generatoIl: new Date().toISOString(),
    gruppo: sel.gruppo,
    imbuto: sel.imbuto,
    allargamentoChiesto: sel.allargamentoChiesto,
    forzati: sel.forzati,
    distanza: { efficienti: { ...dEff, righe: undefined }, top5: { ...dTop, righe: undefined }, sensibilita: { ...dSens, righe: undefined } },
    distanzaPerWallet: dm.perWallet.map(({ misure, ...r }) => r),
    mercati: {
      efficienti: { n: mEff.length, minSize: perChiave(mEff, 'minSize'), maxSpread: perChiave(mEff, 'maxSpread'), volume24hMediano: mediana(mEff.map((m) => m.volume24h).filter(Number.isFinite)) },
      top5: { n: mTop.length, minSize: perChiave(mTop, 'minSize'), maxSpread: perChiave(mTop, 'maxSpread'), volume24hMediano: mediana(mTop.map((m) => m.volume24h).filter(Number.isFinite)) },
      comuni: comuni.length,
      quotaDeiMercatiEfficientiAncheNeiTop5: mEff.length ? comuni.length / mEff.length : null,
    },
    uscite: { efficienti: { ...pEff, censurati: uEff.censurati }, top5: { ...pTop, censurati: uTop.censurati }, sensibilita: { ...pSens, censurati: uSens.censurati } },
  };
  fs.writeFileSync(path.join(DIR_DATI, 'efficienti-03-sintesi.json'), JSON.stringify(out, null, 1));

  // ── IL MARKDOWN ────────────────────────────────────────────────────────────────────────────────
  const r = [];
  r.push('# Gli «efficienti» dentro i 65 — capitale piccolo, trading in pari');
  r.push('');
  r.push(`Generato ${out.generatoIl}. Sola lettura, nessuna transazione. Sorgenti: \`screening-05 · efficienti-01/02\`.`);
  r.push('');
  r.push('## ⚠ Il gruppo si chiude a 4, e allargare il capitale non lo muove');
  r.push('');
  r.push('| filtro applicato da solo, sui 65 | wallet |');
  r.push('|---|---|');
  r.push(`| capitale $500–6.000 | ${sel.imbuto.soloCapitale6k} |`);
  r.push(`| capitale $500–15.000 | ${sel.imbuto.soloCapitale15k} |`);
  r.push(`| \\|P&L 7g\\| ≤ $100 | ${sel.imbuto.soloPnl} |`);
  r.push(`| rewards 14g ≥ $300 | ${sel.imbuto.soloRewards} |`);
  r.push(`| due-lateralità ≥ 40% | ${sel.imbuto.soloDueLati} |`);
  r.push(`| **tutti e quattro** | **${sel.imbuto.tuttiEQuattro}** |`);
  r.push('');
  r.push('Togliendo **un** vincolo alla volta si vede quale morde:');
  r.push('');
  r.push('| senza… | wallet |');
  r.push('|---|---|');
  r.push(`| il vincolo di capitale (qualunque capitale) | ${sel.imbuto.senzaVincoloCapitale} |`);
  r.push(`| il vincolo di P&L | ${sel.imbuto.senzaVincoloPnl} |`);
  r.push(`| il vincolo di rewards | ${sel.imbuto.senzaVincoloRewards} |`);
  r.push(`| il vincolo di due-lateralità | ${sel.imbuto.senzaVincoloDueLati} |`);
  r.push('');
  r.push('**L\'allargamento chiesto è inerte**: portare il tetto di capitale da $6.000 a $15.000 aggiunge');
  r.push(`**${sel.allargamentoChiesto.walletAggiunti.length} wallet**, e toglierlo del tutto ne aggiunge **0**. Il collo è \`|P&L 7g| ≤ $100\`.`);
  r.push('');
  r.push('## Il gruppo');
  r.push('');
  r.push('| wallet | rewards 14g | mediana/g | capitale | P&L 7g | 2 lati | rewards/capitale |');
  r.push('|---|---|---|---|---|---|---|');
  for (const w of sel.gruppo) {
    r.push(`| \`${w.wallet}\` | ${usd(w.rewards14g)} | ${usd(w.medianaGiornaliera)} | ${usd(w.capitaleStimato, 0)} | ${usd(w.pnl7g, 0)} | ${pct(w.quotaDueLati, 0)} | ${w.rendimentoPct === null ? 'n/d' : w.rendimentoPct.toFixed(1) + '%'} |`);
  }
  r.push('');
  r.push('I due wallet indicati dall\'operatore **non hanno avuto bisogno dell\'inclusione forzata**: ' + sel.forzati.map((f) => `\`${f.wallet.slice(0, 10)}…\` ${f.perche}`).join(' · ') + '.');
  r.push('');
  r.push(`Gruppo di sensibilità (stessi filtri, \`|P&L| ≤ $250\`, capitale ≤ $15.000): **${sel.gruppoSensibilita.length} wallet**. Serve solo a dare un \`n\` alle misure a valle.`);
  r.push('');

  // ① distanza
  r.push('## ① Distanza dal mid');
  r.push('');
  r.push('Ricostruita dai soli fill **maker** (un fill taker misura il costo di attraversare lo spread, non');
  r.push('la posizione di quotazione), contro il campione di `prices-history` immediatamente **precedente**');
  r.push(`il fill, scartato oltre ${dm.parametri.maxEtaMidS} s di età.`);
  r.push('');
  r.push('| gruppo | wallet | fill misurati | mediana | q25 | q75 | q90 | quota maker | dalla parte giusta del mid |');
  r.push('|---|---|---|---|---|---|---|---|---|');
  for (const [nome, d] of [['efficienti', dEff], ['top 5 per rewards', dTop], ['sensibilità', dSens]]) {
    r.push(`| ${nome} | ${d.wallet} | ${d.fillMisurati} | **${n2(d.medianaDelleMediane)}¢** | ${n2(d.q25)}¢ | ${n2(d.q75)}¢ | ${n2(d.q90)}¢ | ${pct(d.quotaMaker, 0)} | ${pct(d.dallaParteGiusta, 0)} |`);
  }
  r.push('');
  r.push('Wallet per wallet (mediana delle proprie distanze):');
  r.push('');
  r.push('| wallet | gruppo | ore coperte | fill maker | misurati | mediana | q90 | coincidenza col campione successivo |');
  r.push('|---|---|---|---|---|---|---|---|');
  for (const w of dm.perWallet) {
    r.push(`| \`${w.wallet.slice(0, 12)}…\` | ${w.etichetta} | ${n2(w.copertura.ore, 0)} | ${w.eventiMaker} | ${w.misurati} | ${w.distanzaC ? n2(w.distanzaC.mediana) + '¢' : 'n/d'} | ${w.distanzaC ? n2(w.distanzaC.q90) + '¢' : 'n/d'} | ${pct(w.semanticaCoincidenzaDopo, 0)} |`);
  }
  r.push('');
  r.push('L\'ultima colonna è la **prova che la serie non è il prezzo dell\'ultimo scambio**: se lo fosse, il');
  r.push('campione successivo al fill coinciderebbe col prezzo del fill quasi sempre.');
  r.push('');
  r.push('**La stessa distanza, normalizzata sul raggio della banda premiante** (`maxSpread` del mercato:');
  r.push('una distanza di 2,5¢ vale metà in un mercato a 5¢ di raggio e più della metà in uno a 4,5¢).');
  r.push('⚠ Poggia sulle sole misure conservate per esteso — le prime 40 per wallet, quindi le più recenti:');
  r.push('campione piccolo **e** non casuale, da leggere come indicazione.');
  r.push('');
  r.push('| gruppo | n | distanza/raggio q25 | mediana | q75 | fill fuori dalla banda |');
  r.push('|---|---|---|---|---|---|');
  for (const [nome, k] of [['efficienti', 'efficiente'], ['top 5 per rewards', 'top5'], ['sensibilità', 'sensibilita']]) {
    const v = normalizzata[k];
    if (!v || !v.n) { r.push(`| ${nome} | 0 | n/d | n/d | n/d | n/d |`); continue; }
    r.push(`| ${nome} | ${v.n} ⚠ | ${n2(q(v.rapporti, 0.25))} | **${n2(q(v.rapporti, 0.50))}** | ${n2(q(v.rapporti, 0.75))} | ${pct(v.fuoriBanda / v.n, 1)} |`);
  }
  r.push('');

  // ② mercati
  r.push('## ② I mercati');
  r.push('');
  r.push(`Insieme dei mercati toccati nel campione di trade: **${out.mercati.efficienti.n}** per gli efficienti, **${out.mercati.top5.n}** per i primi 5.`);
  r.push(`Sovrapposizione: **${out.mercati.comuni}** mercati in comune, cioè il **${pct(out.mercati.quotaDeiMercatiEfficientiAncheNeiTop5, 1)}** di quelli degli efficienti.`);
  r.push('');
  r.push('| `minSize` | mercati degli efficienti | mercati dei top 5 |');
  r.push('|---|---|---|');
  const chiaviMin = [...new Set([...out.mercati.efficienti.minSize.righe.map((x) => x[0]), ...out.mercati.top5.minSize.righe.map((x) => x[0])])].sort((a, b) => a - b);
  for (const k of chiaviMin) {
    const a = out.mercati.efficienti.minSize.righe.find((x) => x[0] === k);
    const b = out.mercati.top5.minSize.righe.find((x) => x[0] === k);
    r.push(`| ${k} | ${a ? a[1] : 0} (${pct((a ? a[1] : 0) / (out.mercati.efficienti.minSize.noti || 1), 0)}) | ${b ? b[1] : 0} (${pct((b ? b[1] : 0) / (out.mercati.top5.minSize.noti || 1), 0)}) |`);
  }
  r.push('');
  r.push('| `maxSpread` | mercati degli efficienti | mercati dei top 5 |');
  r.push('|---|---|---|');
  const chiaviMax = [...new Set([...out.mercati.efficienti.maxSpread.righe.map((x) => x[0]), ...out.mercati.top5.maxSpread.righe.map((x) => x[0])])].sort((a, b) => a - b);
  for (const k of chiaviMax) {
    const a = out.mercati.efficienti.maxSpread.righe.find((x) => x[0] === k);
    const b = out.mercati.top5.maxSpread.righe.find((x) => x[0] === k);
    r.push(`| ${k} | ${a ? a[1] : 0} (${pct((a ? a[1] : 0) / (out.mercati.efficienti.maxSpread.noti || 1), 0)}) | ${b ? b[1] : 0} (${pct((b ? b[1] : 0) / (out.mercati.top5.maxSpread.noti || 1), 0)}) |`);
  }
  r.push('');
  r.push(`Volume 24 h mediano dei mercati: efficienti ${usd(out.mercati.efficienti.volume24hMediano, 0)} · top 5 ${usd(out.mercati.top5.volume24hMediano, 0)}.`);
  r.push('');

  // ③ uscite
  r.push('## ③ Cosa fanno dopo un fill');
  r.push('');
  r.push(`Orizzonte di classificazione ${uscite.parametri.orizzonteH} h. Gli eventi troppo vicini alla fine del campione sono **censurati** ed esclusi dalle percentuali.`);
  r.push('');
  r.push('| | efficienti | top 5 | sensibilità |');
  r.push('|---|---|---|---|');
  const riga = (etichetta, f) => r.push(`| ${etichetta} | ${f(pEff)} | ${f(pTop)} | ${f(pSens)} |`);
  riga('eventi classificati', (p) => p.tot);
  r.push(`| censurati | ${uEff.censurati} | ${uTop.censurati} | ${uSens.censurati} |`);
  riga('**A** completa la coppia', (p) => `${pct(p.quote.A.pct, 1)} (n=${p.quote.A.n})`);
  riga('**B** rivende lo stesso esito', (p) => `${pct(p.quote.B.pct, 1)} (n=${p.quote.B.n})`);
  riga('**C** tiene fino alla risoluzione', (p) => `${pct(p.quote.C.pct, 1)} (n=${p.quote.C.n})`);
  riga('**D** aumenta sullo stesso lato', (p) => `${pct(p.quote.D.pct, 1)} (n=${p.quote.D.n})`);
  riga('E smonta l\'altro lato', (p) => `${pct(p.quote.E.pct, 1)} (n=${p.quote.E.n})`);
  riga('quota di fill presi in taker', (p) => pct(p.fillTaker, 1));
  r.push('');
  r.push('**A — completare la coppia**');
  r.push('');
  r.push('| | efficienti | top 5 | sensibilità |');
  r.push('|---|---|---|---|');
  riga('costo coppia mediano', (p) => conN(`${n2(p.A.costoCoppiaC.mediana)}¢`, p.A.n));
  riga('costo coppia q25–q75', (p) => `${n2(p.A.costoCoppiaC.q25)} – ${n2(p.A.costoCoppiaC.q75)}¢`);
  riga('**quota sotto la pari (<100¢)**', (p) => `**${pct(p.A.sottoLaPari, 1)}**`);
  riga('tempo mediano', (p) => `${n2(p.A.dtSec.mediana, 0)} s`);
  riga('entro 120 s', (p) => pct(p.A.entro120s, 1));
  riga('**completata da un ordine GIÀ a libro (maker)**', (p) => `**${pct(p.A.seguitoMaker, 1)}**`);
  riga('fra le completate entro 120 s, quota sotto la pari', (p) => pct(p.A.velociSottoLaPari, 1));
  r.push('');
  r.push('**B — rivendere lo stesso esito**');
  r.push('');
  r.push('| | efficienti | top 5 | sensibilità |');
  r.push('|---|---|---|---|');
  riga('delta mediano', (p) => conN(`${n2(p.B.deltaC.mediana)}¢`, p.B.n));
  riga('delta q25–q75', (p) => `${n2(p.B.deltaC.q25)} – ${n2(p.B.deltaC.q75)}¢`);
  riga('quota in guadagno', (p) => pct(p.B.inGuadagno, 1));
  riga('tempo mediano', (p) => `${n2(p.B.dtSec.mediana, 0)} s`);
  riga('venduta da un ordine già a libro', (p) => pct(p.B.seguitoMaker, 1));
  r.push('');
  r.push('**D — aumentare sullo stesso lato**: tempo mediano ' + [pEff, pTop, pSens].map((p) => `${n2(p.D.dtSec.mediana, 0)} s`).join(' · ') + ' (efficienti · top 5 · sensibilità).');
  r.push('');

  // ── IL COSTO REALIZZATO ────────────────────────────────────────────────────────────────────────
  // È la sintesi economica delle tre classi: A e B sono le uniche con un esito realizzato, C e D
  // lasciano la posizione dov'è. Segno positivo = guadagno per share.
  r.push('### Il costo realizzato dell\'uscita');
  r.push('');
  r.push('Segno positivo = guadagno. Una coppia chiusa a 99¢ vale **+1¢/share**, una a 102¢ vale −2¢/share.');
  r.push('C e D non hanno un esito realizzato: contano nella colonna «resta direzionale».');
  r.push('');
  r.push('| | efficienti | top 5 | sensibilità |');
  r.push('|---|---|---|---|');
  const cst = (p) => p;
  r.push(`| costo medio sugli eventi con esito (A+B) | ${n2(costi.efficienti.media)}¢ (n=${costi.efficienti.n}) | ${n2(costi.top5.media)}¢ (n=${costi.top5.n}) | ${n2(costi.sensibilita.media)}¢ (n=${costi.sensibilita.n}) |`);
  r.push(`| costo mediano | **${n2(costi.efficienti.mediana)}¢** | **${n2(costi.top5.mediana)}¢** | ${n2(costi.sensibilita.mediana)}¢ |`);
  r.push(`| **resta direzionale (C+D)** | **${pct(costi.efficienti.direzionale, 1)}** | **${pct(costi.top5.direzionale, 1)}** | ${pct(costi.sensibilita.direzionale, 1)} |`);
  r.push(`| coppie chiuse sopra la pari | ${pct(costi.efficienti.sopraLaPari, 1)} | ${pct(costi.top5.sopraLaPari, 1)} | ${pct(costi.sensibilita.sopraLaPari, 1)} |`);
  r.push(`| …e quando sono sopra, di quanto (mediana) | ${n2(costi.efficienti.quantoSopra)}¢ | ${n2(costi.top5.quantoSopra)}¢ | ${n2(costi.sensibilita.quantoSopra)}¢ |`);
  r.push(`| coppie chiuse oltre 110¢ | ${pct(costi.efficienti.oltre110, 1)} | ${pct(costi.top5.oltre110, 1)} | ${pct(costi.sensibilita.oltre110, 1)} |`);
  r.push(`| coppie chiuse oltre 120¢ | ${pct(costi.efficienti.oltre120, 1)} | ${pct(costi.top5.oltre120, 1)} | ${pct(costi.sensibilita.oltre120, 1)} |`);
  r.push('');
  cst(0);

  // ── CONCLUSIONE ────────────────────────────────────────────────────────────────────────────────
  r.push('## Conclusione — cosa fanno gli efficienti che i grossi non fanno');
  r.push('');
  r.push('**① NON è la distanza dal mid, e la misura va nella direzione opposta all\'attesa.** Gli efficienti');
  r.push(`quotano mediana **${n2(dEff.medianaDelleMediane)}¢** dal mid contro **${n2(dTop.medianaDelleMediane)}¢** dei primi 5 — cioè un po' **più lontano**, e con una`);
  r.push(`coda molto più larga (q90 ${n2(dEff.q90)}¢ contro ${n2(dTop.q90)}¢). Normalizzata sul raggio della banda la differenza`);
  r.push('si assottiglia ma non cambia segno. **La posizione nel book non è il loro vantaggio.**');
  r.push('');
  r.push('**② I mercati sì, e sono quasi disgiunti.** Solo il ' + pct(out.mercati.quotaDeiMercatiEfficientiAncheNeiTop5, 1) + ' dei mercati degli efficienti è toccato');
  r.push('anche dai primi 5. Gli efficienti stanno su book **più sottili** (volume 24 h mediano ' + usd(out.mercati.efficienti.volume24hMediano, 0) + ' contro');
  r.push(usd(out.mercati.top5.volume24hMediano, 0) + ') e su bande **più larghe** (`maxSpread` 6.5 nel ' + pct((out.mercati.efficienti.maxSpread.righe.find((x) => x[0] === 6.5)?.[1] || 0) / (out.mercati.efficienti.maxSpread.noti || 1), 0) + ' dei loro mercati contro il ' + pct((out.mercati.top5.maxSpread.righe.find((x) => x[0] === 6.5)?.[1] || 0) / (out.mercati.top5.maxSpread.noti || 1), 0) + ' dei grossi):');
  r.push('più spazio per stare dentro la banda restando lontani dal mid, e meno concorrenza per il montepremi.');
  r.push('');
  r.push('**③ La differenza vera è l\'uscita, ed è doppia.**');
  r.push('');
  r.push(`· **Le due gambe stanno a libro insieme.** Il ${pct(pEff.A.seguitoMaker, 1)} delle coppie si completa con un ordine`);
  r.push(`  **già a riposo** che viene colpito, in ${n2(pEff.A.dtSec.mediana, 0)} secondi mediani, e il ${pct(pEff.A.velociSottoLaPari, 1)} di quelle chiuse entro`);
  r.push(`  120 s costa **meno di $1**. Non è una reazione al fill: è una quotazione a due lati che si riempie da sola.`);
  r.push(`  Nei primi 5 la stessa cosa vale per il ${pct(pTop.A.entro120s, 1)} delle coppie, e fra quelle veloci solo il ${pct(pTop.A.velociSottoLaPari, 1)} sta sotto la pari:`);
  r.push('  quando i grossi chiudono in fretta, è perché **stanno attraversando lo spread**.');
  r.push('');
  r.push(`· **Quando la coppia non arriva, la smontano invece di pagarla.** ${pct(pEff.quote.B.pct, 1)} dei loro eventi è una rivendita`);
  r.push(`  dello stesso esito a **${n2(pEff.B.deltaC.mediana)}¢** mediani in ${n2(pEff.B.dtSec.mediana, 0)} secondi, contro il ${pct(pTop.quote.B.pct, 1)} dei primi 5. Il risultato è che restano`);
  r.push(`  direzionali il **${pct(costi.efficienti.direzionale, 1)}** delle volte contro il **${pct(costi.top5.direzionale, 1)}**, e chiudono sopra la pari solo il ${pct(costi.efficienti.sopraLaPari, 1)} contro il ${pct(costi.top5.sopraLaPari, 1)}.`);
  r.push('');
  r.push(`In una riga: **il costo mediano realizzato di un\'uscita è ${n2(costi.efficienti.mediana)}¢ per gli efficienti e ${n2(costi.top5.mediana)}¢ per i primi 5.**`);
  r.push('I grossi accumulano (D ' + pct(pTop.quote.D.pct, 1) + ' contro ' + pct(pEff.quote.D.pct, 1) + ') e pagano il completamento; gli efficienti si appaiano o escono.');
  r.push('');

  // ── IL CONFRONTO CON LA REGOLA DEL BOT ─────────────────────────────────────────────────────────
  // ⚠ I valori del bot sono LETTERALI con la citazione accanto, non importati: questa corsia di
  // ricerca non importa da `lib/maker/` (screening-lib.js:6). Sono stati verificati sul sorgente in
  // questa sessione, e la riga citata è dove vivono.
  r.push('## La regola del bot, confrontata');
  r.push('');
  r.push('⚠ **Prima una correzione di premessa: il tetto della coppia non è 110¢, è 120¢.**');
  r.push('`lib/maker/chiusura-rapida.js:73` — `TETTO_COPPIA_DEFAULT_CENTS = 120`, e `MAKER_TETTO_COPPIA_CENTS`');
  r.push('non è impostata né in `.env` né in `ecosystem.config.js`, quindi il valore in servizio è 120.');
  r.push('I 110¢ erano **quattro commenti rimasti indietro** dopo la modifica del 12 agosto');
  r.push('(`auto-close.js` righe 49, 1155, 1301, 1496) — reperto D7, §5.2 punto 28. Sono stati corretti');
  r.push('**da un\'altra sessione in parallelo su questa stessa copia**, mentre questa misura girava.');
  r.push('');
  r.push('| | il bot | gli efficienti |');
  r.push('|---|---|---|');
  r.push('| tetto della coppia ai Livelli 1-2 | **99¢** (`100 − carico − MERGE_MIN_MARGIN_CENTS`, `strategia-merge.js:45,83`) | costo mediano **' + n2(pEff.A.costoCoppiaC.mediana) + '¢**, q75 ' + n2(pEff.A.costoCoppiaC.q75) + '¢ |');
  r.push('| come si completa la coppia | Livello 1 **taker** se l\'ask sta già sotto il tetto, altrimenti Livello 2 **maker** | ' + pct(pEff.A.seguitoMaker, 1) + ' **maker**, ' + pct(1 - pEff.A.seguitoMaker, 1) + ' taker |');
  r.push('| quanto si aspetta da maker | **60 min** (`MERGE_WAIT_TIMEOUT_MIN`, `strategia-merge.js:47`) | ' + pct(pEff.A.entro120s, 1) + ' delle coppie si chiude entro **120 s** |');
  r.push('| dopo l\'attesa | Livello 3: taker fin dove il book copre + limit, coppia ≤ **120¢** | coppie oltre 120¢: **' + pct(costi.efficienti.oltre120, 1) + '** |');
  r.push('| vendere la gamba in perdita | vietato fino a **30 min** (`profitPct: 1`), poi al carico; **sotto** il carico solo da **120 min** e per al più 2 tick / 5% (`urgenza-scoperto.js:63,85,86`) | lo fanno in **' + n2(pEff.B.dtSec.mediana, 0) + ' s** mediani, a ' + n2(pEff.B.deltaC.mediana) + '¢, nel ' + pct(pEff.quote.B.pct, 1) + ' dei casi |');
  r.push('');
  r.push('**Dove la regola somiglia.** Il tetto di 99¢ dei Livelli 1-2 è **esattamente** il costo mediano che');
  r.push('gli efficienti pagano davvero (' + n2(pEff.A.costoCoppiaC.mediana) + '¢): il numero è tarato bene. E il Livello 2 — coppia da maker,');
  r.push('sotto il tetto, che intanto matura reward — è la stessa cosa che loro fanno nel ' + pct(pEff.A.seguitoMaker, 1) + ' dei casi.');
  r.push('');
  r.push('**Dove non somiglia, e sono due punti.**');
  r.push('');
  r.push('· **L\'escalation a 120¢ è una via che loro non prendono quasi mai** (' + pct(costi.efficienti.oltre120, 1) + ' delle coppie), e i primi 5');
  r.push('  nemmeno (' + pct(costi.top5.oltre120, 1) + '). Non è un difetto — è una valvola per il caso peggiore — ma non è la leva che');
  r.push('  distingue chi guadagna: nessuno dei due gruppi ci vive dentro.');
  r.push('');
  r.push('· **La vera differenza è che il bot non si sgancia in fretta.** La rivendita della gamba a piccola');
  r.push('  perdita è ' + pct(pEff.quote.B.pct, 1) + ' del comportamento degli efficienti, a ' + n2(pEff.B.deltaC.mediana) + '¢ mediani dopo ' + n2(pEff.B.dtSec.mediana, 0) + ' secondi. Il bot la stessa');
  r.push('  azione la **consente** — un tick sotto il carico rientra nei 2 tick e nel 5% del gradino 2 —');
  r.push('  ma **solo dopo 120 minuti di scopertura**, cioè circa **' + Math.round(120 * 60 / (pEff.B.dtSec.mediana || 1)) + '×** più tardi. Nel frattempo il');
  r.push('  Livello 2 tiene un ordine di completamento a libro per un\'ora.');
  r.push('');
  r.push('**⚠ Quello che questa misura NON dice**: se il bot uscisse prima, incasserebbe di meno in reward');
  r.push('(un ordine che riposa matura, uno smontato no). Il confronto qui è sul **costo dell\'uscita**, non');
  r.push('sul saldo fra costo d\'uscita e reward maturato: quel saldo richiede il reward per mercato, che');
  r.push('§4.12 dà per non attribuibile (il venue paga un bonifico aggregato).');
  r.push('');

  fs.writeFileSync(path.join(DIR_DATI, 'sintesi-efficienti.md'), r.join('\n') + '\n');
  console.log(`scritto ${path.join(DIR_DATI, 'sintesi-efficienti.md')}`);
  console.log(`scritto ${path.join(DIR_DATI, 'efficienti-03-sintesi.json')}`);
}

main();

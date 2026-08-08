'use strict';
// lib/audit/coda.js — LA CODA DEI REPERTI: UNA MEMORIA, NON UNA FOTOGRAFIA.
//
// ═══ LA REGOLA CHE DECIDE TUTTO IL RESTO ════════════════════════════════════════════════════════════
// Un reperto non sparisce mai in silenzio. Se la scansione di stanotte non lo ritrova, non viene
// cancellato: viene marcato **risolto**, con la data in cui lo era ancora e quella in cui non lo era
// più. Sparire e essere stato risolto sono due fatti diversi, e una coda che li confonde è una coda
// che non si può usare per capire se il lavoro sta funzionando.
//
// Per la stessa ragione ogni voce porta `primaVisto` accanto a `ultimoVisto`: un problema aperto da
// nove giorni e uno aperto da stanotte meritano attenzioni diverse, e la differenza si legge solo se
// la prima data non viene sovrascritta.
//
// ═══ L'IMPRONTA ═════════════════════════════════════════════════════════════════════════════════════
// Il riconoscimento fra una scansione e l'altra sta nell'`id` che il rilevatore assegna — per esempio
// `D7:lib/maker/risk-classifier.js:MIN_HORIZON_DAYS`. Deve essere STABILE (lo stesso problema deve
// avere lo stesso id domani) e SPECIFICO (due problemi diversi non devono collidere). Non ci si affida
// al testo del titolo: quello può essere riscritto meglio senza che il problema sia cambiato.
//
// ═══ DUE FILE, DUE MESTIERI ═════════════════════════════════════════════════════════════════════════
//   data/audit-coda.json  la memoria: completa, ordinata, fatta per essere riletta da un programma.
//   data/audit-coda.md    la lettura: `cat` e si capisce. Rigenerato da zero a ogni scansione, perché
//                         è una VISTA — la storia sta nel json, e duplicarla in due posti significa
//                         avere due storie appena una scrittura fallisce a metà.

const fs = require('fs');
const path = require('path');

const ORDINE = { alta: 0, media: 1, bassa: 2 };
const sev = (s) => (ORDINE[s] != null ? ORDINE[s] : 3);

/** Legge la coda. Un file assente o rotto non è un errore: è una coda vuota, cioè la prima scansione. */
function leggiCoda(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      versione: 1,
      scansioni: Array.isArray(d.scansioni) ? d.scansioni : [],
      reperti: Array.isArray(d.reperti) ? d.reperti : [],
      leggibile: true,
      motivo: null,
    };
  } catch (e) {
    return { versione: 1, scansioni: [], reperti: [], leggibile: false, motivo: e.code === 'ENOENT' ? 'prima scansione: nessuna coda precedente' : `coda illeggibile (${e.message})` };
  }
}

/**
 * FONDE i reperti di questa scansione con la memoria. Puro: niente I/O, così la regola «non sparisce
 * niente» si prova senza toccare il disco.
 *
 * @returns {{reperti:object[], nuovi:string[], riaperti:string[], risolti:string[], aperti:number}}
 */
function fondi(precedenti, trovati, { adessoIso, scansioneN } = {}) {
  const ora = adessoIso || new Date().toISOString();
  const perId = new Map((precedenti || []).map((r) => [r.id, { ...r }]));
  const visti = new Set();
  const nuovi = [], riaperti = [];

  for (const t of trovati || []) {
    if (!t || !t.id) continue;
    visti.add(t.id);
    const vecchio = perId.get(t.id);
    if (!vecchio) {
      perId.set(t.id, {
        ...t, stato: 'aperto', primaVisto: ora, ultimoVisto: ora, risoltoIl: null,
        scansioniViste: 1, scansionePrima: scansioneN ?? null,
      });
      nuovi.push(t.id);
      continue;
    }
    // Un reperto che TORNA dopo essere stato risolto non è nuovo e non è mai stato risolto davvero:
    // è riaperto, e vale la pena distinguerlo perché di solito significa che il fix non teneva.
    const eraRisolto = vecchio.stato === 'risolto';
    perId.set(t.id, {
      ...vecchio, ...t,
      stato: 'aperto',
      primaVisto: vecchio.primaVisto || ora,
      ultimoVisto: ora,
      risoltoIl: null,
      riapertoIl: eraRisolto ? ora : (vecchio.riapertoIl || null),
      scansioniViste: (vecchio.scansioniViste || 0) + 1,
      scansionePrima: vecchio.scansionePrima ?? scansioneN ?? null,
    });
    if (eraRisolto) riaperti.push(t.id);
  }

  const risolti = [];
  for (const [id, r] of perId) {
    if (visti.has(id) || r.stato === 'risolto') continue;
    r.stato = 'risolto';
    r.risoltoIl = ora;
    risolti.push(id);
  }

  const reperti = [...perId.values()].sort((a, b) => {
    if ((a.stato === 'aperto') !== (b.stato === 'aperto')) return a.stato === 'aperto' ? -1 : 1;
    if (sev(a.severita) !== sev(b.severita)) return sev(a.severita) - sev(b.severita);
    return String(a.primaVisto).localeCompare(String(b.primaVisto));
  });
  return { reperti, nuovi, riaperti, risolti, aperti: reperti.filter((r) => r.stato === 'aperto').length };
}

/** Scrive la coda in modo atomico: nessun lettore deve poter vedere un file a metà. */
function scriviCoda(file, corpo) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(corpo, null, 2));
  fs.renameSync(tmp, file);
}

const SIMBOLO = { alta: '🔴', media: '🟠', bassa: '🟡' };
const eta = (r, oraIso) => {
  const d = Date.parse(oraIso) - Date.parse(r.primaVisto);
  if (!Number.isFinite(d) || d < 0) return '';
  const g = Math.floor(d / 86_400_000);
  return g >= 1 ? ` · aperto da ${g}g` : ' · aperto da oggi';
};

/** La VISTA leggibile. Rigenerata da zero: la storia sta nel json. */
function rendiMarkdown(corpo) {
  const ultima = corpo.scansioni[corpo.scansioni.length - 1] || {};
  const aperti = corpo.reperti.filter((r) => r.stato === 'aperto');
  const risolti = corpo.reperti.filter((r) => r.stato === 'risolto');
  const perSev = (s) => aperti.filter((r) => r.severita === s);
  const L = [];

  L.push('# Coda dell\'audit di scoperta');
  L.push('');
  L.push('> Generato da `agent44-audit-scoperta`. **Non corregge niente**: trova e archivia.');
  L.push('> La storia sta in `data/audit-coda.json`; questo file è la vista, e si rigenera a ogni giro.');
  L.push('');
  L.push(`**Ultima scansione:** ${ultima.at || '—'}`
    + (ultima.durataSec != null ? ` · durata ${ultima.durataSec}s` : '')
    + (ultima.rssMaxMb != null ? ` · RAM max ${ultima.rssMaxMb} MB` : '')
    + (ultima.completa === false ? ' · **PARZIALE** (budget di tempo esaurito)' : ''));
  L.push('');
  L.push(`**Aperti: ${aperti.length}** — 🔴 ${perSev('alta').length} alta · 🟠 ${perSev('media').length} media · 🟡 ${perSev('bassa').length} bassa`
    + `  ·  risolti nel tempo: ${risolti.length}  ·  scansioni finora: ${corpo.scansioni.length}`);
  if (ultima.nuovi && ultima.nuovi.length) L.push('');
  if (ultima.nuovi && ultima.nuovi.length) L.push(`**NUOVI in questa scansione: ${ultima.nuovi.length}**`);
  if (ultima.riaperti && ultima.riaperti.length) L.push(`**RIAPERTI (il fix non teneva): ${ultima.riaperti.length}**`);
  if (ultima.risolti && ultima.risolti.length) L.push(`**Risolti in questa scansione: ${ultima.risolti.length}**`);
  L.push('');

  if (!aperti.length) {
    L.push('## Aperti');
    L.push('');
    L.push('Nessun reperto aperto. *(Che non è «non c\'è niente da trovare»: è «i rilevatori di oggi non hanno trovato niente». L\'elenco delle regole è in `lib/audit/rilevatori.js`.)*');
  } else {
    L.push('## Aperti');
    for (const s of ['alta', 'media', 'bassa']) {
      const g = perSev(s);
      if (!g.length) continue;
      L.push('');
      L.push(`### ${SIMBOLO[s]} Severità ${s} (${g.length})`);
      for (const r of g) {
        const nuovo = (ultima.nuovi || []).includes(r.id) ? ' **[NUOVO]**' : '';
        const riap = (ultima.riaperti || []).includes(r.id) ? ' **[RIAPERTO]**' : '';
        L.push('');
        L.push(`- **${r.titolo}**${nuovo}${riap}`);
        L.push(`  - dove: \`${r.dove}\``);
        L.push(`  - ${r.dettaglio}`);
        L.push(`  - regola \`${r.regola}\` · id \`${r.id}\` · visto in ${r.scansioniViste} scansioni${eta(r, ultima.at || new Date().toISOString())}`);
      }
    }
  }

  if (risolti.length) {
    L.push('');
    L.push(`## Risolti (${risolti.length}) — tenuti perché «sparito» e «risolto» non sono la stessa cosa`);
    for (const r of risolti.slice(-25)) {
      L.push(`- ~~${r.titolo}~~ · \`${r.id}\` · risolto il ${r.risoltoIl} (visto la prima volta il ${r.primaVisto})`);
    }
  }

  L.push('');
  L.push('---');
  L.push('');
  L.push('### Le scansioni');
  L.push('');
  L.push('| quando | durata | RAM max | aperti | nuovi | risolti | esito |');
  L.push('|---|---|---|---|---|---|---|');
  for (const s of corpo.scansioni.slice(-14)) {
    L.push(`| ${s.at} | ${s.durataSec}s | ${s.rssMaxMb} MB | ${s.aperti} | ${(s.nuovi || []).length} | ${(s.risolti || []).length} | ${s.completa === false ? 'parziale' : 'completa'} |`);
  }
  return L.join('\n') + '\n';
}

module.exports = { leggiCoda, fondi, scriviCoda, rendiMarkdown };

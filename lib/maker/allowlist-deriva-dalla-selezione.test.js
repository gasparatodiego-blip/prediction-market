'use strict';
// lib/maker/allowlist-deriva-dalla-selezione.test.js — CHI NON E' NELLA SELEZIONE NON E' ABILITATO.
//
// ═══ IL DIFETTO, OSSERVATO IN PRODUZIONE ═════════════════════════════════════════════════════════════
// 16 agosto 2026: `data/maker-auto-reprice.json` con **4 mercati abilitati** contro i **3** della
// selezione. `0x776841ce…` era stato sostituito alle 12:34 e nessuno lo aveva disabilitato.
//
// LA CAUSA E' STRUTTURALE. Le uscite dalla selezione finiscono in TRE liste — `uscenti`, `spodestati`,
// `liberati` — e il cablaggio chiamava `rilasciaDallaSelezione` solo sulle prime due. Ogni percorso di
// uscita nuovo doveva ricordarsi di spegnere anche la allowlist; uno non se n'e' ricordato.
//
// Quindi NON si prova «anche `liberati` viene rilasciato»: sarebbe la terza toppa e la quarta
// arriverebbe da sola. Si prova la PROPRIETA': dopo la riconciliazione, allowlist ⊆ selezione,
// qualunque sia la strada da cui un mercato e' uscito.

const assert = require('assert');

let p = 0;
const ok = (nome, cond) => { assert.ok(cond, nome); p += 1; console.log(`  ✓ ${nome}`); };

const A41 = require('../../agents/agent41-realloc-scheduler.js');

const cfg = (abilitati) => ({
  readable: true,
  markets: Object.fromEntries(abilitati.map((id) => [id, { enabled: true }])),
});

async function riconcilia({ sel, abilitati }) {
  const spenti = [];
  const r = await A41.riconciliaAllowlist({
    selezione: sel,
    leggiConfig: () => cfg(abilitati),
    rilascia: async ({ marketId }) => { spenti.push(marketId); return { ok: true }; },
  });
  return { r, spenti };
}

(async () => {
  console.log('\n════ la allowlist deriva dalla selezione ════');

  // ── IL CASO REALE ──────────────────────────────────────────────────────────────────────────────
  {
    const { r, spenti } = await riconcilia({
      sel: { attiva: true, ids: ['0xa', '0xb', '0xc'], idsAttivi: ['0xa', '0xb', '0xc'] },
      abilitati: ['0xa', '0xb', '0xc', '0x776841ce'],
    });
    ok('un mercato abilitato ma fuori dalla selezione viene SPENTO — il caso del 16/08',
      r.ok === true && spenti.length === 1 && spenti[0] === '0x776841ce');
  }

  // ── LA PROPRIETA': allowlist ⊆ selezione, da qualunque strada sia uscito ────────────────────────
  {
    const sel = { attiva: true, ids: ['0xa', '0xb'], idsAttivi: ['0xa', '0xb'] };
    for (const strada of ['uscente', 'spodestato', 'liberato', 'coppia-chiusa', 'mai-visto']) {
      const { spenti } = await riconcilia({ sel, abilitati: ['0xa', '0xb', `0x${strada}`] });
      ok(`  ${strada}: spento comunque — la derivazione non chiede da dove sia uscito`,
        spenti.length === 1 && spenti[0] === `0x${strada}`);
    }
  }

  // ── I MERCATI IN GESTIONE RESTANO ABILITATI (§4.13) ────────────────────────────────────────────
  // `sel.ids` li comprende, `idsAttivi` no. Confrontare con il secondo li spegnerebbe, e la gamba
  // sorella morirebbe per GTD in <= 23 minuti — prima dei 30 che la scala d'uscita le concede.
  {
    const { spenti } = await riconcilia({
      sel: { attiva: true, ids: ['0xa', '0xb', '0xgestione'], idsAttivi: ['0xa', '0xb'] },
      abilitati: ['0xa', '0xb', '0xgestione'],
    });
    ok('un mercato IN GESTIONE resta abilitato: si confronta con `ids`, non con `idsAttivi`',
      spenti.length === 0);
  }

  // ── NON SI ACCENDE MAI ─────────────────────────────────────────────────────────────────────────
  // Abilitare richiede quattro scritture coordinate (`preparaMercatoNuovo`); una derivazione che
  // accendesse ricreerebbe da una porta laterale il rischio «ordini senza via d'uscita».
  {
    const { r, spenti } = await riconcilia({
      sel: { attiva: true, ids: ['0xa', '0xb', '0xc'], idsAttivi: ['0xa', '0xb', '0xc'] },
      abilitati: ['0xa'],
    });
    ok('un mercato selezionato ma NON abilitato non viene acceso da qui',
      r.ok === true && spenti.length === 0);
  }

  // ── FAIL-CLOSED: una selezione che non si legge non spegne il mondo ────────────────────────────
  for (const [nome, sel] of [
    ['selezione spenta', { attiva: false, ids: [] }],
    ['selezione senza ids', { attiva: true, ids: null }],
    ['selezione assente', null],
  ]) {
    const { r, spenti } = await riconcilia({ sel, abilitati: ['0xa', '0xb', '0xc'] });
    ok(`${nome} ⇒ non si tocca NIENTE`, r.ok === false && spenti.length === 0);
  }
  {
    const spenti = [];
    const r = await A41.riconciliaAllowlist({
      selezione: { attiva: true, ids: ['0xa'] },
      leggiConfig: () => ({ readable: false }),
      rilascia: async ({ marketId }) => { spenti.push(marketId); return { ok: true }; },
    });
    ok('allowlist illeggibile ⇒ non si tocca niente', r.ok === false && spenti.length === 0);
  }

  // ── UNO SPEGNIMENTO FALLITO SI DICHIARA, non si finge riuscito ─────────────────────────────────
  {
    const r = await A41.riconciliaAllowlist({
      selezione: { attiva: true, ids: ['0xa'] },
      leggiConfig: () => cfg(['0xa', '0xz']),
      rilascia: async () => ({ ok: false, error: 'venue giu' }),
    });
    ok('uno spegnimento fallito resta `spento:false` con il motivo',
      r.spenti.length === 1 && r.spenti[0].spento === false && /venue giu/.test(r.spenti[0].error));
  }

  console.log(`\nallowlist-deriva-dalla-selezione: ${p} passati, 0 falliti`);
})().catch((e) => { console.error('✗', e.message); process.exit(1); });

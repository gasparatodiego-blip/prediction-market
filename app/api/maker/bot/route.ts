import { NextResponse } from 'next/server';
// L'INTERRUTTORE AVVIA / FERMA DEL BOT.
//
// Questa rotta importa SOLO `lib/maker/bot-enabled`, che è un file di stato: nessun adapter, nessun
// percorso di piazzamento, nessuna credenziale. Premere AVVIA non manda niente al venue — scrive un
// flag che agent41 rilegge a ogni giro. Il primo ordine reale nascerà dal ciclo successivo del
// riallocatore, e solo se tutte le regole del motore lo consentono.
//
// AVVIA/FERMA NON È IL KILL. FERMA blocca i nuovi piazzamenti e le rotazioni ma lascia gestite le
// posizioni aperte (auto-close, riprezzatura, rinnovi). Il KILL — /api/maker/kill — resta separato,
// invariato e assoluto. Sono due bottoni perché sono due intenzioni diverse.
import fs from 'fs';
import path from 'path';
import { statoBot, impostaBot, apertureDallAvvio } from '@/lib/maker/bot-enabled';
import { MAX_NUOVI_PER_GIRO, TARGET_UTILIZZO } from '@/lib/maker/utilizzo-capitale';
import { killStatus, checkKill } from '@/lib/safety/kill-switch';
import { DATA_DIR } from '@/lib/safety/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * L'ULTIMO CICLO DI agent41, letto dalla CODA del suo registro.
 *
 * Il registro è append-only e cresce; si leggono gli ultimi 512 KiB e basta. Il piano non viene
 * ricalcolato qui — sarebbe una seconda matematica accanto a quella dello scheduler, e le due
 * potrebbero divergere senza che nessuno se ne accorga. Questa rotta MOSTRA quello che agent41 ha
 * deciso, non decide.
 */
function ultimoCiclo() {
  const file = path.join(DATA_DIR, 'realloc-scheduler.jsonl');
  let coda = '';
  try {
    const st = fs.statSync(file);
    const CHUNK = 512 * 1024;
    const da = Math.max(0, st.size - CHUNK);
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, st.size));
      const n = fs.readSync(fd, buf, 0, buf.length, da);
      coda = buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch {
    return { letto: false, motivo: 'registro del riallocatore non leggibile' };
  }
  const righe = coda.split('\n');
  for (let i = righe.length - 1; i >= 0; i -= 1) {
    let j: Record<string, unknown>;
    try { j = JSON.parse(righe[i]); } catch { continue; }
    if (j && j.tipo === 'ciclo-referto') {
      const piano = (j.piano || {}) as { capitale?: number; mercati?: unknown[]; capitaleImpegnatoUsd?: number };
      return {
        letto: true,
        at: j.at ?? null,
        azione: j.azione ?? null,
        motivo: j.motivo ?? null,
        soloPiano: j.dryRun === true,
        capitale: piano.capitale ?? null,
        capitaleImpegnatoUsd: piano.capitaleImpegnatoUsd ?? null,
        mercati: Array.isArray(piano.mercati) ? piano.mercati : [],
      };
    }
  }
  return { letto: false, motivo: 'nessun ciclo nella coda del registro' };
}

/** Posizioni aperte, dalla fotografia che agent40 già scrive. Nessuna chiamata al venue da qui. */
function posizioniAperte() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'venue-positions.json'), 'utf8'));
    const arr = Array.isArray(raw?.positions) ? raw.positions : [];
    let usd = 0;
    let leggibile = true;
    for (const p of arr) {
      const size = Math.abs(Number(p?.size));
      const px = Number(p?.avgPrice);
      if (!Number.isFinite(size) || !Number.isFinite(px)) { leggibile = false; continue; }
      usd += size * px;
    }
    return { leggibile, n: arr.length, costoUsd: +usd.toFixed(2), at: raw?.takenAtIso ?? raw?.takenAt ?? null };
  } catch {
    return { leggibile: false, n: null, costoUsd: null, at: null };
  }
}

function istantanea() {
  const s = statoBot({});
  const r = apertureDallAvvio({});
  let kill: { effectivelyKilled: boolean | null; readable: boolean } = { effectivelyKilled: null, readable: false };
  try {
    const k = killStatus() as { effectivelyKilled?: boolean; readable?: boolean };
    kill = { effectivelyKilled: k.effectivelyKilled === true, readable: k.readable === true };
  } catch { /* il kill illeggibile si riporta come tale, non si indovina */ }
  return {
    enabled: s.enabled,
    at: s.at, atIso: s.atIso, by: s.by, reason: s.reason,
    leggibile: s.leggibile, motivo: s.motivo,
    // Il tetto giornaliero («rampa», 5 mercati / 24h) è stato rimosso il 9 agosto 2026: qui viaggia il
    // REGISTRO di cosa è stato aperto, più i due numeri della regola che l'ha sostituita — l'obiettivo
    // di utilizzo e il tetto di velocità per giro. Il pannello mostra una constatazione, non un timer.
    aperture: { ...r, maxNuoviPerGiro: MAX_NUOVI_PER_GIRO, targetUtilizzoPct: +(TARGET_UTILIZZO * 100).toFixed(0) },
    kill,
    posizioni: posizioniAperte(),
    ciclo: ultimoCiclo(),
  };
}

// `serverAt` e non `at`: dentro l'istantanea `at` è già l'istante in cui l'interruttore fu commutato
// l'ultima volta, e uno spread lo sovrascriveva silenziosamente con l'ora della risposta — o meglio, il
// contrario: il campo dichiarato ISO finiva rimpiazzato dall'epoch numerico del flag. Due significati
// diversi non possono condividere un nome in un oggetto che si spalma.
/** GET /api/maker/bot — stato dell'interruttore, del registro aperture e del kill. Sola lettura. */
export async function GET() {
  try {
    return NextResponse.json({ ok: true, serverAt: new Date().toISOString(), ...istantanea() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

/**
 * POST /api/maker/bot — commuta l'interruttore. Body: { enabled: boolean, reason?: string }.
 *
 * `enabled` deve essere un booleano ESPLICITO: niente toggle implicito, perché un toggle su una rotta
 * che autorizza spesa reale è un bottone che fa cose diverse a seconda di uno stato che il chiamante
 * potrebbe non conoscere. Il middleware ha già ristretto la rotta a una sessione admin.
 *
 * Due esiti oltre al 200: 400 se `enabled` non è un booleano, 409 se si chiede di ACCENDERE mentre il
 * kill è attivo o illeggibile. Spegnere non ha rifiuti.
 */
export async function POST(req: Request) {
  try {
    let body: unknown = null;
    try { body = await req.json(); } catch { /* corpo assente o non JSON */ }
    const enabled = (body as { enabled?: unknown } | null)?.enabled;
    if (typeof enabled !== 'boolean') {
      return NextResponse.json(
        { ok: false, error: 'serve { "enabled": true|false } — un booleano esplicito, non un toggle' },
        { status: 400 },
      );
    }
    // ── IL KILL SI CONTROLLA QUI, NON SOLO NEL PANNELLO ─────────────────────────────────────────────
    // Il tasto AVVIA è già disabilitato a kill attivo, ma quella è una cortesia della UI: chiunque
    // abbia una sessione admin e `curl` la scavalca, e fino a oggi la scavalcava davvero. Una rotta
    // che autorizza spesa reale non può delegare al suo client l'unica verifica che conta.
    //
    // Si usa `checkKill`, il chokepoint, e non `killStatus`: il secondo è documentato per la GET di
    // visualizzazione e guarda solo il globale, mentre il primo restituisce una decisione definita,
    // copre anche lo scope utente e — soprattutto — FALLISCE CHIUSO se lo stato non è leggibile.
    // «Non riesco a leggere il kill» non è «il kill è spento».
    //
    // SOLO L'ACCENSIONE PASSA DI QUI. FERMA deve restare possibile sempre, e a maggior ragione a kill
    // attivo: se fermarsi richiedesse che l'emergenza sia a posto, l'emergenza bloccherebbe il freno.
    if (enabled === true) {
      const k = checkKill({}) as { killed?: boolean; scope?: string | null; gate?: string | null; reason?: string };
      if (k.killed === true) {
        return NextResponse.json(
          {
            ok: false,
            error: 'AVVIA rifiutato: il KILL è attivo. Toglilo prima, oppure usa FERMA — che resta sempre disponibile.',
            gate: k.gate ?? 'kill', scope: k.scope ?? null, motivoKill: k.reason ?? null,
            ...istantanea(),
          },
          { status: 409 },
        );
      }
    }

    const reason = (body as { reason?: unknown } | null)?.reason;
    const r = impostaBot({
      enabled,
      by: 'operatore · tab Mercati',
      reason: typeof reason === 'string' && reason.trim() ? reason.trim() : (enabled ? 'AVVIA dalla dashboard' : 'FERMA dalla dashboard'),
    });
    if (!r.ok) return NextResponse.json({ ok: false, error: r.motivo }, { status: 500 });
    return NextResponse.json({ ok: true, serverAt: new Date().toISOString(), prima: r.prima, ...istantanea() });
  } catch (e) {
    return NextResponse.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

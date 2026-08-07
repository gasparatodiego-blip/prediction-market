'use client';
// IL TASTO AVVIA / FERMA, e la riga di stato che gli sta sotto.
//
// ═══ COSA FA PREMERE QUESTO TASTO ════════════════════════════════════════════════════════════════════
// Scrive un flag. Nient'altro parte da qui: nessun ordine, nessuna chiamata al venue. Il flag è la
// CONFERMA ESPLICITA dell'operatore, e agent41 lo rilegge a ogni giro — quindi AVVIA autorizza il
// riallocatore a piazzare dal ciclo successivo, se e solo se tutte le regole del motore lo consentono.
// FERMA toglie l'autorizzazione dal giro successivo, senza riavviare niente.
//
// ═══ NON È IL KILL, E IL PANNELLO LO DEVE DIRE ═══════════════════════════════════════════════════════
// FERMA blocca i piazzamenti nuovi e le rotazioni; le posizioni già aperte restano gestite (uscita
// automatica, riprezzatura, rinnovi). Il KILL è un altro bottone, altrove, e cancella tutto. Chi preme
// FERMA vuole smettere di aprire; chi preme KILL vuole smettere e basta.
//
// ═══ LE CARD DEL PIANO SONO DI SOLA LETTURA ══════════════════════════════════════════════════════════
// Mostrano l'ultimo ciclo di agent41 così com'è stato registrato. Non ricalcolano niente: una seconda
// matematica accanto a quella dello scheduler è il modo in cui due schermate iniziano a raccontare due
// numeri diversi sullo stesso piano.
import { useCallback, useEffect, useState } from 'react';

type Mercato = { marketId?: string; nome?: string; capitale?: number; lordoGiorno?: number };
type Stato = {
  ok?: boolean;
  enabled?: boolean;
  atIso?: string | null;
  by?: string | null;
  reason?: string | null;
  leggibile?: boolean;
  motivo?: string | null;
  rampa?: { attiva?: boolean; residuo?: number; aperti?: number; motivo?: string; ore?: number; maxMercati?: number; oreRimaste?: number };
  kill?: { effectivelyKilled?: boolean | null; readable?: boolean };
  posizioni?: { leggibile?: boolean; n?: number | null; costoUsd?: number | null; at?: string | null };
  ciclo?: { letto?: boolean; at?: string | null; azione?: string | null; motivo?: string | null; soloPiano?: boolean; capitale?: number | null; capitaleImpegnatoUsd?: number | null; mercati?: Mercato[]; };
  error?: string;
};

const usd = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '—');

export default function BotSwitch() {
  const [s, setS] = useState<Stato | null>(null);
  const [inCorso, setInCorso] = useState(false);
  const [errore, setErrore] = useState<string | null>(null);
  const [conferma, setConferma] = useState(false);

  const carica = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/bot', { cache: 'no-store' });
      setS(await r.json());
    } catch (e) { setErrore((e as Error).message); }
  }, []);

  useEffect(() => { carica(); const t = setInterval(carica, 10_000); return () => clearInterval(t); }, [carica]);

  const commuta = useCallback(async (enabled: boolean) => {
    setInCorso(true); setErrore(null);
    try {
      const r = await fetch('/api/maker/bot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const j = await r.json();
      if (!j.ok) setErrore(j.error || 'commutazione rifiutata');
      setS(j.ok ? j : s);
      if (j.ok) await carica();
    } catch (e) { setErrore((e as Error).message); }
    finally { setInCorso(false); setConferma(false); }
  }, [carica, s]);

  const acceso = s?.enabled === true;
  const killAttivo = s?.kill?.effectivelyKilled === true;
  const pos = s?.posizioni;
  const ciclo = s?.ciclo;

  return (
    <div className="ex-card" data-lrc-section="bot-switch" style={{ marginBottom: 14 }}>
      <div className="ex-sech"><span className="ex-sech-t">Interruttore del bot</span></div>

      {/* ── IL TASTO ─────────────────────────────────────────────────────────────────────────────
          AVVIA chiede una conferma in due tempi: è il gesto che autorizza spesa reale, e un click
          singolo su un bottone grande è troppo facile da dare per sbaglio. FERMA no — fermarsi non
          deve mai richiedere un passaggio in più. */}
      {!acceso && !conferma && (
        <button
          type="button" disabled={inCorso || killAttivo}
          onClick={() => setConferma(true)}
          style={{
            width: '100%', padding: '20px 16px', fontSize: 20, fontWeight: 700, letterSpacing: '.04em',
            borderRadius: 10, cursor: killAttivo ? 'not-allowed' : 'pointer',
            border: '1px solid var(--ok-bd, #2f7d4f)', background: 'var(--ok-bg, #123020)', color: 'var(--ok-fg, #7ee2a8)',
            opacity: killAttivo ? 0.5 : 1,
          }}
        >
          AVVIA BOT
        </button>
      )}
      {!acceso && conferma && (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button" disabled={inCorso} onClick={() => commuta(true)}
            style={{ flex: 2, padding: '20px 16px', fontSize: 18, fontWeight: 700, borderRadius: 10, cursor: 'pointer',
              border: '1px solid var(--ok-bd, #2f7d4f)', background: 'var(--ok-bg, #123020)', color: 'var(--ok-fg, #7ee2a8)' }}
          >
            {inCorso ? 'avvio…' : 'CONFERMA: il bot potrà piazzare ordini veri'}
          </button>
          <button type="button" disabled={inCorso} onClick={() => setConferma(false)}
            style={{ flex: 1, padding: '20px 16px', fontSize: 15, borderRadius: 10, cursor: 'pointer' }}>
            annulla
          </button>
        </div>
      )}
      {acceso && (
        <button
          type="button" disabled={inCorso} onClick={() => commuta(false)}
          style={{
            width: '100%', padding: '20px 16px', fontSize: 20, fontWeight: 700, letterSpacing: '.04em',
            borderRadius: 10, cursor: 'pointer',
            border: '1px solid var(--warn-bd, #8a6d1f)', background: 'var(--warn-bg, #2e2410)', color: 'var(--warn-fg, #f0c862)',
          }}
        >
          {inCorso ? 'fermo…' : 'FERMA BOT'}
        </button>
      )}

      {/* ── LA RIGA DI STATO ─────────────────────────────────────────────────────────────────────── */}
      <div style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7 }}>
        <strong>{acceso ? '● attivo' : '○ fermo'}</strong>
        {' · '}
        {pos?.leggibile
          ? <>posizioni aperte <strong>{pos.n}</strong> · capitale impegnato <strong>{usd(pos.costoUsd)}</strong></>
          : <span style={{ opacity: 0.75 }}>posizioni non leggibili — non «zero», non lette</span>}
        {s?.atIso && <> · ultimo cambio {new Date(s.atIso).toLocaleString('it-IT')}{s.by ? ` da ${s.by}` : ''}</>}
      </div>

      {acceso && s?.rampa?.motivo && (
        <div style={{ marginTop: 6, fontSize: 12.5, opacity: 0.9 }}>
          Rampa: {s.rampa.motivo}
          {s.rampa.attiva && typeof s.rampa.oreRimaste === 'number' && <> · finisce fra {s.rampa.oreRimaste.toFixed(1)}h</>}
        </div>
      )}
      {!acceso && s?.leggibile === false && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--warn-fg, #f0c862)' }}>{s.motivo}</div>
      )}
      {killAttivo && (
        <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--bad-fg, #f08c8c)' }}>
          Il KILL è attivo: finché non lo togli, AVVIA non ha effetto. Sono due interruttori diversi —
          il KILL è l&apos;emergenza e cancella tutto, questo è il fermo di tutti i giorni.
        </div>
      )}
      {errore && <div style={{ marginTop: 6, fontSize: 12.5, color: 'var(--bad-fg, #f08c8c)' }}>Errore: {errore}</div>}

      <div style={{ marginTop: 8, fontSize: 12, opacity: 0.72 }}>
        FERMA blocca i piazzamenti nuovi e le rotazioni. Le posizioni già aperte restano gestite: uscita
        automatica, riprezzatura e rinnovi continuano. Per cancellare tutto serve il KILL.
      </div>

      {/* ── IL PIANO CORRENTE, SOLA LETTURA ──────────────────────────────────────────────────────── */}
      <div className="ex-sech" style={{ marginTop: 14 }}><span className="ex-sech-t">Piano corrente del riallocatore</span></div>
      {!ciclo?.letto && <div style={{ fontSize: 12.5, opacity: 0.75 }}>{ciclo?.motivo || 'nessun ciclo registrato'}</div>}
      {ciclo?.letto && (
        <>
          <div style={{ fontSize: 12.5, opacity: 0.85, marginBottom: 8 }}>
            {ciclo.at ? new Date(ciclo.at).toLocaleString('it-IT') : '—'} · esito <strong>{ciclo.azione || '—'}</strong>
            {ciclo.soloPiano && <> · <em>solo piano, nessun ordine inviato</em></>}
            {typeof ciclo.capitale === 'number' && <> · capitale valutato {usd(ciclo.capitale)}</>}
          </div>
          {ciclo.motivo && <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 8 }}>{ciclo.motivo}</div>}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 8 }}>
            {(ciclo.mercati || []).map((m) => (
              <div key={m.marketId} className="ex-card" style={{ padding: '8px 10px' }}>
                <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}>{m.nome || m.marketId?.slice(0, 18)}</div>
                <div style={{ fontSize: 12, opacity: 0.85, marginTop: 4 }}>
                  capitale <strong>{usd(m.capitale)}</strong>
                  {typeof m.lordoGiorno === 'number' && <> · lordo {usd(m.lordoGiorno)}/g</>}
                </div>
              </div>
            ))}
          </div>
          {(ciclo.mercati || []).length === 0 && <div style={{ fontSize: 12.5, opacity: 0.75 }}>il piano non ha righe</div>}
          <div style={{ marginTop: 8, fontSize: 11.5, opacity: 0.65 }}>
            Card di sola lettura: mostrano l&apos;ultimo piano registrato da agent41, non lo ricalcolano.
            Il lordo è la cifra al soffitto teorico — la stima corretta sta nella tab Mercati ottimizzati.
          </div>
        </>
      )}
    </div>
  );
}

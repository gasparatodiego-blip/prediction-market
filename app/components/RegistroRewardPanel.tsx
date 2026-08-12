'use client';

// app/components/RegistroRewardPanel.tsx — QUANTO ABBIAMO DAVVERO INCASSATO, in forma compatta.
//
// ═══ PERCHÉ ESISTE ═══════════════════════════════════════════════════════════════════════════════════
// Ogni altro numero di questo pannello è una STIMA IN AVANTI. Questo è l'unico consuntivo: i dollari
// che il venue ha davvero bonificato, letti dal registro attività pubblico e confrontati con ciò che
// il bot si era detto lo stesso giorno.
//
// ═══ LEGGIBILE DA MOBILE, E COSA VUOL DIRE QUI ══════════════════════════════════════════════════════
// Niente tabella a cinque colonne che diventa una fisarmonica sotto i 400px. Tre numeri grandi in cima
// (incassato · stimato · scarto) e sotto una riga per giorno che sta su una riga sola anche stretta,
// con lo scarto come pastiglia colorata invece che come colonna. La lista scorre in orizzontale solo
// se proprio deve, dentro il suo contenitore — mai la pagina.
//
// ═══ ⚠ IL LIMITE È SCRITTO NEL PANNELLO, NON SOLO NEL CODICE ════════════════════════════════════════
// Il reale NON esiste per mercato: il venue paga un bonifico aggregato al giorno. Chi guarda deve
// vederlo scritto, altrimenti l'assenza della colonna sembra un guasto o, peggio, viene riempita a
// occhio con la stima.

import { useCallback, useEffect, useState } from 'react';

interface Giorno {
  giorno: string;
  stimaUsd: number | null;
  realeUsd: number | null;
  consuntivato: boolean;
  scartoUsd: number | null;
  scartoPct: number | null;
  direzione: string | null;
  pagamenti: number;
  motivo: string | null;
}
interface Totali {
  giornateConsuntivate: number;
  giornateConEntrambi: number;
  realeUsd: number;
  stimaUsd: number;
  realeSuGiorniConfrontabili: number;
  scartoPct: number | null;
  direzione: string | null;
  mediaGiornalieraUsd: number | null;
  primoGiorno: string | null;
  ultimoGiorno: string | null;
}
interface Vista {
  ok: boolean;
  giorni?: Giorno[];
  totali?: Totali | null;
  limiti?: { realePerMercato: boolean; realePerMercatoMotivo: string };
  error?: string;
}

const usd = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(2)}` : '—');
const giornoBreve = (g: string) => g.slice(5).replace('-', '/');

export default function RegistroRewardPanel() {
  const [v, setV] = useState<Vista | null>(null);
  const [busy, setBusy] = useState(false);

  const carica = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/maker/registro-reward', { cache: 'no-store' });
      setV((await r.json()) as Vista);
    } catch (e) {
      setV({ ok: false, error: (e as Error).message });
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { carica(); const t = setInterval(carica, 300_000); return () => clearInterval(t); }, [carica]);

  if (!v) return <div className="rr-box"><div className="rr-vuoto">Registro reward — caricamento…</div></div>;
  if (!v.ok) {
    // FAIL HONEST anche a schermo: un registro illeggibile non si mostra come «zero incassato».
    return <div className="rr-box"><div className="rr-vuoto">Registro reward NON leggibile: {v.error || 'motivo sconosciuto'}</div></div>;
  }
  const t = v.totali;
  const giorni = v.giorni || [];

  return (
    <div className="rr-box">
      <div className="rr-testa">
        <b>Reward incassati</b>
        <span className="rr-sub">
          {t?.primoGiorno ? `${giornoBreve(t.primoGiorno)}→${giornoBreve(t.ultimoGiorno || '')}` : '—'}
          {' · '}{t?.giornateConsuntivate ?? 0} gg
        </span>
        <button className="rr-agg" onClick={carica} disabled={busy}>{busy ? '…' : '↻'}</button>
      </div>

      <div className="rr-numeri">
        <div className="rr-n"><span className="rr-eti">incassato</span><b className="rr-big rr-ok">{usd(t?.realeUsd)}</b></div>
        <div className="rr-n"><span className="rr-eti">stimato*</span><b className="rr-big">{usd(t?.stimaUsd)}</b></div>
        <div className="rr-n">
          <span className="rr-eti">scarto</span>
          <b className={`rr-big ${(t?.scartoPct ?? 0) > 0 ? 'rr-alto' : 'rr-ok'}`}>
            {t?.scartoPct == null ? '—' : `${t.scartoPct > 0 ? '+' : ''}${t.scartoPct.toFixed(0)}%`}
          </b>
        </div>
      </div>
      <div className="rr-nota">
        * su {t?.giornateConEntrambi ?? 0} giornate con entrambi i numeri ({usd(t?.realeSuGiorniConfrontabili)} reali).
        Media {usd(t?.mediaGiornalieraUsd)}/g.
      </div>

      <div className="rr-lista">
        {giorni.map((g) => (
          <div key={g.giorno} className={`rr-riga${g.consuntivato ? '' : ' rr-attesa'}`}>
            <span className="rr-data">{giornoBreve(g.giorno)}</span>
            <span className="rr-val">{g.consuntivato ? usd(g.realeUsd) : '—'}</span>
            <span className="rr-vs">vs</span>
            <span className="rr-val rr-stima">{usd(g.stimaUsd)}</span>
            <span className={`rr-pill ${g.scartoPct == null ? 'rr-p-n' : (g.scartoPct > 50 ? 'rr-p-alto' : (g.scartoPct < -50 ? 'rr-p-basso' : 'rr-p-ok'))}`}>
              {g.scartoPct == null ? (g.consuntivato ? '=' : 'attesa') : `${g.scartoPct > 0 ? '+' : ''}${g.scartoPct.toFixed(0)}%`}
            </span>
          </div>
        ))}
        {!giorni.length && <div className="rr-vuoto">Nessuna giornata registrata.</div>}
      </div>

      {v.limiti && !v.limiti.realePerMercato && (
        <div className="rr-limite">
          ⚠ Il consuntivo è <b>per giorno, non per mercato</b>: il venue paga un bonifico aggregato e non
          dichiara il mercato. La ripartizione per mercato esiste solo sul lato stima e non viene
          proiettata sul reale.
        </div>
      )}

      <style jsx>{`
        .rr-box { border:1px solid #2a2f3a; border-radius:10px; padding:10px 12px; background:#12151c; margin:12px 0; }
        .rr-testa { display:flex; align-items:baseline; gap:8px; }
        .rr-testa b { font-size:14px; }
        .rr-sub { font-size:11px; opacity:.6; }
        .rr-agg { margin-left:auto; background:none; border:1px solid #2a2f3a; color:inherit; border-radius:6px;
                  padding:1px 7px; cursor:pointer; font-size:12px; }
        .rr-numeri { display:flex; gap:14px; margin:8px 0 2px; flex-wrap:wrap; }
        .rr-n { display:flex; flex-direction:column; min-width:78px; }
        .rr-eti { font-size:10px; text-transform:uppercase; letter-spacing:.4px; opacity:.55; }
        .rr-big { font-size:19px; line-height:1.15; font-variant-numeric:tabular-nums; }
        .rr-ok { color:#5fd68a; } .rr-alto { color:#e8b23a; }
        .rr-nota { font-size:10.5px; opacity:.55; margin-bottom:6px; }
        .rr-lista { display:flex; flex-direction:column; gap:2px; }
        .rr-riga { display:flex; align-items:center; gap:6px; font-size:12px; font-variant-numeric:tabular-nums;
                   padding:2px 0; border-top:1px solid #1c2029; }
        .rr-attesa { opacity:.5; }
        .rr-data { width:42px; opacity:.7; flex:none; }
        .rr-val { width:58px; text-align:right; flex:none; }
        .rr-stima { opacity:.6; }
        .rr-vs { opacity:.35; font-size:10px; flex:none; }
        .rr-pill { margin-left:auto; font-size:10px; padding:1px 6px; border-radius:9px; flex:none;
                   background:#1c2029; }
        .rr-p-alto { background:#3a2c14; color:#e8b23a; }
        .rr-p-basso { background:#14283a; color:#5aa9e8; }
        .rr-p-ok { background:#16301f; color:#5fd68a; }
        .rr-p-n { opacity:.5; }
        .rr-limite { margin-top:8px; font-size:10.5px; opacity:.62; line-height:1.35; }
        .rr-vuoto { font-size:12px; opacity:.6; padding:6px 0; }
        /* Sotto i 380px la riga resta comunque su UNA riga: si stringono le colonne, non si va a capo. */
        @media (max-width:380px) {
          .rr-val { width:50px; } .rr-data { width:36px; } .rr-big { font-size:17px; }
        }
      `}</style>
    </div>
  );
}

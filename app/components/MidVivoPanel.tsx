'use client';

// MidVivoPanel — IL MID CHE SI MUOVE, PER I MERCATI CON ORDINI A RIPOSO. SOLA LETTURA.
//
// ═══ COSA MOSTRA, E PERCHÉ QUESTE TRE COSE ══════════════════════════════════════════════════════════
//   · il MID corrente di ogni mercato su cui c'è un ordine a riposo;
//   · la DISTANZA di ogni ordine da quel mid, in centesimi e con il segno — è il numero che dice se
//     l'ordine sta ancora dove pensavamo, e cambia da un istante all'altro anche se l'ordine è fermo;
//   · se quel mercato è in stato «MID STANTIO», cioè se il motore lo sta mettendo in pausa perché il
//     libro non parla da più della soglia. Uno stato di pausa che non si vede è indistinguibile da un
//     motore che ha smesso di funzionare.
//
// ═══ PUSH, NON POLLING ══════════════════════════════════════════════════════════════════════════════
// Una EventSource su /api/maker/live-mid. Il server guarda con fs.watch lo snapshot che agent34 riscrive
// a ogni aggiornamento del websocket e spinge; qui non c'è nessun setInterval che chiede. Il freno
// (≤ 4 aggiornamenti/s) sta sul server, così gli eventi scartati non pagano nemmeno la serializzazione.
//
// ═══ NON TOCCA NIENTE ═══════════════════════════════════════════════════════════════════════════════
// Nessun bottone, nessun form, nessuna POST. È una finestra, non una console.

import { useEffect, useRef, useState } from 'react';

type Ordine = {
  orderId: string | null; side: string | null; price: number | null;
  size: number | null; sizeRemaining: number | null;
  distanzaCents: number | null; latoDelMid: 'sotto' | 'sopra' | 'sul' | null;
};
type Riga = {
  marketId: string; title: string | null; mid: number | null; midAgeSec: number | null;
  live: boolean; midStantio: boolean; sogliaStantioSec: number; ordini: Ordine[];
};
type Stato = {
  at: string; feedLetto: boolean; mercati: Riga[];
  ordiniErrore: string | null; sogliaFrenoMs: number;
};

const cent = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : null);

export default function MidVivoPanel() {
  const [stato, setStato] = useState<Stato | null>(null);
  const [connesso, setConnesso] = useState(false);
  const [degradato, setDegradato] = useState<string | null>(null);
  const [aggiornamenti, setAggiornamenti] = useState(0);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource('/api/maker/live-mid');
    esRef.current = es;
    es.addEventListener('stato', (ev) => {
      try {
        setStato(JSON.parse((ev as MessageEvent).data));
        setConnesso(true);
        setAggiornamenti((n) => n + 1);
      } catch { /* un evento malformato non deve svuotare il pannello */ }
    });
    es.addEventListener('degradato', (ev) => {
      try { setDegradato(JSON.parse((ev as MessageEvent).data).motivo); } catch { setDegradato('modalità degradata'); }
    });
    es.onerror = () => setConnesso(false);
    return () => { es.close(); esRef.current = null; };
  }, []);

  const mercati = stato?.mercati ?? [];
  const totOrdini = mercati.reduce((a, m) => a + m.ordini.length, 0);

  return (
    <div className="ex-card" style={{ marginTop: 16 }}>
      <div className="ex-sech">
        <span className="ex-sech-t">Mid vivo · ordini a riposo</span>
        <span className="ex-stat-v" style={{ fontSize: 12, opacity: 0.75 }}>
          {connesso ? '● in ascolto dal feed' : '○ connessione interrotta'}
          {stato ? ` · ${aggiornamenti} aggiornamenti · freno ${stato.sogliaFrenoMs}ms` : ''}
        </span>
      </div>

      {degradato && <div className="ex-banner is-warn">Push non disponibile: {degradato}</div>}
      {stato && !stato.feedLetto && (
        <div className="ex-banner is-bad">
          Lo snapshot del feed non è leggibile: i mid qui sotto NON sono disponibili — non sono «fermi».
        </div>
      )}
      {stato?.ordiniErrore && (
        <div className="ex-banner is-bad">Ordini NON letti: {stato.ordiniErrore} — non è una lista vuota.</div>
      )}

      {!stato && <p className="lrc-fine">In attesa del primo evento dal feed…</p>}
      {stato && mercati.length === 0 && (
        <p className="lrc-fine">Nessun ordine a riposo: non c&apos;è nessun mid da sorvegliare.</p>
      )}

      {mercati.map((m) => (
        <div key={m.marketId} style={{ marginBottom: 14 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <strong style={{ fontSize: 13 }}>{m.title || `cid_${m.marketId.replace(/^0x/, '').slice(0, 12)}`}</strong>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>
              mid {cent(m.mid) != null ? `${(m.mid! * 100).toFixed(2)}¢` : '—'}
            </span>
            <span style={{ fontSize: 12, opacity: 0.7 }}>
              {m.midAgeSec != null ? `${m.midAgeSec}s fa` : 'età ignota'}
            </span>
            {m.midStantio && (
              <span className="ex-tag is-warn" title={`oltre ${m.sogliaStantioSec}s ⇒ il motore mette questo mercato in pausa`}>
                MID STANTIO · in pausa
              </span>
            )}
            {!m.live && <span className="ex-tag is-bad">book non live</span>}
          </div>

          <table className="ex-table" style={{ marginTop: 6 }}>
            <thead>
              <tr>
                <th>lato</th><th>prezzo</th><th>size</th><th>distanza dal mid</th>
              </tr>
            </thead>
            <tbody>
              {m.ordini.map((o, i) => (
                <tr key={o.orderId || i}>
                  <td>{o.side || '—'}</td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {cent(o.price) != null ? `${(o.price! * 100).toFixed(2)}¢` : '—'}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {cent(o.sizeRemaining) != null ? o.sizeRemaining : (cent(o.size) ?? '—')}
                  </td>
                  <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                    {o.distanzaCents == null
                      ? <span title="mid non leggibile: la distanza non è calcolabile">—</span>
                      : `${o.distanzaCents > 0 ? '+' : ''}${o.distanzaCents.toFixed(2)}¢ ${o.latoDelMid === 'sotto' ? 'sotto' : o.latoDelMid === 'sopra' ? 'sopra' : 'sul mid'}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <p className="lrc-fine">
        Sola lettura. Il mid arriva in push dal feed di agent34 (nessun polling); la lista degli ordini si
        rinfresca sul suo orologio lento perché costa una chiamata al venue, mentre la distanza si
        ricalcola contro il mid nuovo a ogni aggiornamento. {totOrdini} ordine/i su {mercati.length} mercato/i.
      </p>
    </div>
  );
}

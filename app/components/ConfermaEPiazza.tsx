'use client';

// ConfermaEPiazza — UN SOLO BOTTONE, UNA SOLA CONFERMA, DUE GAMBE.
//
// ═══ COSA SOSTITUISCE ═══════════════════════════════════════════════════════════════════════════════
// Il percorso precedente chiedeva quattro gesti per piazzare UN mercato:
//     1 · Anteprima  →  + Metti in coda  →  conferma gamba YES  →  conferma gamba NO
// Quattro conferme per una decisione non sono quattro protezioni. La decisione è UNA — «impegno $X su
// questo mercato» — e ribadirla tre volte non la rende più consapevole: la rende automatica. Le gambe
// YES e NO non sono due decisioni, sono i due lati tecnici della stessa: una gamba sola matura zero
// fuori dal range [0,10–0,90] e un terzo dentro, quindi «confermare solo la prima» non è nemmeno uno
// stato che abbia senso volere.
//
// ═══ LA CONFERMA ESPLICITA C'È, ED È QUESTA ═════════════════════════════════════════════════════════
// La regola di sicurezza del progetto — mai ordini reali senza conferma esplicita dell'operatore
// nell'interfaccia — è soddisfatta dal dialog: mercato, capitale totale, e le DUE gambe con prezzo e
// size, lette dall'anteprima del server (che non scrive e non piazza), non dallo stato del client.
// Chiudere il dialog non piazza niente. Il bottone di conferma dentro il dialog è l'unico punto da cui
// parte un ordine.
//
// ═══ LO STESSO COMPONENTE PER SAFE E PER RISK ═══════════════════════════════════════════════════════
// La tab Ottimizza e la tab Risk usano QUESTO file, non due copie. `profile` è solo un'etichetta che
// viaggia nell'audit e nel testo: non cambia un gate, non cambia il motore, non cambia il prezzo. Se un
// giorno cambiasse qualcosa, cambierebbe per tutti e due — che è il punto.

import { useCallback, useState } from 'react';

/** Una gamba come la produce lib/rewards/plan-to-orders.gambeDiUnaRiga. */
export interface GambaOrdine {
  marketId: string;
  title?: string | null;
  book: 'yes' | 'no';
  side?: 'BUY' | 'SELL';
  price: number;
  size: number;
  coppia?: string;
  gamba?: 'yes' | 'no';
  /** La richiesta di non finire primi sul libro. Viaggia fino a placeManualOrder. */
  inCoda?: boolean;
}

interface EsitoGamba {
  book: string | null;
  status: string;
  orderId: string | null;
  price: number | null;
  size: number | null;
  notionalUsd: number | null;
  reason: string | null;
}

interface Risposta {
  ok?: boolean;
  gate?: string;
  error?: string;
  preview?: boolean;
  capitaleTotaleUsd?: number;
  gambe?: Array<{ book: string; side: string; price: number; size: number; notionalUsd: number }>;
  preparazione?: Array<{ passo: string; ok: boolean; detail?: string }> | { giaInGestioneManuale: boolean; scritture: string[] };
  perGamba?: EsitoGamba[];
  statoLeggibile?: string;
  placed?: number;
  refused?: number;
  rolledBack?: number;
  orphan?: number;
  esclusiDalVenue?: Array<{ marketId?: string; motivo?: string; dettaglio?: string }>;
  openBefore?: number | null;
}

const money = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : '—';
const cents = (v: number | null | undefined) =>
  typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(2)}¢` : '—';

export default function ConfermaEPiazza({
  marketId, title, gambe, capitaleUsd, potAtPlan, profile, onPlaced, disabled, disabledReason,
}: {
  marketId: string;
  title?: string | null;
  /** Le DUE gambe. Con un numero diverso da due il bottone non si mostra: vedi sotto. */
  gambe: GambaOrdine[];
  capitaleUsd: number | null;
  potAtPlan?: number | null;
  profile: 'safe' | 'risk';
  onPlaced?: (marketId: string, esito: Risposta) => void;
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const [aperto, setAperto] = useState(false);
  const [busy, setBusy] = useState<null | 'anteprima' | 'invio'>(null);
  const [anteprima, setAnteprima] = useState<Risposta | null>(null);
  const [esito, setEsito] = useState<Risposta | null>(null);
  const [err, setErr] = useState<string | null>(null);

  // ── DUE GAMBE O NIENTE ────────────────────────────────────────────────────────────────────────
  // Non è una validazione difensiva: è la stessa regola del venue che vive in plan-to-orders e in
  // bulk-allocate. Con una gamba sola questo bottone non deve esistere, perché non esiste l'azione.
  const dueGambe = Array.isArray(gambe) && gambe.length === 2
    && new Set(gambe.map((g) => g.book)).size === 2;

  const chiedi = useCallback(async (preview: boolean) => {
    setErr(null);
    setBusy(preview ? 'anteprima' : 'invio');
    try {
      const r = await fetch('/api/maker/manual/place-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          marketId,
          rows: gambe,
          preview,
          profile,
          potAtPlan: typeof potAtPlan === 'number' && Number.isFinite(potAtPlan) ? potAtPlan : undefined,
        }),
      });
      const b = (await r.json()) as Risposta;
      if (preview) {
        if (b.ok !== true) { setErr(b.error || b.gate || 'anteprima rifiutata'); setAnteprima(null); return; }
        setAnteprima(b);
        setAperto(true);
      } else {
        setEsito(b);
        setAperto(false);
        if (onPlaced) onPlaced(marketId, b);
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(null);
    }
  }, [marketId, gambe, profile, potAtPlan, onPlaced]);

  if (!dueGambe) {
    return (
      <div className="alloc-note alloc-warn" style={{ marginTop: 8 }} data-conferma-no-gambe={marketId}>
        ⚠ Nessun ordine proponibile su questo mercato: servono due gambe opposte e il piano non le ha
        prodotte entrambe. Una gamba sola non si piazza.
      </div>
    );
  }

  const totale = typeof capitaleUsd === 'number' && Number.isFinite(capitaleUsd)
    ? capitaleUsd
    : gambe.reduce((s, g) => s + g.price * g.size, 0);

  return (
    <div style={{ marginTop: 9 }} data-conferma-piazza={marketId}>
      <button
        className="alloc-btn"
        style={{ fontSize: 13, background: 'color-mix(in srgb,#2FA96B 30%,transparent)', fontWeight: 600 }}
        data-conferma-apri={marketId}
        disabled={busy != null || disabled === true}
        title={disabled === true
          ? (disabledReason || 'non disponibile')
          : 'Apre il riepilogo di conferma. Non piazza niente adesso: il dialog mostra le due gambe e il capitale totale, e solo il bottone dentro il dialog invia.'
            + ' Alla conferma, se il mercato non è già in gestione manuale viene preso ora — agent35 non scriverà più su quel libro finché non lo restituisci.'}
        onClick={() => chiedi(true)}
      >
        {busy === 'anteprima' ? 'verifico al venue…' : `Conferma e piazza — ${money(totale)}`}
      </button>
      {disabled === true && disabledReason && (
        <div className="alloc-sub" style={{ marginTop: 4 }}>{disabledReason}</div>
      )}

      {err && (
        <div className="alloc-note alloc-warn" style={{ marginTop: 8 }} data-conferma-errore={marketId}>
          ⚠ <b>Non è stato inviato niente.</b> {err}
        </div>
      )}

      {/* ══ IL DIALOG DI CONFERMA — minimale, e con i numeri del SERVER ═══════════════════════════
          I prezzi e le size qui sotto vengono dall'anteprima appena chiesta al server, non dallo stato
          del client: fra la costruzione della card e questo tap possono passare minuti, e confermare
          numeri vecchi è il modo in cui si piazza su un mid che non esiste più. */}
      {aperto && anteprima && (
        <div className="alloc-card" style={{ marginTop: 10, borderColor: 'color-mix(in srgb,#2FA96B 45%,transparent)' }}
          role="dialog" aria-modal="false" aria-label="Conferma piazzamento" data-conferma-dialog={marketId}>
          <div className="alloc-h" style={{ fontSize: 14 }}>
            Conferma il piazzamento{profile === 'risk' ? ' · profilo Risk' : ''}
          </div>
          <div style={{ marginTop: 6 }}>
            <b>{title || marketId.slice(0, 16)}</b>
          </div>
          <div style={{ marginTop: 6 }}>
            Capitale totale <b className="ex-n">{money(anteprima.capitaleTotaleUsd ?? totale)}</b>
            {' · '}entrambe le gambe incluse
          </div>

          <table style={{ width: '100%', marginTop: 8, fontSize: 12.5, borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', opacity: 0.75 }}>
                <th>Gamba</th><th>Lato</th><th>Prezzo</th><th>Size</th><th style={{ textAlign: 'right' }}>Impegno</th>
              </tr>
            </thead>
            <tbody>
              {(anteprima.gambe ?? []).map((g) => (
                <tr key={g.book} data-conferma-gamba={g.book}>
                  <td><span className={`ex-side ${g.book === 'yes' ? 'is-yes' : 'is-no'}`}>{g.book.toUpperCase()}</span></td>
                  <td>{g.side}</td>
                  <td className="ex-n">{cents(g.price)}</td>
                  <td className="ex-n">{g.size}</td>
                  <td className="ex-n" style={{ textAlign: 'right' }}>{money(g.notionalUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Il prezzo finale può spostarsi di un tick: va detto PRIMA, non scoperto nel referto. */}
          {gambe.some((g) => g.inCoda === true) && (
            <div className="alloc-sub" style={{ marginTop: 8 }}>
              Al piazzamento il prezzo può arretrare di un tick per non finire primi sul libro; se la
              banda premiante non lo consente, vince la banda. Lo spostamento è riportato nel referto.
            </div>
          )}

          {/* ── COSA CAMBIA IN MODO DUREVOLE, DETTO PRIMA DEL TAP ────────────────────────────────
              Prendere un mercato in gestione manuale non è un dettaglio di implementazione: è una
              scrittura che resta, e che toglie quel libro ad agent35 finché non lo si restituisce.
              Chi conferma deve leggerlo QUI, non scoprirlo dopo — e «l'ho preso io adesso» e «c'era
              già» sono due fatti diversi, quindi si distinguono invece di riassumerli. */}
          {anteprima.preparazione && !Array.isArray(anteprima.preparazione) && (
            <div className="alloc-sub" style={{ marginTop: 8 }} data-conferma-preparazione>
              Prima dell&apos;ordine verranno scritte: {anteprima.preparazione.scritture.join(' · ')}.
              {anteprima.preparazione.giaInGestioneManuale
                ? ' Il mercato era già in gestione manuale: nessuna nuova presa di proprietà.'
                : ' Il mercato passa ORA in gestione manuale: agent35 non scriverà più su questo libro,'
                  + ' e resta così finché non lo restituisci dal pannello ordini manuali.'}
            </div>
          )}

          {(anteprima.esclusiDalVenue?.length ?? 0) > 0 && (
            <div className="alloc-note alloc-warn" style={{ marginTop: 8 }}>
              ⚠ Il venue ha segnalato questo mercato: {anteprima.esclusiDalVenue!.map((x) => x.motivo || x.dettaglio).join(' · ')}
            </div>
          )}

          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              className="alloc-btn"
              style={{ background: 'color-mix(in srgb,#2FA96B 42%,transparent)', fontWeight: 700 }}
              data-conferma-invia={marketId}
              disabled={busy != null}
              onClick={() => chiedi(false)}
            >
              {busy === 'invio' ? 'invio…' : `Sì, piazza — ${money(anteprima.capitaleTotaleUsd ?? totale)}`}
            </button>
            <button
              className="alloc-btn"
              data-conferma-annulla={marketId}
              disabled={busy != null}
              onClick={() => { setAperto(false); setAnteprima(null); }}
            >
              Annulla
            </button>
          </div>
          <div className="alloc-sub" style={{ marginTop: 6 }}>
            Annullare non scrive niente: l&apos;anteprima non ha toccato nulla.
          </div>
        </div>
      )}

      {/* ══ IL REFERTO — QUALE GAMBA È ANDATA E QUALE NO ═══════════════════════════════════════════
          Non si riassume in «ok» o «errore». I quattro esiti sono diversi fra loro e l'operatore deve
          poterli distinguere senza dedurli:
            placed      sul libro
            rolled-back piazzata e poi RITIRATA perché l'altra è stata rifiutata → nessuna esposizione
            orphan      piazzata, l'altra rifiutata, e il ritiro NON è riuscito → esposizione VERA
            refused     mai partita */}
      {esito && (
        <div
          className={`alloc-note ${esito.ok === true ? '' : 'alloc-warn'}`}
          style={{ marginTop: 10 }}
          data-conferma-esito={marketId}
        >
          <div><b>{esito.statoLeggibile || (esito.ok === true ? 'piazzato' : 'non piazzato')}</b></div>
          {esito.error && <div style={{ marginTop: 4 }}>{esito.error}</div>}
          {(esito.orphan ?? 0) > 0 && (
            <div className="oob" style={{ marginTop: 6, fontWeight: 600 }}>
              ⚠ Va guardata a mano: una gamba è rimasta sul libro senza la sua controparte.
            </div>
          )}
          {(esito.perGamba?.length ?? 0) > 0 && (
            <table style={{ width: '100%', marginTop: 8, fontSize: 12.5, borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', opacity: 0.75 }}>
                  <th>Gamba</th><th>Esito</th><th>Prezzo</th><th>Order id</th>
                </tr>
              </thead>
              <tbody>
                {esito.perGamba!.map((g, i) => (
                  <tr key={`${g.book}-${i}`} data-conferma-esito-gamba={String(g.book ?? i)}>
                    <td><b>{String(g.book ?? '?').toUpperCase()}</b></td>
                    <td className={g.status === 'placed' ? 'fresh-ok' : 'oob'}>
                      {g.status === 'placed' ? 'sul libro'
                        : g.status === 'rolled-back' ? 'ritirata (nessuna esposizione)'
                          : g.status === 'orphan' ? 'RIMASTA SOLA — ritiro fallito'
                            : g.status === 'refused' ? `rifiutata${g.reason ? `: ${g.reason}` : ''}`
                              : g.status}
                    </td>
                    <td className="ex-n">{cents(g.price)}</td>
                    <td style={{ fontFamily: 'var(--ex-mono)', fontSize: 11 }}>{g.orderId || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

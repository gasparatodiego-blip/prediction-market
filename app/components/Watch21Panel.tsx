'use client';

// ════════════════════════════════════════════════════════════════════════════════════════════════
// «I 21 ORA» — la finestra sul comportamento dei 21 maker del manuale v2, dentro il Riepilogo.
//
// COSA MOSTRA, IN ORDINE DI URGENZA: le convergenze aperte (≥2 dei 21 entrati sullo stesso mercato
// entro due ore — il segnale forte), poi gli ultimi ingressi singoli, poi il consuntivo che si
// accumula giorno per giorno.
//
// COSA NON FA, ED È IL PUNTO: NIENTE. Non c'è un bottone, non c'è un link che piazza, non c'è un
// «prendi in gestione». Questa sezione non tocca l'allocatore, non riordina il piano, non marca
// nessun mercato come candidato. È una finestra, non una leva. Se un giorno una convergenza dovrà
// diventare un criterio di selezione, quella sarà una modifica esplicita all'allocatore decisa
// dall'operatore — non una conseguenza silenziosa di aver messo il dato a schermo.
//
// Legge un solo endpoint di sola lettura, /api/maker/watch-21, che a sua volta legge solo file.
// ════════════════════════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useState } from 'react';

interface Ingresso {
  ts: number; nome: string; wallet: string; conditionId: string;
  titolo: string | null; slug: string | null;
  montepremiGiorno: number | null; nelProgrammaPremi: boolean | null; banda: number | null;
  oreAScadenza: number | null; scadenzaAttendibile: boolean | null;
  etaMercatoOre: number | null; affollamento: number | null;
  primoFill?: { side: string | null; price: number | null; size: number | null; nozionale: number | null };
}
interface Convergenza {
  ts: number; conditionId: string; titolo: string | null; slug: string | null;
  n: number; spanMin: number | null; finestraOre: number;
  wallet: Array<{ nome: string; addr: string; ts: number }>;
  montepremiGiorno: number | null; oreAScadenza: number | null;
}
interface Ritiro {
  ts: number; nome: string; titolo: string | null; conditionId: string;
  orePrimaDellaRisoluzione: number | null; v2MedianaWalletOre: number | null;
  scadenzaAttendibile: boolean | null;
}
interface Buco { nome: string; oreScoperte: number }
interface Scartati { ingressi: number; ritiri: number; motivo: string }
interface Stats {
  totali?: {
    ingressi: number; convergenze: number; ritiri: number; mercatiDistinti: number;
    scartatiScadenzaNonAttendibile?: Scartati;
  };
  finestra?: { giorniOsservati: number };
  consenso?: {
    etaMercatoOreMediana: number | null;
    oreAScadenzaMediana: number | null; oreAScadenzaSuNEventi: number;
    montepremiMediano: number | null; montepremiSuNEventi: number; fuoriDalProgrammaPremi: number;
    montepremiQ1Q3: Array<number | null>;
    ritiroOreMediana: number | null; ritiroSuNEventi: number; v2RitiroOreMediana: number;
    v2ScadenzaOreMediana: number; v2MontepremiMediano: number;
    fasceMontepremi: Record<string, number>;
  };
  perWallet?: Array<{
    nome: string; ingressiTotali: number; ingressiAlGiorno: number | null; v2NuoviAlGiorno: number | null;
    etaMercatoOreMediana: number | null; montepremiMediano: number | null; v2PremioMediano: number | null;
    ritiroOreMediana: number | null; v2RitiroOreMediana: number | null; ultimoIngressoTs: number | null;
  }>;
}
interface Payload {
  monitor: {
    attivo: boolean; etaGiroSec: number | null; giri: number | null;
    latenzaGiroMedianaMs: number | null; latenzaAttesaMedianaS: number | null;
    retiFallite: number | null; wallet: number | null; buchi: number; fonte: string;
  };
  finestre: { ingressiOre: number; convergenzeOre: number };
  ingressi: Ingresso[]; convergenze: Convergenza[]; ritiri: Ritiro[]; buchi: Buco[];
  statistiche: Stats;
}

const nd = (v: number | null | undefined, suff = '') => (v == null ? 'N/D' : `${v}${suff}`);
const soldi = (v: number | null | undefined) => (v == null ? 'N/D' : `$${Math.round(v).toLocaleString('it-IT')}`);
function quando(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 90) return `${s}s fa`;
  if (s < 5400) return `${Math.round(s / 60)} min fa`;
  return `${(s / 3600).toFixed(1)} h fa`;
}
const linkMercato = (slug: string | null) => (slug ? `https://polymarket.com/market/${slug}` : null);

export default function Watch21Panel() {
  const [d, setD] = useState<Payload | null>(null);
  const [errore, setErrore] = useState<string | null>(null);
  const [apri, setApri] = useState(false);

  const carica = useCallback(async () => {
    try {
      const r = await fetch('/api/maker/watch-21', { cache: 'no-store' });
      if (r.status === 404) { setD(null); setErrore('gated'); return; }   // visitatore non operatore
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setD(await r.json()); setErrore(null);
    } catch (e) {
      setErrore(e instanceof Error ? e.message : 'lettura fallita');
    }
  }, []);

  useEffect(() => {
    carica();
    const t = setInterval(carica, 30_000);   // la stessa cadenza del monitor: più spesso non c'è niente di nuovo
    return () => clearInterval(t);
  }, [carica]);

  if (errore === 'gated') return null;

  const m = d?.monitor;
  const st = d?.statistiche?.consenso;
  const tot = d?.statistiche?.totali;

  return (
    <div data-lrc-watch21>
      <div className="ex-sech">
        <span className="ex-sech-t">I 21 ora</span>
        <span className="ex-badges">
          {m && (
            <span className={`ex-badge ${m.attivo ? 'is-ok' : 'is-bad'}`}>
              {m.attivo ? `monitor vivo · ${nd(m.etaGiroSec, 's')} fa` : 'MONITOR FERMO'}
            </span>
          )}
          {m?.buchi ? <span className="ex-badge is-warn">{m.buchi} buchi dichiarati</span> : null}
        </span>
      </div>

      {/* SALUTE PRIMA DEI DATI. «Nessun ingresso» perché il mercato è calmo e «nessun ingresso» perché
          il processo è morto sono la stessa schermata: senza questa riga la sezione mentirebbe per
          omissione ogni volta che agent42 si ferma. */}
      {!d && !errore && <p className="lrc-note">Lettura in corso…</p>}
      {errore && errore !== 'gated' && (
        <div className="ex-banner is-warn lrc-mb">Segnali non leggibili: {errore}. Nessun dato inventato.</div>
      )}
      {m && !m.attivo && (
        <div className="ex-banner is-warn lrc-mb">
          Il monitor dei 21 non gira da oltre cinque minuti: quello che segue è l&apos;ultimo stato noto,
          non la situazione adesso. <code>pm2 restart agent42-watch-makers</code>
        </div>
      )}

      {/* ── CONVERGENZE — IL SEGNALE FORTE, e per questo sta sopra e ha un riquadro suo ─────────── */}
      {d && (d.convergenze.length > 0 ? (
        <div className="lrc-alert" data-lrc-alert="convergenza-21">
          <div className="lrc-alert-t">
            {d.convergenze.length === 1 ? 'Una convergenza attiva' : `${d.convergenze.length} convergenze attive`}
            {' '}— ≥2 dei 21 entrati sullo stesso mercato entro {d.convergenze[0]?.finestraOre ?? 2} ore
          </div>
          <div className="ex-rows lrc-alert-rows">
            {d.convergenze.map((c) => (
              <div key={c.conditionId} className="ex-row">
                <div className="ex-row-main">
                  <div className="ex-row-t">
                    <span className="ex-badge is-gold">{c.n} wallet</span>{' '}
                    {linkMercato(c.slug)
                      ? <a href={linkMercato(c.slug)!} target="_blank" rel="noreferrer">{c.titolo ?? c.conditionId.slice(0, 14)}</a>
                      : (c.titolo ?? c.conditionId.slice(0, 14))}
                  </div>
                  <div className="ex-row-s">
                    {c.wallet.map((w) => w.nome).join(' · ')} — nell&apos;arco di {nd(c.spanMin, ' min')}, {quando(c.ts)}
                  </div>
                </div>
                <div className="ex-row-nums">
                  <span>premio {c.montepremiGiorno == null ? 'N/D' : `${soldi(c.montepremiGiorno)}/g`}</span>
                  <span>scade fra {nd(c.oreAScadenza, ' h')}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="lrc-note">
          Nessuna convergenza nelle ultime {d.finestre.convergenzeOre} ore. Una convergenza è ≥2 dei 21
          che fanno il PRIMO fill sullo stesso mercato entro due ore: due che macinano da giorni lo stesso
          mercato non lo sono.
        </p>
      ))}

      {/* ── ULTIMI INGRESSI ─────────────────────────────────────────────────────────────────────── */}
      {d && (
        <>
          <div className="ex-sech">
            <span className="ex-sech-t">Ultimi ingressi · {d.finestre.ingressiOre} h</span>
          </div>
          {d.ingressi.length === 0 ? (
            <p className="lrc-note">
              Nessun ingresso su un mercato nuovo nelle ultime {d.finestre.ingressiOre} ore.
              {m?.attivo ? ' Il monitor sta girando: è il campione che è fermo, non la lettura.' : ''}
            </p>
          ) : (
            <div className="ex-rows">
              {d.ingressi.map((e) => (
                <div key={`${e.wallet}:${e.conditionId}:${e.ts}`} className="ex-row">
                  <div className="ex-row-main">
                    <div className="ex-row-t">
                      <b>{e.nome}</b> →{' '}
                      {linkMercato(e.slug)
                        ? <a href={linkMercato(e.slug)!} target="_blank" rel="noreferrer">{e.titolo ?? e.conditionId.slice(0, 14)}</a>
                        : (e.titolo ?? e.conditionId.slice(0, 14))}
                    </div>
                    <div className="ex-row-s">
                      {quando(e.ts)} · mercato vecchio di {nd(e.etaMercatoOre, ' h')} ·{' '}
                      {e.scadenzaAttendibile === false
                        ? <span title="Gamma pubblica per questo mercato una endDate anteriore ai fill: la data è inutilizzabile, non è il maker a entrare tardi.">scadenza non attendibile</span>
                        : `scade fra ${nd(e.oreAScadenza, ' h')}`}
                      {e.affollamento != null && ` · ${e.affollamento} wallet sul libro (limite sup.)`}
                      {e.primoFill?.nozionale != null && ` · primo fill $${e.primoFill.nozionale}`}
                    </div>
                  </div>
                  <div className="ex-row-nums">
                    {/* «fuori premi» e «$0/g» non sono la stessa riga: la prima dice che su quel
                        mercato la nostra domanda non si pone, la seconda che si pone e la risposta
                        è zero. Un operatore che scorre questa lista decide in base a quale delle due è. */}
                    <span>
                      {e.nelProgrammaPremi === false ? 'fuori premi'
                        : e.montepremiGiorno == null ? 'premio N/D'
                          : `${soldi(e.montepremiGiorno)}/g`}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── IL CONSUNTIVO CHE SI SCRIVE DA SOLO ─────────────────────────────────────────────────── */}
      {d && st && (
        <details className="lrc-sec" data-lrc-watch21-stats open={apri} onToggle={(ev) => setApri((ev.currentTarget as HTMLDetailsElement).open)}>
          <summary className="ex-sech-t">
            Il consuntivo · {tot?.ingressi ?? 0} ingressi su {tot?.mercatiDistinti ?? 0} mercati in{' '}
            {d.statistiche.finestra?.giorniOsservati ?? 0} giorni osservati
          </summary>
          <div className="lrc-note">
            Ogni riga affianca quello che il monitor MISURA dal vivo al valore corrispondente del
            manuale v2, che è una finestra di 90 giorni chiusa il 7 agosto 2026. Le due colonne non
            sono la stessa misura su periodi diversi: la seconda è la base storica, la prima è ciò che
            sta succedendo. Divergono quando il campione cambia comportamento — che è esattamente il
            motivo per cui questo monitor esiste.
          </div>
          <div className="ex-rows">
            <div className="ex-row">
              <div className="ex-row-main"><div className="ex-row-t">Età del mercato all&apos;ingresso (mediana)</div></div>
              <div className="ex-row-nums"><span>{nd(st.etaMercatoOreMediana, ' h')}</span><span>v2: —</span></div>
            </div>
            <div className="ex-row">
              <div className="ex-row-main">
                <div className="ex-row-t">Ore alla scadenza all&apos;ingresso (mediana)</div>
                <div className="ex-row-s">su {st.oreAScadenzaSuNEventi} ingressi con scadenza attendibile</div>
              </div>
              <div className="ex-row-nums"><span>{nd(st.oreAScadenzaMediana, ' h')}</span><span>v2: {st.v2ScadenzaOreMediana} h</span></div>
            </div>
            <div className="ex-row">
              <div className="ex-row-main">
                <div className="ex-row-t">Montepremi frequentato (mediana)</div>
                <div className="ex-row-s">
                  su {st.montepremiSuNEventi} ingressi dentro il programma premi
                  {st.fuoriDalProgrammaPremi > 0 && ` · ${st.fuoriDalProgrammaPremi} su mercati che un programma non ce l'hanno`}
                </div>
              </div>
              <div className="ex-row-nums">
                <span>{st.montepremiMediano == null ? 'N/D' : `${soldi(st.montepremiMediano)}/g`}</span>
                <span>v2: ${st.v2MontepremiMediano}/g</span>
              </div>
            </div>
            <div className="ex-row">
              <div className="ex-row-main">
                <div className="ex-row-t">Ritiro pre-risoluzione (mediana)</div>
                <div className="ex-row-s">su {st.ritiroSuNEventi} mercati risolti con scadenza attendibile</div>
              </div>
              <div className="ex-row-nums">
                <span>{nd(st.ritiroOreMediana, ' h')}</span>
                <span>v2: {st.v2RitiroOreMediana} h</span>
              </div>
            </div>
          </div>

          {/* L'ESCLUSIONE SI LEGGE ACCANTO AL NUMERO CHE HA PRODOTTO, non in una nota a piè di pagina.
              Una mediana calcolata su metà del campione senza dirlo è peggio di nessuna mediana. */}
          {(() => {
            const sc = tot?.scartatiScadenzaNonAttendibile;
            if (!sc || (sc.ingressi === 0 && sc.ritiri === 0)) return null;
            return (
              <p className="lrc-note">
                Esclusi dalle due mediane che dipendono dalla scadenza: <b>{sc.ingressi} ingressi</b> e{' '}
                <b>{sc.ritiri} ritiri</b> — {sc.motivo}. Restano nel giornale e nei conteggi: è la data
                del venue a non essere usabile, non l&apos;evento a non essere avvenuto.
              </p>
            );
          })()}

          <div className="ex-sech"><span className="ex-sech-t">Fasce di montepremi frequentate</span></div>
          <div className="ex-chips">
            {Object.entries(st.fasceMontepremi ?? {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => (
              <span key={k} className="ex-chip is-on">{k} · {v}</span>
            ))}
            {Object.keys(st.fasceMontepremi ?? {}).length === 0 && <span className="lrc-note">Nessun ingresso ancora.</span>}
          </div>

          <div className="ex-sech"><span className="ex-sech-t">Per wallet · ingressi al giorno, misurati contro il v2</span></div>
          <div className="ex-rows">
            {(d.statistiche.perWallet ?? []).filter((w) => w.ingressiTotali > 0).map((w) => (
              <div key={w.nome} className="ex-row">
                <div className="ex-row-main">
                  <div className="ex-row-t">{w.nome}</div>
                  <div className="ex-row-s">
                    {w.ingressiTotali} ingressi · età mediana {nd(w.etaMercatoOreMediana, ' h')}
                    {w.montepremiMediano != null && ` · premio ${soldi(w.montepremiMediano)}/g (v2 ${soldi(w.v2PremioMediano)}/g)`}
                  </div>
                </div>
                <div className="ex-row-nums">
                  <span>{nd(w.ingressiAlGiorno)}/g</span>
                  <span>v2: {nd(w.v2NuoviAlGiorno)}/g</span>
                </div>
              </div>
            ))}
            {!(d.statistiche.perWallet ?? []).some((w) => w.ingressiTotali > 0) && (
              <p className="lrc-note">Nessun wallet ha ancora prodotto un ingresso da quando il monitor gira.</p>
            )}
          </div>

          {d.ritiri.length > 0 && (
            <>
              <div className="ex-sech"><span className="ex-sech-t">Ritiri pre-risoluzione osservati · 48 h</span></div>
              <div className="ex-rows">
                {d.ritiri.map((r, i) => (
                  <div key={`${r.conditionId}:${r.nome}:${i}`} className="ex-row">
                    <div className="ex-row-main">
                      <div className="ex-row-t"><b>{r.nome}</b> — {r.titolo ?? r.conditionId.slice(0, 14)}</div>
                      <div className="ex-row-s">ultimo fill prima che il mercato si risolvesse</div>
                    </div>
                    <div className="ex-row-nums">
                      <span>{r.scadenzaAttendibile === false ? 'data non usabile' : nd(r.orePrimaDellaRisoluzione, ' h')}</span>
                      <span>v2: {nd(r.v2MedianaWalletOre, ' h')}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </details>
      )}

      {/* IL PERIMETRO, SCRITTO DOVE SI GUARDA IL DATO. Chi legge questa sezione deve sapere, senza
          andare a cercarlo nel codice, che nessuna di queste righe muove capitale. */}
      <p className="lrc-note">
        {m?.fonte ?? 'sola lettura'} · giro dei {nd(m?.wallet)} wallet in {m?.latenzaGiroMedianaMs == null ? 'N/D' : `${(m.latenzaGiroMedianaMs / 1000).toFixed(1)}s`},
        {' '}latenza attesa di rilevamento ~{nd(m?.latenzaAttesaMedianaS, 's')}.
        {' '}<b>Questa sezione non muove capitale.</b> Nessun ingresso e nessuna convergenza entra
        nell&apos;allocatore, nel piano o nella selezione dei mercati: il segnale è informativo, e
        usarlo come criterio resta una decisione da prendere a parte.
      </p>
    </div>
  );
}

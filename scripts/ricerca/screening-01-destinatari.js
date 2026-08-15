'use strict';
// scripts/ricerca/screening-01-destinatari.js — L'UNIVERSO DELLO SCREENING, dalla ricevuta della tx.
//
// Legge la ricevuta della transazione di distribuzione indicata dall'operatore, decodifica i Transfer
// di pUSD e ne estrae i destinatari con l'importo. Nessuna transazione, nessuna scrittura di stato.
//
//   node scripts/ricerca/screening-01-destinatari.js
//
// ⚠ IL «400» È UN BATCH, NON UNA GIORNATA — e la differenza cambia come si legge tutto il resto.
// §5-bis p.149 ha misurato ~2.570 destinatari al giorno su 30 giorni: una distribuzione giornaliera
// sta in PIÙ transazioni Disperse da 400. Quindi questo file produce un CAMPIONE della giornata, non
// la giornata. Lo screening che segue è su quel campione, e il referto deve dirlo.
// Lo script prova comunque a contare i batch del giorno con `eth_getLogs`; se l'RPC ha potato la
// storia, registra l'esito come NON MISURATO invece di far finta che il batch sia la giornata.

const { TOPIC_TRANSFER, PUSD, rpc, scrivi, giornoDiCompetenza } = require('./screening-lib');

const TX = process.argv[2] || '0x9b3ee31151a0775575aa82c78e613103b18776b7e5442107176fe757ede85d9a';

const hex = (n) => '0x' + Number(n).toString(16);
const daTopic = (t) => '0x' + String(t).slice(26).toLowerCase();

async function main() {
  const ric = await rpc('eth_getTransactionReceipt', [TX]);
  if (!ric) throw new Error(`ricevuta non trovata per ${TX}`);
  if (ric.status !== '0x1') throw new Error(`la tx non è riuscita (status ${ric.status})`);

  const blocco = Number(ric.blockNumber);
  const b = await rpc('eth_getBlockByNumber', [hex(blocco), false]);
  const tsSec = Number(b.timestamp);

  const trasferimenti = (ric.logs || [])
    .filter((l) => l.topics && l.topics[0] === TOPIC_TRANSFER
      && String(l.address).toLowerCase() === PUSD)
    .map((l) => ({
      da: daTopic(l.topics[1]),
      a: daTopic(l.topics[2]),
      usd: Number(BigInt(l.data)) / 1e6,
    }));

  if (!trasferimenti.length) throw new Error('nessun Transfer di pUSD nella ricevuta: token o tx sbagliati');

  const mittenti = [...new Set(trasferimenti.map((t) => t.da))];
  if (mittenti.length !== 1) {
    // Non si prosegue con un mittente ambiguo: il distributore è l'ancora di tutto il resto.
    throw new Error(`mittenti multipli nella stessa tx: ${mittenti.join(', ')}`);
  }
  const distributore = mittenti[0];

  // ── QUANTI BATCH HA QUEL GIORNO? Tentativo dichiarato, non assunto. ────────────────────────────
  // Polygon ~2 s/blocco ⇒ un giorno ≈ 43.200 blocchi. Si guarda la finestra ±6 h attorno al batch:
  // i pagamenti escono tutti subito dopo la mezzanotte UTC, quindi la finestra li contiene tutti.
  let giornata = { misurato: false, motivo: null };
  try {
    const meta = 6 * 3600 / 2;   // ~10.800 blocchi = 6 ore
    const topicMittente = '0x' + '0'.repeat(24) + distributore.replace(/^0x/, '');
    // ⚠ L'RPC pubblico rifiuta le finestre oltre 10.000 blocchi («exceed maximum block range»), e non
    // è un errore da ritentare: è da SPEZZARE. Misurato al primo giro.
    const PASSO = 9_500;
    const logs = [];
    for (let da = blocco - meta; da <= blocco + meta; da += PASSO) {
      const a = Math.min(da + PASSO - 1, blocco + meta);
      const parte = await rpc('eth_getLogs', [{
        fromBlock: hex(da), toBlock: hex(a),
        address: PUSD, topics: [TOPIC_TRANSFER, topicMittente],
      }]);
      logs.push(...(parte || []));
    }
    const tx = new Set((logs || []).map((l) => l.transactionHash));
    // Un wallet può comparire in più batch dello stesso giorno: si SOMMA per wallet.
    const perWallet = new Map();
    for (const l of logs || []) {
      const w = daTopic(l.topics[2]);
      perWallet.set(w, (perWallet.get(w) || 0) + Number(BigInt(l.data)) / 1e6);
    }
    giornata = {
      misurato: true,
      batch: tx.size,
      destinatariDistinti: perWallet.size,
      usdTotale: (logs || []).reduce((a, l) => a + Number(BigInt(l.data)) / 1e6, 0),
      quotaDelBatch: perWallet.size ? trasferimenti.length / perWallet.size : null,
      righe: [...perWallet.entries()]
        .map(([wallet, usd]) => ({ wallet, usd }))
        .sort((a, b) => b.usd - a.usd),
    };
  } catch (e) {
    // L'RPC pubblico è NON-archive: oltre ~2 giorni risponde «History has been pruned».
    giornata = { misurato: false, motivo: e.message.slice(0, 200) };
  }

  const importi = trasferimenti.map((t) => t.usd).sort((a, b) => a - b);
  const out = {
    generatoIl: new Date().toISOString(),
    tx: TX,
    blocco,
    istante: new Date(tsSec * 1000).toISOString(),
    giornoDiCompetenza: giornoDiCompetenza(tsSec),
    distributore,
    token: PUSD,
    destinatari: trasferimenti.length,
    usdTotale: trasferimenti.reduce((a, t) => a + t.usd, 0),
    usdMin: importi[0],
    usdMax: importi[importi.length - 1],
    giornata,
    righe: trasferimenti.map((t) => ({ wallet: t.a, usd: t.usd })),
  };

  const f = scrivi('screening-01-destinatari.json', out);
  console.log(`tx ${TX}`);
  console.log(`blocco ${blocco} · ${out.istante} · giorno di competenza ${out.giornoDiCompetenza}`);
  console.log(`distributore ${distributore}`);
  console.log(`destinatari nel batch: ${out.destinatari} · totale $${out.usdTotale.toFixed(2)} · min $${out.usdMin.toFixed(4)} · max $${out.usdMax.toFixed(2)}`);
  if (giornata.misurato) {
    console.log(`giornata intera (±6h): ${giornata.batch} batch · ${giornata.destinatariDistinti} destinatari distinti · $${giornata.usdTotale.toFixed(2)}`);
    console.log(`⇒ questo batch è il ${(giornata.quotaDelBatch * 100).toFixed(1)}% dei destinatari del giorno`);
  } else {
    console.log(`giornata intera: NON MISURATA — ${giornata.motivo}`);
  }
  console.log(`scritto ${f}`);
}

main().catch((e) => { console.error('errore:', e.message); process.exit(1); });

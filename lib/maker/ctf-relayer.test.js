#!/usr/bin/env node
'use strict';
// LE OPERAZIONI CTF VIA RELAYER: COSA SI FIRMA, E COSA IL MODULO SI RIFIUTA DI FIRMARE.
//
// Il rischio di questo percorso non è che sbagli un merge: è che firmi qualcosa che non è un merge. Il
// batch che il relayer esegue è una lista di chiamate arbitrarie, e la firma dell'owner le autorizza
// tutte allo stesso modo. Quindi la maggior parte di questi test non prova il caso felice — prova che
// il confine regge: un target diverso, un selettore diverso, un value diverso, due chiamate invece di
// una, un nonce che parla di un altro indirizzo. Ognuno di questi deve SOLLEVARE prima della firma.
//
// Nessuna rete: l'HTTP è un finto iniettato. Nessuna chiave reale: si genera una Wallet a caso.

const { ethers } = require('ethers');
const R = require('./ctf-relayer');
const { PUSD } = require('../poly-contracts');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };
const solleva = (n, fn, frammento) => {
  try { fn(); ok(n, false, 'non ha sollevato'); }
  catch (e) { ok(n, !frammento || e.message.includes(frammento), frammento ? `«${e.message.slice(0, 90)}»` : ''); }
};
const sollevaAsync = async (n, fn, frammento) => {
  try { await fn(); ok(n, false, 'non ha sollevato'); }
  catch (e) { ok(n, !frammento || e.message.includes(frammento), frammento ? `«${e.message.slice(0, 90)}»` : ''); }
};

const CID = '0x' + 'ab'.repeat(32);
const WALLET = '0x4C81F19a436e8174f1f3b07d7c0169150Fbdbdee';
const SIGNER = '0x7bD09f34622296FA6ba5A28f6d4e888D418285d3';
const NOW = 1_786_000_000_000;
const base = { conditionId: CID, depositWallet: WALLET, signer: SIGNER, nonce: '7', deadline: 1_786_000_240 };

console.log('\n── 1 · GLI INGRESSI CHE NON SI INDOVINANO');
solleva('conditionId malformato è rifiutato',
  () => R.costruisciOperazione({ ...base, operazione: 'mergePositions', conditionId: '0xabc', negRisk: false, quantita: 1 }), 'conditionId malformato');
solleva('conditionId assente è rifiutato',
  () => R.costruisciOperazione({ ...base, operazione: 'mergePositions', conditionId: null, negRisk: false, quantita: 1 }), 'conditionId malformato');
solleva('negRisk non dichiarato è rifiutato, non assunto false',
  () => R.costruisciOperazione({ ...base, operazione: 'mergePositions', negRisk: undefined, quantita: 1 }), 'negRisk non dichiarato');
solleva('negRisk stringa "true" non è true',
  () => R.costruisciOperazione({ ...base, operazione: 'mergePositions', negRisk: 'true', quantita: 1 }), 'negRisk non dichiarato');
solleva('quantità zero è rifiutata',
  () => R.costruisciOperazione({ ...base, operazione: 'mergePositions', negRisk: false, quantita: 0 }), 'positivo');
solleva('quantità negativa è rifiutata',
  () => R.costruisciOperazione({ ...base, operazione: 'splitPosition', negRisk: false, quantita: -5 }), 'positivo');
solleva('quantità null su un merge è rifiutata (null non è zero, ed è comunque inammissibile)',
  () => R.costruisciOperazione({ ...base, operazione: 'mergePositions', negRisk: false, quantita: null }), 'positivo');
solleva('quantità NaN è rifiutata',
  () => R.costruisciOperazione({ ...base, operazione: 'splitPosition', negRisk: false, quantita: NaN }), 'positivo');
solleva('depositWallet malformato è rifiutato',
  () => R.costruisciOperazione({ ...base, depositWallet: 'non-un-indirizzo', operazione: 'mergePositions', negRisk: false, quantita: 1 }), 'depositWallet');

console.log('\n── 2 · L\'ADAPTER SI SCEGLIE DA negRisk, NON DA UN PARAMETRO LIBERO');
ok('negRisk=false → CtfCollateralAdapter', R.adapterPer(false) === R.ADAPTER_STANDARD, R.ADAPTER_STANDARD);
ok('negRisk=true → NegRiskCtfCollateralAdapter', R.adapterPer(true) === R.ADAPTER_NEG_RISK, R.ADAPTER_NEG_RISK);
solleva('negRisk assente non sceglie un default', () => R.adapterPer(undefined), 'non dichiarato');
{
  const p = R.costruisciOperazione({ ...base, operazione: 'mergePositions', negRisk: true, quantita: 10 });
  ok('un mercato neg-risk finisce sull\'adapter neg-risk', p.adapter === R.ADAPTER_NEG_RISK);
  ok('e il target della chiamata è lo stesso adapter', p.invio.corpo.depositWalletParams.calls[0].target.toLowerCase() === R.ADAPTER_NEG_RISK.toLowerCase());
}

console.log('\n── 3 · LE UNITÀ: 6 DECIMALI, SENZA SORPRESE IN VIRGOLA MOBILE');
ok('1 → 1_000_000', R.inUnitaBase(1, 'x') === 1_000_000n, R.inUnitaBase(1, 'x').toString());
ok('2 pUSD → 2_000_000', R.inUnitaBase(2, 'x') === 2_000_000n);
ok('144.2 share → 144_200_000', R.inUnitaBase(144.2, 'x') === 144_200_000n, R.inUnitaBase(144.2, 'x').toString());
ok('0.1+0.2 non diventa 0.30000000000000004', R.inUnitaBase(0.1 + 0.2, 'x') === 300_000n, R.inUnitaBase(0.1 + 0.2, 'x').toString());
ok('un bigint passa intatto', R.inUnitaBase(5_000_000n, 'x') === 5_000_000n);

console.log('\n── 4 · IL CALLDATA DICE DAVVERO QUELLO CHE CREDIAMO');
{
  const iface = new ethers.Interface([
    'function splitPosition(address,bytes32,bytes32,uint256[],uint256)',
    'function mergePositions(address,bytes32,bytes32,uint256[],uint256)',
    'function redeemPositions(address,bytes32,bytes32,uint256[])',
  ]);
  const m = R.costruisciOperazione({ ...base, operazione: 'mergePositions', negRisk: false, quantita: 100 });
  const d = iface.parseTransaction({ data: m.invio.corpo.depositWalletParams.calls[0].data });
  ok('il merge è mergePositions', d.name === 'mergePositions');
  ok('il collaterale è pUSD', String(d.args[0]).toLowerCase() === PUSD.toLowerCase());
  ok('parentCollectionId è 32 byte a zero', d.args[1] === ethers.ZeroHash);
  ok('il conditionId è il nostro', String(d.args[2]).toLowerCase() === CID);
  ok('la partizione è [1,2]', d.args[3].map(Number).join(',') === '1,2');
  ok('l\'importo è in unità base', d.args[4] === 100_000_000n, d.args[4].toString());
  ok('quantitaUmana rispecchia l\'input', m.quantitaUmana === '100.0', m.quantitaUmana);

  const s = R.costruisciOperazione({ ...base, operazione: 'splitPosition', negRisk: false, quantita: 2 });
  ok('lo split è splitPosition', iface.parseTransaction({ data: s.invio.corpo.depositWalletParams.calls[0].data }).name === 'splitPosition');

  const r = R.costruisciOperazione({ ...base, operazione: 'redeemPositions', negRisk: false });
  const dr = iface.parseTransaction({ data: r.invio.corpo.depositWalletParams.calls[0].data });
  ok('il redeem è redeemPositions e non porta quantità', dr.name === 'redeemPositions' && dr.args.length === 4);
  ok('il redeem non dichiara quantità umana', r.quantitaUmana === null);
}

console.log('\n── 5 · IL CONFINE: TUTTO CIÒ CHE NON È SPLIT/MERGE/REDEEM VERSO I DUE ADAPTER');
{
  const buono = R.costruisciOperazione({ ...base, operazione: 'mergePositions', negRisk: false, quantita: 1 })
    .invio.corpo.depositWalletParams.calls[0];
  ok('la chiamata legittima passa', R.verificaConfinamento([buono]).operazione === 'mergePositions');

  solleva('un target estraneo è rifiutato',
    () => R.verificaConfinamento([{ ...buono, target: '0x000000000000000000000000000000000000dEaD' }]), 'target non ammesso');
  solleva('il CTF nudo non è un target ammesso (solo gli adapter)',
    () => R.verificaConfinamento([{ ...buono, target: '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' }]), 'target non ammesso');
  solleva('un transfer di pUSD è rifiutato anche verso un adapter ammesso',
    () => R.verificaConfinamento([{ ...buono, data: new ethers.Interface(['function transfer(address,uint256)']).encodeFunctionData('transfer', ['0x000000000000000000000000000000000000dEaD', 1n]) }]), 'selettore non ammesso');
  solleva('un setApprovalForAll è rifiutato',
    () => R.verificaConfinamento([{ ...buono, data: new ethers.Interface(['function setApprovalForAll(address,bool)']).encodeFunctionData('setApprovalForAll', ['0x000000000000000000000000000000000000dEaD', true]) }]), 'selettore non ammesso');
  solleva('un value diverso da zero è rifiutato',
    () => R.verificaConfinamento([{ ...buono, value: '1' }]), 'value dev\'essere 0');
  solleva('due chiamate nello stesso batch sono rifiutate',
    () => R.verificaConfinamento([buono, buono]), 'ESATTAMENTE una');
  solleva('un batch vuoto è rifiutato',
    () => R.verificaConfinamento([]), 'ESATTAMENTE una');
  solleva('un calldata troncato non arriva alla firma',
    () => R.verificaConfinamento([{ ...buono, data: buono.data.slice(0, 40) }]), 'non decodificabile');
  // Questo è il caso che il solo `parseTransaction` NON prende: ethers (come Solidity) ignora la coda
  // e decodifica senza lamentarsi. Lo prende solo il confronto con la forma ri-codificata.
  solleva('un calldata con coda appesa non arriva alla firma',
    () => R.verificaConfinamento([{ ...buono, data: buono.data + 'deadbeef' }]), 'non canonico');
}

console.log('\n── 6 · L\'EIP-712 CHE IL DEPOSIT WALLET VERIFICA');
{
  const p = R.costruisciOperazione({ ...base, operazione: 'mergePositions', negRisk: false, quantita: 1 });
  const d = p.firma.dominio;
  ok('dominio name = DepositWallet', d.name === 'DepositWallet');
  ok('dominio version = 1', d.version === '1');
  ok('dominio chainId = 137 (Polygon)', d.chainId === 137);
  ok('verifyingContract è il deposit wallet, non l\'adapter', d.verifyingContract.toLowerCase() === WALLET.toLowerCase());
  ok('primaryType = Batch', p.firma.tipoPrimario === 'Batch');
  ok('il messaggio nomina il wallet', p.firma.messaggio.wallet.toLowerCase() === WALLET.toLowerCase());
  ok('il messaggio porta il nonce', p.firma.messaggio.nonce === '7');
  ok('il `from` del submit è il SIGNER, non il wallet', p.invio.corpo.from.toLowerCase() === SIGNER.toLowerCase());
  ok('il `to` del submit è l\'executor del relayer', p.invio.corpo.to === R.RELAYER_EXECUTOR);
  ok('il tipo di transazione è WALLET', p.invio.corpo.type === 'WALLET');
  // La firma dev'essere davvero verificabile contro il signer atteso.
  const w = ethers.Wallet.createRandom();
  const sig = w.signTypedDataSync ? null : null;   // ethers v6 non ha la variante sync: si prova sotto in async
  ok('i tipi contengono Call e Batch', !!(R.TIPI_BATCH.Call && R.TIPI_BATCH.Batch));
  void sig;
}

console.log('\n── 7 · IL TRANELLO DEL NONCE: 200 CON UN INDIRIZZO A CASO');
(async () => {
  await sollevaAsync('un address diverso dal nostro fa sollevare invece di firmare su un nonce inventato',
    () => R.leggiNonce({
      signer: SIGNER, cred: { key: 'k', address: SIGNER },
      http: async () => ({ status: 200, json: { address: '0x2d988c087c95596c3804e34b2b994aa758c7e185', nonce: '5' }, testo: '' }),
    }), 'credenziali non valide');
  await sollevaAsync('un HTTP non-200 fa sollevare',
    () => R.leggiNonce({ signer: SIGNER, cred: { key: 'k', address: SIGNER }, http: async () => ({ status: 403, json: null, testo: 'no' }) }), 'lettura del nonce fallita');
  await sollevaAsync('un nonce non numerico fa sollevare',
    () => R.leggiNonce({ signer: SIGNER, cred: { key: 'k', address: SIGNER }, http: async () => ({ status: 200, json: { address: SIGNER, nonce: 'cinque' }, testo: '' }) }), 'nonce non numerico');
  {
    const n = await R.leggiNonce({ signer: SIGNER, cred: { key: 'k', address: SIGNER }, http: async () => ({ status: 200, json: { address: SIGNER.toLowerCase(), nonce: '12' }, testo: '' }) });
    ok('il nonce buono passa, anche con maiuscole diverse', n === '12', n);
  }

  console.log('\n── 8 · L\'INTERRUTTORE SPENTO: NESSUNA FIRMA, NESSUNA RETE');
  {
    let chiamateHttp = 0;
    let signerChiesto = false;
    const env = { MAKER_FUNDER_ADDRESS: WALLET, POLYMARKET_RELAYER_API_KEY: 'k', POLYMARKET_RELAYER_API_KEY_ADDRESS: SIGNER };
    const res = await R.mergePosition(CID, 100, {
      negRisk: true,
      deps: { env, now: () => NOW, abilitato: false,
        http: async () => { chiamateHttp += 1; return { status: 200, json: {}, testo: '' }; },
        signerProvider: async () => { signerChiesto = true; return { privateKey: '0x' + '11'.repeat(32) }; } },
    });
    ok('non eseguito', res.eseguito === false);
    ok('nessuna chiamata HTTP', chiamateHttp === 0);
    ok('la chiave non è stata nemmeno chiesta', signerChiesto === false);
    ok('ma il piano c\'è tutto', !!res.piano && res.piano.confinamento.operazione === 'mergePositions');
    ok('e il piano dichiara l\'adapter neg-risk', res.piano.adapter === R.ADAPTER_NEG_RISK);
    ok('la firma nel corpo è un segnaposto, non una firma', String(res.piano.invio.corpo.signature).startsWith('<'));
    ok('CTF_RELAYER_ENABLED è false di default', R.CTF_RELAYER_ENABLED === false);
  }

  console.log('\n── 9 · IL GIRO COMPLETO CONTRO UN RELAYER FINTO');
  {
    const w = ethers.Wallet.createRandom();
    const env = { MAKER_FUNDER_ADDRESS: WALLET, POLYMARKET_RELAYER_API_KEY: 'k', POLYMARKET_RELAYER_API_KEY_ADDRESS: w.address };
    const visti = [];
    const http = async ({ metodo, percorso, corpo }) => {
      visti.push(`${metodo} ${percorso.split('?')[0]}`);
      if (percorso.startsWith('/v1/account/transactions/params')) return { status: 200, json: { address: w.address, nonce: '3' }, testo: '' };
      if (percorso === '/submit') { visti.corpo = corpo; return { status: 200, json: { transactionID: 'tx-abc', state: 'STATE_NEW' }, testo: '' }; }
      return { status: 200, json: { state: 'STATE_CONFIRMED', transactionHash: '0xfeed' }, testo: '' };
    };
    const res = await R.splitPosition(CID, 2, {
      negRisk: false,
      deps: { env, now: () => NOW, abilitato: true, http, signerProvider: async () => ({ privateKey: w.privateKey }), attendi: async () => {} },
    });
    ok('eseguito', res.eseguito === true);
    ok('transactionID riportato', res.transactionID === 'tx-abc');
    ok('confermato', res.stato === 'STATE_CONFIRMED');
    ok('hash on-chain riportato', res.transactionHash === '0xfeed');
    ok('ha letto il nonce prima di firmare', visti[0].includes('/v1/account/transactions/params'));
    ok('poi ha inviato', visti[1] === 'POST /submit');
    ok('il nonce inviato è quello letto', visti.corpo.nonce === '3');
    // La firma dev'essere verificabile: chi la ricostruisce deve ottenere il signer.
    const p = res.piano.firma;
    const recuperato = ethers.verifyTypedData(p.dominio, p.tipi, { ...p.messaggio, nonce: '3' }, visti.corpo.signature);
    ok('la firma si verifica contro il signer', recuperato.toLowerCase() === w.address.toLowerCase(), recuperato);
    ok('la firma è di 65 byte', (visti.corpo.signature.length - 2) / 2 === 65);
    ok('il deadline è 4 minuti avanti', Number(visti.corpo.depositWalletParams.deadline) === Math.floor(NOW / 1000) + R.DEADLINE_SEC);
  }

  console.log('\n── 10 · GLI ERRORI NON DIVENTANO SILENZI');
  {
    const w = ethers.Wallet.createRandom();
    const env = { MAKER_FUNDER_ADDRESS: WALLET, POLYMARKET_RELAYER_API_KEY: 'k', POLYMARKET_RELAYER_API_KEY_ADDRESS: w.address };
    const conStato = (stato) => async ({ percorso }) => {
      if (percorso.startsWith('/v1/account/transactions/params')) return { status: 200, json: { address: w.address, nonce: '1' }, testo: '' };
      if (percorso === '/submit') return { status: 200, json: { transactionID: 'tx', state: 'STATE_NEW' }, testo: '' };
      return { status: 200, json: { state: stato }, testo: 'boom' };
    };
    const d = (http) => ({ env, now: () => NOW, abilitato: true, http, signerProvider: async () => ({ privateKey: w.privateKey }), attendi: async () => {}, tentativiConferma: 2, passoConfermaMs: 1 });

    const f = await R.mergePosition(CID, 1, { negRisk: false, deps: d(conStato('STATE_FAILED')) });
    ok('STATE_FAILED è terminale e riportato', f.stato === 'STATE_FAILED');
    const inv = await R.mergePosition(CID, 1, { negRisk: false, deps: d(conStato('STATE_INVALID')) });
    ok('STATE_INVALID è terminale e riportato', inv.stato === 'STATE_INVALID');
    const p = await R.mergePosition(CID, 1, { negRisk: false, deps: d(conStato('STATE_PENDING')) });
    ok('una conferma che non arriva NON diventa un fallimento', p.stato === 'STATE_SCONOSCIUTO');
    ok('e dice esplicitamente di non ri-inviare alla cieca', /non ri-inviarla/.test(p.motivo));

    await sollevaAsync('un submit non-200 solleva',
      () => R.mergePosition(CID, 1, { negRisk: false, deps: d(async ({ percorso }) => (percorso.startsWith('/v1/account') && !percorso.includes('transactions/tx')
        ? { status: 200, json: { address: w.address, nonce: '1' }, testo: '' } : { status: 500, json: null, testo: 'errore' })) }), 'submit rifiutato');

    // La chiave in custodia deve corrispondere alle credenziali del relayer.
    const altra = ethers.Wallet.createRandom();
    await sollevaAsync('una chiave che non corrisponde alle credenziali fa rifiutare la firma',
      () => R.mergePosition(CID, 1, { negRisk: false, deps: { ...d(conStato('STATE_CONFIRMED')), signerProvider: async () => ({ privateKey: altra.privateKey }) } }), 'rifiuto di firmare');

    await sollevaAsync('senza POLYMARKET_RELAYER_API_KEY si dice dove crearla',
      () => R.mergePosition(CID, 1, { negRisk: false, deps: { env: { MAKER_FUNDER_ADDRESS: WALLET }, abilitato: true } }), 'Settings → API Keys');
  }

  console.log('\n── 11 · ISOLAMENTO: QUESTO FILE NON PUÒ PIAZZARE UN ORDINE');
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, 'ctf-relayer.js'), 'utf8');
    const vietati = ['clob-client', 'polymarket-clob-maker/adapter', './manual-order', 'manual-order', 'postOrder', 'createOrder', 'strategia-merge', 'auto-close'];
    for (const v of vietati) {
      // L'audit vive sotto polymarket-clob-maker/: si esclude quella sola riga dal controllo.
      const righe = src.split('\n').filter((l) => l.includes(v) && !l.includes('polymarket-clob-maker/audit'));
      ok(`non nomina «${v}» in un require`, !righe.some((l) => /require\(/.test(l)), righe.length ? `${righe.length} menzione/i, nessuna in require` : '');
    }
    const req = [...src.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]);
    ok('i require sono solo quelli attesi', req.every((r) => ['https', 'ethers', '../poly-contracts', '../venues/polymarket-clob-maker/audit'].includes(r)), req.join(' '));
    ok('non compare setApprovalForAll in nessun ramo eseguibile', !/encodeFunctionData\(\s*'setApprovalForAll'/.test(src));
    ok('non compare approve in nessun ramo eseguibile', !/encodeFunctionData\(\s*'approve'/.test(src));
    ok('non compare transfer in nessun ramo eseguibile', !/encodeFunctionData\(\s*'transfer'/.test(src));
    // La parola compare nell'intestazione («zero sendTransaction in tutto il repo»): si cerca la
    // CHIAMATA, non la prosa, e si guarda solo il codice.
    const codice = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok('nessuna chiamata a sendTransaction nel codice', !/\.sendTransaction\s*\(/.test(codice));
    ok('nessun provider di scrittura costruito qui', !/JsonRpcProvider|getSigner\s*\(/.test(codice));
  }

  console.log(`\n${fail === 0 ? 'TUTTI VERDI' : 'ROSSI'}: ${pass} passati, ${fail} falliti\n`);
  process.exit(fail === 0 ? 0 : 1);
})();

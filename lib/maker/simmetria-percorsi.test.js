#!/usr/bin/env node
'use strict';
// NESSUN MERCATO DIVENTA PIAZZABILE SENZA UNA VIA D'USCITA — DA NESSUNA DELLE DUE STRADE.
//
// ═══ LA CLASSE DI DIFETTO, SESTA VOLTA IN UN GIORNO ══════════════════════════════════════════════════
// Una garanzia viene costruita su UN percorso e non sull'altro. Il sistema ha due strade per rendere un
// mercato piazzabile, e finora facevano cose diverse:
//
//   A · IL RESET       lib/maker/allocation-reset.js — «Conferma ed esegui» e il riallocatore agent41.
//                      Cancella, spegne ciò che esce dal piano, ACCENDE i mercati del piano CON l'uscita
//                      automatica (fase 3), poi piazza (fase 4).
//   B · IL PER-MERCATO app/api/maker/markets/enable — «Conferma e aggiungi» della tab Ottimizza.
//                      Additivo per costruzione: aggiunge un mercato alla allowlist e basta.
//
// La garanzia «ogni mercato gestito ha una via d'uscita» era stata costruita in A e non in B. Spider-Man,
// abilitato da B la sera del 4 agosto 2026, e' nato con due gambe potenziali e nessuna uscita: un fill
// avrebbe lasciato le share bloccate fino alla risoluzione (31 dicembre 2026). Lo stato vero al momento
// della scoperta: uscita accesa su TRE mercati, tutti vecchi, due dei quali finestre Bitcoin gia' chiuse.
//
// Le altre cinque della stessa famiglia, tutte del 3-4 agosto: collector-priority, tetto di
// concentrazione 30%, verifica dei mercati al venue, `coppia`/`gamba` scartati da uno schema zod,
// rimpiazzo della gamba eseguita mai iniettato.
//
// ═══ COSA PROVA QUESTO FILE ══════════════════════════════════════════════════════════════════════════
// Non il comportamento di un modulo: una PROPRIETA' del sistema. Che le due strade portino allo stesso
// posto, e che nessuna delle due possa rendere un mercato piazzabile senza uscita.

const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (n, c, x) => { c ? (pass++, console.log('  ✓ ' + n + (x ? ' — ' + x : ''))) : (fail++, console.log('  ✗ ' + n + (x ? ' — ' + x : ''))); };

const ROOT = path.resolve(__dirname, '..', '..');
const leggi = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const routeEnable = leggi('app', 'api', 'maker', 'markets', 'enable', 'route.ts');
const reset = leggi('lib', 'maker', 'allocation-reset.js');
const routeOrder = leggi('app', 'api', 'maker', 'manual', 'order', 'route.ts');
const orderPanel = leggi('app', 'components', 'OrderPanel.tsx');

console.log('\n══ 1 · IL PERCORSO PER-MERCATO ACCENDE L USCITA, COME FA IL RESET');
{
  ok('la route per-mercato chiama setAutoClose', /setAutoClose\(\{/.test(routeEnable),
    'fino al 4 agosto 2026 non lo faceva da nessuna parte');
  ok('  con enabled:true', /setAutoClose\(\{[\s\S]{0,200}enabled:\s*true/.test(routeEnable));
  ok('  e lo importa davvero', /import\s*\{[^}]*setAutoClose[^}]*\}\s*from\s*'@\/lib\/maker\/auto-close-config'/.test(routeEnable));

  // L'ORDINE È LA REGOLA, non un dettaglio: fra «piazzabile» e «con via d'uscita» non deve esistere
  // un istante, ed è in quell'istante che un fill arriverebbe senza nessuno pronto a chiuderlo.
  const iAc = routeEnable.indexOf('setAutoClose({');
  const iOn = routeEnable.indexOf('setAutoReprice({\n      scope: \'market\', marketId: id, enabled: true');
  const iOnAlt = routeEnable.indexOf('const on = setAutoReprice(');
  ok('L USCITA SI ACCENDE PRIMA DELLA ALLOWLIST', iAc > 0 && iOnAlt > 0 && iAc < iOnAlt,
    `auto-close a ${iAc}, allowlist a ${iOnAlt > 0 ? iOnAlt : iOn}`);
}

console.log('\n══ 2 · SE L USCITA NON SI ACCENDE, IL MERCATO NON VIENE ABILITATO (fermo duro)');
{
  ok('esiste il gate auto-close-write-failed', /gate:\s*'auto-close-write-failed'/.test(routeEnable));
  // Il fermo deve stare PRIMA della scrittura della allowlist, altrimenti non è un fermo.
  const iGate = routeEnable.indexOf("gate: 'auto-close-write-failed'");
  const iAllow = routeEnable.indexOf('const on = setAutoReprice(');
  ok('  e il ritorno avviene PRIMA di toccare la allowlist', iGate > 0 && iGate < iAllow);
  ok('  con una nota che dice perché', /peggio di un mercato in meno/.test(routeEnable));
  // La stessa regola, con le stesse parole, nel percorso di reset: è da lì che viene.
  ok('il reset ha lo stesso fermo duro (è il riferimento)',
    /nonAccesi/.test(reset) && /peggio di un mercato in meno/.test(reset));
}

console.log('\n══ 3 · L ANTEPRIMA LO DICHIARA PRIMA CHE L OPERATORE CONFERMI');
{
  ok('l anteprima elenca data/maker-auto-close.json fra i file scritti',
    /maker-auto-close\.json — USCITA AUTOMATICA/.test(routeEnable),
    'chi conferma deve sapere che l uscita viene accesa, non scoprirlo dopo');
  ok('  e dichiara che senza di essa non si abilita niente',
    /se non si riesce ad accenderla il mercato non viene abilitato affatto/.test(routeEnable));
  ok('l anteprima riporta se l uscita c era GIÀ', /autoCloseBefore:/.test(routeEnable));
  ok('  e lo stato dell interruttore GENERALE', /autoCloseGlobal:/.test(routeEnable),
    'un opt-in per mercato non serve a niente se il generale è spento');
  ok('  con un avviso esplicito quando il generale è spento',
    /interruttore GENERALE dell\\?'uscita automatica è SPENTO/.test(routeEnable));
}

console.log('\n══ 4 · «MAI PRIMO SUL LIBRO» ARRIVA ANCHE AL PERCORSO A MANO');
{
  // Era la stessa forma del difetto `coppia`/`gamba`: uno schema zod che scarta in silenzio un campo
  // che il resto del sistema manda. Il piano lo porta, l'uscita automatica e il rimpiazzo pure.
  ok('lo schema della route manuale DICHIARA inCoda', /inCoda:\s*z\.boolean\(\)\.optional\(\)/.test(routeOrder),
    'zod scarta le chiavi che non conosce: non dichiararlo significava buttarlo via senza un errore');
  ok('il pannello ordine lo manda', /inCoda:\s*true/.test(orderPanel));
  ok('  e MOSTRA lo spostamento del prezzo, se avviene',
    /priceAdjusted\?\.inCoda/.test(orderPanel) && /data-op-qs-in-coda/.test(orderPanel),
    'un prezzo che cambia senza dirlo è peggio del male che cura');

  // Gli altri tre percorsi che già ce l'avevano: la simmetria si prova elencandoli.
  ok('il piano lo porta su ogni riga', /inCoda:\s*true/.test(leggi('lib', 'rewards', 'plan-to-orders.js')));
  ok('  il piazzamento in blocco lo propaga', /inCoda:\s*r\.inCoda === true/.test(leggi('lib', 'maker', 'bulk-allocate.js')));
  ok('  l uscita automatica ce l ha', /inCoda:\s*true/.test(leggi('lib', 'maker', 'auto-close.js')));
  ok('  e il rimpiazzo della gamba pure', /inCoda:\s*true/.test(leggi('agents', 'agent40-manual-reprice.js')));
}

console.log('\n══ 5 · LO SNAPSHOT DELLE POSIZIONI NON DIPENDE PIÙ DALL USCITA AUTOMATICA');
{
  const ag = leggi('agents', 'agent40-manual-reprice.js');
  ok('esiste un compito autonomo per lo snapshot', /async function snapshotPosizioniTask\(\)/.test(ag));
  ok('  girato dal ciclo principale', /await snapshotPosizioniTask\(\)/.test(ag));
  // La prova che conta: il compito non è dietro il return della configurazione auto-close.
  const iSnap = ag.indexOf('await snapshotPosizioniTask()');
  const iClose = ag.indexOf('await closeTask()');
  ok('  e PRIMA della chiusura automatica, non dentro', iSnap > 0 && iClose > 0 && iSnap < iClose);
  ok('la scrittura dello snapshot non sta più dentro readPositions della chiusura',
    !/readPositions:[\s\S]{0,400}writeVenuePositions/.test(ag),
    'era lì, cioè dopo il return che salta tutto quando nessun mercato ha l uscita accesa');
  ok('  ma la lettura è UNA SOLA, condivisa', /const p = await leggiPosizioniVenue\(\)/.test(ag)
    && /function leggiPosizioniVenue/.test(ag));
  ok('  con una cache breve, per non chiedere due volte al venue nello stesso giro',
    /POSIZIONI_FRESCHE_MS/.test(ag));
}

console.log('\n══ 6 · LO STATO VERO, ADESSO');
{
  // Non un'asserzione sul codice: una lettura dello stato di produzione. Se un domani un mercato
  // tornasse a essere abilitato senza uscita, questo test lo dice.
  const arCfg = require('./auto-reprice-config').readAutoRepriceConfig();
  const acCfg = require('./auto-close-config').readAutoCloseConfig();
  const senzaUscita = arCfg.enabledMarketIds.filter(
    (m) => !acCfg.enabledMarketIds.some((k) => k.toLowerCase() === m.toLowerCase()));
  ok('l interruttore generale dell uscita è acceso', acCfg.globalEnabled === true);
  ok('OGNI mercato abilitato ha l uscita automatica', senzaUscita.length === 0,
    senzaUscita.length ? senzaUscita.map((m) => m.slice(0, 12) + '…').join(' · ')
      : `${arCfg.enabledMarketIds.length} abilitati, tutti con via d uscita`);
}

console.log(`\nsimmetria fra i due percorsi: ${pass} passati, ${fail} falliti`);
process.exit(fail ? 1 : 0);

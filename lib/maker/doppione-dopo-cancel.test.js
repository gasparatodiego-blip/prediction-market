// ⚠ IL DIFETTO CHE QUESTO TEST DIFENDE — 20 agosto 2026.
// `replaceManualOrder` cancella e poi ripiazza. Fra il `cancel` confermato e la lettura degli ordini
// vivi passano ~73 ms, e la vista degli ordini aperti del VENUE (`adapter.listOpenOrders`, non una
// cache nostra) non ha ancora recepito la cancellazione: l'ordine appena tolto e' ancora nell'elenco.
// Il gate dei doppioni lo vedeva, e su un `expiry-refresh` — che per definizione ripiazza allo STESSO
// prezzo — lo dichiarava `doppione-identico`. Esito {oldCancelled:true, replaced:false}: gamba fuori
// dal libro. 17 episodi in 11 ore; quella del 09:16:59 su 0x12dc2b61 NO non e' mai rientrata.
//
// ⚠ SI DIFENDE LA PROPRIETA', NON IL VALORE (§5.3): non si asserisce su un id o su un conteggio, ma su
// «l'ordine che questo percorso sta sostituendo e' escluso dall'insieme confrontato, e nessun altro».
'use strict';
const { gemellaEsistente } = require('./doppioni');

let ok = 0, ko = 0;
function ok_(m, c, extra) { if (c) { ok++; console.log('  ✓', m); } else { ko++; console.log('  ✗ ROSSO:', m, extra !== undefined ? JSON.stringify(extra) : ''); } }

const VECCHIO = '0xVECCHIO';
const ALTRO = '0xALTRO';
const base = { conditionId: '0xAA', tokenId: 'tokA', side: 'BUY', price: 0.831, size: 56 };
const ordineVecchio = { orderId: VECCHIO, conditionId: '0xAA', tokenId: 'tokA', side: 'BUY', price: 0.831, size: 56 };
const ordineAltro = { orderId: ALTRO, conditionId: '0xAA', tokenId: 'tokA', side: 'BUY', price: 0.831, size: 56 };

// La stessa filtrata che `valutaNozionaleMercato` applica: `escludiOrderId` toglie UN id, non una classe.
const filtra = (ordini, escl) => (escl ? ordini.filter((o) => String(o.orderId) !== String(escl)) : ordini);

console.log('\n══ 1 · IL DIFETTO: senza esclusione, il rimpiazzo e\' doppione di se stesso');
{
  const g = gemellaEsistente(filtra([ordineVecchio], null), base);
  ok_('senza escludiOrderId l\'ordine appena cancellato viene visto come gemella IDENTICA', g.esiste && g.identico);
  ok_('  ...ed e\' proprio quello che il percorso stava sostituendo', g.ordine && g.ordine.orderId === VECCHIO);
}

console.log('\n══ 2 · LA CURA: escluso l\'id sostituito, non c\'e\' nessun doppione');
{
  const g = gemellaEsistente(filtra([ordineVecchio], VECCHIO), base);
  ok_('escludendo l\'id sostituito il rimpiazzo passa', !g.esiste);
}

console.log('\n══ 3 · IL GATE NON E\' ALLENTATO: un doppione VERO resta rifiutato');
{
  // Due ordini identici a libro: uno e' quello che stiamo sostituendo, l'ALTRO e' un doppione vero.
  const g = gemellaEsistente(filtra([ordineVecchio, ordineAltro], VECCHIO), base);
  ok_('con un secondo ordine identico davvero a libro il doppione e\' ancora rilevato', g.esiste && g.identico);
  ok_('  ...e la gemella nominata e\' l\'ALTRO, non quello sostituito', g.ordine && g.ordine.orderId === ALTRO);
}
{
  // Nessuna sostituzione in corso (piazzamento normale): il gate deve mordere come sempre.
  const g = gemellaEsistente(filtra([ordineAltro], null), base);
  ok_('su un piazzamento normale (nessun id da escludere) il doppione e\' rifiutato', g.esiste && g.identico);
}

console.log('\n══ 4 · L\'ESCLUSIONE E\' PUNTUALE: toglie un id, non una classe');
{
  const g = gemellaEsistente(filtra([ordineAltro], VECCHIO), base);
  ok_('escludere un id ASSENTE non toglie nessun altro ordine', g.esiste && g.identico && g.ordine.orderId === ALTRO);
  const diverso = gemellaEsistente(filtra([{ ...ordineVecchio, price: 0.820 }], VECCHIO), base);
  ok_('l\'esclusione vale anche quando l\'ordine sostituito ha prezzo diverso (riprezzo vero)', !diverso.esiste);
}

console.log('\n══ 5 · IL CABLAGGIO: `replaceManualOrder` PASSA l\'id a `placeManualOrder`');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, 'manual-order.js'), 'utf8');
  // Si guarda il codice, non i commenti: il difetto era proprio un campo letto in un punto e scritto
  // in nessuno, e un commento che lo racconta non lo caccia.
  const codice = src.split('\n').filter((r) => !/^\s*(\/\/|\*|\/\*)/.test(r)).join('\n');
  const letture = (codice.match(/spec\.sostituisceOrderId/g) || []).length;
  const scritture = (codice.match(/sostituisceOrderId:\s*orderId/g) || []).length;
  ok_('il campo e\' LETTO dal precontrollo del tetto per mercato', letture >= 1, { letture });
  ok_('il campo e\' anche SCRITTO dal percorso di sostituzione (era il difetto: 1 lettura, 0 scritture)',
    scritture >= 1, { scritture });
  ok_('  e la scrittura sta nella chiamata a placeManualOrder del rimpiazzo',
    /placeManualOrder\(\{[^}]*sostituisceOrderId:\s*orderId/s.test(codice));
  ok_('il PRECONTROLLO continua a escludere l\'ordine che sta per sostituire',
    /escludiOrderId:\s*orderId/.test(codice));
}

console.log(`\n${ok} verdi, ${ko} rossi`);
process.exit(ko === 0 ? 0 : 1);

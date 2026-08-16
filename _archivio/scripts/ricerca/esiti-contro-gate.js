#!/usr/bin/env node
// ESITI REALI CONTRO IL VERDETTO DEL GATE DI PROFONDITÀ — sola lettura.
// Richiede che 'taratura-profondita.js' sia già girato (legge data/ricerca/taratura-profondita.json).
// Risponde a B3: i mercati che il filtro esclude ci hanno fatto del male, o no?
const fs=require('fs'),path=require('path');
const D=JSON.parse(fs.readFileSync('/root/rewards-bot/data/ricerca/taratura-profondita.json','utf8'));
const perCid=new Map(D.righe.map(r=>[r.cid,r]));
const pos=JSON.parse(fs.readFileSync('/root/rewards-bot/data/venue-positions.json','utf8')).positions||[];
const res=JSON.parse(fs.readFileSync('/root/rewards-bot/data/residui-scoperti.json','utf8'));
const {pavimentoPremiante}=require('/root/rewards-bot/lib/rewards/concentration');
const TETTO=32.67, Q=0.60;
const smax=(d)=>d*Q/(1-Q);
const stato=(r)=>{ if(!r||!Number.isFinite(r.depthShares)||!Number.isFinite(r.minSize))return 'ignoto';
  if(pavimentoPremiante(r.minSize)>TETTO)return 'non-finanziabile';
  return r.minSize>smax(r.depthShares)?'ESCLUSO-depth':'ammesso'; };

console.log('=== I MERCATI IN CUI ABBIAMO CAPITALE, CONTRO IL GATE ===');
console.log('n posizioni:',pos.length);
const resMap=new Map(Object.entries(res.residui||res||{}).filter(([k,v])=>typeof v==='object'));
let amm=[],esc=[],nf=[],ign=[];
for(const p of pos){
  const cid=String(p.conditionId||'').toLowerCase();
  const r=perCid.get(cid);
  const s=stato(r);
  const val=Number(p.size)*Number(p.curPrice)||0;
  const rec={t:(p.title||'').slice(0,44),val:+val.toFixed(2),size:+Number(p.size).toFixed(1),
    minSize:r?r.minSize:null,depth:r&&Number.isFinite(r.depthShares)?+r.depthShares.toFixed(1):null,
    lordo:r?r.lordoGiornoUsd:null,inBoard:!!r};
  ({'ammesso':amm,'ESCLUSO-depth':esc,'non-finanziabile':nf,'ignoto':ign})[s].push(rec);
}
for(const [n,a] of [['AMMESSI dal gate',amm],['ESCLUSI dal gate profondità',esc],['NON FINANZIABILI (minSize>tetto)',nf],['non nel board / profondità ignota',ign]]){
  const tot=a.reduce((x,y)=>x+y.val,0);
  console.log(`\n-- ${n}: ${a.length} posizioni, $${tot.toFixed(2)}`);
  a.sort((x,y)=>y.val-x.val).forEach(r=>console.log('   $'+String(r.val).padStart(6),'size='+String(r.size).padStart(6),'minSize='+String(r.minSize).padStart(5),'depth='+String(r.depth).padStart(9),'lordo/g='+String(r.lordo).padStart(5),' ',r.t));
}
console.log('\n=== RESIDUI SOTTO IL MINIMO: nascono su book sottili o spessi? ===');
const RS=res.residui||res;
const righe=[];
for(const [k,v] of Object.entries(RS)){
  if(!v||typeof v!=='object'||!v.marketId)continue;
  const r=perCid.get(String(v.marketId).toLowerCase());
  righe.push({k:k.slice(0,14),pronto:v.pronto,size:v.size,minSize:v.minSize,
    stato:stato(r),depth:r&&Number.isFinite(r.depthShares)?+r.depthShares.toFixed(1):null});
}
console.log('voci nel registro:',righe.length);
const g=new Map(); righe.forEach(r=>g.set(r.stato,(g.get(r.stato)||0)+1));
[...g].forEach(([k,v])=>console.log('  ',v,k));
righe.slice(0,20).forEach(r=>console.log('   ',r.k,'pronto='+r.pronto,'size='+r.size,'min='+r.minSize,r.stato,'depth='+r.depth));

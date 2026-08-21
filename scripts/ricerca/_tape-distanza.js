'use strict';
const fs=require('fs'),path=require('path');
const R=path.resolve(__dirname,'..','..');
const {fileRuntime,NOMI}=require(R+'/lib/percorsi-runtime');
const ORD=JSON.parse(fs.readFileSync(R+'/data/ricerca/ordini-vivi-21ago.json','utf8'));
const BD=Object.fromEntries(JSON.parse(fs.readFileSync(fileRuntime(NOMI.boardNormalizzato),'utf8')).markets.map(m=>[m.marketId,m]));
const IDS=[...new Set(ORD.ordini.map(o=>o.market))]; const S=new Set(IDS);
const FINE=Date.parse(ORD.atIso), INIZIO=FINE-24*3600*1000;
const H=new Map(IDS.map(i=>[i,[]])), T=[];
for(const g of ['2026-08-20','2026-08-21']){
 for(const l of fs.readFileSync(`${R}/data/mid-history-${g}.jsonl`,'utf8').split('\n')){if(!l)continue;let d;try{d=JSON.parse(l)}catch{continue}
  if(!S.has(d.marketId))continue;const t=Date.parse(d.ts);if(t<INIZIO||t>FINE)continue;H.get(d.marketId).push({t,mid:d.adjMid,bb:d.bestBid,ba:d.bestAsk,tick:d.tick});}
 for(const l of fs.readFileSync(`${R}/data/trade-tape-${g}.jsonl`,'utf8').split('\n')){if(!l)continue;let d;try{d=JSON.parse(l)}catch{continue}
  if(!S.has(d.marketId))continue;const t=Number(d.tsVenueMs);if(t<INIZIO||t>FINE)continue;T.push(d);}}
for(const a of H.values())a.sort((x,y)=>x.t-y.t);
const at=(a,t)=>{let lo=0,hi=a.length-1,b=null;while(lo<=hi){const m=(lo+hi)>>1;if(a[m].t<=t){b=a[m];lo=m+1}else hi=m-1}return b&&t-b.t<=150000?b:null};
const dist=[],oltreTouch=[];
const perLato={BUY:0,SELL:0,null:0};
for(const tr of T){
  const b=BD[tr.marketId],r=at(H.get(tr.marketId),Number(tr.tsVenueMs));if(!r)continue;
  const yes=String(tr.tokenId)===String(b.tokenId);
  const p=yes?Number(tr.price):+(1-Number(tr.price)).toFixed(6);
  const lato=yes?String(tr.side).toUpperCase():(String(tr.side).toUpperCase()==='BUY'?'SELL':'BUY');
  perLato[lato]=(perLato[lato]||0)+1;
  const dc=+(Math.abs(p-r.mid)*100).toFixed(3);
  dist.push(dc);
  // quanto oltre il touch e' andata la stampa, in tick
  let oltre=null;
  if(lato==='SELL'&&Number.isFinite(r.bb)) oltre=+((r.bb-p)/r.tick).toFixed(2);
  if(lato==='BUY'&&Number.isFinite(r.ba)) oltre=+((p-r.ba)/r.tick).toFixed(2);
  if(oltre!=null) oltreTouch.push(oltre);
}
const q=(a,p)=>{const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.floor(s.length*p))]};
console.log('stampe giudicabili:',dist.length,' lato taker:',JSON.stringify(perLato));
console.log('distanza |stampa - mid| in ¢:  min',Math.min(...dist),' p50',q(dist,.5),' p90',q(dist,.9),' p99',q(dist,.99),' max',Math.max(...dist));
console.log('tick OLTRE il touch (0 = ha colpito il miglior prezzo, 1 = ha mangiato un secondo livello):');
console.log('   min',Math.min(...oltreTouch),' p50',q(oltreTouch,.5),' p90',q(oltreTouch,.9),' p99',q(oltreTouch,.99),' max',Math.max(...oltreTouch));
const oltre1=oltreTouch.filter(x=>x>=1).length, oltre2=oltreTouch.filter(x=>x>=2).length;
console.log(`   stampe che hanno superato il touch di >=1 tick: ${oltre1}/${oltreTouch.length}   >=2 tick: ${oltre2}`);
const isto={};for(const d of dist){const k=Math.floor(d*2)/2;isto[k]=(isto[k]||0)+1}
console.log('istogramma distanza dal mid (¢, passo 0,5):',JSON.stringify(isto));

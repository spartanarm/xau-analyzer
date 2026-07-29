// ══════════════════════════════════════════════════════════════════
// ENGINE.JS — il "cervello" del motore XAU/USD Technical Analyzer,
// estratto da index.html (regione motore pura, righe 339-2117) e reso
// stabile in questo file separato.
//
// COSA CONTIENE: TUTTE le regole di trading costruite finora — qualità
// del setup (A+/A/B), stop loss strutturale, isteresi anti-flip-flop,
// lifecycle lock, anti-chase, radar delle opportunità, TP FAST,
// assegnazione tardiva del target. Nessuna di queste regole è stata
// toccata: questo file è un'estrazione automatica, non una riscrittura.
//
// COSA NON CONTIENE: nessun accesso a internet, nessun salvataggio dati,
// nessuna parte grafica. Prende candele (prezzi) in ingresso e restituisce
// un piano di trading in uscita — niente altro.
//
// COME SI VERIFICA CHE SIA IDENTICO: la stessa suite di 246 controlli
// automatici che abbiamo usato per ogni modifica del progetto viene
// eseguita anche su questo file. Se anche un solo controllo fallisse,
// il file NON verrebbe consegnato.
// ══════════════════════════════════════════════════════════════════

// candles: array oldest-first di {t(ms), o, h, l, c}
function computeTRs(cd){
  var trs=[];
  for(var i=0;i<cd.length;i++){
    if(i===0){trs.push(cd[i].h-cd[i].l);continue;}
    trs.push(Math.max(cd[i].h-cd[i].l, Math.abs(cd[i].h-cd[i-1].c), Math.abs(cd[i].l-cd[i-1].c)));
  }
  return trs;
}
function computeATR(cd, period){
  if(cd.length<period+1)return null;
  var trs=computeTRs(cd);
  var s=0;for(var i=trs.length-period;i<trs.length;i++)s+=trs[i];
  return s/period;
}
function classifyVolatility(cd, period){
  var atr=computeATR(cd,period);
  if(atr===null||cd.length<4)return{atr:null,recent:null,ratio:null,cls:'NA'};
  var trs=computeTRs(cd);
  var recent=(trs[trs.length-1]+trs[trs.length-2]+trs[trs.length-3])/3;
  var r=atr>0?recent/atr:1;
  var cls=r<0.7?'LOW':r<=1.3?'NORMAL':r<=2.0?'HIGH':'EXTREME';
  return{atr:atr,recent:recent,ratio:r,cls:cls};
}

// Swing detection oggettiva: estremo locale su k candele per lato.
// L'ultima candela (potenzialmente in formazione) non genera swing.
function findSwings(cd, k){
  var out=[];
  for(var i=k;i<cd.length-k-1;i++){
    var isH=true,isL=true;
    for(var j=1;j<=k;j++){
      if(cd[i].h<=cd[i-j].h||cd[i].h<=cd[i+j].h)isH=false;
      if(cd[i].l>=cd[i-j].l||cd[i].l>=cd[i+j].l)isL=false;
      if(!isH&&!isL)break;
    }
    if(isH)out.push({idx:i,price:cd[i].h,type:'H',t:cd[i].t});
    if(isL)out.push({idx:i,price:cd[i].l,type:'L',t:cd[i].t});
  }
  return out;
}

// Struttura: HH/HL/LH/LL + trend + BOS/CHoCH deterministici
function analyzeStructure(cd, swings){
  var highs=swings.filter(function(s){return s.type==='H';});
  var lows=swings.filter(function(s){return s.type==='L';});
  var labels=[];
  swings.slice(-6).forEach(function(s){
    if(s.type==='H'){
      var prev=null;
      for(var i=highs.length-1;i>=0;i--){if(highs[i].idx<s.idx){prev=highs[i];break;}}
      if(prev)labels.push(s.price>prev.price?'HH':'LH');
    }else{
      var prevL=null;
      for(var j=lows.length-1;j>=0;j--){if(lows[j].idx<s.idx){prevL=lows[j];break;}}
      if(prevL)labels.push(s.price>prevL.price?'HL':'LL');
    }
  });
  var trend='RANGE';
  if(highs.length>=2&&lows.length>=2){
    var hh=highs[highs.length-1].price>highs[highs.length-2].price;
    var hl=lows[lows.length-1].price>lows[lows.length-2].price;
    var lh=highs[highs.length-1].price<highs[highs.length-2].price;
    var ll=lows[lows.length-1].price<lows[lows.length-2].price;
    if(hh&&hl)trend='BULLISH';
    else if(lh&&ll)trend='BEARISH';
  }
  var lastClose=cd.length?cd[cd.length-1].c:null;
  var lastSwingHigh=highs.length?highs[highs.length-1].price:null;
  var lastSwingLow=lows.length?lows[lows.length-1].price:null;
  var lastEvent=null;
  if(lastClose!==null&&lastSwingHigh!==null&&lastSwingLow!==null){
    if(trend==='BULLISH'){
      if(lastClose>lastSwingHigh)lastEvent={type:'BOS',dir:'up',level:lastSwingHigh};
      else if(lastClose<lastSwingLow)lastEvent={type:'CHoCH',dir:'down',level:lastSwingLow};
    }else if(trend==='BEARISH'){
      if(lastClose<lastSwingLow)lastEvent={type:'BOS',dir:'down',level:lastSwingLow};
      else if(lastClose>lastSwingHigh)lastEvent={type:'CHoCH',dir:'up',level:lastSwingHigh};
    }else{
      if(lastClose>lastSwingHigh)lastEvent={type:'BOS',dir:'up',level:lastSwingHigh};
      else if(lastClose<lastSwingLow)lastEvent={type:'BOS',dir:'down',level:lastSwingLow};
    }
  }
  // STATO STRUTTURALE: distingue il trend (dagli swing) dall'ultimo evento.
  // INTACT = nessun evento; CONTINUATION = BOS a favore del trend;
  // TRANSITION = CHoCH contro il trend (possibile transizione/pullback,
  // il trend NON viene riclassificato automaticamente);
  // BREAKOUT = BOS da un range (rottura direzionale di un mercato laterale).
  var state='INTACT';
  if(lastEvent){
    if(lastEvent.type==='CHoCH')state='TRANSITION';
    else if(trend==='RANGE')state='BREAKOUT';
    else state='CONTINUATION';
  }
  return{trend:trend,labels:labels.slice(-4),lastEvent:lastEvent,state:state,
    lastSwingHigh:lastSwingHigh,lastSwingLow:lastSwingLow,
    swingHighs:highs,swingLows:lows,lastClose:lastClose};
}

// Filtro anti-rumore in stile zigzag: uno swing è strutturalmente
// significativo solo se dista dal precedente swing opposto almeno
// minMove (= swingAtrMult × ATR del timeframe). Tra swing consecutivi
// dello stesso tipo sopravvive il più estremo. minMove<=0 → filtro off.
function filterSwings(sw, minMove){
  if(!sw.length||!minMove||minMove<=0)return sw;
  var out=[];
  for(var i=0;i<sw.length;i++){
    var s=sw[i];
    if(!out.length){out.push(s);continue;}
    var last=out[out.length-1];
    if(s.type===last.type){
      if((s.type==='H'&&s.price>last.price)||(s.type==='L'&&s.price<last.price))out[out.length-1]=s;
    }else if(Math.abs(s.price-last.price)>=minMove){
      out.push(s);
    }
  }
  return out;
}
function buildTF(cd, cfgIn, kOverride){
  var C=cfgIn||cfg;
  var k=kOverride||C.swingK;
  if(!cd||cd.length<k*2+5)return{ok:false,reason:'candele insufficienti'};
  var atr=computeATR(cd,C.atrPeriod);
  var raw=findSwings(cd,k);
  var swings=(atr!==null&&C.swingAtrMult>0)?filterSwings(raw,C.swingAtrMult*atr):raw;
  var st=analyzeStructure(cd,swings);
  var vol=classifyVolatility(cd,C.atrPeriod);
  return{ok:true,swings:swings,structure:st,vol:vol,lastClose:st.lastClose,candles:cd};
}

// Zone S/R: cluster di livelli vicini; punteggio = pesi TF + tocchi
function clusterZones(points, tolPct, refPrice){
  if(!points.length)return[];
  var tol=refPrice*tolPct/100;
  var sorted=points.slice().sort(function(a,b){return a.price-b.price;});
  // Anti-chaining: un punto entra nel gruppo solo se dista <= tol dal
  // PRIMO punto del gruppo, non dall'ultimo. Larghezza zona <= tol garantita.
  var groups=[];var cur=[sorted[0]];
  for(var i=1;i<sorted.length;i++){
    if(sorted[i].price-cur[0].price<=tol)cur.push(sorted[i]);
    else{groups.push(cur);cur=[sorted[i]];}
  }
  groups.push(cur);
  return groups.map(function(g){
    var wsum=0,psum=0,tags={};
    g.forEach(function(p){wsum+=p.weight;psum+=p.price*p.weight;if(p.label)tags[p.label]=1;});
    var pxs=g.map(function(p){return p.price;});
    return{low:Math.min.apply(null,pxs),high:Math.max.apply(null,pxs),
      center:psum/wsum,score:wsum,touches:g.length,tags:Object.keys(tags)};
  });
}

// Liquidità: EQH/EQL, sweep/stop hunt, false breakout — pattern osservabili
function detectLiquidity(m15, h1, eqTolPct, refPrice){
  var out=[];
  var tol=refPrice*eqTolPct/100;
  var lastClose=m15.candles.length?m15.candles[m15.candles.length-1].c:refPrice;
  function posTxt(lv){ return lv>lastClose?' (sopra il prezzo attuale)':' (sotto il prezzo attuale)'; }
  // ── Equal H/L con STATO. La liquidità di un EQL sta SOTTO i minimi;
  // quella di un EQH sta SOPRA i massimi. Regole (nessun look-ahead:
  // solo candele già chiuse, successive alla formazione della coppia):
  //   INVALIDATO: una chiusura ha attraversato il livello (EQL: close<lv,
  //     EQH: close>lv) → la liquidità è stata consumata dal passaggio
  //     del prezzo → NON viene più mostrato.
  //   SWEPT: solo wick oltre il livello con chiusure rientrate → mostrato
  //     come "liquidità probabilmente già raccolta (sweep)".
  //   ATTIVO: il prezzo non ha mai superato il livello dopo la formazione.
  //   NON RILEVANTE: livello distante oltre 1.5% dal prezzo → scartato.
  function eqScan(swings,candles,type,tag){
    var pts=swings.filter(function(s){return s.type===type;}).slice(-8);
    // coppia più RECENTE valida (scansione dal fondo)
    for(var i=pts.length-1;i>=1;i--)for(var j=i-1;j>=0;j--){
      if(Math.abs(pts[i].price-pts[j].price)>tol)continue;
      var lv=(pts[i].price+pts[j].price)/2;
      if(Math.abs(lv-lastClose)>refPrice*0.015)continue; // non più rilevante
      var formIdx=Math.max(pts[i].idx,pts[j].idx);
      var status='ACTIVE';
      if(candles&&candles.length){
        for(var q=formIdx+1;q<candles.length;q++){
          if(tag==='EQL'){
            if(candles[q].c<lv){status='INVALID';break;}
            if(candles[q].l<lv)status='SWEPT';
          }else{
            if(candles[q].c>lv){status='INVALID';break;}
            if(candles[q].h>lv)status='SWEPT';
          }
        }
      }
      if(status==='INVALID')return; // attraversato: mai mostrato come attivo
      var base=(tag==='EQH'?'Equal Highs':'Equal Lows')+' ~'+lv.toFixed(2)+' (H1)'+posTxt(lv);
      var desc=status==='SWEPT'
        ?': livelli quasi identici già perforati da uno spike — liquidità probabilmente già raccolta (sweep avvenuto, pattern osservabile).'
        :': livelli quasi identici ancora intatti — area dove tipicamente si accumulano stop (pattern osservabile).';
      out.push({tag:tag,level:lv,status:status,text:base+desc});
      return;
    }
  }
  eqScan(h1.swings,h1.candles,'H','EQH');eqScan(h1.swings,h1.candles,'L','EQL');
  var cd=m15.candles, sw=m15.swings;
  // Sweep: solo nelle ultime 6 candele E solo se il pattern non è stato
  // superato dal prezzo (se il prezzo ha poi rotto il livello nella
  // direzione dello spike, lo sweep non è più un'informazione valida).
  var start=Math.max(1,cd.length-6);
  for(var x=cd.length-1;x>=start;x--){
    var c=cd[x];
    var priorH=null,priorL=null;
    for(var i2=sw.length-1;i2>=0;i2--){
      if(sw[i2].idx<x){ if(!priorH&&sw[i2].type==='H')priorH=sw[i2]; if(!priorL&&sw[i2].type==='L')priorL=sw[i2]; }
      if(priorH&&priorL)break;
    }
    if(priorH&&c.h>priorH.price&&c.c<priorH.price&&lastClose<=priorH.price){
      out.push({tag:'SWEEP',level:priorH.price,text:'Possibile liquidity sweep / stop hunt sopra '+priorH.price.toFixed(2)+' (M15): spike oltre lo swing high e chiusura sotto il livello.'});
      break;
    }
    if(priorL&&c.l<priorL.price&&c.c>priorL.price&&lastClose>=priorL.price){
      out.push({tag:'SWEEP',level:priorL.price,text:'Possibile liquidity sweep / stop hunt sotto '+priorL.price.toFixed(2)+' (M15): spike oltre lo swing low e chiusura sopra il livello.'});
      break;
    }
  }
  // False breakout: chiusura oltre uno swing high/low, poi rientro entro 3 candele
  var swH=sw.filter(function(s){return s.type==='H';});
  var swL=sw.filter(function(s){return s.type==='L';});
  var found=false;
  for(var y=cd.length-13;y<cd.length-1&&!found;y++){
    if(y<1)continue;
    for(var z=swH.length-1;z>=0&&!found;z--){
      var lv2=swH[z];if(lv2.idx>=y)continue;
      if(cd[y].c>lv2.price&&cd[y-1].c<=lv2.price&&lastClose<=lv2.price){
        for(var w=y+1;w<=Math.min(y+3,cd.length-1);w++){
          if(cd[w].c<lv2.price){
            out.push({tag:'FBK',level:lv2.price,text:'False breakout sopra '+lv2.price.toFixed(2)+' (M15): chiusura oltre il livello, rientro entro '+(w-y)+' candele.'});
            found=true;break;
          }
        }
      }
    }
    for(var z2=swL.length-1;z2>=0&&!found;z2--){
      var lv3=swL[z2];if(lv3.idx>=y)continue;
      if(cd[y].c<lv3.price&&cd[y-1].c>=lv3.price&&lastClose>=lv3.price){
        for(var w2=y+1;w2<=Math.min(y+3,cd.length-1);w2++){
          if(cd[w2].c>lv3.price){
            out.push({tag:'FBK',level:lv3.price,text:'False breakout sotto '+lv3.price.toFixed(2)+' (M15): chiusura oltre il livello, rientro entro '+(w2-y)+' candele.'});
            found=true;break;
          }
        }
      }
    }
  }
  return out.slice(0,4);
}

// Bias multi-timeframe. Regole:
// - contributo = peso TF × direzione trend; DIMEZZATO se lo stato del TF
//   è TRANSITION (CHoCH contro trend: il trend non viene ignorato né
//   ribaltato, ma la sua affidabilità è ridotta del 50%).
// - MIXED se il setup (M15) o la conferma (M5) vanno contro il contesto H4.
// - La nota è COSTRUITA dinamicamente dalla gerarchia reale
//   (H4=contesto, H1=struttura, M15=setup, M5=conferma), mai hardcoded.
function stateLabel(st){
  return st==='TRANSITION'?'CHoCH contro trend — possibile transizione':
         st==='CONTINUATION'?'BOS a favore':
         st==='BREAKOUT'?'break del range':'';
}
function combineBias(tf){
  var W={h4:3,h1:2,m15:1,m5:1};
  function dir(t){return t==='BULLISH'?1:t==='BEARISH'?-1:0;}
  function trWord(t){return t==='BULLISH'?'rialzista':t==='BEARISH'?'ribassista':'in range';}
  var reasons=[],score=0,avail=0;
  ['h4','h1','m15','m5'].forEach(function(k){
    var a=tf[k];
    if(!a||!a.ok){reasons.push({tf:k.toUpperCase(),text:'dati non disponibili'});return;}
    avail++;
    var t=a.structure.trend;
    var mult=a.structure.state==='TRANSITION'?0.5:1;
    score+=dir(t)*W[k]*mult;
    var lbl=a.structure.labels.join('·')||'—';
    var stl=stateLabel(a.structure.state);
    var ev=a.structure.lastEvent?(' · '+a.structure.lastEvent.type+' '+(a.structure.lastEvent.dir==='up'?'▲':'▼')+' @'+a.structure.lastEvent.level.toFixed(2)+(stl?' ('+stl+')':'')):'';
    reasons.push({tf:k.toUpperCase(),text:t.toLowerCase()+' ('+lbl+')'+ev});
  });
  if(avail===0)return{bias:'NA',reasons:reasons,note:null,score:0};
  var h4d=tf.h4&&tf.h4.ok?dir(tf.h4.structure.trend):0;
  var h1d=tf.h1&&tf.h1.ok?dir(tf.h1.structure.trend):0;
  var m15d=tf.m15&&tf.m15.ok?dir(tf.m15.structure.trend):0;
  var m5d=tf.m5&&tf.m5.ok?dir(tf.m5.structure.trend):0;
  var m15Opp=h4d!==0&&m15d===-h4d;
  var m5Opp=h4d!==0&&m5d===-h4d;
  // Bias pieno solo se il contesto H4 conferma la direzione dello score.
  // Direzione che nasce SOLO dai TF minori (H4 in range) → bias CONDIZIONALE
  // (NEUTRAL-BULLISH / NEUTRAL-BEARISH): la gerarchia pesa H4/H1 sopra M15/M5.
  var bias;
  if(m15Opp||m5Opp)bias='MIXED';
  else if(score>=2)bias=h4d>0?'BULLISH':'BULLISH_COND';
  else if(score<=-2)bias=h4d<0?'BEARISH':'BEARISH_COND';
  else bias='NEUTRAL';
  // ── Nota dinamica dalla gerarchia reale ──
  var note=null;
  var h4Trans=tf.h4&&tf.h4.ok&&tf.h4.structure.state==='TRANSITION';
  var isCond=bias==='BULLISH_COND'||bias==='BEARISH_COND';
  if(bias==='MIXED'||h4Trans||isCond){
    var parts=[];
    if(tf.h4&&tf.h4.ok)parts.push('Contesto H4 '+trWord(tf.h4.structure.trend)+(h4Trans?' (ma CHoCH contro trend: possibile transizione)':''));
    if(tf.h1&&tf.h1.ok)parts.push('struttura H1 '+trWord(tf.h1.structure.trend));
    if(tf.m15&&tf.m15.ok)parts.push('setup M15 '+trWord(tf.m15.structure.trend));
    if(tf.m5&&tf.m5.ok)parts.push('conferma M5 '+trWord(tf.m5.structure.trend));
    var desc=parts.join(', ')+'.';
    var concl='';
    if(m15Opp)concl=' Il setup M15 va contro il contesto H4: possibile correzione contro trend, non un\'inversione confermata.';
    else if(m5Opp)concl=' Solo la conferma di breve (M5) mostra pressione contraria: manca la conferma multi-timeframe per un setup.';
    else if(h4d!==0&&h1d===-h4d)concl=' La struttura H1 diverge dal contesto H4: attendere riallineamento.';
    else if(h4Trans)concl=' Il CHoCH su H4 mette in discussione il trend principale senza ancora invertirlo.';
    else if(isCond)concl=' Bias CONDIZIONALE: la direzione nasce dai timeframe minori (H1/M5) senza conferma del contesto H4 — affidabilità ridotta.';
    note=desc+concl;
  }
  return{bias:bias,reasons:reasons,note:note,score:score};
}

// Scenari condizionali costruiti sui livelli calcolati (mai hardcoded)
function buildScenarios(price, res, sup){
  var r1=res[0]||null,r2=res[1]||null,s1=sup[0]||null,s2=sup[1]||null;
  var bull=null,bear=null,bullInv=null,bearInv=null;
  if(r1&&s1){
    bull='Se XAU/USD tiene sopra <b>'+s1.center.toFixed(2)+'</b> e rompe <b>'+r1.high.toFixed(2)+'</b> con chiusura confermata → possibile estensione verso <b>'+(r2?r2.center.toFixed(2):'il massimo di periodo')+'</b>.';
    bullInv='Invalidazione: chiusura sotto '+s1.low.toFixed(2);
    bear='Se XAU/USD perde <b>'+s1.low.toFixed(2)+'</b> con chiusura sotto → possibile continuazione verso <b>'+(s2?s2.center.toFixed(2):'il minimo di periodo')+'</b>.';
    bearInv='Invalidazione: chiusura sopra '+r1.high.toFixed(2);
  }
  return{bull:bull,bear:bear,bullInv:bullInv,bearInv:bearInv};
}

// Setup potenziale — mai apertura automatica di trade. TRE stati:
//   LONG / SHORT   = confluenza presente (bias direzionale + prezzo in zona)
//   WAIT_CONFIRM   = direzione potenziale identificata, ma manca una conferma
//                    SPECIFICA (elencata con livelli reali dal grafico)
//   NONE           = NO CLEAR SETUP: struttura realmente confusa o nessun
//                    vantaggio tecnico. Regole:
//   - m15 contro h4  → conflitto reale → NONE
//   - h4 direzionale + m15 allineato/range + solo M5 contro → WAIT_CONFIRM
//   - bias direzionale ma prezzo lontano dalle zone → WAIT_CONFIRM (pullback o rottura)
//   - NEUTRAL / dati mancanti → NONE
function buildSetup(bias, tf, price, res, sup, atrH1){
  if(atrH1===null||price===null)return{type:'NONE',reason:'Dati insufficienti per valutare un setup.'};
  function d(k){var a=tf&&tf[k];return a&&a.ok?(a.structure.trend==='BULLISH'?1:a.structure.trend==='BEARISH'?-1:0):0;}
  var h4d=d('h4'),m15d=d('m15'),m5d=d('m5');
  var s1=sup[0]||null,r1=res[0]||null;
  var m15=tf&&tf.m15&&tf.m15.ok?tf.m15.structure:null;
  // REGOLA TARGET: un target LONG deve stare SOPRA il livello di conferma,
  // uno SHORT SOTTO. Si sceglie la prima zona tecnica valida OLTRE la
  // conferma nella direzione del trade; se non esiste → null (nessun
  // target tecnico valido, R/R non calcolabile).
  function tgtsAbove(lv){ var o=[]; if(lv===null||lv===undefined)return o; for(var i=0;i<res.length;i++){ if(res[i].center>lv)o.push(res[i].center); } return o; }
  function tgtsBelow(lv){ var o=[]; if(lv===null||lv===undefined)return o; for(var i=0;i<sup.length;i++){ if(sup[i].center<lv)o.push(sup[i].center); } return o; }
  function tgtAbove(lv){ var o=tgtsAbove(lv); return o.length?o[0]:null; }
  function tgtBelow(lv){ var o=tgtsBelow(lv); return o.length?o[0]:null; }
  function tgt2Above(lv){ var o=tgtsAbove(lv); return o.length>1?o[1]:null; }
  function tgt2Below(lv){ var o=tgtsBelow(lv); return o.length>1?o[1]:null; }
  var isBull=bias==='BULLISH'||bias==='BULLISH_COND';
  var isBear=bias==='BEARISH'||bias==='BEARISH_COND';

  // ── Setup completo: bias direzionale + prezzo in zona ──
  if(isBull&&s1&&Math.abs(price-s1.center)<=0.6*atrH1){
    var confL=m15&&m15.lastSwingHigh?m15.lastSwingHigh:(r1?r1.low:null);
    return{type:'LONG',zone:s1,confirm:confL,condBias:bias!=='BULLISH',
      invalid:s1.low-0.2*atrH1,target:tgtAbove(confL),target2:tgt2Above(confL),
      note:'Prezzo in zona di supporto con bias rialzista. Conferma: rottura dell\'ultimo swing high M15.'};
  }
  if(isBear&&r1&&Math.abs(price-r1.center)<=0.6*atrH1){
    var confS=m15&&m15.lastSwingLow?m15.lastSwingLow:(s1?s1.high:null);
    return{type:'SHORT',zone:r1,confirm:confS,condBias:bias!=='BEARISH',
      invalid:r1.high+0.2*atrH1,target:tgtBelow(confS),target2:tgt2Below(confS),
      note:'Prezzo in zona di resistenza con bias ribassista. Conferma: rottura dell\'ultimo swing low M15.'};
  }

  // ── Conflitto reale: il setup M15 va contro il contesto H4 → NONE ──
  if(h4d!==0&&m15d===-h4d){
    return{type:'NONE',reason:'Il setup M15 va contro il contesto H4: struttura in conflitto reale, nessun vantaggio tecnico chiaro.'};
  }

  // ── Direzione potenziale dal contesto: manca solo la conferma di breve ──
  if(h4d!==0&&(m15d===h4d||m15d===0)&&m5d===-h4d){
    var isL=h4d>0;
    var conds=[];
    var confirmLv=m15?(isL?m15.lastSwingHigh:m15.lastSwingLow):null;
    if(confirmLv!==null&&confirmLv!==undefined)conds.push((isL?'Chiusura M15 sopra l\'ultimo swing high ':'Chiusura M15 sotto l\'ultimo swing low ')+confirmLv.toFixed(2));
    conds.push('M5 che torni '+(isL?'rialzista':'ribassista')+' (attualmente contrario)');
    var invalidLv=m15?(isL?m15.lastSwingLow:m15.lastSwingHigh):null;
    return{type:'WAIT_CONFIRM',dir:isL?'LONG':'SHORT',conditions:conds,
      confirm:(confirmLv!==null&&confirmLv!==undefined)?confirmLv:null,zone:null,
      invalid:(invalidLv!==null&&invalidLv!==undefined)?invalidLv:null,
      target:isL?tgtAbove(confirmLv):tgtBelow(confirmLv),
      target2:isL?tgt2Above(confirmLv):tgt2Below(confirmLv),
      note:'Direzione potenziale dal contesto H4 '+(isL?'rialzista':'ribassista')+': manca solo la conferma di breve periodo (M5 attualmente contrario).'};
  }

  // ── Bias direzionale ma prezzo lontano dalle zone → attendere condizioni ──
  if(isBull||isBear){
    var isL2=isBull;
    var conds2=[];
    var zone=isL2?s1:r1;
    if(zone)conds2.push('Pullback verso la zona '+zone.low.toFixed(2)+'\u2013'+zone.high.toFixed(2));
    var brk=isL2?(r1?r1.high:null):(s1?s1.low:null);
    if(brk!==null)conds2.push('Oppure rottura confermata (chiusura) '+(isL2?'sopra ':'sotto ')+brk.toFixed(2));
    if(!conds2.length)return{type:'NONE',reason:'Bias direzionale ma nessuna zona tecnica di riferimento disponibile.'};
    return{type:'WAIT_CONFIRM',dir:isL2?'LONG':'SHORT',conditions:conds2,
      confirm:brk,zone:zone||null,
      invalid:zone?(isL2?zone.low-0.2*atrH1:zone.high+0.2*atrH1):null,
      target:isL2?tgtAbove(brk):tgtBelow(brk),
      target2:isL2?tgt2Above(brk):tgt2Below(brk),condBias:bias.indexOf('_COND')>=0,
      note:'Bias '+bias+' ma prezzo lontano dalle zone di interesse: nessun ingresso a mercato, attendere una delle condizioni sopra.'};
  }

  var reason=bias==='MIXED'?'Timeframe in conflitto senza una direzione potenziale sfruttabile.':
    bias==='NEUTRAL'?'Bias NEUTRAL: nessuna direzione dominante.':
    'Dati non disponibili.';
  return{type:'NONE',reason:reason};
}

// ══════════════════════════════════════════════════════════════════
// SETUP LIFECYCLE TRACKER — funzione PURA, persistita fuori (localStorage).
// Stati: PENDING → ACTIVATED ⇄ RETEST → TARGET_HIT | INVALIDATED
//        PENDING → INVALIDATED | EXPIRED (tempo o struttura cambiata)
// Regole dichiarate:
// - Attivazione SOLO su CHIUSURA della candela M15 oltre il livello di
//   conferma (mai il semplice superamento intrabar) e con M5 non opposto.
// - Un setup ATTIVATO vive sui propri livelli congelati: le nuove proposte
//   del motore NON lo resettano (persistenza tra i refresh).
// - Invalidazione: chiusura M15 oltre il livello (coerente con gli scenari).
// - Target: raggiunto anche intrabar (i target si toccano, non si chiudono).
// - Ingresso tardivo: R/R residuo dal prezzo attuale < 1 → flag esplicito.
// - PENDING scade dopo 120 min senza attivazione o se la struttura cambia.
// - Dopo uno stato terminale, la stessa identica proposta è soppressa per
//   60 min (nessuna risurrezione immediata); una proposta diversa sostituisce.
var SETUP_RULES={pendingMaxAgeMs:120*60000,retestBandAtr:0.25,lateRR:1.0,terminalCooldownMs:60*60000,confirmTfMs:15*60000,confirmM5Ms:5*60000,slBufferAtr:0.2,minStopAtr:1.0,directLimitMinScore:4,directLimitMinTouches:2,
  // SWEEP vs BREAK STRUTTURALE (pattern tecnico osservabile, niente narrativa):
  // penetrazione oltre l'invalidazione < sweepDepthAtr×ATR con retest già
  // toccato = possibile sweep (tollerato, in attesa di reclaim); penetrazione
  // profonda o nessun reclaim entro sweepMaxWaitMs = break strutturale.
  sweepDepthAtr:0.5,sweepMaxWaitMs:60*60000,sweepMarkAtr:0.15,noChaseAtr:1.2,
  // OPPORTUNITY RADAR: distanza massima zona-prezzo per uno scenario (×ATR),
  // soglia APPROACHING, età massima, cooldown anti-ricreazione post-terminale,
  // blocco MARKET sotto zona contraria forte (normalizzato ATR), floor R/R
  // ASSOLUTO sotto il quale nessun trade è mai valido.
  radarMaxDistAtr:3.0,radarApproachAtr:1.0,radarMaxAgeMs:4*60*60000,radarCooldownMs:30*60000,marketBlockAtr:0.8,rrFloor:1.25};

function proposalToTracker(p, now){
  if(!p||(p.type!=='LONG'&&p.type!=='SHORT'&&p.type!=='WAIT_CONFIRM'))return null;
  var dir=p.type==='WAIT_CONFIRM'?p.dir:p.type;
  var confirm=(p.confirm!==null&&p.confirm!==undefined)?p.confirm:null;
  var invalid=(p.invalid!==null&&p.invalid!==undefined)?p.invalid:null;
  if(confirm===null||invalid===null)return null; // non tracciabile senza livelli oggettivi
  var isL=dir==='LONG';
  // Invalidazione dal lato sbagliato → proposta incoerente: scartata
  if(isL?invalid>=confirm:invalid<=confirm)return null;
  // Target dal lato sbagliato rispetto all'attivazione → MAI usato
  var t1=(p.target!==null&&p.target!==undefined)?p.target:null;
  if(t1!==null&&(isL?t1<=confirm:t1>=confirm))t1=null;
  var t2=(p.target2!==null&&p.target2!==undefined)?p.target2:null;
  if(t2!==null&&(t1===null||(isL?t2<=t1:t2>=t1)))t2=null;
  return{id:'S'+now.toString(36)+'-'+Math.floor(Math.random()*46656).toString(36),
    key:dir+'|'+confirm.toFixed(2)+'|'+invalid.toFixed(2),dir:dir,prevState:null,
    zone:p.zone||null,confirm:confirm,invalid:invalid,
    target:t1,target2:t2,condBias:!!p.condBias,
    state:'PENDING',createdAt:now,activatedAt:null,activationClose:null,
    rrAtActivation:null,lateFlag:false,marketExpired:false,retest:null,note:null,outcome:null,terminalAt:null};
}

// Ripara tracker persistiti da versioni precedenti (target dal lato sbagliato)
function sanitizeTracker(t){
  if(!t)return null;
  var isL=t.dir==='LONG';
  if(t.target!==null&&t.target!==undefined&&(isL?t.target<=t.confirm:t.target>=t.confirm)){
    t=Object.assign({},t);
    t.target=(t.target2!==undefined&&t.target2!==null&&(isL?t.target2>t.confirm:t.target2<t.confirm))?t.target2:null;
    t.target2=null;t.rrAtActivation=null;t.lateFlag=false;
    t.note=(t.note?t.note+' ':'')+'Target originario rimosso: era dal lato sbagliato rispetto all\'attivazione.';
  }
  if(t.marketExpired===undefined){t=Object.assign({},t);t.marketExpired=false;}
  if(t.retest===undefined){t=Object.assign({},t);t.retest=null;}
  if(!t.id){t=Object.assign({},t);t.id='S'+Date.now().toString(36)+'-legacy';}
  if(t.prevState===undefined){t=Object.assign({},t);t.prevState=null;}
  return t;
}

function endTracker(prev,now,outcome,note){
  var t=Object.assign({},prev);
  t.prevState=prev.state;
  t.state=outcome;t.outcome=outcome;t.terminalAt=now;t.note=note;
  if(t.retest)t.retest=Object.assign({},t.retest,{timeline:tlPush(t.retest.timeline,outcome,now)});
  return t;
}

// ctx = { now, price|null, m15Closed:{c,t}|null (ultima M15 CHIUSA), m5Dir:1|-1|0|null, atrH1|null }
function advanceSetup(prev, proposal, ctx){
  var now=ctx.now;
  prev=sanitizeTracker(prev);
  var cand=proposalToTracker(proposal, now);
  // STATO TERMINALE = DEFINITIVO per quel setupId: il tracker terminale non
  // transita MAI verso stati operativi. Può solo essere SOSTITUITO da una
  // NUOVA istanza (nuovo id, nuovo createdAt, lifecycle azzerato) quando il
  // motore rileva una NUOVA opportunità:
  //   - direzione opposta → subito;
  //   - stessa direzione ma conferma lontana >1×ATR dal setup terminato → subito;
  //   - altrimenti solo a cooldown scaduto (niente cloni ravvicinati).
  if(prev&&prev.terminalAt){
    var cooled=now-prev.terminalAt>SETUP_RULES.terminalCooldownMs;
    if(cand){
      if(cand.dir!==prev.dir)return cand;
      if(cooled)return cand;
      var farNew=ctx.atrH1?Math.abs(cand.confirm-prev.confirm)>1.0*ctx.atrH1:false;
      if(farNew)return cand;
      return prev; // stessa opportunità appena terminata: nessuna resurrezione
    }
    if(cooled)return null;
    return prev;
  }
  if(!prev)return cand;

  if(prev.state==='PENDING'){
    if(!cand)return endTracker(prev,now,'EXPIRED','Struttura cambiata prima dell\'attivazione: setup eliminato e in ricalcolo.');
    if(cand.key!==prev.key){
      var moved=ctx.atrH1?Math.abs(cand.confirm-prev.confirm)>0.3*ctx.atrH1:true;
      if(cand.dir!==prev.dir||moved)return cand; // sostituito da un setup materialmente diverso
    }
    if(now-prev.createdAt>SETUP_RULES.pendingMaxAgeMs)
      return endTracker(prev,now,'EXPIRED','Tempo massimo senza attivazione superato: setup scaduto, in ricalcolo.');
    if(prev.retest&&prev.retest.swept&&!prev.retest.confirmed&&now-prev.retest.sweptAt>SETUP_RULES.sweepMaxWaitMs)
      return endTracker(prev,now,'INVALIDATED','Sweep senza reclaim entro la finestra: break strutturale confermato.');
    var cc=ctx.m15Closed;
    if(cc){
      var isL=prev.dir==='LONG';
      if(isL?cc.c<prev.invalid:cc.c>prev.invalid){
        // SWEEP vs BREAK: se il retest è già stato TOCCATO e la penetrazione
        // oltre l'invalidazione è modesta (< sweepDepthAtr×ATR), il pattern
        // può essere uno sweep di liquidità: si tollera in attesa del
        // reclaim. Penetrazione profonda = break strutturale → INVALIDATED.
        var pen=Math.abs(cc.c-prev.invalid);
        var deep=ctx.atrH1?pen>=SETUP_RULES.sweepDepthAtr*ctx.atrH1:true;
        var inRetest=prev.retest&&prev.retest.touched&&!prev.retest.confirmed;
        if(inRetest&&!deep){
          if(!prev.retest.swept){
            var nsw=Object.assign({},prev);
            nsw.retest=Object.assign({},prev.retest,{swept:true,sweptAt:cc.t+SETUP_RULES.confirmTfMs,sweptClose:cc.c});
            nsw.note='Penetrazione modesta oltre l\'invalidazione con retest già toccato: possibile SWEEP — in attesa di reclaim (finestra '+(SETUP_RULES.sweepMaxWaitMs/60000)+' min).';
            return nsw;
          }
          if(now-prev.retest.sweptAt>SETUP_RULES.sweepMaxWaitMs)
            return endTracker(prev,now,'INVALIDATED','Nessun reclaim entro la finestra sweep: break strutturale confermato oltre '+prev.invalid.toFixed(2)+'.');
          return prev;
        }
        return endTracker(prev,now,'INVALIDATED','Invalidazione raggiunta prima dell\'attivazione: chiusura M15 oltre '+prev.invalid.toFixed(2)+(deep?' (break strutturale, penetrazione '+pen.toFixed(2)+'$)':'')+'.');
      }
      var confOk=isL?cc.c>prev.confirm:cc.c<prev.confirm;
      var m5ok=ctx.m5Dir===undefined||ctx.m5Dir===null||ctx.m5Dir!==(isL?-1:1);
      // COERENZA TEMPORALE: la candela di conferma deve CHIUDERE dopo la
      // creazione del setup — mai attivazioni retroattive su conferme
      // già avvenute prima che il setup esistesse.
      var freshCc=(cc.t+SETUP_RULES.confirmTfMs)>=prev.createdAt;
      if(confOk&&m5ok&&freshCc){
        var nx=Object.assign({},prev);
        nx.prevState=prev.state;
        nx.state='ACTIVATED';nx.activatedAt=cc.t;nx.activationClose=cc.c;
        // Target già raggiunto/superato durante la conferma → consumato,
        // MAI riutilizzato: si promuove TP2 se valido, altrimenti nessun target.
        if(nx.target!==null){
          var consumed=isL?(cc.c>=nx.target||(ctx.price!==null&&ctx.price!==undefined&&ctx.price>=nx.target))
                          :(cc.c<=nx.target||(ctx.price!==null&&ctx.price!==undefined&&ctx.price<=nx.target));
          if(consumed){
            nx.target=(nx.target2!==null&&nx.target2!==undefined)?nx.target2:null;
            nx.target2=null;
            nx.note='Target originario già raggiunto durante la conferma: consumato, non riutilizzato.'+(nx.target===null?' NESSUN TARGET TECNICO VALIDO.':' Promosso il target successivo.');
          }
        }
        if(nx.target!==null){
          var risk=Math.abs(nx.confirm-nx.invalid);
          nx.rrAtActivation=risk>0?Math.abs(nx.target-nx.confirm)/risk:null;
          if(ctx.price!==null&&ctx.price!==undefined){
            var rem=Math.abs(nx.target-ctx.price), rk=Math.abs(ctx.price-nx.invalid);
            nx.lateFlag=(rk>0&&rem/rk<SETUP_RULES.lateRR)||(nx.rrAtActivation!==null&&nx.rrAtActivation<SETUP_RULES.lateRR);
          }
        }else{nx.rrAtActivation=null;nx.lateFlag=false;}
        return nx;
      }
    }
    return prev; // il prezzo può anche essere oltre il livello: senza CHIUSURA resta in attesa
  }

  // ACTIVATED / RETEST
  var isL2=prev.dir==='LONG';
  var cc2=ctx.m15Closed;
  if(cc2&&(isL2?cc2.c<prev.invalid:cc2.c>prev.invalid))
    return endTracker(prev,now,'INVALIDATED','Chiusura M15 oltre l\'invalidazione '+prev.invalid.toFixed(2)+(prev.state==='RETEST'?' durante il retest: livello perso.':'.'));
  if(prev.target!==null&&ctx.price!==null&&ctx.price!==undefined&&(isL2?ctx.price>=prev.target:ctx.price<=prev.target))
    return endTracker(prev,now,'TARGET_HIT','Target tecnico '+prev.target.toFixed(2)+' raggiunto.');
  var nx2=Object.assign({},prev);
  if(ctx.atrH1&&ctx.price!==null&&ctx.price!==undefined){
    var band=SETUP_RULES.retestBandAtr*ctx.atrH1;
    var nearLevel=Math.abs(ctx.price-prev.confirm)<=band||(prev.zone&&ctx.price>=prev.zone.low-band&&ctx.price<=prev.zone.high+band);
    var newSt=nearLevel?'RETEST':'ACTIVATED';
    if(newSt!==prev.state)nx2.prevState=prev.state;
    nx2.state=newSt;
    if(nx2.target!==null){
      var rem2=Math.abs(nx2.target-ctx.price), rk2=Math.abs(ctx.price-nx2.invalid);
      nx2.lateFlag=rk2>0&&rem2/rk2<SETUP_RULES.lateRR;
    }
  }
  return nx2;
}

// ══════════════════════════════════════════════════════════════════
// REPLAY (no look-ahead): tiene SOLO le candele completamente CHIUSE
// prima dell'istante ts. La candela che contiene ts è in formazione a
// quell'istante → esclusa. Nessun dato futuro può entrare nel motore.
function sliceClosedCandles(cd, ts, tfMs){
  if(!cd)return [];
  return cd.filter(function(k){ return k.t+tfMs<=ts; });
}

// VALIDAZIONE: rileva le transizioni del tracker da registrare nel
// registro segnali (separato dal motore, mai retroattivo sui segnali).
function detectSignalEvent(prev, next){
  if(!next)return null;
  if(next.state==='ACTIVATED'&&(!prev||prev.terminalAt||prev.key!==next.key||prev.state==='PENDING'))
    return prev&&prev.key===next.key&&prev.state==='PENDING'?'ACTIVATED':null;
  if(prev&&prev.key===next.key&&!prev.terminalAt&&next.terminalAt)return 'TERMINAL';
  return null;
}

// DEBUG: spiega PERCHÉ di ogni classificazione, usando solo i dati
// già calcolati dal motore (nessuna logica nuova: pura esposizione).
function buildDebugLines(core, plan){
  var L=[];
  var W={h4:3,h1:2,m15:1,m5:1};
  ['h4','h1','m15','m5'].forEach(function(k){
    var a=core.tf[k];
    if(!a||!a.ok){L.push(k.toUpperCase()+': dati non disponibili ('+(a&&a.reason?a.reason:'—')+').');return;}
    var st=a.structure;
    var hs=st.swingHighs.slice(-2).map(function(s){return s.price.toFixed(2);});
    var ls=st.swingLows.slice(-2).map(function(s){return s.price.toFixed(2);});
    var why=st.trend==='RANGE'
      ?'perché gli ultimi swing non formano né HH+HL né LH+LL'
      :'perché swing high '+hs.join('→')+' e swing low '+ls.join('→');
    var evTxt=st.lastEvent
      ?(st.lastEvent.type+' '+(st.lastEvent.dir==='up'?'▲':'▼')+' perché close '+(st.lastClose!==null?st.lastClose.toFixed(2):'—')+(st.lastEvent.dir==='up'?' > ':' < ')+'swing '+st.lastEvent.level.toFixed(2)+' → stato '+st.state)
      :'nessun BOS/CHoCH: close dentro la struttura';
    L.push(k.toUpperCase()+' '+st.trend+' '+why+' ('+st.labels.join('·')+'). '+evTxt+'.');
  });
  var contrib=['h4','h1','m15','m5'].map(function(k){
    var a=core.tf[k];
    if(!a||!a.ok)return k.toUpperCase()+'=n.d.';
    var d=a.structure.trend==='BULLISH'?1:a.structure.trend==='BEARISH'?-1:0;
    var m=a.structure.state==='TRANSITION'?0.5:1;
    return k.toUpperCase()+'='+(d*W[k]*m);
  }).join(', ');
  L.push('BIAS '+core.bias.bias+' perché score = '+contrib+' → totale '+core.bias.score+(core.bias.note?' · '+core.bias.note:''));
  if(plan)L.push('PLAN '+plan.action+'/'+plan.status+(plan.orderType?'/'+plan.orderType:'')+
    (plan.quality?(' · quality '+(plan.quality.grade||'—')+' conf '+plan.quality.confidence+'/100 · rr richiesto '+(plan.requiredRR!==null?plan.requiredRR.toFixed(2):'—')):'')+
    ' perché: '+plan.reason);
  if(plan&&plan.tracker&&plan.tracker.retest&&plan.tracker.retest.timeline&&plan.tracker.retest.timeline.length){
    var tlr=plan.tracker.retest.timeline;
    L.push('TIMELINE: '+tlr.map(function(e){
      var hh=(e.at!==null&&e.at!==undefined)?new Date(e.at).toISOString().slice(11,16)+'Z':'';
      return e.st+(hh?(' '+hh):'');
    }).join(' \u2192 '));
  }
  if(plan&&plan.stability){
    var sb=plan.stability;
    L.push('SETUP CONTINUITY: prev '+(sb.prevMode||'\u2014')+'/'+(sb.prevConf!==null&&sb.prevConf!==undefined?sb.prevConf:'\u2014')+
      ' \u00b7 raw '+(sb.rawMode||plan.executionMode)+(plan.quality&&plan.quality.raw?('/'+plan.quality.raw.confidence):'')+
      ' \u00b7 stabilized '+plan.executionMode+'/'+(plan.quality?plan.quality.confidence:'\u2014')+
      ' \u00b7 newEvidence='+!!sb.newEvidence+
      (sb.evidence&&sb.evidence.length?(' ['+sb.evidence.join('; ')+']'):'')+
      (sb.reason?(' \u00b7 '+sb.reason):'')+(sb.upgradeReason?(' \u00b7 '+sb.upgradeReason):''));
  }
  if(plan&&plan.directChecklist){
    var dc=plan.directChecklist;
    L.push('DIRECT LIMIT CHECKLIST:');
    L.push('  zoneKind='+dc.zoneKind+' (ZONE richiesto) \u2192 '+dc.zoneKindOk);
    L.push('  zoneScore='+dc.zoneScore+' \u2265 '+dc.zoneScoreThreshold+' \u2192 '+dc.zoneScoreOk);
    L.push('  zoneTouches='+dc.zoneTouches+' \u2265 '+dc.zoneTouchesThreshold+' \u2192 '+dc.zoneTouchesOk);
    L.push('  zoneStrongEnough (score OR touches) \u2192 '+dc.zoneStrongEnough);
    L.push('  stabPrevMode='+(dc.stabPrevMode||'\u2014')+' (percorso a conferma pregresso su questa zona)');
    L.push('  lockModeConfirmPath (tracker gi\u00e0 lockato su un percorso a conferma) \u2192 '+dc.lockModeConfirmPath);
    L.push('  newEvidenceDetected \u2192 '+dc.newEvidenceDetected+(dc.evidenceList&&dc.evidenceList.length?(' ['+dc.evidenceList.join('; ')+']'):' [nessuna evidenza nuova]'));
    L.push('  hysteresisBlockingUpgrade \u2192 '+dc.hysteresisBlockingUpgrade+(dc.hysteresisBlockingUpgrade?(' (bloccato: percorso precedente = '+(dc.stabPrevMode||'lock del tracker')+', nessuna evidenza nuova da superarlo)'):' (nessun percorso a conferma pregresso da bloccare, oppure evidenza nuova presente)'));
    L.push('  slStructuralFound (ATR STOP SANITY) \u2192 '+dc.slStructuralFound+(dc.slDistAtr!==null?(' (dist '+dc.slDistAtr.toFixed(2)+'\u00d7ATR \u2265 minimo '+SETUP_RULES.minStopAtr.toFixed(2)+'\u00d7ATR)'):(dc.slRejectedInfo?(' (miglior candidato: '+dc.slRejectedInfo.src+' a '+dc.slRejectedInfo.distAtr.toFixed(2)+'\u00d7ATR < minimo '+dc.slRejectedInfo.minStopAtr.toFixed(2)+'\u00d7ATR)'):'')));
    L.push('  qualityGrade='+(dc.qualityGrade||'\u2014')+' (confidence '+(dc.qualityConfidence!==null?dc.qualityConfidence:'\u2014')+'/100) \u2192 '+dc.qualityGradeOk);
    L.push('  requiredRR='+(dc.requiredRR!==null?dc.requiredRR.toFixed(2):'\u2014')+' \u2014 RR effettivo '+(dc.rrEffective!==null&&dc.rrEffective!==undefined?('1:'+dc.rrEffective.toFixed(2)):'\u2014')+' \u2265 richiesto \u2192 '+dc.rrCheckPassed);
    L.push('  \u2192\u2192 ALL_REQUIREMENTS_MET = '+dc.ALL_REQUIREMENTS_MET+' \u2014 finalDecision = '+(dc.finalDecision||'\u2014'));
  }
  if(plan&&plan.slDecisionTree&&plan.slDecisionTree.length){
    L.push('SL DECISION TREE:');
    plan.slDecisionTree.forEach(function(row){
      L.push('  '+row.n+') '+row.name+' \u2014 '+row.price.toFixed(2)+' \u2192 '+row.verdict);
      L.push('     reason: '+row.reason);
    });
  }
  var tk=plan&&plan.tracker;
  if(tk){
    function iso(t){return (t===null||t===undefined)?'—':new Date(t).toISOString().slice(5,16).replace('T',' ')+'Z';}
    L.push('SETUP '+(tk.id||'—')+' · createdAt '+iso(tk.createdAt)+' · '+(tk.prevState?tk.prevState+' → ':'')+tk.state+
      (tk.retest?(' · retestTouched='+tk.retest.touched+(tk.retest.touchedAt?' @'+iso(tk.retest.touchedAt):'')+
        (tk.retest.confirmed?(' · confirmed @'+iso(tk.retest.confirmedAt)):'')):'')+
      (tk.terminalAt?(' · terminale @'+iso(tk.terminalAt)):'')+
      (tk.note?(' · motivo: '+tk.note):''));
  }
  return L;
}

// ══════════════════════════════════════════════════════════════════
// TRADE PLAN ENGINE — funzione PURA. Trasforma tracker+contesto in un
// piano operativo, senza mai eseguire ordini. Regole dichiarate:
// - R/R SEMPRE calcolato dal PREZZO REALE DI INGRESSO previsto
//   (market = prezzo attuale; limit = livello dell'ordine; stop = livello
//   dell'ordine), mai dal livello teorico che ha originato il setup.
// - MARKET solo se: setup confermato, ingresso non scaduto (latch
//   marketExpired), R/R residuo >= minRR.
// - LIMIT solo su vera zona strutturale di retest (il livello rotto:
//   vecchia resistenza→supporto o viceversa), mai "perché il prezzo si è
//   allontanato".
// - STOP in attesa di conferma solo se il R/R DAL PREZZO DELL'ORDINE
//   regge, con avviso che lo stop entra al tocco (non a chiusura).
// - Se il mercato corre e né market né retest reggono il minRR →
//   EXPIRED / ENTRY TOO LATE (persistito: non torna READY da solo).
// - Nessuna direzione forzata: NEUTRAL/MIXED/nessun vantaggio → NO TRADE.
function rrCalc(dir, entry, sl, tp){
  if(entry===null||sl===null||tp===null||entry===undefined||sl===undefined||tp===undefined)return null;
  var isL=dir==='LONG';
  var risk=isL?entry-sl:sl-entry;
  var rew=isL?tp-entry:entry-tp;
  if(risk<=0)return null;
  return rew/risk;
}
function planBiasLabel(b){var M={BULLISH:'BULLISH',BEARISH:'BEARISH',NEUTRAL:'NEUTRAL',MIXED:'MIXED',BULLISH_COND:'NEUTRAL-BULLISH',BEARISH_COND:'NEUTRAL-BEARISH',NA:'—'};return M[b]||b;}

// Zona tecnica REALE per un ingresso limit alternativo. Ordine di priorità:
// 1) zona di interesse del setup (S/R di origine o appena rotta)
// 2) prima zona S/R dal lato giusto (supporto per BUY, resistenza per SELL)
// 3) swing M15 pertinente   4) swing H1 pertinente
// Vincoli oggettivi: lato corretto rispetto al prezzo, oltre lo SL,
// distanza <= 3×ATR (un "retest" lontanissimo non è un retest).
// PRIMA si verifica che la zona ESISTA, SOLO DOPO si calcola il R/R:
// mai inventare un limit per raggiungere matematicamente il minimo.
function findRetestZone(tracker, tech, price, atr){
  var isL=tracker.dir==='LONG';var sl=tracker.invalid;var cands=[];
  if(tracker.zone)cands.push({lo:tracker.zone.low,hi:tracker.zone.high,src:'zona strutturale del setup',kind:'ZONE',score:tracker.zone.score,touches:tracker.zone.touches});
  if(tech){
    var arr=isL?(tech.sup||[]):(tech.res||[]);
    if(arr[0])cands.push({lo:arr[0].low,hi:arr[0].high,src:isL?'zona di supporto':'zona di resistenza',kind:'ZONE',score:arr[0].score,touches:arr[0].touches});
    var m=tech.m15;var lv=m?(isL?m.lastSwingLow:m.lastSwingHigh):null;
    if(lv!==null&&lv!==undefined)cands.push(isL?{lo:lv-(atr?0.1*atr:0),hi:lv,src:'swing low M15',kind:'SWING'}:{lo:lv,hi:lv+(atr?0.1*atr:0),src:'swing high M15',kind:'SWING'});
    var h=tech.h1;var lh=h?(isL?h.lastSwingLow:h.lastSwingHigh):null;
    if(lh!==null&&lh!==undefined)cands.push(isL?{lo:lh-(atr?0.1*atr:0),hi:lh,src:'swing low H1',kind:'SWING'}:{lo:lh,hi:lh+(atr?0.1*atr:0),src:'swing high H1',kind:'SWING'});
  }
  for(var i=0;i<cands.length;i++){
    var z=cands[i];
    var edge=isL?z.hi:z.lo; // primo tocco = fill conservativo per il R/R
    if(price===null||price===undefined)continue;
    if(isL?(edge>=price||edge<=sl):(edge<=price||edge>=sl))continue;
    if(atr&&Math.abs(price-edge)>3*atr)continue;
    return {lo:z.lo,hi:z.hi,entry:edge,src:z.src,kind:z.kind,score:z.score,touches:z.touches};
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════
// OPPORTUNITY RADAR — quando non c'è trade immediato, costruisce fino a
// 2 scenari (1 LONG, 1 SHORT) SOLO da livelli reali del motore. È un
// layer informativo persistente: quando trigger+conferma accadono davvero
// è la pipeline esistente (tracker → piano) a ricalcolare TUTTO dal
// prezzo reale e a dichiarare TRADE READY. Il radar non esegue mai.
// Stati: WATCHING → APPROACHING → ZONE_TOUCHED/WAITING_CONFIRMATION →
// TRIGGERED · terminali: EXPIRED / INVALIDATED (con cooldown 30 min
// anti-ricreazione dello stesso scenario).
// ══════════════════════════════════════════════════════════════════
// SETUP HYSTERESIS / STABILITY LAYER — separazione tra RAW ANALYSIS
// (ciò che il motore calcolerebbe dal solo dato corrente) e STABILIZED
// DECISION (dopo confronto con l'identità di decisione precedente sulla
// stessa zona). Principio CAUSALE:
//   · stesso dataset M15 (nessuna nuova chiusura) → decisione INVARIATA
//   · nuove candele ma nessuna evidenza forte → smoothing 25%, MAI
//     upgrade di execution mode verso DIRECT
//   · evidenza strutturale nuova (touch/sweep/conferma nuovi; forza zona
//     o struttura M15 cambiate CON nuove candele) → raw, upgrade
//     consentito con motivo registrato
// Sicurezza SEMPRE immediata: invalidazioni/terminali non passano di qui.
// ── SETUP LOCK: cronologia transizioni (append-only, no duplicati consecutivi)
function tlPush(tl,st,at){
  tl=(tl||[]).slice(-19);
  if(tl.length&&tl[tl.length-1].st===st)return tl;
  return tl.concat([{st:st,at:at}]);
}
var STAB_CONF_MODES={'CONFIRMED RETEST':1,'FAST CONFIRMATION':1,'SWEEP RECLAIM':1,'REJECTION / RECLAIM':1,'PULLBACK / RETEST':1};
function gradeOfConf(cf){return cf>=75?'A+':cf>=60?'A':cf>=45?'B':null;}
function stabFind(list,dir,zLo,zHi,atr){
  if(!list)return null;
  var tol=0.3*(atr||0.0001);
  for(var i=0;i<list.length;i++){var s=list[i];
    if(s.dir===dir&&Math.abs(s.zLo-zLo)<=tol&&Math.abs(s.zHi-zHi)<=tol)return s;}
  return null;
}
function detectNewEvidence(prev, ev){
  if(!prev)return {isNew:true,newBar:true,list:['prima osservazione della zona: nessun vincolo di isteresi']};
  var list=[];
  var newBar=!!(ev.m15Closed&&(prev.lastM15T===null||prev.lastM15T===undefined||ev.m15Closed.t>prev.lastM15T));
  var R=ev.retest;
  if(R&&R.touchedAt&&(!prev.lastSeen||R.touchedAt>prev.lastSeen))list.push('nuovo TOUCH della zona');
  if(R&&R.sweptAt&&(!prev.lastSeen||R.sweptAt>prev.lastSeen))list.push('nuovo SWEEP');
  if(R&&R.confirmed&&R.confirmedAt&&(!prev.lastSeen||R.confirmedAt>prev.lastSeen))list.push('conferma retest completata ('+(R.confirmedBy||'')+')');
  if(newBar){
    if((ev.zScore||0)>(prev.zScore||0)||(ev.zTouches||0)>(prev.zTouches||0))
      list.push('forza zona aumentata (score '+(prev.zScore||0)+'\u2192'+(ev.zScore||0)+', tocchi '+(prev.zTouches||0)+'\u2192'+(ev.zTouches||0)+') con nuova chiusura M15');
    if(ev.m15Trend&&prev.m15Trend&&ev.m15Trend!==prev.m15Trend)
      list.push('cambio struttura M15 ('+prev.m15Trend+'\u2192'+ev.m15Trend+') con nuova chiusura M15');
  }
  return {isNew:list.length>0,newBar:newBar,list:list};
}
function stabilizeQuality(prev, q, evInfo){
  if(!prev||!q||evInfo.isNew)return q;
  var sc=evInfo.newBar?Math.round(prev.confidence+0.25*(q.confidence-prev.confidence)):prev.confidence;
  return {grade:gradeOfConf(sc),confidence:sc,
    factors:q.factors.concat(['STABILIZED: raw '+q.confidence+' \u2192 '+sc+(evInfo.newBar?' (smoothing: nuove candele senza evidenza forte)':' (stesso dataset M15: confidence invariata)')]),
    raw:{grade:q.grade,confidence:q.confidence}};
}
function updateStability(list, e, now){
  var out=(list||[]).filter(function(s){return now-(s.lastSeen||0)<=4*60*60000;});
  var tol=0.3*(e.atr||0.0001);
  for(var i=0;i<out.length;i++){var s=out[i];
    if(s.dir===e.dir&&Math.abs(s.zLo-e.zLo)<=tol&&Math.abs(s.zHi-e.zHi)<=tol){
      out[i]=Object.assign({},s,e,{id:s.id,createdAt:s.createdAt,lastSeen:now});return out;}}
  out.push(Object.assign({},e,{id:'ST'+now.toString(36)+'-'+Math.floor(Math.random()*1296).toString(36),createdAt:now,lastSeen:now}));
  return out;
}
// ══════════════════════════════════════════════════════════════════
// DIRECT LIMIT CHECKLIST — diagnostica pura per il DEBUG: NON decide
// nulla (la decisione resta nel ramo reale di buildTradePlan), si limita
// a rispecchiare ogni singola condizione che quel ramo valuta, con
// TRUE/FALSE esplicito, così è sempre chiaro QUALE requisito blocca il
// DIRECT anche quando zoneScore e touches sono ampiamente sopra soglia.
function directLimitChecklist(z, stabPrev, evStab, lockIsConf, slR, qD, reqD){
  var zoneKindOk = z.kind === 'ZONE';
  var scoreOk = (z.score||0) >= SETUP_RULES.directLimitMinScore;
  var touchesOk = (z.touches||0) >= SETUP_RULES.directLimitMinTouches;
  var strongEnough = zoneKindOk && (scoreOk || touchesOk);
  var hysteresisBlocking = !evStab.isNew && ((stabPrev && STAB_CONF_MODES[stabPrev.mode]) || lockIsConf);
  var newEvidencePresent = evStab.isNew;
  var slSaneOk = !!slR;
  var qualityGradeOk = !!(qD && qD.grade);
  var rrThresholdOk = reqD !== null && reqD !== undefined;
  var allPass = strongEnough && !hysteresisBlocking && slSaneOk && qualityGradeOk && rrThresholdOk;
  return {
    zoneKind: z.kind, zoneKindOk: zoneKindOk,
    zoneScore: z.score||0, zoneScoreThreshold: SETUP_RULES.directLimitMinScore, zoneScoreOk: scoreOk,
    zoneTouches: z.touches||0, zoneTouchesThreshold: SETUP_RULES.directLimitMinTouches, zoneTouchesOk: touchesOk,
    zoneStrongEnough: strongEnough,
    stabPrevMode: stabPrev?stabPrev.mode:null, lockModeConfirmPath: !!lockIsConf,
    newEvidenceDetected: newEvidencePresent, evidenceList: evStab.list,
    hysteresisBlockingUpgrade: hysteresisBlocking,
    slStructuralFound: slSaneOk, slDistAtr: slR?slR.distAtr:null,
    qualityGrade: qD?qD.grade:null, qualityConfidence: qD?qD.confidence:null, qualityGradeOk: qualityGradeOk,
    requiredRR: reqD, rrThresholdOk: rrThresholdOk,
    ALL_REQUIREMENTS_MET: allPass
  };
}
function zoneStrongRaw(z){
  return !!z&&((z.score||0)>=SETUP_RULES.directLimitMinScore||(z.touches||0)>=SETUP_RULES.directLimitMinTouches);
}
function buildOpportunityRadar(prev, a){
  prev=prev||[];
  if(a.price===null||a.price===undefined||!a.atrH1)return [];
  var atr=a.atrH1, atrX=a.atrExec||a.atrH1, now=a.now, price=a.price;
  var buf=SETUP_RULES.slBufferAtr*atrX;
  function firstBeyond(arr,px,cmpUp){for(var i=0;i<arr.length;i++){if(cmpUp?arr[i].center>px:arr[i].center<px)return arr[i];}return null;}
  function q(dir,zone,slDistAtr,entry,tp){
    return computeSetupQuality({dir:dir,bias:a.bias,zone:zone,slDistAtr:slDistAtr,confirmType:null,
      m15Trend:a.m15?a.m15.trend:null,h1Trend:a.h1?a.h1.trend:null,tp1:tp,
      spaceAtr:(tp!==null&&entry!==null)?Math.abs(tp-entry)/atr:null});
  }
  function reqOf(g){if(!a.thr)return a.minRR;return g==='A+'?Math.max(a.thr.aplus,SETUP_RULES.rrFloor):g==='A'?Math.max(a.thr.a,SETUP_RULES.rrFloor):Math.max(a.thr.b,SETUP_RULES.rrFloor);}
  function mk(dir){
    var isL=dir==='LONG', out=[];
    var res=a.res||[], sup=a.sup||[];
    // (A) BREAKOUT WATCH: prima zona contraria FORTE davanti al prezzo
    var bz=firstBeyond(isL?res:sup,price,isL);
    if(bz&&zoneStrongRaw(bz)){
      var bEdge=isL?bz.high:bz.low, bNear=isL?bz.low:bz.high;
      var bDist=Math.max(0,isL?bNear-price:price-bNear);
      if(bDist<=SETUP_RULES.radarMaxDistAtr*atr){
        var bEntry=isL?bEdge+0.1*atr:bEdge-0.1*atr;
        var bSl=isL?bz.low-buf:bz.high+buf; // invalidazione naturale: ritorno oltre la zona rotta
        var bTgt=firstBeyond(isL?res:sup,isL?bEdge+0.01:bEdge-0.01,isL);
        var bTgtPx=bTgt?bTgt.center:null;
        if(bTgtPx!==null){
          var bRR=rrCalc(dir,bEntry,bSl,bTgtPx);
          var bQ=q(dir,{kind:'ZONE',score:bz.score,touches:bz.touches},Math.abs(bEntry-bSl)/atrX,bEntry,bTgtPx);
          if(bQ.grade&&bRR!==null&&bRR>=reqOf(bQ.grade))
            out.push({dir:dir,setupType:'BREAKOUT + RETEST',zLo:bz.low,zHi:bz.high,src:'zona '+(isL?'di resistenza':'di supporto'),
              trigger:'Chiusura M15 '+(isL?'sopra':'sotto')+' '+bEdge.toFixed(2),
              confirmation:'retest/reclaim della zona con M5 non contrario — pipeline completa ricalcolata al trigger',
              invalidation:'chiusura M15 '+(isL?'sotto':'sopra')+' '+bSl.toFixed(2),
              target:bTgtPx,rrEst:bRR,quality:bQ,distAtr:bDist/atr,invLevel:bSl,trigLevel:bEdge,kindTag:'BREAKOUT',zScore:bz.score,zTouches:bz.touches});
        }
      }
    }
    // (B) REJECTION / PULLBACK: prima zona concorde dietro il prezzo (anche non forte: decide la quality)
    var pz=firstBeyond(isL?sup:res,price,!isL);
    if(pz){
      var pHi=isL?pz.high:pz.low; // edge verso il prezzo
      var pDist=Math.max(0,isL?price-pz.high:pz.low-price);
      // sopprimi se coincide col ciclo retest già seguito dal tracker (già nel piano)
      var dup=a.tracker&&a.tracker.retest&&a.tracker.dir===dir&&Math.abs((isL?a.tracker.retest.hi:a.tracker.retest.lo)-pHi)<=0.3*atr;
      if(!dup&&pDist<=SETUP_RULES.radarMaxDistAtr*atr){
        var pEntry=pHi;
        var pSl=isL?pz.low-buf:pz.high+buf;
        var pTgt=firstBeyond(isL?res:sup,price,isL);
        var pTgtPx=pTgt?pTgt.center:null;
        if(pTgtPx!==null){
          var pRR=rrCalc(dir,pEntry,pSl,pTgtPx);
          var pQ=q(dir,{kind:'ZONE',score:pz.score,touches:pz.touches},Math.abs(pEntry-pSl)/atrX,pEntry,pTgtPx);
          if(pQ.grade&&pRR!==null&&pRR>=reqOf(pQ.grade))
            out.push({dir:dir,setupType:pDist>SETUP_RULES.radarApproachAtr*atr?'PULLBACK / RETEST':'REJECTION / RECLAIM',
              zLo:pz.low,zHi:pz.high,src:'zona '+(isL?'di supporto':'di resistenza'),
              trigger:'Test della zona '+pz.low.toFixed(2)+'\u2013'+pz.high.toFixed(2),
              confirmation:'chiusura M5/M15 '+(isL?'sopra':'sotto')+' '+pHi.toFixed(2)+' POST-touch (mai retroattiva), struttura M5 non contraria',
              invalidation:'chiusura M15 '+(isL?'sotto':'sopra')+' '+pSl.toFixed(2),
              target:pTgtPx,rrEst:pRR,quality:pQ,distAtr:pDist/atr,invLevel:pSl,trigLevel:null,kindTag:'PULLBACK',zScore:pz.score,zTouches:pz.touches});
        }
      }
    }
    if(!out.length)return null;
    // Opportunity Score: confidence − 8×distanza(ATR) — a parità di qualità
    // vince lo scenario più vicino (peso dichiarato, euristica)
    function oscore(o){return o.quality.confidence-8*o.distAtr;}
    out.sort(function(x,y){return oscore(y)-oscore(x)||y.rrEst-x.rrEst;});
    return out[0];
  }
  var fresh=[mk('LONG'),mk('SHORT')].filter(Boolean);
  // MERGE con lo stato precedente: stesso scenario → stesso opportunityId
  // e latch conservati; terminale recente → cooldown anti-ricreazione.
  var kept=[];
  fresh.forEach(function(f){
    var m=null;
    for(var i=0;i<prev.length;i++){
      var p2=prev[i];
      if(p2.dir===f.dir&&Math.abs(p2.zHi-f.zHi)<=0.3*atr&&Math.abs(p2.zLo-f.zLo)<=0.3*atr){m=p2;break;}
    }
    if(m&&(m.status==='INVALIDATED'||m.status==='EXPIRED')){
      if(now-(m.statusAt||m.createdAt)<=SETUP_RULES.radarCooldownMs){kept.push(m);return;} // cooldown: mostra il terminale, non ricreare
      m=null; // cooldown scaduto: nuova istanza legittima
    }
    var o=Object.assign({},f);
    if(m){o.id=m.id;o.createdAt=m.createdAt;o.touched=!!m.touched;o.touchedAt=m.touchedAt||null;}
    else{o.id='O'+now.toString(36)+'-'+Math.floor(Math.random()*46656).toString(36);o.createdAt=now;o.touched=false;o.touchedAt=null;}
    // HYSTERESIS: stesso dataset M15 → confidence invariata; nuove candele
    // senza evidenza (touch nuovo / forza zona aumentata) → smoothing 25%.
    if(m&&m.quality&&typeof m.quality.confidence==='number'){
      var newM15R=!!(a.m15Closed&&(m.lastM15T===null||m.lastM15T===undefined||a.m15Closed.t>m.lastM15T));
      var evR=((f.zScore||0)>(m.zScore||0)&&newM15R);
      if(!evR){
        var scR=newM15R?Math.round(m.quality.confidence+0.25*(f.quality.confidence-m.quality.confidence)):m.quality.confidence;
        o.quality={grade:gradeOfConf(scR),confidence:scR,factors:f.quality.factors,raw:{grade:f.quality.grade,confidence:f.quality.confidence}};
      }
      if(m.touched)o.setupType=m.setupType; // il tipo è fissato dopo il touch
    }
    o.lastM15T=a.m15Closed?a.m15Closed.t:(m?m.lastM15T:null);
    // eventi SOLO da candele chiuse/prezzo con timestamp ≥ createdAt (mai retroattivi)
    var isL=o.dir==='LONG';
    var m5=a.m5Bar; // ultima M5 CHIUSA {h,l,c,t}
    if(!o.touched){
      var pIn=price>=o.zLo&&price<=o.zHi;
      var barIn=m5&&(m5.t+5*60000)>=o.createdAt&&(m5.l<=o.zHi&&m5.h>=o.zLo); // high/low: tocco tra refresh non perso
      if(pIn||barIn){o.touched=true;o.touchedAt=pIn?now:(m5.t+5*60000);}
    }
    var st='WATCHING';
    if(o.distAtr<=SETUP_RULES.radarApproachAtr)st='APPROACHING';
    if(o.touched)st='ZONE_TOUCHED';
    if(o.kindTag==='BREAKOUT'&&a.m15Closed&&(a.m15Closed.t+15*60000)>=o.createdAt&&(isL?a.m15Closed.c>o.trigLevel:a.m15Closed.c<o.trigLevel))st='TRIGGERED';
    if(a.m15Closed&&(a.m15Closed.t+15*60000)>=o.createdAt&&(isL?a.m15Closed.c<o.invLevel:a.m15Closed.c>o.invLevel)){st='INVALIDATED';o.statusAt=now;}
    if(st!=='INVALIDATED'&&now-o.createdAt>SETUP_RULES.radarMaxAgeMs){st='EXPIRED';o.statusAt=now;}
    o.status=st;
    kept.push(o);
  });
  // conserva terminali recenti non ri-generati (per il cooldown)
  prev.forEach(function(p2){
    if((p2.status==='INVALIDATED'||p2.status==='EXPIRED')&&now-(p2.statusAt||p2.createdAt)<=SETUP_RULES.radarCooldownMs){
      var dup=kept.some(function(k){return k.id===p2.id;});
      if(!dup)kept.push(p2);
    }
  });
  return kept;
}

// ══════════════════════════════════════════════════════════════════
// SETUP QUALITY — classificazione A+/A/B da fattori REALMENTE calcolati
// dal motore (mai indicatori inventati). Il punteggio è TECHNICAL
// CONFIDENCE (0-100): NON è una probabilità di vincita — non abbiamo
// ancora backtest sufficienti per stimarla.
// Pesi dichiarati (euristiche, non backtestate):
//   bias pieno concorde +25 / condizionale +15 · M15 concorde +10 ·
//   H1 concorde +5 · zona forte +20 (score≥3 +12, tocchi≥2 +5, swing +6) ·
//   SL sano 1–2.5×ATR +15 (accettabile +8, fuori range +3) ·
//   conferma: sweep+reclaim +25, M15 +18, M5 +14, zona forte direct +15 ·
//   target chiaro +5 · spazio ≥1.5×ATR +5.
// Grade: ≥75 A+ · ≥60 A · ≥45 B · sotto = qualità insufficiente.
function computeSetupQuality(a){
  var f=[],cf=0;
  var dirSign=a.dir==='LONG'?1:-1;
  var bs=a.bias||'NA';
  var bSign=(bs==='BULLISH'||bs==='BULLISH_COND')?1:(bs==='BEARISH'||bs==='BEARISH_COND')?-1:0;
  if(bSign===dirSign&&(bs==='BULLISH'||bs==='BEARISH')){cf+=25;f.push('bias H4 pieno concorde (+25)');}
  else if(bSign===dirSign){cf+=15;f.push('bias condizionale concorde (+15)');}
  else f.push('bias non direzionale/contrario (+0)');
  function tdir(t){return t==='BULLISH'?1:t==='BEARISH'?-1:0;}
  if(a.m15Trend&&tdir(a.m15Trend)===dirSign){cf+=10;f.push('struttura M15 concorde (+10)');}
  if(a.h1Trend&&tdir(a.h1Trend)===dirSign){cf+=5;f.push('struttura H1 concorde (+5)');}
  if(a.zone&&a.zone.kind==='ZONE'){
    if((a.zone.score||0)>=SETUP_RULES.directLimitMinScore){cf+=20;f.push('zona forte score '+a.zone.score+' (+20)');}
    else if((a.zone.score||0)>=3){cf+=12;f.push('zona score '+a.zone.score+' (+12)');}
    if((a.zone.touches||0)>=2){cf+=5;f.push(a.zone.touches+' tocchi (+5)');}
  }else if(a.zone){cf+=6;f.push('livello swing singolo (+6)');}
  if(a.slDistAtr!==null&&a.slDistAtr!==undefined){
    if(a.slDistAtr>=1&&a.slDistAtr<=2.5){cf+=15;f.push('SL strutturale sano '+a.slDistAtr.toFixed(1)+'×ATR (+15)');}
    else if(a.slDistAtr>=0.8&&a.slDistAtr<=3.5){cf+=8;f.push('SL accettabile '+a.slDistAtr.toFixed(1)+'×ATR (+8)');}
    else {cf+=3;f.push('SL fuori range ottimale '+a.slDistAtr.toFixed(1)+'×ATR (+3)');}
  }else f.push('SL non valutabile (+0)');
  if(a.confirmType==='SWEEP'){cf+=25;f.push('sweep + reclaim confermato (+25)');}
  else if(a.confirmType==='M15'){cf+=18;f.push('conferma M15 (+18)');}
  else if(a.confirmType==='M5'){cf+=14;f.push('conferma rapida M5 (+14)');}
  else if(a.confirmType==='DIRECT'){cf+=15;f.push('zona forte, pending diretto (+15)');}
  else f.push('conferma assente (+0)');
  if(a.tp1!==null&&a.tp1!==undefined){cf+=5;f.push('target strutturale chiaro (+5)');}
  if(a.spaceAtr!==null&&a.spaceAtr!==undefined){
    if(a.spaceAtr>=1.5){cf+=5;f.push('spazio al target '+a.spaceAtr.toFixed(1)+'×ATR (+5)');}
    else if(a.spaceAtr>=0.8){cf+=2;f.push('spazio limitato '+a.spaceAtr.toFixed(1)+'×ATR (+2)');}
    else f.push('spazio molto ridotto (+0)');
  }
  if(cf>100)cf=100;
  var grade=cf>=75?'A+':cf>=60?'A':cf>=45?'B':null;
  return {grade:grade,confidence:cf,factors:f};
}
// Soglia R/R richiesta per grade. thr assente → soglia base (compatibilità
// totale col comportamento precedente). Grade B: soglia ridotta SOLO con
// requisiti extra (SL sano, conferma/zona forte presente, target chiaro,
// spazio ≥0.8×ATR); altrimenti si applica la soglia A. Grade nullo con thr
// attivo → null = qualità tecnica insufficiente (anche con R/R alto).
function rrRequiredFor(q, thr, fallbackMin, extras){
  if(!thr)return fallbackMin;
  if(!q||!q.grade)return null;
  var req;
  if(q.grade==='A+')req=thr.aplus;
  else if(q.grade==='A')req=thr.a;
  else{
    // grade B: accettabile SOLO con SL sano, conferma presente, target
    // chiaro e spazio sufficiente — e comunque alla soglia B piena.
    var okB=extras&&extras.slOk&&extras.confirmOk&&extras.tpOk&&extras.spaceOk;
    if(!okB)return null;
    req=thr.b;
  }
  return Math.max(req,SETUP_RULES.rrFloor); // sotto 1.25 MAI trade
}

// EXECUTION MODE — la zona decide, mai forzata:
// DIRECT LIMIT solo per zone S/R clusterizzate FORTI (score>=4 o tocchi>=2):
// pending order eseguito al tocco, nessuna conferma successiva.
// Zone deboli o livelli swing → CONFIRMED RETEST: niente ordine pendente,
// serve la reazione (chiusura M15 oltre la zona dopo il tocco, M5 non
// contrario), poi entry/SL/TP/R-R ricalcolati dal prezzo reale.
function zoneStrongEnough(z){
  return z.kind==='ZONE'&&(((z.score||0)>=SETUP_RULES.directLimitMinScore)||((z.touches||0)>=SETUP_RULES.directLimitMinTouches));
}

// ══════════════════════════════════════════════════════════════════
// ALLERTE OPERATIVE — rileva le TRANSIZIONI del piano che meritano un
// avviso (mai ripetuto finché lo stato non cambia). Solo stati operativi:
// ordine pronto, trade ready, esiti. Nessun avviso su WATCHING/WAIT.
var ALERT_STATES={PENDING_LIMIT:'📌 ORDINE LIMIT PRONTO',TRADE_READY:'⚡ TRADE READY',TARGET_HIT:'🎯 TARGET RAGGIUNTO',INVALIDATED:'✖ SETUP INVALIDATO',EXPIRED:'⌛ SETUP SCADUTO'};
function planSig(plan){
  if(!plan)return '';
  return (plan.status||'')+'|'+(plan.orderType||'')+'|'+(plan.tracker?plan.tracker.key:'');
}
function planAlertEvent(prevSig, plan){
  if(!plan)return null;
  var sig=planSig(plan);
  if(sig===prevSig)return null;
  var lbl=ALERT_STATES[plan.status];
  if(!lbl)return null;
  var txt=(plan.direction?plan.direction+' ':'')+(plan.orderType?plan.orderType+' ':'')+
    ((plan.entryLo!==null&&plan.entryLo!==undefined)?('@'+plan.entryLo.toFixed(2)):'');
  return {sig:sig,label:lbl,text:txt};
}

// ══════════════════════════════════════════════════════════════════
// STOP LOSS STRUTTURALE — ordine di calcolo OBBLIGATORIO:
//   1) entry tecnica  2) invalidazione strutturale  3) buffer ATR
//   4) SL  5) TP dai livelli reali  6) SOLO ALLA FINE il R/R.
// Lo SL non viene MAI ristretto o allargato per ottenere il Minimum R/R:
// il Minimum R/R è esclusivamente un filtro finale del setup.
// Candidati di invalidazione (dal più vicino all'entry): limite della zona
// strutturale, swing M15, swing H1, zone S/R dal lato giusto, invalidazione
// originale del setup. ATR STOP SANITY CHECK: se la distanza Entry→SL è
// sotto minStopAtr × ATR di esecuzione (M15, fallback M5), quel livello è
// rumore, non invalidazione → si passa alla successiva invalidazione
// strutturale; se nessuna è sana → il setup NON può diventare TRADE READY.
function structuralSL(dir, entry, tracker, tech, atrExec){
  var isL=dir==='LONG';
  var buf=atrExec?SETUP_RULES.slBufferAtr*atrExec:0;
  var cands=[];
  function push(lv,src,preBuffered){
    if(lv===null||lv===undefined)return;
    if(isL?lv>=entry:lv<=entry)return;
    cands.push({lv:lv,src:src,pre:!!preBuffered});
  }
  if(tracker.zone)push(isL?tracker.zone.low:tracker.zone.high,'limite della zona strutturale');
  if(tech&&tech.m15)push(isL?tech.m15.lastSwingLow:tech.m15.lastSwingHigh,'swing M15');
  if(tech&&tech.h1)push(isL?tech.h1.lastSwingLow:tech.h1.lastSwingHigh,'swing H1');
  if(tech){
    var arr=isL?(tech.sup||[]):(tech.res||[]);
    for(var q=0;q<arr.length;q++)push(isL?arr[q].low:arr[q].high,isL?'zona di supporto':'zona di resistenza');
  }
  push(tracker.invalid,'invalidazione originale del setup',true); // buffer già incluso alla creazione
  cands.sort(function(a,b){return isL?(b.lv-a.lv):(a.lv-b.lv);}); // dal più vicino
  for(var i=0;i<cands.length;i++){
    var a2=cands[i];
    var sl=a2.pre?a2.lv:(isL?a2.lv-buf:a2.lv+buf);
    var dist=isL?entry-sl:sl-entry;
    if(dist<=0)continue;
    if(atrExec&&dist<SETUP_RULES.minStopAtr*atrExec)continue; // troppo stretto vs volatilità: NON è invalidazione
    return {sl:sl,anchor:a2.lv,src:a2.src,dist:dist,distAtr:atrExec?dist/atrExec:null};
  }
  return null; // contratto INVARIATO: null = nessun SL sano trovato (5 chiamanti esistenti si aspettano questo)
}

// Diagnostica PURA, mai nel percorso decisionale: quando structuralSL
// fallisce, ricalcola gli stessi candidati SOLO per esporre nel DEBUG
// quale distanza reale avevano e contro quale soglia sono stati scartati
// (es. "0.82×ATR < minimo 1.0×ATR"). Nessuna delle 5 chiamate esistenti
// a structuralSL viene toccata: questa gira in parallelo, sola per il DEBUG.
// ══════════════════════════════════════════════════════════════════
// SL DECISION TREE — diagnostica PURA per il DEBUG: ricostruisce
// l'identica raccolta/ordinamento di structuralSL, mostrando OGNI
// candidato realmente valutato con esito PASS/REJECT e motivo preciso.
// Non decide nulla e non viene mai chiamata dal percorso decisionale.
//
// Il motore REALE valuta solo due condizioni, in quest'ordine:
//   1) dist<=0 → candidato dalla parte sbagliata dell'entry (non è
//      un'invalidazione: sta oltre l'entry, quindi "non strutturale"
//      in questo senso specifico — nessun concetto di R/R qui)
//   2) dist < minStopAtr×ATR → troppo stretto vs la volatilità corrente
// Il primo candidato che supera ENTRAMBE vince — la sua "priorità" è
// semplicemente l'ordine di raccolta (zona del tracker, swing M15,
// swing H1, zone S/R, invalidazione originale), poi ordinati per
// vicinanza. NON esiste un controllo R/R per-candidato nella pipeline
// reale: il R/R si valuta UNA SOLA VOLTA, dopo che l'SL è già scelto.
// Questo albero riflette quei due controlli, non un algoritmo diverso.
// ══════════════════════════════════════════════════════════════════
// STORIA OSSERVABILE — proprietà oggettiva (mai una soglia di ore/giorni
// arbitraria): verifica che la finestra di swing H1 attualmente
// disponibile copra ancora l'istante di nascita del tracker. Se il più
// vecchio swing conosciuto è POSTERIORE a tracker.createdAt, la finestra
// ha perso l'inizio della storia — "nessun CHoCH" non sarebbe più
// dimostrabile, solo non falsificato per mancanza di dati. In quel caso
// l'assegnazione tardiva del target NON procede: non perché sia
// sbagliata, ma perché non è verificabile con i dati oggi disponibili.
function historyCoversCreation(swingsH1, createdAt){
  if(!swingsH1||!swingsH1.length)return false; // nessuno swing noto: nulla da verificare con certezza
  var oldest=swingsH1[0].t;
  for(var i=1;i<swingsH1.length;i++){ if(swingsH1[i].t<oldest)oldest=swingsH1[i].t; }
  return oldest<=createdAt;
}

// ══════════════════════════════════════════════════════════════════
// NESSUN CHoCH LUNGO LA CATENA — proprietà oggettiva, dominio
// strutturale del motore (BOS/CHoCH/swing, mai momentum o intensità).
// Scorre OGNI coppia di swing H1 consecutivi con t>createdAt (mai
// retroattivo) e applica la STESSA identica logica di rilevamento CHoCH
// già usata da analyzeStructure (HH/HL vs LH/LL tra coppie successive),
// non un confronto isolato sull'ultimo punto: un'inversione avvenuta a
// metà catena e poi "riassorbita" da un nuovo BOS nella stessa direzione
// resta comunque rilevata, perché si controlla l'intera sequenza.
function noChoCHSinceCreation(swingsH1, createdAt, dir){
  var relevant=(swingsH1||[]).filter(function(s){return s.t>createdAt;}).sort(function(a,b){return a.idx-b.idx;});
  if(!relevant.length)return true; // nessuno swing nuovo dalla creazione: nulla che possa aver invertito la struttura
  var highs=relevant.filter(function(s){return s.type==='H';});
  var lows=relevant.filter(function(s){return s.type==='L';});
  var isL=dir==='LONG';
  for(var i=1;i<highs.length;i++){
    var lh=highs[i].price<highs[i-1].price;
    if(isL&&lh)return false; // LH in un trend rialzista: CHoCH contro la direzione del tracker
  }
  for(var j=1;j<lows.length;j++){
    var ll=lows[j].price<lows[j-1].price;
    if(!isL&&!ll){
      var hl=lows[j].price>lows[j-1].price;
      if(hl)return false; // HL in un trend ribassista: CHoCH contro la direzione del tracker
    }
  }
  return true;
}

function structuralSLDecisionTree(dir, entry, tracker, tech, atrExec){
  var isL=dir==='LONG';
  var buf=atrExec?SETUP_RULES.slBufferAtr*atrExec:0;
  var cands=[];
  function push(lv,src,preBuffered){
    if(lv===null||lv===undefined)return; // candidato non disponibile: MAI mostrato come "mai valutato", semplicemente non esiste nel dataset corrente
    cands.push({lv:lv,src:src,pre:!!preBuffered});
  }
  if(tracker.zone)push(isL?tracker.zone.low:tracker.zone.high,'limite della zona strutturale');
  if(tech&&tech.m15)push(isL?tech.m15.lastSwingLow:tech.m15.lastSwingHigh,'swing M15');
  if(tech&&tech.h1)push(isL?tech.h1.lastSwingLow:tech.h1.lastSwingHigh,'swing H1');
  if(tech){
    var arr=isL?(tech.sup||[]):(tech.res||[]);
    for(var q=0;q<arr.length;q++)push(isL?arr[q].low:arr[q].high,isL?'zona di supporto':'zona di resistenza');
  }
  push(tracker.invalid,'invalidazione originale del setup',true);
  // stessa identica ordinazione di structuralSL: dal più vicino all'entry
  cands.sort(function(a,b){return isL?(b.lv-a.lv):(a.lv-b.lv);});
  var tree=[];
  var winnerFound=false;
  for(var i=0;i<cands.length;i++){
    var a2=cands[i];
    var sl=a2.pre?a2.lv:(isL?a2.lv-buf:a2.lv+buf);
    var dist=isL?entry-sl:sl-entry;
    var distAtr=atrExec?dist/atrExec:null;
    var row={n:i+1,name:a2.src,price:a2.lv,slIfChosen:sl};
    if(winnerFound){
      row.verdict='SKIPPED';row.reason='non valutato: un candidato precedente nell\'ordine di priorità ha già superato entrambi i controlli (dist>0 e ATR sanity).';
      tree.push(row);continue;
    }
    if(dist<=0){
      row.verdict='REJECT';row.reason='candidato oltre l\'entry ('+a2.lv.toFixed(2)+' non è dal lato corretto per '+dir+' @'+entry.toFixed(2)+'): non può essere un\'invalidazione.';
      tree.push(row);continue;
    }
    row.dist=dist;row.distAtr=distAtr;
    if(atrExec&&dist<SETUP_RULES.minStopAtr*atrExec){
      row.verdict='REJECT';row.reason='ATR distance = '+distAtr.toFixed(2)+'\u00d7ATR < minimo richiesto '+SETUP_RULES.minStopAtr.toFixed(2)+'\u00d7ATR: troppo stretto vs la volatilità corrente, non è un\'invalidazione sana.';
      tree.push(row);continue;
    }
    row.verdict='PASS';row.reason=(distAtr!==null?('ATR distance = '+distAtr.toFixed(2)+'\u00d7ATR \u2265 minimo '+SETUP_RULES.minStopAtr.toFixed(2)+'\u00d7ATR: '):'ATR non disponibile in questo contesto, controllo di sanità non applicato: ')+'candidato SCELTO (il primo, nell\'ordine di priorità, a superare i controlli disponibili).';
    tree.push(row);winnerFound=true;
  }
  return tree;
}

function structuralSLRejectedInfo(dir, entry, tracker, tech, atrExec){
  var isL=dir==='LONG';
  var buf=atrExec?SETUP_RULES.slBufferAtr*atrExec:0;
  var cands=[];
  function push(lv,src,preBuffered){
    if(lv===null||lv===undefined)return;
    if(isL?lv>=entry:lv<=entry)return;
    cands.push({lv:lv,src:src,pre:!!preBuffered});
  }
  if(tracker.zone)push(isL?tracker.zone.low:tracker.zone.high,'limite della zona strutturale');
  if(tech&&tech.m15)push(isL?tech.m15.lastSwingLow:tech.m15.lastSwingHigh,'swing M15');
  if(tech&&tech.h1)push(isL?tech.h1.lastSwingLow:tech.h1.lastSwingHigh,'swing H1');
  if(tech){
    var arr=isL?(tech.sup||[]):(tech.res||[]);
    for(var q=0;q<arr.length;q++)push(isL?arr[q].low:arr[q].high,isL?'zona di supporto':'zona di resistenza');
  }
  push(tracker.invalid,'invalidazione originale del setup',true);
  cands.sort(function(a,b){return isL?(b.lv-a.lv):(a.lv-b.lv);});
  var best=null;
  for(var i=0;i<cands.length;i++){
    var a2=cands[i];
    var sl=a2.pre?a2.lv:(isL?a2.lv-buf:a2.lv+buf);
    var dist=isL?entry-sl:sl-entry;
    if(dist<=0)continue;
    var distAtr=atrExec?dist/atrExec:null;
    if(atrExec&&dist<SETUP_RULES.minStopAtr*atrExec){
      if(!best||(distAtr!==null&&distAtr>best.distAtr))best={src:a2.src,distAtr:distAtr};
      continue;
    }
    return null; // esisterebbe un candidato sano: non è questo il motivo del fallimento
  }
  return best?{src:best.src,distAtr:best.distAtr,minStopAtr:SETUP_RULES.minStopAtr}:null;
}

function buildTradePlan(tracker, biasObj, price, atrH1, minRR, techCtx){
  var bias=biasObj?biasObj.bias:'NA';
  var mb=planBiasLabel(bias);
  // ATR del timeframe di ESECUZIONE per buffer e sanity dello SL (M15, fallback M5)
  var atrExec=techCtx?(techCtx.atrM15!==undefined&&techCtx.atrM15!==null?techCtx.atrM15:(techCtx.atrM5!==undefined&&techCtx.atrM5!==null?techCtx.atrM5:null)):null;
  // GATE ADATTIVO: attivo SOLO se il chiamante passa le soglie per qualità
  // (techCtx.rrThresholds). Assenti → comportamento identico al precedente.
  var thr=techCtx?techCtx.rrThresholds:null;
  function spaceAtrCalc(entryPx,tp){ var ref=atrH1||atrExec; if(entryPx===null||entryPx===undefined||tp===null||tp===undefined||!ref)return null; return Math.abs(tp-entryPx)/ref; }
  function qualityCalc(confirmType,zoneObj,slDistAtr,entryPx,tpPri){
    return computeSetupQuality({dir:tracker?tracker.dir:null,bias:bias,zone:zoneObj,slDistAtr:slDistAtr,confirmType:confirmType,
      m15Trend:techCtx&&techCtx.m15?techCtx.m15.trend:null,h1Trend:techCtx&&techCtx.h1?techCtx.h1.trend:null,
      tp1:tpPri,spaceAtr:spaceAtrCalc(entryPx,tpPri)});
  }
  function reqFor(q,slDistAtr,confirmType,tpPri,entryPx){
    var sp=spaceAtrCalc(entryPx,tpPri);
    return rrRequiredFor(q,thr,minRR,{slOk:slDistAtr!==null&&slDistAtr>=1,confirmOk:confirmType!==null,tpOk:tpPri!==null&&tpPri!==undefined,spaceOk:sp!==null&&sp>=0.8});
  }
  function base(action,tradeAction,status,orderType){return{action:action,marketBias:mb,tradeAction:tradeAction,direction:null,status:status,orderType:orderType||null,executionMode:'NO TRADE',entryLo:null,entryHi:null,sl:null,slAnchor:null,slAnchorSrc:null,slDist:null,slDistAtr:null,tp1:null,tp2:null,tpFast:null,rrFast:null,rr1:null,rr2:null,quality:null,requiredRR:null,stability:null,phase:null,directChecklist:null,trigger:null,invalidation:null,reason:null,warn:null,tracker:tracker};}
  function noTrade(status,reason){var p=base('NO_TRADE','NO TRADE',status,null);p.reason=reason;return p;}
  if(!tracker){
    var r=bias==='MIXED'?'Timeframe in conflitto: nessun vantaggio tecnico.':
      bias==='NEUTRAL'?'Bias NEUTRAL: nessuna direzione dominante.':
      bias==='NA'?'Dati insufficienti.':'Nessuna zona/livello operativo identificato dal motore.';
    return noTrade('WATCHING','NO TRADE — ATTENDERE. '+r+' Il bias di mercato NON è un\'autorizzazione a entrare.');
  }
  var isL=tracker.dir==='LONG';
  var dirWord=isL?'BUY':'SELL';
  var sl=tracker.invalid;
  var tp1=tracker.target, tp2=(tracker.target2!==undefined)?tracker.target2:null;
  var condTag=tracker.condBias?' (bias condizionale: contesto H4 non confermato)':'';

  // ══════════════════════════════════════════════════════════════════
  // ASSEGNAZIONE TARDIVA DEL TARGET (one-shot) — SOLO quando il tracker è
  // nato con target:null (nessuna zona disponibile alla creazione) e
  // resta null ORA. Gate strutturale: una volta assegnato, questa stessa
  // condizione (tp1===null) non è più vera, quindi il blocco non viene
  // mai rieseguito per lo stesso tracker — l'immutabilità è garantita
  // dalla struttura del controllo, non da una convenzione a parte.
  // Doppia condizione, entrambe necessarie (dominio strutturale, mai
  // momentum/intensità):
  //   B) la storia H1 conosciuta ORA copre ancora tracker.createdAt
  //      (altrimenti "nessun CHoCH" non sarebbe verificabile, solo non
  //      falsificato per finestra dati incompleta — non si procede);
  //   A) nessun CHoCH H1 lungo l'INTERA catena di swing dalla creazione
  //      (non solo l'ultimo confronto): la stessa struttura che ha
  //      generato il tracker non si è mai invertita nel frattempo.
  // Zona cercata con la STESSA identica regola di buildSetup (prima zona
  // oltre tracker.confirm nella direzione del trade) — mai un criterio
  // nuovo, mai un target inventato.
  if(tp1===null&&tracker.state!=='PENDING'){
    var swingsH1=(techCtx&&techCtx.h1&&techCtx.h1.swingHighs&&techCtx.h1.swingLows)?techCtx.h1.swingHighs.concat(techCtx.h1.swingLows):[];
    if(historyCoversCreation(swingsH1,tracker.createdAt)&&noChoCHSinceCreation(swingsH1,tracker.createdAt,tracker.dir)){
      var arrLate=isL?(techCtx&&techCtx.res?techCtx.res:[]):(techCtx&&techCtx.sup?techCtx.sup:[]);
      for(var qLate=0;qLate<arrLate.length;qLate++){
        var cpxLate=arrLate[qLate].center;
        if(isL?cpxLate>tracker.confirm:cpxLate<tracker.confirm){
          tracker=Object.assign({},tracker,{target:cpxLate,note:(tracker.note?tracker.note+' ':'')+'Target assegnato successivamente alla creazione: nessuna zona era disponibile allora, struttura invariata da '+new Date(tracker.createdAt).toISOString().slice(0,16)+'Z (nessun CHoCH, storia interamente osservabile).'});
          tp1=cpxLate;
          break;
        }
      }
    }
  }

  if(tracker.state==='INVALIDATED')return noTrade('INVALIDATED','Setup invalidato: '+(tracker.note||''));
  if(tracker.state==='EXPIRED')return noTrade('EXPIRED',tracker.note||'Setup scaduto.');
  if(tracker.state==='TARGET_HIT')return noTrade('TARGET_HIT',tracker.note||'Target raggiunto: piano chiuso.');

  // TP FAST: primo livello tecnico REALE oltre l'entry e più vicino di TP1
  // (zona S/R o swing M15). Mai inventato: se non esiste → null.
  function tpFastCalc(entryPx){
    if(entryPx===null||entryPx===undefined)return null;
    var isLf=tracker&&tracker.dir==='LONG';
    var arr=isLf?(techCtx&&techCtx.res?techCtx.res:[]):(techCtx&&techCtx.sup?techCtx.sup:[]);
    for(var i=0;i<arr.length;i++){
      var cpx=arr[i].center;
      if(isLf?cpx>entryPx:cpx<entryPx){
        if(tp1===null||tp1===undefined)return cpx;
        return (isLf?cpx<tp1:cpx>tp1)?cpx:null;
      }
    }
    var m=techCtx&&techCtx.m15;
    var lv=m?(isLf?m.lastSwingHigh:m.lastSwingLow):null;
    if(lv!==null&&lv!==undefined&&(isLf?lv>entryPx:lv<entryPx)&&(tp1===null||tp1===undefined||(isLf?lv<tp1:lv>tp1)))return lv;
    return null;
  }

  // Piano LIMIT alternativo condiviso (usato quando il breakout è scartato).
  // Pipeline SL invariata: entry → invalidazione strutturale → buffer ATR →
  // SL → TP reali → R/R come FILTRO finale. In più, EXECUTION MODE:
  // zona FORTE → DIRECT LIMIT (esecuzione al tocco, nessuna conferma dopo);
  // zona debole/swing → CONFIRMED RETEST (nessun pending order: tocco →
  // chiusura M15 oltre la zona con M5 non contrario → entry ricalcolata
  // dal prezzo reale → R/R ricontrollato → solo allora TRADE READY).
  function limitAlternative(status, rejectedReason){
    var nowP=techCtx&&techCtx.now?techCtx.now:Date.now();
    var tkR=Object.assign({},tracker);
    var zFresh=findRetestZone(tracker,techCtx,price,atrH1);
    var stored=tkR.retest;
    // La zona di un retest ATTIVO è CONGELATA. Si abbandona solo se il
    // prezzo è ancora FUORI dalla zona memorizzata e la struttura fresca è
    // materialmente diversa — MAI perché il selettore, col prezzo dentro la
    // zona, scala a un fallback più profondo (era il bug che azzerava il
    // touch). Dopo il touch la zona non si resetta in nessun caso.
    if(stored&&zFresh&&!stored.touched){
      var outsideZ=price!==null&&price!==undefined&&(isL?price>stored.hi:price<stored.lo);
      if(outsideZ&&Math.abs(stored.entry-zFresh.entry)>0.3*(atrH1||0.0001))tkR.retest=null;
    }
    var z=tkR.retest
      ?{lo:tkR.retest.lo,hi:tkR.retest.hi,entry:tkR.retest.entry,src:tkR.retest.src,kind:tkR.retest.kind||'ZONE',score:tkR.retest.score,touches:tkR.retest.touches,stored:true}
      :zFresh;
    if(!z)return noTrade('WAITING_BETTER_ENTRY',rejectedReason+' Nessuna zona tecnica di retest valida: nessun limit inventato solo per raggiungere il R/R. NO TRADE — WAIT FOR NEW SETUP.');

    // STABILITY LAYER: identità di decisione precedente su questa zona
    var stabPrev=(techCtx&&techCtx.stability)?stabFind(techCtx.stability,tracker.dir,z.lo,z.hi,atrH1):null;
    var evStab=detectNewEvidence(stabPrev,{m15Closed:techCtx?techCtx.m15Closed:null,retest:tkR.retest,
      zScore:z.score,zTouches:z.touches,m15Trend:techCtx&&techCtx.m15?techCtx.m15.trend:null});
    var stabInfo=stabPrev?{prevMode:stabPrev.mode,prevConf:stabPrev.confidence,newEvidence:evStab.isNew,evidence:evStab.list,rawMode:null,reason:null,upgradeReason:null}:null;

    // ANTI-RESURREZIONE DELLA ZONA: se questa stessa zona di retest (stessa
    // direzione, entro 0.3×ATR) appartiene a un setup TERMINATO da poco,
    // NON viene riproposta durante il cooldown: serve una struttura nuova.
    // Il vecchio setup resta terminale per sempre nel suo archivio.
    var LT=techCtx?techCtx.lastTerminal:null;
    if(LT&&LT.dir===tracker.dir&&LT.id!==tracker.id&&LT.terminalAt&&(nowP-LT.terminalAt)<=SETUP_RULES.terminalCooldownMs&&
       LT.retestEntry!==null&&LT.retestEntry!==undefined&&Math.abs(z.entry-LT.retestEntry)<=0.3*(atrH1||0.0001)){
      return noTrade('WAITING_BETTER_ENTRY',rejectedReason+' La zona di retest '+z.entry.toFixed(2)+' coincide con quella del setup '+LT.id+' appena terminato ('+LT.outcome+'): quel setup resta '+LT.outcome+' per sempre e la zona non viene riproposta subito. Serve nuova struttura o attendere il cooldown. NO TRADE.');
    }

    var R0=tkR.retest;
    var lockIsConf=R0&&R0.lockMode&&STAB_CONF_MODES[R0.lockMode];
    var directDenied=!z.stored&&zoneStrongEnough(z)&&!evStab.isNew&&((stabPrev&&STAB_CONF_MODES[stabPrev.mode])||lockIsConf);
    var directLocked=z.stored&&R0&&R0.lockMode==='DIRECT LIMIT'&&!R0.touched;
    // Checklist DIRECT: calcolata SEMPRE che la zona sia candidabile (non
    // 'STORED', cioè non già impegnata in un altro ciclo), indipendentemente
    // dall'esito — stessi identici slR/qD/reqD che userà il ramo reale.
    var directChk=null;
    if(!z.stored){
      var slRchk=structuralSL(tracker.dir,z.entry,tracker,techCtx,atrExec);
      var qDchk=slRchk?stabilizeQuality(stabPrev,qualityCalc('DIRECT',z,slRchk.distAtr,z.entry,tp1),evStab):null;
      var reqDchk=qDchk?reqFor(qDchk,slRchk.distAtr,'DIRECT',tp1,z.entry):null;
      directChk=directLimitChecklist(z,stabPrev,evStab,lockIsConf,slRchk,qDchk,reqDchk);
      directChk.hysteresisBlockingUpgrade=directDenied; // riflette l'esito REALE (include anche il lock, non solo stabPrev)
      // rrCheckPassed: il R/R EFFETTIVO (su TP1, l'unico calcolabile qui prima
      // di sapere se si userà TP FAST) supera la soglia richiesta — distinto
      // da rrThresholdOk, che dice solo "esiste una soglia numerica".
      var rrZchk=(slRchk&&tp1!==null)?rrCalc(tracker.dir,z.entry,slRchk.sl,tp1):null;
      directChk.rrEffective=rrZchk;
      directChk.rrCheckPassed=(rrZchk!==null&&reqDchk!==null&&reqDchk!==undefined&&rrZchk>=reqDchk);
      // NOTA: un ordine LIMIT scatta AL TOCCO della zona — il prezzo essere
      // sopra la zona (per un BUY LIMIT) o sotto (per un SELL LIMIT) è la
      // condizione ATTESA, non un problema da segnalare. Non esiste un
      // "anti-chase" per questo ramo nel motore reale: il no-chase esiste
      // solo dove ha senso, cioè sugli ingressi a MERCATO (ramo mode2/MARKET,
      // invariato). Niente campo qui per un concetto che il motore non valuta.
      directChk.ALL_REQUIREMENTS_MET=directChk.zoneStrongEnough&&!directDenied&&directChk.slStructuralFound&&directChk.qualityGradeOk&&directChk.rrCheckPassed;
      directChk.finalDecision=directChk.ALL_REQUIREMENTS_MET?'DIRECT_LIMIT':null; // valorizzato a 'DIRECT_LIMIT' solo se TUTTO passa; altrimenti il ramo reale decide altrove (CONFIRMED/FAST/SWEEP/NO_TRADE) e lo riflette qui sotto
    }
    if(directDenied&&stabInfo){
      stabInfo.rawMode='DIRECT LIMIT';
      stabInfo.reason='UPGRADE NEGATO: la zona era in percorso a conferma ('+stabPrev.mode+') e non esiste nuova evidenza strutturale — un refresh/ricalcolo dello stesso dataset non giustifica il passaggio a DIRECT LIMIT.';
    }
    if(((!z.stored&&zoneStrongEnough(z))||directLocked)&&!directDenied){
      // ── MODALITÀ 1: DIRECT LIMIT ──
      tkR.retest=null;
      var slR=(directLocked&&R0.lockSL&&!evStab.isNew)?R0.lockSL:structuralSL(tracker.dir,z.entry,tracker,techCtx,atrExec);
      if(!slR){var nt=noTrade('WAITING_BETTER_ENTRY',rejectedReason+' Zona forte ('+z.src+') ma NESSUNA invalidazione strutturale a distanza sana dalla volatilità (ATR STOP SANITY). NO TRADE — WAIT FOR NEW SETUP.');nt.tracker=tkR;if(directChk){directChk.slStructuralFound=false;directChk.slRejectedInfo=structuralSLRejectedInfo(tracker.dir,z.entry,tracker,techCtx,atrExec);directChk.ALL_REQUIREMENTS_MET=false;directChk.finalDecision='NO_TRADE_ATR_SANITY';}nt.directChecklist=directChk;nt.slDecisionTree=structuralSLDecisionTree(tracker.dir,z.entry,tracker,techCtx,atrExec);return nt;}
      var rrZ1=tp1!==null?rrCalc(tracker.dir,z.entry,slR.sl,tp1):null;
      var rrZ2=tp2!==null?rrCalc(tracker.dir,z.entry,slR.sl,tp2):null;
      var qD=stabilizeQuality(stabPrev,qualityCalc('DIRECT',z,slR.distAtr,z.entry,tp1),evStab);
      if(R0&&R0.lockGrade&&R0.lockMode==='DIRECT LIMIT'&&!evStab.isNew)qD=Object.assign({},qD,{grade:R0.lockGrade});
      if(stabInfo){stabInfo.rawMode='DIRECT LIMIT';
        if(STAB_CONF_MODES[stabPrev.mode])stabInfo.upgradeReason='UPGRADE a DIRECT LIMIT consentito: '+evStab.list.join('; ');
      }
      var reqD=reqFor(qD,slR.distAtr,'DIRECT',tp1,z.entry);
      if(reqD===null){var ntq2=noTrade('WAITING_BETTER_ENTRY',rejectedReason+' Zona forte ma QUALITÀ TECNICA INSUFFICIENTE (confidence '+qD.confidence+'/100 sotto la soglia B): anche con R/R alto il trade non viene accettato. NO TRADE.');if(directChk){directChk.qualityGradeOk=false;directChk.ALL_REQUIREMENTS_MET=false;directChk.finalDecision='NO_TRADE_QUALITY_INSUFFICIENT';}ntq2.directChecklist=directChk;return ntq2;}
      var tpF=tpFastCalc(z.entry);
      var rrF=tpF!==null?rrCalc(tracker.dir,z.entry,slR.sl,tpF):null;
      var usedTp=null;
      if(rrZ1!==null&&rrZ1>=reqD)usedTp='TP1';
      else if(rrF!==null&&rrF>=reqD&&thr)usedTp='FAST';
      if(directChk){
        // sincronizza con l'esito VERO: accettato via TP1 O via TP FAST
        directChk.rrEffective=(usedTp==='FAST')?rrF:rrZ1;
        directChk.rrCheckPassed=(usedTp!==null);
        directChk.ALL_REQUIREMENTS_MET=directChk.zoneStrongEnough&&!directDenied&&directChk.slStructuralFound&&directChk.qualityGradeOk&&directChk.rrCheckPassed;
        directChk.finalDecision=directChk.ALL_REQUIREMENTS_MET?'DIRECT_LIMIT':null;
      }
      if(usedTp!==null){
        var p=base('PLAN',dirWord,'PENDING_LIMIT',isL?'BUY LIMIT':'SELL LIMIT');
        p.executionMode='DIRECT LIMIT';p.tracker=tkR;
        p.direction=dirWord;p.entryLo=z.lo;p.entryHi=z.hi;
        p.sl=slR.sl;p.slAnchor=slR.anchor;p.slAnchorSrc=slR.src;p.slDist=slR.dist;p.slDistAtr=slR.distAtr;
        p.tp1=tp1;p.tp2=tp2;p.rr1=rrZ1;p.rr2=rrZ2;
        p.tpFast=tpF;p.rrFast=rrF;p.quality=qD;p.requiredRR=reqD;p.stability=stabInfo;p.directChecklist=directChk;p.slDecisionTree=structuralSLDecisionTree(tracker.dir,z.entry,tracker,techCtx,atrExec);
        if(usedTp==='FAST')p.warn='SPAZIO LIMITATO: piano gestito sul TP FAST '+tpF.toFixed(2)+' (R/R 1:'+rrF.toFixed(2)+' ≥ richiesto); TP1 resta come estensione.';
        // LOCK del setup DIRECT: zona/SL/grade congelati fino a conclusione
        if(!tkR.retest)tkR.retest={lo:z.lo,hi:z.hi,entry:z.entry,src:z.src,kind:'ZONE',score:z.score,touches:z.touches,touched:false,touchedAt:null,confirmed:false,confirmedBy:null,swept:false,sweptAt:null};
        tkR.retest=Object.assign({},tkR.retest,{lockMode:'DIRECT LIMIT',
          lockSL:{sl:slR.sl,anchor:slR.anchor,src:slR.src,dist:slR.dist,distAtr:slR.distAtr},
          lockGrade:qD.grade,
          timeline:tlPush(tlPush(tkR.retest.timeline||[],'CREATED',nowP),'PENDING_LIMIT',nowP)});
        p.tracker=tkR;
        p.trigger='Ordine '+(isL?'BUY':'SELL')+' LIMIT nella zona '+z.lo.toFixed(2)+'\u2013'+z.hi.toFixed(2)+' ('+z.src+', forza: score '+(z.score!==undefined?z.score:'\u2014')+', tocchi '+(z.touches!==undefined?z.touches:'\u2014')+') \u2014 ESECUZIONE AL TOCCO, nessuna conferma successiva richiesta.';
        p.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+slR.sl.toFixed(2)+' (invalidazione: '+slR.src+' @'+slR.anchor.toFixed(2)+')';
        p.reason=rejectedReason+' Zona abbastanza forte per un pending order diretto: SL strutturale su '+slR.src+', R/R dal prezzo dell\'ordine 1:'+(usedTp==='FAST'?rrF:rrZ1).toFixed(2)+' \u2265 richiesto 1:'+reqD.toFixed(2)+' (grade '+(qD.grade||'\u2014')+').'+condTag;
        return p;
      }
      var nt2=noTrade('WAITING_BETTER_ENTRY',rejectedReason+' Zona forte ('+z.src+') con SL strutturale su '+slR.src+' @'+slR.anchor.toFixed(2)+', ma R/R risultante '+(rrZ1!==null?('1:'+rrZ1.toFixed(2)):'n.d.')+' < richiesto 1:'+reqD.toFixed(2)+(thr?(' per grade '+(qD.grade||'\u2014')):'')+' \u2014 lo SL non viene MAI ristretto per forzare il minimo, e nessun TP FAST valido disponibile. NO TRADE \u2014 WAIT FOR NEW SETUP.');
      if(directChk){directChk.finalDecision='NO_TRADE_RR_INSUFFICIENT';} // ALL_REQUIREMENTS_MET/rrCheckPassed già sincronizzati sopra (usedTp===null)
      nt2.quality=qD;nt2.tracker=tkR;nt2.directChecklist=directChk;return nt2;
    }

    // ── MODALITÀ 2: retest con conferma. Tre vie di conferma, tutte da
    // candele CHIUSE e mai retroattive (timestamp ≥ touch, o ≥ sweep):
    //   M15  → CONFIRMED RETEST (mercato incerto: bias non concorde o swing)
    //   M5   → FAST CONFIRMATION (zona valida + bias direzionale concorde)
    //   dopo SWEEP: reclaim M5/M15 sopra la zona → SWEEP RECLAIM
    if(!tkR.retest)tkR.retest={lo:z.lo,hi:z.hi,entry:z.entry,src:z.src,kind:(z.kind==='SWING'?'SWING':'ZONE'),score:z.score,touches:z.touches,touched:false,touchedAt:null,confirmed:false,confirmedBy:null,swept:false,sweptAt:null};
    var R=tkR.retest;
    var edge=isL?R.hi:R.lo;
    var biasSign=(bias==='BULLISH'||bias==='BULLISH_COND')?1:(bias==='BEARISH'||bias==='BEARISH_COND')?-1:0;
    var fastElig=(R.kind!=='SWING')&&biasSign===(isL?1:-1);
    // LOCK della modalità: fissata alla prima classificazione, insensibile
    // alle oscillazioni del bias; riclassificazione SOLO su evidenza nuova
    if(!R.lockMode){
      R=Object.assign({},R,{lockMode:fastElig?'FAST CONFIRMATION':'CONFIRMED RETEST',
        lockTrend:techCtx&&techCtx.m15?techCtx.m15.trend:null,
        lockBarT:techCtx&&techCtx.m15Closed?techCtx.m15Closed.t:null,
        timeline:tlPush(tlPush(R.timeline||[],'CREATED',tkR.createdAt||nowP),'WATCHING',nowP)});
      tkR.retest=R;
    }else if(!R.touched&&!R.swept&&R.lockMode!=='DIRECT LIMIT'){
      // riclassificazione SOLO su evidenza strutturale vera: nuova M15 CON
      // cambio di struttura M15 (proxy BOS/CHoCH) — mai per la sola
      // oscillazione del bias corrente o per assenza di dati precedenti
      var newBarV=!!(techCtx&&techCtx.m15Closed&&(R.lockBarT===undefined||R.lockBarT===null||techCtx.m15Closed.t>R.lockBarT));
      var structChanged=newBarV&&techCtx&&techCtx.m15&&R.lockTrend&&techCtx.m15.trend!==R.lockTrend;
      if(structChanged){
        var reMode=fastElig?'FAST CONFIRMATION':'CONFIRMED RETEST';
        if(reMode!==R.lockMode){
          R=Object.assign({},R,{lockMode:reMode,timeline:tlPush(R.timeline,'RECLASSIFIED \u2192 '+reMode,nowP)});
        }
      }
      if(newBarV)R=Object.assign({},R,{lockBarT:techCtx.m15Closed.t,lockTrend:techCtx.m15?techCtx.m15.trend:R.lockTrend});
      tkR.retest=R;
    }
    var fastEligEff=R.lockMode==='FAST CONFIRMATION';
    var m5b=techCtx?techCtx.m5Closed:null; // ultima M5 CHIUSA {h,l,c,t}
    var m5bFresh=m5b&&m5b.h!==undefined&&(m5b.t+SETUP_RULES.confirmM5Ms)>=(tkR.createdAt||0);
    if(!R.touched){
      var tPrice=price!==null&&price!==undefined&&(isL?price<=R.hi:price>=R.lo);
      // HIGH/LOW della candela chiusa: il tocco avvenuto TRA due refresh
      // non va perso (mai da candele precedenti alla nascita del setup)
      var tBar=m5bFresh&&(isL?m5b.l<=R.hi:m5b.h>=R.lo);
      if(tPrice||tBar){R=Object.assign({},R,{touched:true,touchedAt:tPrice?nowP:(m5b.t+SETUP_RULES.confirmM5Ms)});R=Object.assign({},R,{timeline:tlPush(tlPush(R.timeline,'ZONE_TOUCHED',R.touchedAt),'WAITING_CONFIRMATION',R.touchedAt)});tkR.retest=R;}
    }
    // latch SWEEP: da prezzo live O da high/low della candela chiusa
    if(R.touched&&!R.confirmed&&!R.swept&&atrH1){
      var mark=SETUP_RULES.sweepMarkAtr*atrH1;
      var sPrice=price!==null&&price!==undefined&&(isL?price<R.lo-mark:price>R.hi+mark);
      var sBar=m5bFresh&&(isL?m5b.l<R.lo-mark:m5b.h>R.hi+mark);
      if(sPrice||sBar){R=Object.assign({},R,{swept:true,sweptAt:sPrice?nowP:(m5b.t+SETUP_RULES.confirmM5Ms)});R=Object.assign({},R,{timeline:tlPush(R.timeline,'SWEPT',R.sweptAt)});tkR.retest=R;}
    }
    var cc=techCtx?techCtx.m15Closed:null;
    var m5c=techCtx?techCtx.m5Closed:null;
    var m5d=techCtx?techCtx.m5Dir:null;
    if(R.touched&&!R.confirmed){
      var refT=R.swept?R.sweptAt:R.touchedAt;
      var m5ok=m5d===undefined||m5d===null||m5d!==(isL?-1:1);
      var by=null,byAt=null;
      if(cc&&refT!==null&&(cc.t+SETUP_RULES.confirmTfMs)>=refT&&(isL?cc.c>R.hi:cc.c<R.lo)&&m5ok){
        by=R.swept?'SWEEP':'M15';byAt=cc.t+SETUP_RULES.confirmTfMs;
      }else if(m5c&&refT!==null&&(m5c.t+SETUP_RULES.confirmM5Ms)>=refT&&(isL?m5c.c>R.hi:m5c.c<R.lo)&&m5ok&&(R.swept||fastEligEff)){
        by=R.swept?'SWEEP':'M5';byAt=m5c.t+SETUP_RULES.confirmM5Ms;
      }
      if(by){R=Object.assign({},R,{confirmed:true,confirmedBy:by,confirmedAt:byAt});R=Object.assign({},R,{timeline:tlPush(R.timeline,'CONFIRMED ('+by+')',byAt)});tkR.retest=R;}
    }
    if(R.confirmed){
      var modeBy=R.confirmedBy==='SWEEP'?'SWEEP RECLAIM':R.confirmedBy==='M5'?'FAST CONFIRMATION':'CONFIRMED RETEST';
      // NO CHASE: se il prezzo è già troppo lontano dalla zona, l'ingresso è perso.
      if(price!==null&&price!==undefined&&atrH1&&Math.abs(price-edge)>SETUP_RULES.noChaseAtr*atrH1){
        var ntc=noTrade('MISSED_ENTRY','NO CHASE — conferma valida ('+modeBy+') ma il prezzo dista '+Math.abs(price-edge).toFixed(2)+'$ ('+(Math.abs(price-edge)/atrH1).toFixed(1)+'\u00d7ATR) dalla zona: non si insegue. MISSED ENTRY / WAIT FOR NEW SETUP.');
        ntc.tracker=tkR;return ntc;
      }
      // conferma avvenuta: ENTRY = prezzo realmente disponibile, pipeline completa
      var slC=structuralSL(tracker.dir,price,tracker,techCtx,atrExec);
      if(!slC){var nt3=noTrade('WAITING_BETTER_ENTRY',rejectedReason+' Retest confermato ma nessuna invalidazione strutturale a distanza sana dal prezzo attuale (ATR STOP SANITY). NO TRADE.');nt3.tracker=tkR;return nt3;}
      var rrC1=tp1!==null?rrCalc(tracker.dir,price,slC.sl,tp1):null;
      var rrC2=tp2!==null?rrCalc(tracker.dir,price,slC.sl,tp2):null;
      var qC=stabilizeQuality(stabPrev,qualityCalc(R.confirmedBy,{kind:R.kind,score:z.score,touches:z.touches},slC.distAtr,price,tp1),evStab);
      var reqC=reqFor(qC,slC.distAtr,R.confirmedBy,tp1,price);
      if(reqC===null){var ntq=noTrade('WAITING_BETTER_ENTRY','Conferma avvenuta ('+modeBy+') ma QUALITÀ TECNICA INSUFFICIENTE (confidence '+qC.confidence+'/100): il trade non viene accettato nemmeno con R/R alto. NO TRADE.');ntq.quality=qC;ntq.tracker=tkR;return ntq;}
      var tpFc=tpFastCalc(price);
      var rrFc=tpFc!==null?rrCalc(tracker.dir,price,slC.sl,tpFc):null;
      var usedC=null;
      if(rrC1!==null&&rrC1>=reqC)usedC='TP1';
      else if(rrFc!==null&&rrFc>=reqC&&thr)usedC='FAST';
      if(usedC!==null){
        var pc=base('PLAN',dirWord,'TRADE_READY','MARKET');
        pc.executionMode=modeBy;pc.tracker=tkR;
        pc.direction=dirWord;pc.entryLo=price;
        pc.sl=slC.sl;pc.slAnchor=slC.anchor;pc.slAnchorSrc=slC.src;pc.slDist=slC.dist;pc.slDistAtr=slC.distAtr;
        pc.tp1=tp1;pc.tp2=tp2;pc.rr1=rrC1;pc.rr2=rrC2;pc.tpFast=tpFc;pc.rrFast=rrFc;pc.quality=qC;pc.requiredRR=reqC;pc.stability=stabInfo;pc.slDecisionTree=structuralSLDecisionTree(tracker.dir,price,tracker,techCtx,atrExec);
        if(usedC==='FAST')pc.warn='SPAZIO LIMITATO: piano gestito sul TP FAST '+tpFc.toFixed(2)+' (R/R 1:'+rrFc.toFixed(2)+'); TP1 come estensione.';
        tkR.retest=Object.assign({},tkR.retest,{timeline:tlPush(tkR.retest.timeline,'TRADE_READY',nowP)});pc.tracker=tkR;
        pc.trigger=(R.confirmedBy==='SWEEP'
          ?('SWEEP + RECLAIM: penetrazione della zona '+R.lo.toFixed(2)+'\u2013'+R.hi.toFixed(2)+' e successivo recupero con chiusura oltre '+edge.toFixed(2)+' (pattern tecnico osservabile).')
          :('Retest CONFERMATO ('+(R.confirmedBy==='M5'?'chiusura M5':'chiusura M15')+' '+(isL?'sopra ':'sotto ')+edge.toFixed(2)+' post-touch, M5 non contrario). Entry ricalcolata dal prezzo reale.'));
        pc.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+slC.sl.toFixed(2)+' (invalidazione: '+slC.src+' @'+slC.anchor.toFixed(2)+')';
        pc.reason='Conferma '+modeBy+' ottenuta. SL/TP/R-R ricalcolati dall\'entry reale: R/R 1:'+(usedC==='FAST'?rrFc:rrC1).toFixed(2)+' \u2265 richiesto 1:'+reqC.toFixed(2)+' (grade '+(qC.grade||'\u2014')+', confidence '+qC.confidence+'/100).'+condTag;
        return pc;
      }
      tkR.retest=Object.assign({},tkR.retest,{timeline:tlPush(tkR.retest.timeline,'MISSED',nowP)});
      var nt4=noTrade('MISSED_ENTRY','INGRESSO SFUMATO: conferma valida ('+modeBy+') ma R/R dal prezzo reale '+(rrC1!==null?('1:'+rrC1.toFixed(2)):'n.d.')+' < richiesto 1:'+reqC.toFixed(2)+' e nessun TP FAST valido — il prezzo è scappato durante la conferma. Ingresso sfumato: NO TRADE.');
      nt4.quality=qC;nt4.tracker=tkR;return nt4;
    }
    // in attesa: tocco e/o conferma
    var slP=structuralSL(tracker.dir,z.entry,tracker,techCtx,atrExec);
    var rrP1=(slP&&tp1!==null)?rrCalc(tracker.dir,z.entry,slP.sl,tp1):null;
    var slPTree=structuralSLDecisionTree(tracker.dir,z.entry,tracker,techCtx,atrExec);
    var pw=base('WAIT',dirWord,R.touched?'RETEST_TOUCHED':'WAITING_RETEST',null);
    pw.slDecisionTree=slPTree;
    pw.executionMode=R.swept?'SWEEP RECLAIM':(R.lockMode||'CONFIRMED RETEST');pw.tracker=tkR;
    var bufW=SETUP_RULES.slBufferAtr*(atrExec||atrH1||0.0001);
    var slDistW=atrExec?Math.abs(z.entry-(isL?z.lo-bufW:z.hi+bufW))/atrExec:null;
    pw.quality=stabilizeQuality(stabPrev,qualityCalc(null,{kind:z.kind,score:z.score,touches:z.touches},slDistW,z.entry,tp1),evStab);
    if(R.lockGrade&&!evStab.isNew&&pw.quality)pw.quality=Object.assign({},pw.quality,{grade:R.lockGrade});
    if(!R.lockGrade&&pw.quality&&pw.quality.grade){R=Object.assign({},R,{lockGrade:pw.quality.grade});tkR.retest=R;pw.tracker=tkR;}
    pw.stability=stabInfo;pw.directChecklist=directChk;
    // fase dinamica (si aggiorna col prezzo, senza toccare la classificazione)
    if(!R.touched&&price!==null&&price!==undefined&&atrH1){
      var dW=isL?Math.max(0,price-R.hi):Math.max(0,R.lo-price);
      pw.phase=dW<=1.0*atrH1?'APPROACHING':'WATCHING';
      R=Object.assign({},R,{timeline:tlPush(R.timeline,pw.phase,nowP)});tkR.retest=R;pw.tracker=tkR;
    }
    pw.direction=dirWord;pw.entryLo=z.lo;pw.entryHi=z.hi;
    if(slP){pw.sl=slP.sl;pw.slAnchor=slP.anchor;pw.slAnchorSrc=slP.src;pw.slDist=slP.dist;pw.slDistAtr=slP.distAtr;}
    pw.tp1=tp1;pw.tp2=tp2;pw.rr1=rrP1;
    pw.trigger='RETEST ZONE '+z.lo.toFixed(2)+'\u2013'+z.hi.toFixed(2)+' ('+z.src+'). NESSUN ordine pendente: dopo il tocco serve '+(fastEligEff?'chiusura M5 (fast) o M15':'chiusura M15')+' '+(isL?'sopra ':'sotto ')+edge.toFixed(2)+' con M5 non contrario.'+
      (R.swept?' SWEEP rilevato: la zona è stata penetrata — in attesa di RECLAIM (chiusura oltre '+edge.toFixed(2)+') entro la finestra.':(R.touched?' Zona GI\u00c0 toccata: in attesa della chiusura di conferma.':''));
    pw.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+tracker.invalid.toFixed(2);
    pw.reason=rejectedReason+' Zona di retest valida ma NON abbastanza forte per un limit diretto ('+z.src+(z.kind==='ZONE'?', score '+(z.score!==undefined?z.score:'\u2014')+', tocchi '+(z.touches!==undefined?z.touches:'\u2014'):', livello swing singolo')+'): richiesta conferma. Alla conferma, entry/SL/TP/R-R saranno ricalcolati dal prezzo reale (indicativi attuali'+(rrP1!==null?(': R/R 1:'+rrP1.toFixed(2)):'')+').'+condTag;
    return pw;
  }

  if(tracker.state==='PENDING'){
    if(tp1===null){
      // Bias direzionale ma nessun target strutturale lontano: PRIMA di
      // fermarsi, cerca un TP FAST reale (primo livello tecnico oltre la
      // conferma) — scalping/intraday a target ridotto, mai inventato.
      var tpFp=tpFastCalc(tracker.confirm);
      if(tpFp!==null){
        var slDistFp=atrExec?Math.abs(tracker.confirm-sl)/atrExec:null;
        var qFp=qualityCalc('DIRECT',null,slDistFp,tracker.confirm,tpFp);
        var reqFp=reqFor(qFp,slDistFp,'DIRECT',tpFp,tracker.confirm);
        var rrFp=rrCalc(tracker.dir,tracker.confirm,sl,tpFp);
        if(reqFp!==null&&rrFp!==null&&rrFp>=reqFp){
          var pf=base('PLAN',dirWord,'PENDING_LIMIT',isL?'BUY STOP':'SELL STOP');
          pf.executionMode='CONFIRMED BREAKOUT';pf.direction=dirWord;
          pf.entryLo=tracker.confirm;pf.sl=sl;pf.slDist=Math.abs(tracker.confirm-sl);pf.slDistAtr=slDistFp;
          pf.tpFast=tpFp;pf.rrFast=rrFp;pf.quality=qFp;pf.requiredRR=reqFp;
          pf.trigger='Chiusura M15 '+(isL?'sopra':'sotto')+' '+tracker.confirm.toFixed(2);
          pf.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+sl.toFixed(2);
          pf.warn='NESSUN TARGET STRUTTURALE LONTANO: piano a TARGET RIDOTTO (scalping/intraday) sul primo livello tecnico reale oltre la conferma.';
          pf.reason='Bias '+dirWord+' confermabile ma senza target lontano: TP FAST '+tpFp.toFixed(2)+' \u2265 R/R richiesto 1:'+reqFp.toFixed(2)+' (grade '+(qFp.grade||'\u2014')+'). Ordine condizionato al breakout, target ridotto.'+condTag;
          return pf;
        }
      }
      var pw=base('WAIT','WAIT','WAITING_CONFIRMATION',null);
      pw.direction=dirWord;pw.sl=sl;
      pw.trigger='Chiusura M15 '+(isL?'sopra':'sotto')+' '+tracker.confirm.toFixed(2);
      pw.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+sl.toFixed(2);
      pw.reason='NESSUN TARGET TECNICO VALIDO oltre la conferma, e nessun TP FAST reale con R/R sufficiente: nessun ordine consigliabile.'+condTag;
      return pw;
    }
    if(tracker.retest&&(tracker.retest.touched||tracker.retest.swept))return limitAlternative('WAITING_RETEST','Ciclo di retest in corso (zona già toccata): il piano segue la macchina a stati del retest, non un nuovo ordine stop.');
    var stopEntry=isL?tracker.confirm+0.1*(atrH1||0):tracker.confirm-0.1*(atrH1||0);
    var rrS1=rrCalc(tracker.dir,stopEntry,sl,tp1);
    var rrS2=tp2!==null?rrCalc(tracker.dir,stopEntry,sl,tp2):null;
    var slDistS=atrExec?Math.abs(stopEntry-sl)/atrExec:null;
    var qS=qualityCalc(null,tracker.zone?{kind:'ZONE',score:tracker.zone.score,touches:tracker.zone.touches}:null,slDistS,stopEntry,tp1);
    var reqS=thr?reqFor(qS,slDistS,null,tp1,stopEntry):minRR;
    if(rrS1!==null&&reqS!==null&&rrS1>=reqS){
      var ps=base('PLAN',dirWord,'WAITING_CONFIRMATION',isL?'BUY STOP':'SELL STOP');
      ps.executionMode='CONFIRMED BREAKOUT';
      ps.direction=dirWord;ps.entryLo=stopEntry;ps.sl=sl;ps.tp1=tp1;ps.tp2=tp2;ps.rr1=rrS1;ps.rr2=rrS2;
      ps.trigger='Chiusura M15 '+(isL?'sopra':'sotto')+' '+tracker.confirm.toFixed(2)+' (lo stop order entrerebbe al tocco di '+stopEntry.toFixed(2)+': la conferma a chiusura NON è garantita)';
      ps.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+sl.toFixed(2);
      ps.quality=qS;ps.requiredRR=reqS;
      ps.reason='Breakout non ancora confermato: ordine stop condizionato oltre il livello, R/R valido dal prezzo dell\'ordine.'+condTag;
      ps.warn='Lo stop order entra al TOCCO del livello, non alla chiusura: rischio di falso breakout.';
      return ps;
    }
    // BREAKOUT ENTRY SCARTATO IN ANTICIPO: il sistema sa già che dopo il
    // trigger il R/R sarebbe insufficiente → il bias NON diventa un BUY/SELL.
    var rej='Ingresso breakout '+(isL?'sopra':'sotto')+' '+tracker.confirm.toFixed(2)+' SCARTATO: R/R proiettato '+(rrS1!==null?('1:'+rrS1.toFixed(2)):'n.d.')+' < minimo '+minRR.toFixed(1)+'.';
    return limitAlternative('WAITING_RETEST',rej);
  }

  // ACTIVATED / RETEST
  var tk=Object.assign({},tracker);
  if(tp1===null){
    // Bias attivato ma senza target strutturale lontano: prova un TP FAST
    // reale prima di arrendersi (stessa gerarchia usata altrove: motore
    // non forza mai un target inventato, ma non si ferma se ne esiste uno).
    var tpFm=(price!==null)?tpFastCalc(price):null;
    if(tpFm!==null){
      var slDistFm=(price!==null&&atrExec)?Math.abs(price-sl)/atrExec:null;
      var qFm=qualityCalc('M15',tk.zone?{kind:'ZONE',score:tk.zone.score,touches:tk.zone.touches}:null,slDistFm,price,tpFm);
      var reqFm=reqFor(qFm,slDistFm,'M15',tpFm,price);
      var rrFm=rrCalc(tk.dir,price,sl,tpFm);
      if(reqFm!==null&&rrFm!==null&&rrFm>=reqFm){
        var pfm=base('PLAN',dirWord,'TRADE_READY','MARKET');
        pfm.executionMode='MARKET';pfm.direction=dirWord;pfm.entryLo=price;pfm.sl=sl;pfm.tracker=tk;
        pfm.tpFast=tpFm;pfm.rrFast=rrFm;pfm.quality=qFm;pfm.requiredRR=reqFm;
        pfm.warn='NESSUN TARGET STRUTTURALE LONTANO: piano a TARGET RIDOTTO (scalping/intraday) sul primo livello tecnico reale.';
        pfm.trigger='Ingresso a mercato: setup già confermato.';
        pfm.invalidation='Chiusura M15 '+(tk.dir==='LONG'?'sotto':'sopra')+' '+sl.toFixed(2);
        pfm.reason='Setup confermato senza target lontano: TP FAST '+tpFm.toFixed(2)+' con R/R 1:'+rrFm.toFixed(2)+' \u2265 richiesto 1:'+reqFm.toFixed(2)+' (grade '+(qFm.grade||'\u2014')+'). Target ridotto, mai inventato.';
        return pfm;
      }
    }
    return noTrade(tk.state==='RETEST'?'WAITING_RETEST':'CONFIRMED','Setup tecnicamente confermato MA nessun target tecnico valido nella direzione del trade, e nessun TP FAST reale con R/R sufficiente: NO TRADE.'+(tk.note?' '+tk.note:''));
  }
  var rrM1=price!==null?rrCalc(tk.dir,price,sl,tp1):null;
  var rrM2=(price!==null&&tp2!==null)?rrCalc(tk.dir,price,sl,tp2):null;
  var slDistM=(price!==null&&atrExec)?Math.abs(price-sl)/atrExec:null;
  var qM=qualityCalc('M15',tk.zone?{kind:'ZONE',score:tk.zone.score,touches:tk.zone.touches}:null,slDistM,price,tp1);
  var reqM=reqFor(qM,slDistM,'M15',tp1,price);
  // NO CHASE strutturale: zona contraria FORTE tra il prezzo e il target,
  // più vicina di marketBlockAtr×ATR → niente MARKET (meglio breakout/pullback)
  var mBlock=null;
  if(price!==null&&atrH1&&techCtx){
    var isLm=tk.dir==='LONG';
    var oppArr=isLm?(techCtx.res||[]):(techCtx.sup||[]);
    for(var oi=0;oi<oppArr.length;oi++){
      var oz=oppArr[oi];
      if(isLm?oz.center>price:oz.center<price){
        var od=isLm?oz.low-price:price-oz.high;
        if(zoneStrongRaw(oz)&&od<SETUP_RULES.marketBlockAtr*atrH1&&tp1!==null&&(isLm?tp1>oz.center:tp1<oz.center))
          mBlock=oz;
        break;
      }
    }
  }
  var marketOk=!tk.marketExpired&&!mBlock&&rrM1!==null&&reqM!==null&&rrM1>=reqM;
  var band=atrH1?0.15*atrH1:0;
  var reLo=isL?tk.confirm-band:tk.confirm;
  var reHi=isL?tk.confirm:tk.confirm+band;
  var mBlockNote=mBlock?('NO CHASE: zona contraria FORTE a '+((tk.dir==='LONG'?mBlock.low-price:price-mBlock.high)).toFixed(2)+'$ ('+(((tk.dir==='LONG'?mBlock.low-price:price-mBlock.high))/atrH1).toFixed(2)+'\u00d7ATR) tra prezzo e target: niente MARKET \u2014 WAITING FOR BREAKOUT o PULLBACK (vedi NEXT OPPORTUNITIES). '):'';
  var limitEntry=tk.confirm;
  // SL strutturale per il limit sul retest: pipeline obbligatoria + ATR sanity.
  var slR2=structuralSL(tk.dir,limitEntry,tk,techCtx,atrExec);
  var slR2Tree=structuralSLDecisionTree(tk.dir,limitEntry,tk,techCtx,atrExec);
  var rrL1=slR2?rrCalc(tk.dir,limitEntry,slR2.sl,tp1):null;
  var rrL2=(slR2&&tp2!==null)?rrCalc(tk.dir,limitEntry,slR2.sl,tp2):null;
  var qL=slR2?qualityCalc('M15',tk.zone?{kind:'ZONE',score:tk.zone.score,touches:tk.zone.touches}:null,slR2.distAtr,limitEntry,tp1):null;
  var reqL=slR2?reqFor(qL,slR2.distAtr,'M15',tp1,limitEntry):minRR;
  var limitOk=rrL1!==null&&reqL!==null&&rrL1>=reqL;

  if(tk.state==='RETEST'&&limitOk){
    var pr=base('PLAN',dirWord,'TRADE_READY',isL?'BUY LIMIT':'SELL LIMIT');
    pr.executionMode='DIRECT LIMIT';
    pr.direction=dirWord;pr.entryLo=reLo;pr.entryHi=reHi;
    pr.sl=slR2.sl;pr.slAnchor=slR2.anchor;pr.slAnchorSrc=slR2.src;pr.slDist=slR2.dist;pr.slDistAtr=slR2.distAtr;
    pr.tp1=tp1;pr.tp2=tp2;pr.rr1=rrL1;pr.rr2=rrL2;pr.tracker=tk;pr.quality=qL;pr.requiredRR=reqL;pr.slDecisionTree=slR2Tree;
    pr.trigger='Retest in corso della zona rotta '+tk.confirm.toFixed(2)+' ('+(isL?'vecchia resistenza → possibile supporto':'vecchio supporto → possibile resistenza')+'): limit ESEGUITO AL TOCCO — livello già validato dalla chiusura di breakout M15, nessuna conferma successiva richiesta';
    pr.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+slR2.sl.toFixed(2)+' (invalidazione: '+slR2.src+' @'+slR2.anchor.toFixed(2)+')';
    pr.reason='Breakout confermato (chiusura M15 '+(tk.activationClose!==null?tk.activationClose.toFixed(2):'—')+') e prezzo tornato sulla zona strutturale: ingresso limit, SL strutturale su '+slR2.src+', R/R dal prezzo dell\'ordine.'+condTag;
    return pr;
  }
  if(marketOk){
    var pm=base('PLAN',dirWord,'TRADE_READY','MARKET');
    pm.executionMode='MARKET';
    pm.direction=dirWord;pm.entryLo=price;pm.sl=sl;pm.tp1=tp1;pm.tp2=tp2;pm.rr1=rrM1;pm.rr2=rrM2;pm.tracker=tk;
    pm.quality=qM;pm.requiredRR=reqM;
    pm.trigger='Già confermato: chiusura M15 '+(isL?'sopra':'sotto')+' '+tk.confirm.toFixed(2)+' ('+(tk.activationClose!==null?tk.activationClose.toFixed(2):'—')+')';
    pm.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+sl.toFixed(2);
    pm.reason='Setup confermato, prezzo non esteso: R/R residuo dal prezzo attuale ancora sopra il minimo.'+condTag;
    return pm;
  }
  if(limitOk){
    tk.marketExpired=true; // latch: il MARKET non torna consigliabile da solo
    var pl=base('PLAN',dirWord,'WAITING_RETEST',isL?'BUY LIMIT':'SELL LIMIT');
    pl.executionMode='DIRECT LIMIT';
    pl.direction=dirWord;pl.entryLo=reLo;pl.entryHi=reHi;
    pl.sl=slR2.sl;pl.slAnchor=slR2.anchor;pl.slAnchorSrc=slR2.src;pl.slDist=slR2.dist;pl.slDistAtr=slR2.distAtr;
    pl.tp1=tp1;pl.tp2=tp2;pl.rr1=rrL1;pl.rr2=rrL2;pl.tracker=tk;pl.quality=qL;pl.requiredRR=reqL;pl.slDecisionTree=slR2Tree;
    pl.trigger='Pending limit nella zona '+reLo.toFixed(2)+'–'+reHi.toFixed(2)+' (livello strutturale rotto, validato dal breakout confermato): ESECUZIONE AL TOCCO, nessuna conferma successiva richiesta';
    pl.invalidation='Chiusura M15 '+(isL?'sotto':'sopra')+' '+slR2.sl.toFixed(2)+' (invalidazione: '+slR2.src+' @'+slR2.anchor.toFixed(2)+')';
    pl.reason=mBlockNote+'SETUP TECNICAMENTE CONFERMATO ma ingresso a mercato SCARTATO: '+(mBlock?'zona contraria forte troppo vicina (NO CHASE)':('R/R residuo '+(rrM1!==null?('1:'+rrM1.toFixed(2)):'n.d.')+' < minimo — movimento già esteso'))+'. Piano valido solo sul retest della zona rotta.'+condTag;
    pl.warn='INGRESSO MARKET TARDIVO — R/R insufficiente. Solo limit sul retest.';
    return pl;
  }
  tk.marketExpired=true;
  var pn=noTrade('EXPIRED',mBlockNote+'ENTRY TOO LATE — Setup tecnicamente confermato MA R/R insufficiente sia a mercato ('+(rrM1!==null?('1:'+rrM1.toFixed(2)):'n.d.')+') sia sul retest ('+(rrL1!==null?('1:'+rrL1.toFixed(2)):(slR2?'n.d.':'nessuna invalidazione strutturale a distanza sana — ATR sanity'))+'): movimento già esteso verso il target. NO TRADE.');
  pn.rr1=rrM1;pn.sl=sl;pn.tp1=tp1;pn.tracker=tk;
  return pn;
}
// ══════════════════════════════════════════════════════════════════

module.exports={computeTRs,computeATR,classifyVolatility,findSwings,analyzeStructure,filterSwings,buildTF,clusterZones,detectLiquidity,stateLabel,combineBias,buildScenarios,buildSetup,proposalToTracker,sanitizeTracker,endTracker,advanceSetup,sliceClosedCandles,detectSignalEvent,buildDebugLines,rrCalc,planBiasLabel,findRetestZone,tlPush,gradeOfConf,stabFind,detectNewEvidence,stabilizeQuality,updateStability,directLimitChecklist,zoneStrongRaw,buildOpportunityRadar,computeSetupQuality,rrRequiredFor,zoneStrongEnough,planSig,planAlertEvent,structuralSL,historyCoversCreation,noChoCHSinceCreation,structuralSLDecisionTree,structuralSLRejectedInfo,buildTradePlan,SETUP_RULES,STAB_CONF_MODES,ALERT_STATES};

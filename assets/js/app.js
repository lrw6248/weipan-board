/* ============ 默认数据（2026/11/11 表格快照，作为兜底） ============ */
var SNAPSHOT = {
  date:"2026/11/11", updated_at:"表格快照", source:"snapshot",
  micro_pb:2.017, signal:2.0, diffusion:48.75, avg_mv:19.60, median_mv:19.60, amount:null,
  q25:2.109, q25_source:"东财真实历史截面 · 近 1800 个交易日",
  thresholds:{pb:2.0,signal:3.0,diffusion:20.0},
  indices:{}, signal_detail:{}, diff_detail:{above:195,total:400},
  history:[]
};
// 原文《微盘抄底，胜率极高》点到的 4 个极端时刻，用于在自动识别结果上打标
var ART_MOMENTS = {
  "2024-02-07":"流动性枯竭，恐慌，历史罕见的低估",
  "2025-01-06":"PB 较低，其余一般",
  "2025-04-07":"关税战，急跌后的机会",
  "2026-07-22":"科技成长抱团，被吸血"
};
function fmtSign(v){ return (v>=0?"+":"\u2212")+Math.abs(v).toFixed(1)+"%"; }

var LS = {
  get:function(k,d){ try{var v=localStorage.getItem("wp_"+k);return v===null?d:JSON.parse(v)}catch(e){return d} },
  set:function(k,v){ try{localStorage.setItem("wp_"+k,JSON.stringify(v))}catch(e){} }
};
var CFG_DEFAULT = {notify:true,sound:true,change:true,all:true,daily:false};
var cfg = Object.assign({},CFG_DEFAULT,LS.get("cfg",{}));
var D = null, autoData = window.BOARD_DATA || null, manualData = LS.get("manual",null);
var lastLights = LS.get("lastLights",null);
var lastStamp = LS.get("lastStamp",null);
var EXTRA = window.EXTRA_HIST || null;

/* ============ 工具 ============ */
function $(id){return document.getElementById(id)}
function fmt(v,n){return (v===undefined||v===null||isNaN(v))?"—":Number(v).toFixed(n===undefined?2:n)}
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]})}
function fmtDate(s){return String(s||"—").replace(/-/g,"/")}
function toast(msg){
  var box=$("toast"), el=document.createElement("div");
  el.className="toast-item"; el.innerHTML=msg; box.appendChild(el);
  setTimeout(function(){el.style.opacity="0";el.style.transition="opacity .4s";setTimeout(function(){el.remove()},420)},4200);
}
function beep(){
  try{
    var C=window.AudioContext||window.webkitAudioContext, a=new C();
    [0,0.16].forEach(function(t,i){
      var o=a.createOscillator(), g=a.createGain();
      o.connect(g);g.connect(a.destination);o.type="sine";
      o.frequency.value=i?880:660;g.gain.setValueAtTime(.0001,a.currentTime+t);
      g.gain.exponentialRampToValueAtTime(.18,a.currentTime+t+.02);
      g.gain.exponentialRampToValueAtTime(.0001,a.currentTime+t+.14);
      o.start(a.currentTime+t);o.stop(a.currentTime+t+.16);
    });
  }catch(e){}
}
function desktopNotify(title,body,strong){
  if(!cfg.notify||!("Notification" in window)||Notification.permission!=="granted")return;
  try{ var n=new Notification(title,{body:body,tag:strong?"wp-strong":"wp-normal",requireInteraction:!!strong});
       setTimeout(function(){n.close()},12000); }catch(e){}
}

/* ============ 判定 ============ */
function evaluate(d){
  var t=d.thresholds||{pb:2.0,signal:3.0,diffusion:20.0};
  var lights={pb:d.micro_pb<t.pb, signal:d.signal>=t.signal, diffusion:d.diffusion<t.diffusion};
  var n=(lights.pb?1:0)+(lights.signal?1:0)+(lights.diffusion?1:0);
  var L={
    3:{t:"分批建仓",need:"三项全亮，历史罕见。宜分批买入，不是一次满仓。",
       stat:"参照 5 星档 · 19 次 · +32.5%"},
    2:{t:"重点跟踪",need:"已进入击球区，还差 1 项就齐了。",
       stat:"参照 3 星+PB&lt;2 · 18 次 · +47.1%"},
    1:{t:"继续观察",need:"只亮 1 项，还构不成共振。",
       stat:"参照 3 星档 · 40 次 · +26.1% · 73%"},
    0:{t:"暂不建仓",need:"三项全亮才是「抄底时刻」，三项现在都没亮。",
       stat:"0 / 3 项成立 · 无共振"}
  }[n];
  d.lights=lights;d.light_count=n;d.verdict=L;
  return d;
}

/* ============ 全景图：六面板共用一根时间轴 ============ */
var PANO=(function(){
  var PANELS=[
    {k:'pb',  lb:'微盘 PB',  ts:'微盘 PB', t:'微盘 PB · 等权调和平均',                     h:78, c:'#E9611F', band:2.0, dec:2, u:'', fill:1, bl:'阈值 2.0'},
    {k:'sig', lb:'做多信号',  ts:'做多信号', t:'做多信号 · 0–5 星',                          h:42, c:'#2D6BE4', band:3.0, dec:1, u:'', y0:0, y1:5.05, step:1, bl:'3 星线'},
    {k:'diff',lb:'扩散指数',  ts:'扩散指数', t:'扩散指数 · 站上 20 日均线的比例',             h:40, c:'#0E9F6E', band:20,  dec:0, u:'%', y0:0, y1:100, fill:1, bl:'阈值 20%'},
    {k:'amt', lb:'成交额',   ts:'成交额', t:'微盘成交额',                                 h:48, c:'#5C6B80', dec:0, u:' 亿', bars:1},
    {k:'mv',  lb:'市值',     ts:'市值 中位 / 平均', t:'市值 · 中位数（实线） / 平均（虚线）',        h:44, c:'#92400E', dec:1, u:' 亿', dual:1},
    {k:'dd',  lb:'深跌',     ts:'深跌 · 距前高回撤', t:'深跌 · 距前高回撤（越深越紫）',               h:50, c:'#6D28D9', y0:-50, y1:0, dec:0, u:'%', ddpanel:1}
  ];
  var DDC=['#A98BF7','#8B5CF6','#7333E0','#5F27C7','#4C1D95'];
  var D0=null, GEO=null, ST={range:'6m', focus:null};
  var EV_LOW={}, EV_TRG={};

  function hx(h){ return [parseInt(h.slice(1,3),16),parseInt(h.slice(3,5),16),parseInt(h.slice(5,7),16)]; }
  function mix(a,b,t){ var A=hx(a),B=hx(b);
    return 'rgb('+Math.round(A[0]+(B[0]-A[0])*t)+','+Math.round(A[1]+(B[1]-A[1])*t)+','+Math.round(A[2]+(B[2]-A[2])*t)+')'; }
  function depthT(mdd){ return Math.max(0,Math.min(1,(Math.abs(mdd)-16)/29)); }
  function ddColor(mdd){
    var t=depthT(mdd), f=t*4, i=Math.min(3,Math.floor(f));
    return mix(DDC[i],DDC[i+1],f-i);
  }
  /* 相对亮度：决定压在色块上的数字用白字还是深紫字 */
  function lumOf(rgb){
    var m=String(rgb).match(/(\d+)/g)||[0,0,0];
    function f(c){ c=+c/255; return c<=0.03928? c/12.92 : Math.pow((c+0.055)/1.055,2.4); }
    return 0.2126*f(m[0])+0.7152*f(m[1])+0.0722*f(m[2]);
  }
  function num(v,dec){
    if(v==null||isNaN(v)) return '—';
    if(dec===0) return Math.abs(v)>=10000? (v/10000).toFixed(1)+'万' : Math.round(v).toLocaleString('en-US');
    return Number(v).toFixed(dec);
  }

  function build(){
    var d=D||{}, EX=window.EXTRA_HIST||{}, BT=window.BT_DATA||{};
    var set={};
    function put(a,key){ (a||[]).forEach(function(r){ set[key?r[key]:r[0]]=1; }); }
    put(BT.series,'d');
    put(EX.median); put(EX.avg); put(EX.amount); put(EX.diff);
    put((d.history||[]).map(function(x){return [x.date,x.pb]}));
    var dates=Object.keys(set).sort();
    var pos={}; dates.forEach(function(x,i){ pos[x]=i; });
    var N=dates.length;
    function arr(src, dk, vk){
      var out=new Array(N), i;
      for(i=0;i<N;i++) out[i]=null;
      (src||[]).forEach(function(r){
        var dt=dk?r[dk]:r[0], v=vk?r[vk]:r[1];
        if(v==null||isNaN(v)) return;
        var p=pos[dt]; if(p!=null) out[p]=+v;
      });
      return out;
    }

    /* 深跌：逐日回撤 + 每个区间的起止位置 */
    var lo=null; try{ lo=deepLows(); }catch(e){}
    var ddv=new Array(N); for(var z=0;z<N;z++) ddv[z]=null;
    var zones=[];
    if(lo && lo.S && lo.ddAll){
      lo.S.forEach(function(r,ix){ var p=pos[r.d]; if(p!=null&&lo.ddAll[ix]!=null) ddv[p]=lo.ddAll[ix]; });
      lo.eps.forEach(function(e){
        var da=lo.S[e.from]&&lo.S[e.from].d, db=lo.S[e.to]&&lo.S[e.to].d;
        var a=pos[da], b=pos[db];
        if(a==null||b==null) return;
        if(b<a){ var tmp=a; a=b; b=tmp; }
        zones.push({a:a,b:b,i0:e.from,i1:e.to,mdd:e.mdd,date:e.date,pb:e.pb,sig:e.sig,
          f20:e.f20,f60:e.f60,f120:e.f120,open:!!e.open,no:e.no});
      });
    }
    return {dates:dates, pos:pos, n:N, zones:zones,
      pb :arr((d.history||[]).map(function(x){return [x.date,x.pb]})),
      sig:arr(BT.series,'d','o'),
      diff:arr(EX.diff), amt:arr(EX.amount), med:arr(EX.median), avg:arr(EX.avg), dd:ddv};
  }

  function events(){
    var ev={low:{},trg:{}};
    if(D0&&D0.zones) D0.zones.forEach(function(z){ ev.low[z.date]={mdd:z.mdd,zone:z}; });
    var s=(window.BT_DATA||{}).series||[], seq=0;
    for(var i=1;i<s.length;i++){
      var cv=(s[i].o!=null?s[i].o:s[i].s), pv=(s[i-1].o!=null?s[i-1].o:s[i-1].s);
      if(cv>=3 && pv<3){ seq++; ev.trg[s[i].d]=seq; }
    }
    return ev;
  }

  /* 当前值：取每条序列最后一个非空 */
  function lastOf(arr){
    for(var i=arr.length-1;i>=0;i--) if(arr[i]!=null) return {v:arr[i], i:i, d:D0.dates[i]};
    return null;
  }
  function nowText(k){
    if(k==='mv'){ var m=lastOf(D0.med), a=lastOf(D0.avg); return m?m.v:null; }
    return (lastOf(D0[k])||{}).v;
  }
  function renderNow(){
    var box=document.getElementById('panoNow'); if(!box||!D0) return;
    var d=D||{};
    var pbv=(d.micro_pb!=null?d.micro_pb:nowText('pb'));
    var sgv=(d.signal!=null?d.signal:nowText('sig'));
    var dfv=(d.diffusion!=null?d.diffusion:nowText('diff'));
    var amv=(d.amount!=null?d.amount:nowText('amt'));
    var mdv=(d.median_mv!=null?d.median_mv:nowText('mv'));
    var avv=(d.avg_mv!=null?d.avg_mv:lastOf(D0.avg)?lastOf(D0.avg).v:null);
    var cells=[
      {k:'微盘 PB',c:'#E9611F',v:fmt(pbv,2),u:'',s:'阈值 2.0 · '+(pbv!=null&&pbv<2?'已跌破':'未跌破')},
      {k:'做多信号',c:'#2D6BE4',v:starHTML(sgv),u:'',st:1,s:'满分 5 星 · '+(sgv!=null&&sgv>=3?'已达标':'未达标')},
      {k:'扩散指数',c:'#0E9F6E',v:fmt(dfv,1),u:'%',s:'阈值 20% · '+(dfv!=null&&dfv<20?'已冰点':'未冰点')},
      {k:'微盘成交额',c:'#5C6B80',v:amv!=null?num(amv,0):'—',u:'亿',s:amv!=null?'当日全样本合计':'当日暂无'},
      {k:'市值 中位数',c:'#92400E',v:fmt(mdv,2),u:'亿',s:'平均 '+fmt(avv,2)+' 亿（虚线）'}
    ];
    box.innerHTML=cells.map(function(c){
      return '<div class="pn-cell'+(c.st?' is-star':'')+'"><div class="k"><i style="background:'+c.c+'"></i>'+c.k+'</div>'
        +'<div class="v" style="color:'+c.c+'">'+c.v+'<em>'+c.u+'</em></div>'
        +'<div class="s">'+c.s+'</div></div>';
    }).join('');
  }

  function render(){
    var box=document.getElementById('pano'); if(!box) return;
    if(!D0) D0=build();
    var ev=events(); EV_LOW=ev.low; EV_TRG=ev.trg;

    var N0=D0.n;
    var lim={ '1m':21, '3m':63, '6m':126, '1y':244, '3y':732 };
    var n = ST.range==='all' ? N0 : Math.min(N0, lim[ST.range]||N0);
    var from=N0-n;
    var dates=D0.dates.slice(from);

    var W=Math.max(300, Math.round(box.clientWidth||900));
    var MR=W<520?46:58, ML=8, MT=10, MB=18, GAP=22, CAP=13;
    var pw=W-ML-MR;

    var y=MT, i, p;
    for(i=0;i<PANELS.length;i++){
      p=PANELS[i];
      p._cap=y; p._top=y+CAP; p._bot=p._top+p.h;
      y=p._bot+GAP;
    }
    var evTop=y-2, evH=15;
    var axisY=evTop+evH+11;
    var H=axisY+12;

    function X(idx){ return ML + (n<2?0:idx*pw/(n-1)); }
    function Y(p,v){ return p._bot - (v-p._mn)/(p._mx-p._mn)*p.h; }
    function clampX(v){ return Math.max(ML, Math.min(ML+pw, v)); }

    /* —— 值域 —— */
    PANELS.forEach(function(p){
      var a = p.dual ? D0.med.slice(from) : (p.ddpanel?D0.dd:D0[p.k]).slice(from);
      var vs=[];
      a.forEach(function(v){ if(v!=null) vs.push(v); });
      if(p.dual) D0.avg.slice(from).forEach(function(v){ if(v!=null) vs.push(v); });
      if(!vs.length){ p._mn=p.y0!=null?p.y0:0; p._mx=p.y1!=null?p.y1:1; return; }
      var mn=p.y0!=null?p.y0:Math.min.apply(null,vs), mx=p.y1!=null?p.y1:Math.max.apply(null,vs);
      if(p.y0==null){
        var pad=(mx-mn)*0.10||1; mn-=pad; mx+=pad;
        if(p.band!=null){ mn=Math.min(mn,p.band); mx=Math.max(mx,p.band); }
      }
      if(mx===mn){ mn-=1; mx+=1; }
      if(p.ddpanel && vs.length){
        var mnD=Math.min.apply(null,vs);
        mn=Math.min(-50, Math.floor(mnD/10)*10); mx=0;
      }
      p._mn=mn; p._mx=mx;
    });

    var svg='<svg viewBox="0 0 '+W+' '+H+'" style="display:block;width:100%;height:auto;overflow:visible">';

    /* 纵向淡网格 */
    [0,.25,.5,.75,1].forEach(function(f){
      var x=ML+f*pw;
      svg+='<line x1="'+x.toFixed(1)+'" y1="'+MT+'" x2="'+x.toFixed(1)+'" y2="'+(evTop+evH).toFixed(1)+
           '" stroke="#F2F5FA" stroke-width="1"/>';
    });

    /* 每个面板一个细框：六段曲线各归各的，边界清楚但不抢戏。
       注意这一层是半透明白底，必须画在深跌紫带【之前】，
       否则 72% 的白会把紫带压掉，深跌区间就看不见了。 */
    PANELS.forEach(function(p){
      svg+='<rect x="'+(ML-5)+'" y="'+(p._cap-5)+'" width="'+(pw+10).toFixed(1)+'" height="'+(p.h+CAP+9).toFixed(1)+
           '" rx="8" fill="#FDFEFF" fill-opacity=".72" stroke="#CBD8EA" stroke-width="1"/>';
    });

    /* 深跌区间：淡紫底纹铺在上面五个面板，跌得越深越重（深跌面板本身已有色柱，不再叠一层免得糊成一片）。
       画在白底之上、曲线之下，这样颜色不会被蒙版吃掉。 */
    var ddTop=evTop;
    PANELS.forEach(function(q){ if(q.ddpanel) ddTop=q._cap-7; });
    D0.zones.forEach(function(z){
      var a=Math.max(z.a,from), b=Math.min(z.b, from+n-1);
      if(b<a) return;
      var x0=clampX(X(a-from)), x1=clampX(X(b-from));
      var w=Math.max(1.6,x1-x0), t=depthT(z.mdd);
      svg+='<rect x="'+x0.toFixed(1)+'" y="'+MT+'" width="'+w.toFixed(1)+'" height="'+(ddTop-MT).toFixed(1)+
           '" fill="#8B5CF6" fill-opacity="'+(0.055+t*0.075).toFixed(3)+'"/>';
    });

    PANELS.forEach(function(p){
      var a = p.dual ? D0.med.slice(from) : (p.ddpanel?D0.dd:D0[p.k]).slice(from);

      if(ST.focus===p.k){
        svg+='<rect x="'+(ML-4)+'" y="'+(p._cap-3)+'" width="'+(pw+8)+'" height="'+(p.h+CAP+6)+'" rx="8" fill="'+p.c+'" fill-opacity=".055" stroke="'+p.c+'" stroke-opacity=".33"/>';
      }

      /* 标题 + 当前值（常显，不用悬停） */
      svg+='<rect x="'+ML+'" y="'+(p._cap+3.4)+'" width="6" height="6" rx="1.5" fill="'+p.c+'"/>';
      var ttl=(W<620&&p.ts)?p.ts:p.t;
      svg+='<text x="'+(ML+11)+'" y="'+(p._cap+9.6)+'" font-size="8.6" fill="#7C8798" font-family="-apple-system,sans-serif">'+ttl+'</text>';
      var curTxt='';
      if(p.dual){
        var m1=lastOf(D0.med), a1=lastOf(D0.avg);
        var mvNow=(D&&D.median_mv!=null)?D.median_mv:(m1?m1.v:null);
        var avNow=(D&&D.avg_mv!=null)?D.avg_mv:(a1?a1.v:null);
        curTxt=(mvNow!=null?num(mvNow,1):'—')+(avNow!=null?' / '+num(avNow,1):'');
      }else if(p.ddpanel){
        var lz=lastOf(D0.dd);
        curTxt=lz?('−'+Math.abs(lz.v).toFixed(0)):'—';
      }else{
        var lv=lastOf(D0[p.k]);
        curTxt=lv?num(lv.v,p.dec):'—';
      }
      svg+='<text class="pn-nowv" x="'+(ML+pw-8)+'" y="'+(p._cap+9.6)+'" font-size="'+(W<620?12:13.5)+'" font-weight="700" fill="'+p.c+'" text-anchor="end" font-family="ui-monospace,monospace">'
           +curTxt+'<tspan font-size="7.6" font-weight="600" fill="#9AA4B2"> '+(p.dual?'亿':p.u.trim()||'')+'</tspan>'
           +'</text>';

      /* 网格 + 右刻度 */
      [0,.5,1].forEach(function(f){
        var v=p._mx-(p._mx-p._mn)*f, yy=+Y(p,v).toFixed(1);
        if(f>0) svg+='<line x1="'+ML+'" y1="'+yy+'" x2="'+(ML+pw)+'" y2="'+yy+'" stroke="#F3F6FB" stroke-width="1"/>';
        svg+='<text class="pn-tk" x="'+(W-MR+6)+'" y="'+(yy+3)+'" font-size="8.2" fill="#B0B9C6" font-family="ui-monospace,monospace">'+
             (Math.abs(v)>=1000?(v/1000).toFixed(1)+'k':(Math.abs(v)>=100?Math.round(v):v.toFixed(p.dec)))+'</text>';
      });

      /* 阈值线 + 标注 */
      if(p.band!=null && p.band>=p._mn && p.band<=p._mx){
        var by=+Y(p,p.band).toFixed(1);
        svg+='<line x1="'+ML+'" y1="'+by+'" x2="'+(ML+pw)+'" y2="'+by+'" stroke="'+p.c+'" stroke-opacity=".5" stroke-width="1" stroke-dasharray="4 3"/>';
        svg+='<rect x="'+(ML+1)+'" y="'+(by-9.4)+'" width="'+(p.bl.length*5.6+7)+'" height="9.6" rx="2" fill="#fff" fill-opacity=".85"/>';
        svg+='<text x="'+(ML+4.4)+'" y="'+(by-2)+'" font-size="7.4" fill="'+p.c+'" fill-opacity=".9" font-family="-apple-system,sans-serif">'+p.bl+'</text>';
      }

      /* 缺口：灰色虚线 + 说明 */
      var first=null;
      for(var j=0;j<a.length;j++){ if(a[j]!=null){ first=j; break; } }
      if(first===null) first=a.length;
      if(first>0){
        var bx2=X(first-1);
        svg+='<line x1="'+ML+'" y1="'+p._bot+'" x2="'+bx2.toFixed(1)+'" y2="'+p._bot+'" stroke="#CFD7E2" stroke-width="1" stroke-dasharray="2 3"/>';
        if(bx2-ML>70){
          svg+='<text x="'+((ML+bx2)/2).toFixed(1)+'" y="'+(p._bot-5)+'" font-size="7.4" fill="#B6BFCC" text-anchor="middle" font-family="-apple-system,sans-serif">无历史数据</text>';
        }
      }

      /* 深跌面板：先铺水下浅底 → 再画深度柱 → 最后把曲线画在柱子上层 */
      if(p.ddpanel){
        var y0=Y(p,0);
        var dp='', dop=false;
        for(var kk=0;kk<a.length;kk++){
          if(a[kk]==null){ dop=false; continue; }
          dp+=(dop?'L':'M')+X(kk).toFixed(1)+' '+Y(p,a[kk]).toFixed(1)+' '; dop=true;
        }
        /* 1) 水下浅底（只是背景，柱子会盖住） */
        if(dp){
          svg+='<path d="'+dp+'L'+X(a.length-1).toFixed(1)+' '+y0.toFixed(1)+' L'+X(0).toFixed(1)+' '+y0.toFixed(1)+' Z" fill="#EFE7FD"/>';
        }
        /* 2) 零轴 */
        svg+='<line x1="'+ML+'" y1="'+y0.toFixed(1)+'" x2="'+(ML+pw)+'" y2="'+y0.toFixed(1)+'" stroke="#DCE2EC" stroke-width="1"/>';
        /* 3) 深度柱：越深越紫，最深处也留一点亮度，避免吞掉曲线 */
        var labels=[];
        D0.zones.forEach(function(z){
          var aa=Math.max(z.a,from), bb=Math.min(z.b, from+n-1);
          if(bb<aa) return;
          var x0=clampX(X(aa-from)), x1=clampX(X(bb-from));
          var w=Math.max(4,x1-x0), yy=Y(p,z.mdd), col=ddColor(z.mdd);
          svg+='<rect x="'+x0.toFixed(1)+'" y="'+y0.toFixed(1)+'" width="'+w.toFixed(1)+'" height="'+Math.max(2,yy-y0).toFixed(1)+
               '" rx="1.5" fill="'+col+'"'+(z.open?' stroke="#2A0A55" stroke-opacity=".55" stroke-width="1"':'')+'/>';
          labels.push({x:(x0+x1)/2, w:w, mdd:z.mdd, open:z.open, y:yy, col:col});
        });
        /* 4) 回撤曲线：白描边 + 深紫细线，压在柱子上，任何深度都看得见 */
        if(dp){
          /* 点越密，描边越细，免得整条曲线糊成一条白带 */
          var cw = n>1200 ? 1.9 : (n>520 ? 2.5 : 3.1);
          var lw = n>1200 ? 1.15 : (n>520 ? 1.35 : 1.55);
          svg+='<path d="'+dp+'" fill="none" stroke="#fff" stroke-opacity=".95" stroke-width="'+cw+'" stroke-linejoin="round" stroke-linecap="round"/>';
          svg+='<path d="'+dp+'" fill="none" stroke="#17102B" stroke-width="'+lw+'" stroke-linejoin="round" stroke-linecap="round"/>';
        }
        /* 5) 当前回撤点 */
        var curDD=lastOf(D0.dd);
        if(curDD && curDD.i>=from){
          var cxx=X(curDD.i-from), cyy=Y(p,curDD.v);
          svg+='<circle cx="'+cxx.toFixed(1)+'" cy="'+cyy.toFixed(1)+'" r="3.1" fill="#3B0F6E" stroke="#fff" stroke-width="1.6"/>';
        }
        /* 6) 只给最深/最新的几段标数值，且保证不重叠 */
        labels.sort(function(A,B){ return A.mdd-B.mdd; });
        var put=[];
        labels.slice(0,5).forEach(function(l){
          for(var q=0;q<put.length;q++){ if(Math.abs(put[q]-l.x)<26) return; }
          put.push(l.x);
          if(l.y-y0>15 && l.w>17){
            var lbFill = lumOf(l.col)>0.30 ? '#2A0A55' : '#fff';
            svg+='<text x="'+l.x.toFixed(1)+'" y="'+(l.y-4).toFixed(1)+'" font-size="7.8" font-weight="800" fill="'
              +lbFill+'" text-anchor="middle" font-family="ui-monospace,monospace">\u2212'+Math.abs(l.mdd).toFixed(0)+'%</text>';
          }
        });
        return;
      }

      /* 数据 */
      if(p.bars){
        if(n>900){
          var da='', o2=false;
          for(var b2=0;b2<a.length;b2++){
            if(a[b2]==null){ o2=false; continue; }
            da+=(o2?'L':'M')+X(b2).toFixed(1)+' '+Y(p,a[b2]).toFixed(1)+' '; o2=true;
          }
          svg+='<path d="'+da+'L'+X(a.length-1).toFixed(1)+' '+p._bot+' L'+X(0).toFixed(1)+' '+p._bot+' Z" fill="'+p.c+'" fill-opacity=".32"/>';
          svg+='<path d="'+da+'" fill="none" stroke="'+p.c+'" stroke-width="1.2" stroke-opacity=".85" stroke-linejoin="round"/>';
        }else{
          var bw=Math.max(1.2, pw/n*0.72);
          for(var b=0;b<a.length;b++){
            if(a[b]==null) continue;
            var byy=Y(p,a[b]);
            svg+='<rect x="'+(X(b)-bw/2).toFixed(1)+'" y="'+byy.toFixed(1)+'" width="'+bw.toFixed(2)+
                 '" height="'+Math.max(0.6,p._bot-byy).toFixed(1)+'" fill="'+p.c+'" fill-opacity=".55"/>';
          }
        }
      }else{
        function pathOf(arr, step){
          var d='', open=false, prev=null;
          for(var k=0;k<arr.length;k++){
            var v=arr[k];
            if(v==null){ open=false; prev=null; continue; }
            var xx=X(k).toFixed(1), yy=Y(p,v).toFixed(1);
            if(!open){ d+='M'+xx+' '+yy+' '; open=true; }
            else if(step){ d+='L'+xx+' '+Y(p,prev).toFixed(1)+' L'+xx+' '+yy+' '; }
            else d+='L'+xx+' '+yy+' ';
            prev=v;
          }
          return d;
        }
        if(p.fill){
          var d0=pathOf(a,0), f0=null, l0=null;
          for(var q=0;q<a.length;q++){ if(a[q]!=null){ if(f0===null)f0=q; l0=q; } }
          if(f0!==null){
            var gid='pg'+p.k;
            svg+='<defs><linearGradient id="'+gid+'" x1="0" y1="0" x2="0" y2="1">'+
                 '<stop offset="0" stop-color="'+p.c+'" stop-opacity=".17"/>'+
                 '<stop offset="1" stop-color="'+p.c+'" stop-opacity="0"/></linearGradient></defs>';
            svg+='<path d="'+d0+'L'+X(l0).toFixed(1)+' '+p._bot+' L'+X(f0).toFixed(1)+' '+p._bot+' Z" fill="url(#'+gid+')"/>';
          }
        }
        svg+='<path d="'+pathOf(a,p.step?1:0)+'" fill="none" stroke="'+p.c+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>';
        if(p.dual){
          svg+='<path d="'+pathOf(D0.avg.slice(from),0)+'" fill="none" stroke="#4A6FA5" stroke-width="1.3" stroke-dasharray="4 2.5" stroke-linejoin="round"/>';
        }
      }
    });

    /* 事件带 */
    svg+='<rect x="'+ML+'" y="'+evTop+'" width="'+pw+'" height="'+evH+'" rx="3.5" fill="#F6F8FD"/>';
    svg+='<text x="'+(ML+5)+'" y="'+(evTop+evH-4.6)+'" font-size="7.2" fill="#B6BFCC" font-family="-apple-system,sans-serif">事件</text>';
    var midY=evTop+evH/2+1;
    Object.keys(EV_LOW).forEach(function(dt){
      var k=D0.pos[dt]; if(k==null||k<from) return;
      var x=X(k-from), m=EV_LOW[dt].mdd, sz=2.6+depthT(m)*2.8;
      svg+='<path d="M'+x.toFixed(1)+' '+(midY-sz)+' L'+(x-sz*0.85).toFixed(1)+' '+(midY+sz*0.55)+' L'+(x+sz*0.85).toFixed(1)+' '+(midY+sz*0.55)+' Z" fill="'+ddColor(m)+'"/>';
    });
    Object.keys(EV_TRG).forEach(function(dt){
      var k=D0.pos[dt]; if(k==null||k<from) return;
      var x=X(k-from);
      svg+='<circle cx="'+x.toFixed(1)+'" cy="'+midY+'" r="1.9" fill="#2D6BE4"/>';
    });
    var lowsAll=Object.keys(EV_LOW).sort(), lastLow=lowsAll[lowsAll.length-1];
    if(lastLow){
      var kl=D0.pos[lastLow];
      if(kl!=null && kl>=from){
        var xl=X(kl-from);
        svg+='<text x="'+(xl-4).toFixed(1)+'" y="'+(evTop-2)+'" font-size="7.4" fill="#B5451A" text-anchor="end" font-family="ui-monospace,monospace">最近低点 −'+Math.abs(EV_LOW[lastLow].mdd).toFixed(1)+'%</text>';
      }
    }

    /* 时间轴 */
    var tk = n<=30 ? [0,.5,1] : [0,.25,.5,.75,1];
    var seenTk={};
    tk.forEach(function(f){
      var k=Math.round(f*(n-1)), x=X(k), anc=f===0?'start':(f===1?'end':'middle');
      if(f>0&&f<1) svg+='<line x1="'+x.toFixed(1)+'" y1="'+(evTop+evH).toFixed(1)+'" x2="'+x.toFixed(1)+'" y2="'+(evTop+evH+3).toFixed(1)+'" stroke="#DDE3EC" stroke-width="1"/>';
      var lab=String(dates[k]);
      lab = n<=30 ? lab.slice(5) : lab.slice(0,7);
      if(seenTk[lab]) return; seenTk[lab]=1;
      svg+='<text x="'+(f===0?ML:f===1?ML+pw:x).toFixed(1)+'" y="'+(axisY+4)+'" font-size="8.2" fill="#AEB7C4" text-anchor="'+anc+'" font-family="ui-monospace,monospace">'+lab+'</text>';
    });

    svg+='<g id="pnHov"></g>';
    svg+='<rect id="pnHit" x="'+ML+'" y="'+MT+'" width="'+pw+'" height="'+(evTop+evH-MT)+'" fill="transparent" style="cursor:crosshair"/>';
    svg+='</svg>';
    box.innerHTML=svg;

    GEO={W:W,H:H,ML:ML,MR:MR,pw:pw,n:n,from:from,dates:dates,evTop:evTop,evH:evH};
    bindHover(box);
    renderNow();

    var sub=document.getElementById('panoSub');
    if(sub){
      var miss=[];
      if(D0.diff[from]==null) miss.push('扩散 2025-10 起');
      if(D0.amt[from]==null) miss.push('成交额 2021-12 起');
      sub.innerHTML=dates[0]+' → '+dates[n-1]+'　共 '+n+' 个交易日'
        +(miss.length?'　<span style="color:#B0B9C6">· '+miss.join(' · ')+' 才有数据，之前留空</span>':'');
    }
  }

  function bindHover(box){
    var svg=box.querySelector('svg'), hit=box.querySelector('#pnHit'), hov=box.querySelector('#pnHov');
    if(!svg||!hit||!hov) return;
    function move(ev){
      var r=svg.getBoundingClientRect();
      var cx=(ev.touches?ev.touches[0].clientX:ev.clientX)-r.left;
      var x=cx*(GEO.W/r.width);
      var i=Math.round((x-GEO.ML)/GEO.pw*(GEO.n-1));
      i=Math.max(0,Math.min(GEO.n-1,i));
      var xx=GEO.ML+(GEO.n<2?0:i*GEO.pw/(GEO.n-1));
      var dt=GEO.dates[i], html='';
      html+='<line x1="'+xx.toFixed(1)+'" y1="'+10+'" x2="'+xx.toFixed(1)+'" y2="'+(GEO.H-24).toFixed(1)+'" stroke="#8A94A4" stroke-width="1" stroke-dasharray="3 3"/>';
      PANELS.forEach(function(p){
        var a = p.dual?D0.med.slice(GEO.from):(p.ddpanel?D0.dd:D0[p.k]).slice(GEO.from);
        var v=a[i];
        if(v==null){
          var my=(p._cap+p._bot)/2;
          html+='<rect x="'+(GEO.W-GEO.MR+1)+'" y="'+(my-6.8).toFixed(1)+'" width="'+(GEO.MR-3)+'" height="12.6" rx="3" fill="#fff" fill-opacity=".9" stroke="#E3E9F2"/>';
          html+='<text x="'+(GEO.W-GEO.MR+4)+'" y="'+(my+3.2).toFixed(1)+'" font-size="7.8" fill="#B6BFCC" font-family="-apple-system,sans-serif">无数据</text>';
          return;
        }
        var yy=p._bot-(v-p._mn)/(p._mx-p._mn)*p.h;
        html+='<circle cx="'+xx.toFixed(1)+'" cy="'+yy.toFixed(1)+'" r="2.8" fill="'+p.c+'" stroke="#fff" stroke-width="1.4"/>';
        var unit=(GEO.MR>=54)?p.u.trim():'';
        var txt=(p.dec===0?Math.round(v):v.toFixed(p.dec));
        txt=String(txt).replace('-','\u2212');
        html+='<rect x="'+(GEO.W-GEO.MR+1)+'" y="'+(yy-6.8).toFixed(1)+'" width="'+(GEO.MR-3)+'" height="12.6" rx="3" fill="#fff" fill-opacity=".96" stroke="'+p.c+'" stroke-opacity=".45"/>';
        html+='<text x="'+(GEO.W-GEO.MR+4)+'" y="'+(yy+3.2).toFixed(1)+'" font-size="8.2" fill="'+p.c+'" font-weight="700" font-family="ui-monospace,monospace">'+txt+(unit?'<tspan font-size="6.6" font-weight="500"> '+unit+'</tspan>':'')+'</text>';
        if(p.dual){
          var v2=D0.avg[GEO.from+i];
          if(v2!=null){
            var y2=p._bot-(v2-p._mn)/(p._mx-p._mn)*p.h;
            html+='<circle cx="'+xx.toFixed(1)+'" cy="'+y2.toFixed(1)+'" r="2.2" fill="#4A6FA5" stroke="#fff" stroke-width="1.2"/>';
          }
        }
      });
      var lx=Math.min(Math.max(xx, GEO.ML+32), GEO.ML+GEO.pw-32);
      html+='<rect x="'+(lx-32)+'" y="'+(GEO.H-15)+'" width="64" height="13.6" rx="3.5" fill="#2B3240"/>';
      html+='<text x="'+lx+'" y="'+(GEO.H-5.2)+'" font-size="8.4" fill="#fff" text-anchor="middle" font-family="ui-monospace,monospace">'+dt+'</text>';
      var tag='';
      if(EV_LOW[dt]!=null && EV_LOW[dt].zone){
        var z=EV_LOW[dt].zone;
        tag='深跌低点 −'+Math.abs(z.mdd).toFixed(1)+'% · PB '+fmt(z.pb,2)+' · 信号 '+z.sig
          +(z.f60!=null?(' · 60日 '+(z.f60>=0?'+':'−')+Math.abs(z.f60).toFixed(0)+'%'):'')
          +(z.f120!=null?(' · 120日 '+(z.f120>=0?'+':'−')+Math.abs(z.f120).toFixed(0)+'%'):'');
      }
      else if(EV_TRG[dt]) tag='第 '+EV_TRG[dt]+' 次触发 · 信号上穿 3.0';
      if(tag){
        var tw=tag.length*6.4+12;
        var tx=Math.min(GEO.ML, GEO.W-GEO.MR-tw);
        html+='<rect x="'+(tx<0?0:tx)+'" y="'+(GEO.H-15)+'" width="'+tw+'" height="13.6" rx="3.5" fill="#FDF1E8" stroke="#F2D8C2"/>';
        html+='<text x="'+((tx<0?0:tx)+6)+'" y="'+(GEO.H-5.2)+'" font-size="7.8" fill="#B5451A" font-family="-apple-system,sans-serif">'+tag+'</text>';
      }
      svg.classList.add('hv');
      hov.innerHTML=html;
    }
    hit.addEventListener('mousemove',move);
    hit.addEventListener('touchstart',move,{passive:true});
    hit.addEventListener('touchmove',move,{passive:true});
    hit.addEventListener('mouseleave',function(){ hov.innerHTML=''; svg.classList.remove('hv'); });
  }

  function setRange(r){
    ST.range=r;
    document.querySelectorAll('[data-range]').forEach(function(b){
      b.classList.toggle('on', b.getAttribute('data-range')===r);
    });
    render();
  }
  function focusPanel(k){
    ST.focus=k; render();
    var box=document.getElementById('pano');
    if(box) box.scrollIntoView({block:'center',behavior:'smooth'});
    setTimeout(function(){ ST.focus=null; render(); }, 1700);
  }
  function reset(){ D0=null; }

  return {render:render, setRange:setRange, focusPanel:focusPanel, reset:reset};
})();
window.renderPano=function(){ PANO.render(); };


/* ============ 当前状态（并入对应信号） ============ */
function tierKey(v, pb){
  var x=Math.round((v==null?0:v)*2)/2;
  if(x>=5) return "5";
  if(x>=4) return String(x);
  if(x>=3) return x===3 ? ((pb!=null&&pb<2)?"3pb":"3") : String(x);
  if(x>=2.5) return "2.5";
  return "low";
}
function countBack(arr, test){
  var n=0;
  for(var i=arr.length-1;i>=0;i--){ if(test(arr[i],i)) n++; else break; }
  return n;
}
function renderStatus(d){
  var BT=window.BT_DATA||{}, S=BT.series||[], EX=window.EXTRA_HIST||{};
  function setState(i, on, vHTML, dHTML, tip){
    var box=$("cs"+i); if(!box) return;
    box.classList.toggle("on", !!on);
    $("cs"+i+"v").innerHTML=vHTML;
    $("cs"+i+"d").innerHTML=dHTML||"";
    if(tip) box.title=tip;
  }
  /* 连续天数：只数真实存在的交易日；若顶到数据起点，标 ≥ */
  function days(n, len, pre){
    var edge=(len>1 && n>=len);
    return pre+(edge?'<b>≥ '+n+'</b>':"<b>"+n+"</b>")+DAY+(edge?"（数据仅回溯 "+len+" 天）":"");
  }
  var DAY=" 个交易日";

  /* 0) 深跌阶段 —— 不属于三条信号，放在结论卡里 */
  var o=null, vs=$("vStateV");
  try{ o=deepLows(); }catch(e){}
  if(vs){
    if(o && o.eps && o.eps.length){
      var last=o.eps[o.eps.length-1], cur=o.S[o.S.length-1], lowN=o.S[last.trough].n;
      if(o.open){
        var reb=(cur.n/lowN-1)*100, held=o.S.length-1-last.trough;
        vs.innerHTML='深跌修复期 · 距低点 <b>'+(reb>=0?"+":"\u2212")+Math.abs(reb).toFixed(1)+'%</b>'
          +'<br>低点 '+last.date.slice(5).replace("-","/")+' 起 · 已 <b>'+held+'</b>'+DAY;
      }else{
        var ended=o.S.length-1-last.to;
        vs.innerHTML='正常波动 · 当前回撤 <b>\u2212'+Math.abs(o.dd).toFixed(1)+'%</b>'
          +'<br>上次深跌结束 '+last.date.slice(5).replace("-","/")+' · 已 <b>'+ended+'</b>'+DAY;
      }
    }else{
      vs.innerHTML="数据不足 · 需回测序列";
    }
  }

  /* 1) 绝对估值：PB 2.0 为界 */
  var H=(d&&d.history)||[];
  var pb=d.micro_pb, below=(pb!=null && pb<2);
  var dpb=countBack(H, function(x){ return below ? (x.pb<2) : (x.pb>=2); });
  setState(1, below,
    'PB '+(below?'&lt; 2.0':'&gt; 2.0'),
    days(dpb, H.length, "已连续 "),
    H.length?("依据逐日 PB 共 "+H.length+" 个交易日（"+H[0].date+" 起），从最新一天往回数连续位于 2.0 "+(below?"下方":"上方")+"的交易日，不补零、不插值"):"");

  /* 2) 相对估值：3 星为界 —— 星级只画图标（半星一档），不再并列「N 星」文字 */
  if(S.length){
    var curS=S[S.length-1];
    var cv=(d&&d.signal!=null)?d.signal:(curS.o!=null?curS.o:curS.s);
    var ck=tierKey(cv, curS.p);
    /* 连续天数必须与状态行说的是同一件事：状态行写「≥3 星 / <3 星」，
       这里就数「与当前同侧于 3 星线」的连续交易日，不再数「同一档位」 */
    var over=(cv>=3);
    var dstar=countBack(S, function(x){ return (((x.o!=null?x.o:x.s)>=3)===over); });
    var box2=$("cs2"); if(box2) box2.classList.toggle("on", ck!=="low");
    var vEl=$("cs2v");
    if(vEl) vEl.innerHTML=(over?'≥ 3 星':'&lt; 3 星');
    var dEl=$("cs2d");
    if(dEl){
      var edge=(S.length>1 && dstar>=S.length);
      dEl.innerHTML=edge?('已连续 <b>≥ '+dstar+'</b> 个交易日'):('已连续 <b>'+dstar+'</b> 个交易日');
      dEl.title=("已连续 "+dstar+" 个交易日"+(over?"达到":"低于")+" 3 星线（逐日星级截至 "+S[S.length-1].d
        +"，起点 "+S[0].d+"）");
    }
    var stNow=starStat(ck);
    ["20","60","120"].forEach(function(k){
      var h=stNow?stNow["h"+k]:null;
      var wEl=$("cs2w"+k), aEl=$("cs2a"+k);
      if(wEl) wEl.textContent=(h&&h.win!=null)?Math.round(h.win)+'%':'—';
      if(aEl){
        if(h&&h.avg!=null){ aEl.textContent=pctN(h.avg); aEl.className=(h.avg>=0?'up':'dn'); }
        else { aEl.textContent='—'; aEl.className=''; }
      }
    });
  }else{
    var b2=$("cs2"); if(b2) b2.classList.remove("on");
    var d0=$("cs2d"); if(d0) d0.textContent='需载入 bt_data.js';
  }

  /* 3) 扩散指数：20% 为界 */
  var DF=(EX.diff||[]), dv=d.diffusion, low=(dv!=null && dv<20);
  if(DF.length>1){
    var ddf=countBack(DF, function(x){ return low ? (x[1]<20) : (x[1]>=20); });
    setState(3, low,
      '扩散指数 '+(low?'&lt; 20%':'&gt; 20%'),
      days(ddf, DF.length, "已连续 "),
      "依据扩散指数逐日历史 "+DF.length+" 个交易日（"+DF[0][0]+" 起）：按当前 400 只成分股回溯计算，受数据源限制只能取到这一年，"
        +"连续低于 20% 的交易日数");
  }else{
    setState(3, low, '扩散指数 '+(low?'&lt; 20%':'&gt; 20%'), "历史不足");
  }

  var rd=$("ruleDaysPb");
  if(rd && H.length) rd.textContent=H.length;
  var rs=$("ruleDaysStar"); if(rs && S.length) rs.textContent=S.length;
}

/* ============ 渲染：今日信号 ============ */
function render(){
  if(!D)return;
  var d=evaluate(D), t=d.thresholds;
  $("metaDate").textContent=fmtDate(d.date);
  $("srcChip").innerHTML="来源 <b>"+(d.source==="snapshot"?"表格快照":d.source==="manual"?"手动录入":"自动复算")+"</b>";

  var RC=["#E9611F","#2D6BE4","#0E9F6E"];
  ["pb","signal","diffusion"].forEach(function(k,i){
    $("rs"+(i+1)).setAttribute("stroke", d.lights[k]?RC[i]:"#CFDAEA");
  });
  $("ringN").textContent=d.light_count+"/3";
  $("ringC").className="rc"+(d.light_count===3?" on":"");
  $("spBadge").textContent=d.light_count+" / 3 项";

  $("actionBox").className="verdict"+(d.light_count===3?" on":"");
  $("actTitle").textContent=d.verdict.t;
  $("actStat").innerHTML=d.verdict.stat;
  $("actNeed").textContent=d.verdict.need;

  // 条件1 绝对估值：达标区 0 → 2.0
  var gp=d.micro_pb-t.pb;
  setCond(1,d.micro_pb,"",d.lights.pb,3.0,0,t.pb,
    (gp>=0?"高出阈值 ":"低于阈值 ")+fmt(Math.abs(gp),3));
  // 条件2 相对估值：达标区 3.0 → 5.0
  var gs=d.signal-t.signal;
  setCond(2,d.signal,"",d.lights.signal,5.0,t.signal,5.0,
    (gs>=0?"高出 ":"还差 ")+fmtStar(Math.abs(gs))+" 星");
  // 条件3 情绪冰点：达标区 0 → 20%
  var gd=d.diffusion-t.diffusion;
  setCond(3,d.diffusion,"%",d.lights.diffusion,100,0,t.diffusion,
    (gd>=0?"高出阈值 ":"低于阈值 ")+fmt(Math.abs(gd),1)+" 个百分点");

  // 当前状态栏
  renderStatus(d);

  // 历史曲线：已展开的面板跟着数据一起重画
  if(window.renderPano) renderPano();

  var fst=$("fileState");
  if(fst){
    var BTx=window.BT_DATA||{}, EXx=window.EXTRA_HIST||{};
    function okk(c,t){ return '<span style="color:'+(c?"#0E8C63":"#C0392B")+';font-weight:700">'+(c?"✓":"✗")+'</span> '+t; }
    var mEnd=(BTx.meta&&BTx.meta.end)||"";
    fst.innerHTML=okk(!!(BTx.series&&BTx.series.length),"bt_data.js 回测序列 "+((BTx.meta&&BTx.meta.days)||(BTx.series||[]).length)+" 天"
        +(mEnd?"（逐日数据截至 "+mEnd+"，比行情日早一天入库）":""))
      +' &nbsp;｜&nbsp; '+okk(!!(EXx.diff&&EXx.diff.length),"extra_hist.js 扩散 "+((EXx.diff||[]).length)+" 天");
  }

  // 星级构成（条件2）：三个参照系并列——Ⅰ 时序 / Ⅱ 同源分层 / Ⅲ 公开宽基
  renderBreakdown(d);

  renderStar(d);
  renderLadder(d);
  renderDeep(d);
  renderTriggers(d);

  $("inDate").value=(d.date||"").replace(/\//g,"-");
  $("inPb").value=d.micro_pb; $("inSig").value=d.signal; $("inDif").value=d.diffusion; $("inMv").value=d.avg_mv;
}
function setCond(i,val,unit,on,max,z0,z1,gap){
  if(i===2){ var v2=$("val2st"); if(v2) v2.innerHTML=starHTML(val); }
  else $("val"+i).innerHTML=fmt(val,i===1?3:1)+'<em>'+unit+'</em>';
  var g=$("gauge"+i); g.className="crow"+(on?" on":"");
  $("st"+i).className="cflag";
  $("st"+i).textContent=on?"成立":"未成立";
  $("z"+i).style.left=(z0/max*100)+"%";
  $("z"+i).style.width=((z1-z0)/max*100)+"%";
  $("dt"+i).style.left=Math.max(1.5,Math.min(98.5,val/max*100))+"%";
  $("gap"+i).textContent=gap;
}

/* ============ 渲染：星级阶梯 ============ */
var ART_CONCL=[
  {s:5,n:"首次升至 5 星",a:"极值扳机",t:19,r:32.5,w:100,u:"坑底重手，承受短期浮亏"},
  {s:4,n:"升破 4 星",a:"确认入场",t:26,r:29.23,w:100,u:"胜率抬升，可分批建仓"},
  {s:3,n:"升破 3 星",a:"预警信号",t:19,r:25.78,w:100,u:"纳入关注，准备资金"},
  {s:3.5,n:"3 星 + PB<2.0",a:"双重确认",t:9,r:35.36,w:100,u:"双低确认，性价比最高"}
];
var ART_ORIG={3:{t:40,r:26.1,w:73},4:{t:32,r:22.2,w:79},5:{t:19,r:32.5,w:100},pb:{t:18,r:47.1,w:100}};
function normD(s){return String(s==null?"":s).replace(/\//g,"-")}
function btRow(dateStr){
  var BT=window.BT_DATA; if(!BT||!BT.series||!BT.series.length)return null;
  var k=normD(dateStr);
  for(var i=BT.series.length-1;i>=0;i--){ if(BT.series[i].d<=k) return BT.series[i]; }
  return BT.series[BT.series.length-1];
}
function btTrig(label){
  var BT=window.BT_DATA; if(!BT||!BT.triggers)return null;
  for(var i=0;i<BT.triggers.length;i++){ if(BT.triggers[i].label===label) return BT.triggers[i]; }
  return null;
}
function curStar(d){
  var BT=window.BT_DATA, k=normD(d&&d.date);
  if(BT&&BT.series){
    for(var i=BT.series.length-1;i>=0;i--){
      if(BT.series[i].d===k){
        var r=BT.series[i];
        if(r.o!=null) return {s:r.o,exact:true};
        if(d&&d.signal!=null) return {s:d.signal,exact:true};
        return {s:r.s,exact:true};
      }
    }
  }
  if(d&&d.signal!=null) return {s:d.signal,exact:false};
  return {s:null,exact:false};
}
function nextStats(){
  var S=(window.BT_DATA||{}).series||[], base="2026-09-20";
  var defs=[["3",3,false],["4",4,false],["5",5,false],["3pb",3,true]];
  var out={};
  defs.forEach(function(df){
    var lv=df[1], needPB=df[2], times=0, n=0, sum=0, win=0, runSum=0, runN=0;
    for(var i=1;i<S.length;i++){
      if(S[i].d<=base) continue;
      var c=S[i], p=S[i-1];
      var on=(c.s>=lv)&&(!needPB||c.p<2), prev=(p.s>=lv)&&(!needPB||p.p<2);
      if(on&&!prev){
        times++;
        if(i+120<S.length&&S[i].n>0){
          var r=(S[i+120].n/S[i].n-1)*100; n++; sum+=r; if(r>0) win++;
        }else if(S[i].n>0){
          runN++; runSum+=(S[S.length-1].n/S[i].n-1)*100;
        }
      }
    }
    out[df[0]]={times:times,n:n,avg:n?sum/n:null,win:n?win/n*100:null,
      run:runN?runSum/runN:null,runN:runN};
  });
  return out;
}
function starStr(n){
  var full=Math.min(5,Math.max(0,Math.round(n))), s="";
  for(var i=0;i<5;i++) s+=i<full?"★":"☆";
  return s;
}
function renderLadder(d){
  var box=$("ladBody"); if(!box)return;
  /* 0 星对照：超额与基准都从 bt_data 现取，不再写死旧数字 */
  var ZD=((window.BT_DATA||{}).zero_defense)||{}, BL=((window.BT_DATA||{}).baseline)||{};
  var zex=$("zeroEx"), ztp=$("zeroTip");
  if(zex){
    if(ZD.h60 && ZD.h60.excess!=null){
      zex.textContent=(ZD.h60.excess>=0?'+':'\u2212')+Math.abs(ZD.h60.excess).toFixed(2)+'%';
      zex.style.color=ZD.h60.excess>=0?'#C0392B':'#0E8C63';
    }else zex.textContent='\u2014';
  }
  var T5=btTrig('首次升至5星');
  function putTx(id,txt){ var e=$(id); if(e) e.textContent=txt; }
  if(T5 && T5.h120){
    putTx('q5t', T5.times!=null?T5.times:'\u2014');
    putTx('q5n', T5.h120.n!=null?T5.h120.n:'\u2014');
    putTx('q5a', T5.h120.avg!=null?((T5.h120.avg>=0?'+':'\u2212')+Math.abs(T5.h120.avg).toFixed(1)+'%'):'\u2014');
    putTx('q5w', T5.h120.win!=null?((T5.h120.win>=99.95?'全部':Math.round(T5.h120.win)+'%')):'\u2014');
  }
  if(ZD.h60 && ZD.h60.excess!=null) putTx('q0e', Math.abs(ZD.h60.excess).toFixed(1));
  /* 「0–2 星合计 N 天」现算，不写死 */
  var zs=$("zeroSum");
  if(zs){
    var BS=((window.BT_DATA||{}).by_star)||{}, zt=0;
    ['0','1','2'].forEach(function(k){ if(BS[k]&&BS[k].days) zt+=BS[k].days; });
    zs.textContent=zt?zt:'\u2014';
  }
  if(ztp && ZD.h60 && ZD.h60.avg!=null){
    ztp.innerHTML='0 星那一档，持有 60 个交易日的平均涨幅 '+ZD.h60.avg.toFixed(2)
      +'%，同期「随便哪天买入」的基准是 '+(BL['60']!=null?BL['60']:'\u2014')+'%。样本 '+(ZD.h60.n||0)+' 个交易日。';
  }
  var _cs=curStar(d), cs=_cs.s;
  var pb=(d&&d.micro_pb!=null)?d.micro_pb:(btRow(d&&d.date)||{}).p;
  var curKey="";
  if(cs!=null){
    if(cs>=5)curKey="5"; else if(cs>=4)curKey="4";
    else if(cs>=3)curKey=(pb!=null&&pb<2)?"3.5":"3";
    else if(cs<1)curKey="low";
  }
  var EXT=nextStats(), pending=0;
  // 原文四档的旧统计 + 2026-09 之后按同一口径累加的新触发，加权合并
  function merged(key,oT,oR,oW){
    var e=EXT[key]||{times:0,n:0,avg:null,win:null};
    var N=oT+e.n, R=oR, W=oW;
    if(e.n>0){ R=(oR*oT+e.avg*e.n)/N; W=(oW*oT+e.win*e.n)/N; }
    if(e.times>e.n) pending += e.times-e.n;
    return {T:oT+e.times, N:N, R:R, W:W, ext:e.times, run:(e.runN?e.run:null), runN:(e.runN||0)};
  }
  function mk(key,star,name,sub,m){
    var winN=Math.round(m.W/100*m.N);
    return {key:key, star:star, label:(key==="low"?'<b>0-2</b>':'<b>'+star+'</b>'),
      name:name, sub:sub,
      cnt:m.T+" 次", cntSub:m.ext>0?("9 月后 +"+m.ext+" 次"):"",
      cntSub2:(m.runN>0)?("未满期 "+m.runN+" 次 "+(m.run>=0?"+":"\u2212")+Math.abs(m.run).toFixed(1)+"%"):"",
      runUp:(m.run>=0),
      avg:(m.R>=0?"+":"")+m.R.toFixed(1)+"%",
      barW:Math.max(6,Math.min(100,m.R/46*100)),
      win:winN+" / "+m.N, winSub:"次上涨"};
  }
  var rows=[
    mk("5",5,"首次升至 5 星","极值扳机 · 坑底重手",merged("5",ART_ORIG[5].t,ART_ORIG[5].r,ART_ORIG[5].w)),
    mk("4",4,"升破 4 星","确认入场 · 可分批",merged("4",ART_ORIG[4].t,ART_ORIG[4].r,ART_ORIG[4].w)),
    mk("3",3,"升破 3 星","预警信号 · 先备资金",merged("3",ART_ORIG[3].t,ART_ORIG[3].r,ART_ORIG[3].w)),
    mk("3.5",3,"3 星 + PB<2.0","双重确认 · 最值得配",merged("pb",ART_ORIG.pb.t,ART_ORIG.pb.r,ART_ORIG.pb.w))
  ];
  var ZD=(window.BT_DATA||{}).zero_defense||{};
  var _S=(window.BT_DATA||{}).series||[];
  var zSh=(ZD.days&&_S.length)?(ZD.days/_S.length*100):null;
  rows.push({key:"low", star:0, label:'<b>0</b>', name:"0 星", sub:"未到 1 星 · 原文的不建仓对照",
    cnt:(ZD.days||"—")+" 天", cntSub:'<span style="color:#9AA4B2">按交易日计</span>', muted:true,
    note:'这一档<b>不是触发</b>，是常态：0 星共 '+(ZD.days||"—")+' 个交易日'
      +(zSh!=null?('（占全部 '+zSh.toFixed(0)+'%）'):'')+'，60 日平均超额 <b>\u22124.2%</b>，只作对照，不进买入信号。'
      });

  var html='<div class="lhead"><span>档位（由高到低）</span>'
    +'<span>历史上出现 <span class="tip">?<span class="bub">上面四档统计的是「触发次数」——每出现一次这样的读数就记 1 次。'
    +'<br><br>最下面 0 星那一行<b>不是触发</b>，它是「0 星这个常态一共占了多少个交易日」，所以单位是天，用来和上面的次数做对照。</span></span></span>'
    +'<span>120 日后平均涨幅</span><span>120 日后上涨</span></div>';
  rows.forEach(function(x){
    var now=x.key===curKey;
    if(x.note){
      html+='<div class="lrow muted">'
        +'<div class="lcell"><div class="lstar">'+x.label+'<span class="s">★</span></div>'
          +'<div class="lname">'+x.name+'<small>'+x.sub+'</small></div></div>'
        +'<div class="lcnt">'+x.cnt+(x.cntSub?'<em>'+x.cntSub+'</em>':'')+'</div>'
        +'<div class="lnote">'+x.note+'</div></div>';
      return;
    }
    html+='<div class="lrow'+(now?" now":"")+(x.muted?" muted":"")+'">'
      +'<div class="lcell"><div class="lstar">'+x.label+'<span class="s">★</span></div>'
        +'<div class="lname">'+x.name+(now?'<span class="nowtag">当前</span>':'')+'<small>'+x.sub+'</small></div></div>'
      +'<div class="lcnt">'+x.cnt+(x.cntSub?'<em>'+x.cntSub+'</em>':'')+(x.cntSub2?'<em style="color:'+(x.runUp?"#C0392B":"#0E8C63")+'">'+x.cntSub2+'</em>':'')+'</div>'
      +'<div class="lbar"><div class="ltrack"><i style="width:'+x.barW+'%"></i></div><span><i>'+x.avg+'</i><em>120 日均涨</em></span></div>'
      +'<div class="lwin">'+x.win+(x.winSub?'<em>'+x.winSub+'</em>':'')+'</div>'
      +'</div>';
  });
  if(pending>0) html+='<div class="lad-note">2026-09-20 之后的新触发已计入「历史上出现」；「未满期 N 次 +x%」是它们到目前的浮动收益，等触发满 120 个交易日才并入「平均涨幅」和「上涨次数」两列。</div>';
  box.innerHTML=html;

  var sp=(window.BT_DATA||{}).spearman||{};
  $("rho20").textContent=sp["20"]!=null?sp["20"].toFixed(2):"—";
  $("rho60").textContent=sp["60"]!=null?sp["60"].toFixed(2):"—";
  $("rho120").textContent=sp["120"]!=null?sp["120"].toFixed(2):"—";

  var ob=$("ourBody"), BT=window.BT_DATA||{};
  if(ob){
    ob.innerHTML=(BT.triggers||[]).map(function(t){
      var h=t.h120||{};
      return '<tr><td class="txt">'+t.label+'</td>'
        +'<td>'+t.times+'</td><td>'+(h.n||0)+'</td>'
        +'<td class="'+(h.avg>=0?'up':'dn')+'">'+(h.avg>=0?'+':'')+(h.avg||0).toFixed(1)+'%</td>'
        +'<td>'+(h.win||0).toFixed(0)+'%</td>'
        +'<td class="'+(h.excess>=0?'up':'dn')+'">'+(h.excess>=0?'+':'')+(h.excess||0).toFixed(1)+'%</td></tr>';
    }).join('');
  }
  $("ourNote").innerHTML='口径：东方财富全市场真实截面，自建最小 400 只等权组合，<b>2018-01 起</b>；「完整样本」= 已走完 120 个交易日、可计算收益的次数。与上方原文口径不同（万得微盘、2016 起），数值不必相同，重点看<b>档位排序是否一致</b>。';
}

/* ============ 渲染：星级速览（相对估值展开面板） ============ */
/* 全部数字由 bt_data.js 的逐日序列现算，保证合并档位、子档位都能算，且口径一致 */
var STAR_ROWS=null;
function starCalc(pred){
  var S=((window.BT_DATA||{}).series)||[], HS=[20,60,120];
  var days=0, acc={};
  HS.forEach(function(h){ acc[h]={n:0,sum:0,win:0}; });
  for(var i=0;i<S.length;i++){
    if(!pred(S[i])) continue;
    days++;
    for(var q=0;q<3;q++){
      var h=HS[q], j=i+h;
      if(j>=S.length) continue;
      var r=(S[j].n/S[i].n-1)*100, c=acc[h];
      c.n++; c.sum+=r; if(r>0) c.win++;
    }
  }
  function fin(h){ var c=acc[h]; return c.n?{n:c.n,avg:c.sum/c.n,win:c.win*100/c.n}:{n:0,avg:null,win:null}; }
  return {days:days, h20:fin(20), h60:fin(60), h120:fin(120)};
}
function starRows(){
  if(STAR_ROWS) return STAR_ROWS;
  var S=((window.BT_DATA||{}).series)||[];
  if(S.length<120) return null;
  function sr(r){ var v=(r.o!=null?r.o:r.s); return Math.round(v*2)/2; }
  var rows=[
    {key:'low', name:'0–2 星', sub:0, pred:function(r){ return sr(r)<=2; },
     adv:'没到 3 星线，只作对照'},
    {key:'2.5', name:'2.5 星', sub:0, pred:function(r){ return sr(r)===2.5; },
     adv:'差半星到 3 星线，仍未达标'},
    {key:'3',   name:'3 星',   sub:0, pred:function(r){ return sr(r)===3; },
     adv:'刚够 3 星线，属预警档：先备资金，不算入场'},
    {key:'3pb', name:'3 星 + PB&lt;2', sub:1, pred:function(r){ return sr(r)===3 && r.p<2; },
     adv:'3 星里再叠加 PB&lt;2'},
    {key:'3.5', name:'3.5 星', sub:0, pred:function(r){ return sr(r)===3.5; },
     adv:'跨过 3 星线半档'},
    {key:'4',   name:'4 星',   sub:0, pred:function(r){ return sr(r)===4; },
     adv:'胜率明显抬升'},
    {key:'4.5', name:'4.5 星', sub:0, pred:function(r){ return sr(r)===4.5; },
     adv:'接近满分'},
    {key:'5',   name:'5 星',   sub:0, pred:function(r){ return sr(r)===5; },
     adv:'满分档'}
  ];
  var tot=S.length;
  rows.forEach(function(x){
    var o=starCalc(x.pred);
    x.days=o.days; x.share=o.days/tot*100; x.h20=o.h20; x.h60=o.h60; x.h120=o.h120;
  });
  STAR_ROWS=rows; STAR_ROWS.total=tot;
  return STAR_ROWS;
}
function starKRow(rows,k){
  for(var i=0;i<rows.length;i++){ if(rows[i].key===String(k)) return rows[i]; }
  return null;
}
function starStat(k){
  var rows=starRows(); if(!rows) return null;
  var r=starKRow(rows,k); return (r&&r.h120&&r.h120.n)?r:null;
}
/* 星级：0–5，半星按比例裁切（两层同字叠放，上层宽度＝亮的部分） */
function starHTML(v){
  var x=Math.max(0,Math.min(5,(v==null?0:v)));
  var w=(x/5*100).toFixed(2);
  return '<span class="st5" style="--w:'+w+'%"><span class="e">★★★★★</span><span class="f">★★★★★</span></span>';
}
function fmtStar(v){ if(v==null||isNaN(v)) return '—'; var r=Math.round(v*2)/2; return (r%1===0?String(r):r.toFixed(1)); }
function pctW(h){ return h&&h.win!=null? Math.round(h.win)+'%' : '—'; }
function pctR(h){ return h&&h.avg!=null? ((h.avg>=0?'+':'−')+Math.abs(h.avg).toFixed(1)+'%') : '—'; }
function pctN(v){ return (v>=0?'+':'\u2212')+Math.abs(v).toFixed(1)+'%'; }
/* 星级构成：三个参照系并列，结构完全一致（参照点 / 参照 PB / 得星） */
function renderBreakdown(d){
  var detail=d.signal_detail||{}, keys=Object.keys(detail);
  var A=[], B=[], C=[], longKey=null;
  keys.forEach(function(k){
    if(k.indexOf("纵向")>=0){ longKey=k; return; }
    (/巨盘|大盘|中盘|小盘/.test(k) ? B : C).push(k);
  });
  function row(name, extra, pb, pts, ok){
    return '<tr class="'+(ok?'hit':'')+'"><td>'+name+(extra?'<span class="rng">'+extra+'</span>':'')+'</td>'
      +'<td class="r">'+fmt(pb,3)+'</td>'
      +'<td class="r">'+(pts>0?'<span class="y">+'+fmtStar(pts)+' 星</span>':'<span class="z">0</span>')+'</td></tr>';
  }
  function sumOf(list, w){
    var t=0; list.forEach(function(k){ if(detail[k]&&detail[k].ok) t+=w; }); return t;
  }
  var rowsB=[], rowsC=[];
  B.forEach(function(k){
    var v=detail[k], m=/^(.+?)\((\d+)\s*-\s*(\d+)\)/.exec(k);
    rowsB.push(row(m?m[1]:k, m?(' '+m[2]+'–'+m[3]+' 名'):'', v.value, v.ok?0.5:0, v.ok));
  });
  C.forEach(function(k){
    var v=detail[k];
    rowsC.push(row(k, '', v.value, v.ok?0.5:0, v.ok));
  });
  var rowsA='';
  if(longKey){
    var lv=detail[longKey];
    rowsA=row('1800 日 25% 分位', '', lv.value, lv.ok?1:0, lv.ok);
  }
  var bgA=longKey?(detail[longKey].ok?1:0):0, bgB=sumOf(B,0.5), bgC=sumOf(C,0.5);
  var hA=$("bhA");
  if(hA) hA.innerHTML = longKey
    ? ('当前微盘 PB <b>'+fmt(d.micro_pb,3)+'</b> '+(detail[longKey].ok?'低于':'高于')+' 分位线 <b>'+fmt(detail[longKey].value,3)
       +'</b>，本组得 <b>'+(bgA?'1':'0')+' 星</b>。分位线按近 1800 个交易日滚动计算，每天盘后重算。')
    : '这一项需要逐日 PB 历史才能算，暂缺。';

  var empty='<tr><td colspan="3" class="bempty">运行更新脚本后可查看逐项对比</td></tr>';
  $("brkBodyA").innerHTML = rowsA || empty;
  $("brkBodyB").innerHTML = rowsB.length?rowsB.join('') : '<tr><td colspan="3" class="bempty">4 个自编分层暂未取到</td></tr>';
  $("brkBodyC").innerHTML = rowsC.length?rowsC.join('') : '<tr><td colspan="3" class="bempty">4 个宽基成分暂未取到</td></tr>';
  $("bgA").textContent=bgA?'+'+fmtStar(bgA)+' 星':'0';
  $("bgB").textContent=bgB?'+'+fmtStar(bgB)+' 星':'0';
  $("bgC").textContent=bgC?'+'+fmtStar(bgC)+' 星':'0';
  /* 小标题里的「N 项 · X 星」由数据现算，避免写死后与实际得星不符 */
  [["bhItemA", longKey?1:0, bgA],["bhItemB", B.length, bgB],["bhItemC", C.length, bgC]].forEach(function(t){
    var el=$(t[0]); if(el) el.textContent=t[1]+' 项 · '+(t[2]>0?fmtStar(t[2])+' 星':'0 星');
  });
  document.querySelectorAll('.bref .bcol')[0].classList.toggle('void', bgA<=0);
  document.querySelectorAll('.bref .bcol')[1].classList.toggle('void', bgB<=0);
  document.querySelectorAll('.bref .bcol')[2].classList.toggle('void', bgC<=0);
  var SUM=$("sgSum");
  if(SUM) SUM.innerHTML='合计 <b>'+(d.signal!=null?fmtStar(d.signal):fmtStar(bgA+bgB+bgC))+' 星</b>';
}
function renderStar(d){
  var _cs=curStar(d), cs=(_cs.s==null?0:Math.max(0,Math.min(5,Math.round(_cs.s))));
  var pb=(d&&d.micro_pb!=null)?d.micro_pb:(btRow(d&&d.date)||{}).p;
  var pbLow=(pb!=null && pb<2);
  var sig=(d&&d.signal!=null)?d.signal:(_cs.s!=null?_cs.s:null);
  var curKey = tierKey(sig!=null?sig:cs, pb);
  var rows=starRows()||[];
  var cur=starKRow(rows,curKey);

  /* —— 星级画在卡片标题行（见 setCond），这里只画进度条与差距 —— */
  var flag=$("sgFlag");
  if(flag){
    var ok=sig!=null&&sig>=3;
    flag.className='sg-flag'+(ok?' on':'');
    flag.textContent = ok? '已过 3 星线'
      : (sig!=null? ('距 3 星还差 '+fmtStar(3-sig)+' 星') : '数据不足');
  }
  var fl=$("sgFill");
  if(fl) fl.style.width=Math.max(1.5,Math.min(100,(sig!=null?sig:0)/5*100))+'%';
  $("smDate").innerHTML = fmtDate(d.date)+' 收盘 · 微盘 PB '
    +(pb!=null?fmt(pb,3):'—')+(pbLow?'（已低于 2.0）':'');

  var kpi=$("sgKpi");
  if(kpi){
    if(!cur){
      kpi.innerHTML='<div class="sg-cell"><div class="k">历史统计</div><div class="v">—</div>'
        +'<div class="s">需载入 bt_data.js 逐日序列</div></div>';
    }else{
      kpi.innerHTML=
        '<div class="sg-cell"><div class="k">历史上处于这一档</div>'
          +'<div class="v">'+cur.days+'<em>个交易日</em></div>'
          +'<div class="s">占全部 '+(cur.share!=null?cur.share.toFixed(1):'—')+'%</div></div>'
        +'<div class="sg-cell"><div class="k">120 日后胜率</div>'
          +'<div class="v">'+pctW(cur.h120)+'</div>'
          +'<div class="s">'+(cur.h120&&cur.h120.n?cur.h120.n+' 个样本':'样本不足')+'</div></div>'
        +'<div class="sg-cell"><div class="k">120 日后平均涨幅</div>'
          +'<div class="v" style="color:'+((cur.h120&&cur.h120.avg>=0)?'#C0392B':'#0E8C63')+'">'
          +(cur.h120&&cur.h120.avg!=null?pctN(cur.h120.avg):'—')+'</div>'
          +'<div class="s">'+(cur.h120&&cur.h120.n?cur.h120.n+' 个样本':'样本不足')+'</div></div>';
    }
  }

  /* —— 档位表：胜率与涨幅各占一列，不再挤在一个格子里 —— */
  var tb=$("starTable");
  if(tb){
    if(!rows.length){
      tb.innerHTML='<tr><td colspan="7" style="text-align:center;color:#A8B1BE;padding:12px">需载入 bt_data.js 的逐日序列</td></tr>';
    }else{
      function cell(h, sep){
        var w=pctW(h), r=(h&&h.avg!=null)?pctN(h.avg):'—';
        var c=(h&&h.avg!=null)?(h.avg>=0?'#C0392B':'#0E8C63'):'#B6BFCB';
        return '<td'+(sep?' class="gsep"':'')+'><span class="wr">'+w+'</span></td>'
          +'<td><span class="rr" style="color:'+c+'">'+r+'</span></td>';
      }
      tb.innerHTML=rows.map(function(r){
        var now=(r.key===curKey);
        return '<tr class="'+(now?'cur ':'')+(r.sub?'sub':'')+'">'
          +'<td><span class="sname">'+(r.sub?'<span class="subarrow">↳</span>':'')+r.name
            +(r.sub?'<span class="tagx">子集</span>':'')+'</span>'
            +'<em><s>·</s> '+r.days+' 天</em>'+(now?'<span class="nowpill">当前</span>':'')+'</td>'
          +cell(r.h20,0)+cell(r.h60,1)+cell(r.h120,1)
          +'</tr>';
      }).join('');
    }
  }
  /* 数据区间：说清这张表覆盖哪段时间，避免把「2148 个交易日」误读成别的口径 */
  var rg=$("stblRange");
  if(rg){
    var BT0=window.BT_DATA||{}, SS0=BT0.series||[], MT0=BT0.meta||{};
    var st0=MT0.start||(SS0.length?SS0[0].d:null);
    var en0=MT0.end||(SS0.length?SS0[SS0.length-1].d:null);
    var nd0=MT0.days||SS0.length;
    rg.innerHTML=(st0&&en0)
      ? '数据区间 <b>'+st0+'</b><span class="sep">→</span><b>'+en0+'</b>'
        +'<span class="sep">·</span>逐日 <b>'+nd0+'</b> 个交易日'
        +'<span class="sub">末端不足 20 / 60 / 120 天的样本不计入</span>'
      : '数据区间 —（需载入 bt_data.js）';
  }
  var f=$("smNote");
  if(f){
    var nLow=starKRow(rows,'low'), n3=starKRow(rows,'3'), n3p=starKRow(rows,'3pb');
    var r45=starKRow(rows,'4.5'), r5=starKRow(rows,'5');
    f.innerHTML='读法：<b>持有 N 个交易日</b>＝当天买入、第 N 个交易日卖出，不是「最近 N 个交易日」；'
      +'<b>胜率</b>＝这一档所有交易日里，N 日后收盘高于当天的比例；<b>平均涨幅</b>＝同一批样本 N 日涨跌幅的均值，红色为涨、绿色为跌。'
      +'口径是把上面这段区间逐日记档，再看此后的表现，<b>不是</b>「从 3 星拿到 5 星」的累计。'
      +'0–2 星合成一行（'+(nLow?nLow.days:0)+' 天）只作对照，往上半星一档；'
      +'「3 星 + PB&lt;2」是从 '+(n3?n3.days:0)+' 天的 3 星里再筛出 PB&lt;2 的 '+(n3p?n3p.days:0)+' 天，'
      +'<b>和 3 星那行有重叠</b>，不是额外一档。'
      +'4.5 / 5 星样本很少（'+(starKRow(rows,'4.5')?starKRow(rows,'4.5').days:0)+' / '
      +(starKRow(rows,'5')?starKRow(rows,'5').days:0)+' 天），误差大，只看方向。';
  }
}

/* ============ 渲染：历史回溯 ============ */
function deepLows(){
  var S=((window.BT_DATA||{}).series)||[];
  if(S.length<80) return null;
  var hi=[],h=-1e9,i;
  for(i=0;i<S.length;i++){ h=Math.max(h,S[i].n); hi[i]=h; }
  var dd=[]; for(i=0;i<S.length;i++) dd.push((S[i].n/hi[i]-1)*100);
  var T=-16, REC=-7, eps=[], cur=null;
  for(i=0;i<S.length;i++){
    if(dd[i]<=T){
      if(!cur) cur={from:i,to:i,trough:i,mdd:dd[i]};
      else { cur.to=i; if(dd[i]<cur.mdd){ cur.mdd=dd[i]; cur.trough=i; } }
    }else if(cur&&dd[i]>=REC){ cur.to=i; eps.push(cur); cur=null; }
  }
  var open=!!cur; if(cur) eps.push(cur);
  eps.forEach(function(e,ix){
    var t=S[e.trough], n=e.trough;
    function f(k){ return (n+k<S.length)? (S[n+k].n/t.n-1)*100 : null; }
    e.no=ix+1; e.date=t.d; e.pb=t.p; e.sig=t.s; e.mdd=Math.round(e.mdd*10)/10;
    e.f20=f(20); e.f60=f(60); e.f120=f(120);
    e.art=ART_MOMENTS[t.d]||null;
    e.open=(open && ix===eps.length-1);
  });
  return {eps:eps, open:open, S:S, dd:dd[dd.length-1], ddAll:dd};
}
function renderDeep(d){
  var note=$("ddNote"), tb=$("ddBody"), rs=$("ddRule");
  var o=deepLows();
  if(!o || !o.eps || !o.eps.length){
    if(note) note.textContent='未载入 bt_data.js，暂时无法识别深跌';
    if(tb) tb.innerHTML="";
    return;
  }
  var S=o.S, last=o.eps[o.eps.length-1], cur=S[S.length-1];
  var reb=last? (cur.n/S[last.trough].n-1)*100 : null;
  var ddCur=o.dd;

  if(note){
    if(o.open&&last){
      note.innerHTML='正在第 <b>'+last.no+'</b> 次深跌的修复期：低点 <b>'+last.date+'</b>（−'
        +Math.abs(last.mdd).toFixed(1)+'%），此后<b>'+(reb>=0?'反弹 '+fmtSign(reb):'又跌 '+fmtSign(reb))+'</b>，'
        +'当前回撤收窄到 <b>'+ddCur.toFixed(1)+'%</b>。上图中紫色越深＝跌得越狠。';
    }else{
      note.innerHTML='当前距近一年高点 <b>'+ddCur.toFixed(1)+'%</b>，没到 16% 的深跌线，属于正常波动。'
        +'历史上共 <b>'+o.eps.length+'</b> 次深跌，上图紫色越深＝回撤越大。';
    }
  }

  if(tb){
    tb.innerHTML=o.eps.slice().reverse().map(function(e){
      function c(v){ return '<td class="'+(v==null?'':(v>=0?"up":"dn"))+'">'+(v==null?"—":fmtSign(v))+'</td>'; }
      return '<tr'+(e.art?' class="hot"':'')+'><td>'+e.date+(e.art?' ★':'')+'</td>'
        +'<td class="dn">'+e.mdd.toFixed(1)+'%</td><td>'+e.pb.toFixed(2)+'</td><td>'+e.sig+'</td>'
        +c(e.f20)+c(e.f60)+c(e.f120)+'</tr>';
    }).join("");
  }
  if(rs){
    var extra='';
    if(last && !last.art) extra='最近这一次（<b>'+last.date+'</b>，回撤 '+last.mdd.toFixed(1)+'%）不在原文那 4 次里，是这条规则自动补上的——以后每出现一次新的深跌，图上就会自动多一根紫柱，低点当天就能看到。';
    rs.innerHTML='识别规则：以自建微盘 400 只等权组合的净值为准，从<b>近一年最高点</b>回落达到 <b>16%</b> 起算，'
      +'到回撤收窄回 <b>7% 以内</b>为止算一段深跌，取这一段的最低点。它是<b>跌幅口径</b>，不是「三个信号同时成立」——'
      +'所以有些低点只成立 1 项（如 2018-10 只有估值成立），也有像 2024-02-07 那样三项全中。<br>'
      +'<b>★</b> 是原文点到的 4 个时刻，全部被同一条规则识别出来，日期完全对得上。'+extra;
  }
}
function renderTriggers(d){
  var body=$("trigBody"), BT=window.BT_DATA||{};
  if(!body)return;
  var all=[];
  (BT.triggers||[]).forEach(function(t){
    (t.detail||[]).forEach(function(x){
      all.push({d:x.date,label:t.label,h20:x.h20,h60:x.h60,h120:x.h120});
    });
  });
  all.sort(function(a,b){return b.d.localeCompare(a.d)});
  body.innerHTML=all.map(function(x){
    function c(v){ if(v==null)return '<td style="color:#B6BFCB">—</td>';
      return '<td class="'+(v>=0?'up':'dn')+'">'+(v>=0?'+':'')+v.toFixed(1)+'%</td>'; }
    return '<tr><td>'+x.d+'</td><td class="txt">'+x.label+'</td>'+c(x.h20)+c(x.h60)+c(x.h120)+'</tr>';
  }).join("");
  var noteEl=$("trigNote");
  if(noteEl)noteEl.innerHTML=all.length? '共 <b>'+all.length+'</b> 次触发（含重叠窗口：同一段行情可能被多个档位同时命中，因此各档次数不能相加）。空值表示触发后还没走完对应天数，或该日样本不足。' : "暂无明细数据";
}

/* ============ 数据流 ============ */
function applyData(d,src,silent){
  D=Object.assign({},d); D.source=src||d.source||"auto";
  if(window.PANO) PANO.reset();
  render();
  if(silent){ LS.set("lastLights",D.lights); LS.set("lastStamp",(D.date||"")+"|"+(D.updated_at||"")+"|"+D.source); lastLights=D.lights; lastStamp=LS.get("lastStamp",null); }
  else checkSignal("update");
}
function loadInitial(){
  if(manualData){ applyData(manualData,"manual",true); return; }
  if(autoData){ applyData(autoData,"auto",lastLights===null); return; }
  applyData(SNAPSHOT,"snapshot",true);
}
function pollData(){
  if(manualData)return;
  if(window.__INLINE_DATA__)return;   /* 数据已内联进页面，无需再拉 data/data.js */
  var s=document.createElement("script");
  s.src="data/data.js?t="+Date.now();
  s.onload=function(){
    if(!window.BOARD_DATA)return;
    var nd=window.BOARD_DATA;
    var stamp=(nd.date||"")+"|"+(nd.updated_at||"")+"|auto";
    if(stamp!==lastStamp){
      autoData=nd;
      var b=document.createElement("script");
      b.src="data/bt_data.js?t="+Date.now();
      b.onload=function(){
        applyData(nd,"auto",false); toast("数据已更新 → "+nd.date);
        setTimeout(function(){try{b.remove()}catch(e){}},500);
      };
      b.onerror=function(){ applyData(nd,"auto",false); };
      document.head.appendChild(b);
    }
    setTimeout(function(){try{s.remove()}catch(e){}},500);
  };
  s.onerror=function(){};
  document.head.appendChild(s);
}

/* ============ 提醒 ============ */
function checkSignal(reason){
  if(!D)return;
  var lights=D.lights||{};
  var prev=lastLights;
  var changed=prev&&["pb","signal","diffusion"].some(function(k){return !!prev[k]!==!!lights[k]});
  var isNew=!prev;
  if(reason==="update"&&cfg.daily&&D.light_count!==undefined){
    toast("今日 "+D.light_count+"/3 项成立 · PB "+fmt(D.micro_pb,3)+" · 信号 "+fmt(D.signal,1));
  }
  if(changed&&cfg.change){
    beep();
    var names={pb:"微盘 PB",signal:"做多信号",diffusion:"扩散指数"};
    var parts=[];
    ["pb","signal","diffusion"].forEach(function(k){
      if(!!prev[k]!==!!lights[k]) parts.push(names[k]+(lights[k]?" 已成立":" 已失效"));
    });
    var msg=parts.join(" · ")+"（"+D.light_count+"/3）";
    $("alertText").textContent="🔔 "+msg; $("alertBar").classList.add("show");
    desktopNotify("微盘信号变化",msg,D.light_count===3);
    setTimeout(function(){$("alertBar").classList.remove("show")},12000);
  }else if(D.light_count===3&&cfg.all&&(isNew||reason==="test")){
    beep();
    desktopNotify("⚠️ 三项条件全部成立","原文定义的抄底时刻，历史上极罕见",true);
    $("alertText").textContent="⚠️ 三项条件全部成立 —— 抄底时刻"; $("alertBar").classList.add("show");
  }
  if(reason==="test") toast("已按当前设置发送测试提醒");
  lastLights=lights; LS.set("lastLights",lights);
}

/* ============ 交互：圆环 ↔ 条件联动 ============ */
(function bindRing(){
  var map=[["rs1",1],["rs2",2],["rs3",3]];
  map.forEach(function(p){
    var seg=$(p[0]), row=$("gauge"+p[1]);
    if(!seg||!row)return;
    seg.addEventListener("mouseenter",function(){ row.classList.add("hot"); $("ringBox").classList.add("focus"); seg.classList.add("hot"); });
    seg.addEventListener("mouseleave",function(){ row.classList.remove("hot"); $("ringBox").classList.remove("focus"); seg.classList.remove("hot"); });
    row.addEventListener("mouseenter",function(){ seg.classList.add("hot"); $("ringBox").classList.add("focus"); });
    row.addEventListener("mouseleave",function(){ seg.classList.remove("hot"); $("ringBox").classList.remove("focus"); });
    // 手机没有悬停：点一下条件行，对应圆环段闪一下
    row.addEventListener("click",function(e){
      if(e.target.closest(".c-act"))return;
      seg.classList.add("hot"); $("ringBox").classList.add("focus");
      setTimeout(function(){seg.classList.remove("hot");$("ringBox").classList.remove("focus")},1400);
    });
  });
})();

/* 条件2 的两个展开面板：点「星级」（标题行右侧 或 当前状态那行）→ 星级构成；
   点「当前档位的历史表现」→ 档位历史。一次只开一个（怕页面被撑太长），默认都收起 */
(function(){
  var pA=$("sigPanel"), pB=$("histPanel");
  var bA=[$("val2"),$("cs2s")].filter(Boolean), bB=[$("cs2w")].filter(Boolean);
  if(!pA||!pB) return;
  function open(p,btns,v){
    if(!p) return;
    p.classList.toggle("open",v);
    btns.forEach(function(b){ b.setAttribute("aria-expanded",v?"true":"false"); });
  }
  function flip(p,btns,other,otherBtns){
    var v=!p.classList.contains("open");
    open(p,btns,v);
    if(v) open(other,otherBtns,false);
    if(v) setTimeout(function(){p.scrollIntoView({block:"nearest",behavior:"smooth"})},60);
  }
  bA.forEach(function(b){ b.addEventListener("click",function(e){ e.stopPropagation(); flip(pA,bA,pB,bB); }); });
  bB.forEach(function(b){ b.addEventListener("click",function(e){ e.stopPropagation(); flip(pB,bB,pA,bA); }); });
  window.__toggleSigPanel=function(force){
    var v=(force==null)? !pA.classList.contains("open") : !!force;
    open(pA,bA,v); if(v) open(pB,bB,false);
  };
})();

// 图上定位：滚到全景图并高亮对应面板
document.querySelectorAll(".c-act[data-pano]").forEach(function(el){
  el.addEventListener("click",function(e){
    e.stopPropagation();
    if(window.PANO) PANO.focusPanel(el.getAttribute("data-pano"));
  });
});
// 时间范围切换
document.querySelectorAll("[data-range]").forEach(function(el){
  el.addEventListener("click",function(){
    if(window.PANO) PANO.setRange(el.getAttribute("data-range"));
  });
});
var _rzT=null;
window.addEventListener("resize",function(){
  clearTimeout(_rzT); _rzT=setTimeout(function(){ if(window.renderPano) renderPano(); },220);
});

/* tooltip 点击（手机） */
document.querySelectorAll(".tip").forEach(function(el){
  el.addEventListener("click",function(e){ e.stopPropagation(); el.classList.toggle("open"); });
});
document.addEventListener("click",function(){ document.querySelectorAll(".tip.open").forEach(function(el){el.classList.remove("open")}); });

/* ============ 设置开关 ============ */
function bindSwitch(id,key,onEnable){
  var el=$(id);
  function paint(){el.className="switch"+(cfg[key]?" on":"")}
  paint();
  el.onclick=function(){
    cfg[key]=!cfg[key]; LS.set("cfg",cfg); paint();
    if(cfg[key]&&onEnable)onEnable();
    checkSignal("cfg");
  };
}
bindSwitch("swNotify","notify",function(){
  if("Notification" in window&&Notification.permission==="default") Notification.requestPermission().then(function(p){
    toast(p==="granted"?"✅ 通知权限已开启":"通知权限未开启，桌面提醒将不生效"); checkSignal("cfg");
  });
});
bindSwitch("swSound","sound");
bindSwitch("swChange","change");
bindSwitch("swAll","all");
bindSwitch("swDaily","daily");

/* ============ 事件 ============ */
$("btnTest").onclick=function(){
  if("Notification" in window&&Notification.permission==="default"){
    try{Notification.requestPermission().then(function(){checkSignal("cfg")})}catch(e){}
  }
  checkSignal("test");
};
$("btnCheck").onclick=function(){if(window.__INLINE_DATA__){toast("数据已内嵌在此页面，点「刷新」可重新读取");return}pollData();checkSignal("update");toast("已检查最新信号")};
$("btnRefresh").onclick=function(){if(window.__INLINE_DATA__){location.reload();return}pollData();toast("正在读取 data/data.js …")};
if(window.__INLINE_DATA__){                        /* 数据内联进页面了：不再发 data/*.js 请求，避免单文件打开时 404 */
  var _cb=$("btnCheck"); if(_cb)_cb.style.display="none";
}
$("btnSave").onclick=function(){
  var d={date:$("inDate").value.replace(/-/g,"/"),updated_at:"手动录入 "+new Date().toLocaleString("zh-CN"),
    micro_pb:parseFloat($("inPb").value),signal:parseFloat($("inSig").value),
    diffusion:parseFloat($("inDif").value),avg_mv:parseFloat($("inMv").value),
    median_mv:(D&&D.median_mv)||null, amount:(D&&D.amount)||null,
    q25:(D&&D.q25)||2.109,q25_source:(D&&D.q25_source)||"东财真实历史截面",
    thresholds:{pb:2.0,signal:3.0,diffusion:20.0},indices:{},signal_detail:{},history:(D&&D.history)||[]};
  if(Object.keys(d).some(function(k){return typeof d[k]==="number"&&isNaN(d[k])})){toast("⚠️ 请填满所有数值");return;}
  manualData=d;LS.set("manual",d);applyData(d,"manual",false);toast("✅ 已保存手动数据");
};
$("btnSnapshot").onclick=function(){manualData=SNAPSHOT;LS.set("manual",SNAPSHOT);applyData(SNAPSHOT,"snapshot",false);toast("已载入你提供的表格快照")};
$("btnRestore").onclick=function(){manualData=null;LS.set("manual",null);
  if(autoData)applyData(autoData,"auto",false);else applyData(SNAPSHOT,"snapshot",false);toast("已恢复自动数据")};
$("btnImport").onclick=function(){$("fileInput").click()};
$("fileInput").onchange=function(e){
  var f=e.target.files[0];if(!f)return;
  var r=new FileReader();r.onload=function(){try{var d=JSON.parse(r.result);manualData=d;LS.set("manual",d);applyData(d,"auto",false);toast("✅ 已导入 data.json")}catch(err){toast("⚠️ 文件格式不对")}};
  r.readAsText(f);e.target.value="";
};
$("btnExport").onclick=function(){
  var rows=[["日期","微盘PB","微盘做多信号","微盘扩散指数","平均市值","市值中位数","成交额(亿)","成立项数"],
    [D.date,D.micro_pb,D.signal,D.diffusion,D.avg_mv,D.median_mv,D.amount,D.light_count]];
  (D.history||[]).forEach(function(h){rows.push([h.date,h.pb,"","","","","",""])});
  var csv="\ufeff"+rows.map(function(r){return r.join(",")}).join("\n");
  var a=document.createElement("a");a.href=URL.createObjectURL(new Blob([csv],{type:"text/csv;charset=utf-8"}));
  a.download="微盘信号_"+String(D.date||"").replace(/\//g,"-")+".csv";a.click();toast("已导出 CSV");
};

loadInitial();
checkSignal("init");
setInterval(pollData,60000);
// bt_data.js / extra_hist.js 若比首屏渲染晚到，载入完成后补一次
window.addEventListener("load",function(){ if(D) render(); });
document.addEventListener("visibilitychange",function(){ if(!document.hidden&&D) render(); });

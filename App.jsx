import { useState, useEffect, useRef, useCallback } from "react";

// ─── Supabase config ──────────────────────────────────────────
const SB_URL = "https://rgspgaoqzpljwjkhqsmo.supabase.co";
const SB_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJnc3BnYW9xenBsandqa2hxc21vIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU5MTkwMjIsImV4cCI6MjA5MTQ5NTAyMn0.B0UXZVJ0pvUOnX6-WqQWjUh5RMYQTSysvJksDPStwY8";
const SB_HEADERS = { "Content-Type": "application/json", "apikey": SB_KEY, "Authorization": `Bearer ${SB_KEY}` };

// ─── Binance WebSocket ────────────────────────────────────────
const WS_TICKER = "wss://stream.binance.com:9443/ws/btcusdt@ticker";
const WS_DEPTH  = "wss://stream.binance.com:9443/ws/btcusdt@depth20@1000ms";

// ─── Constants ───────────────────────────────────────────────
const TRAJ_MIN  = 10;
const TRAJ_PTS  = 120;
const HIST_MIN  = 1440; // 24 ساعة
const UPDATE_MS = 10000;
const SAVE_MS   = 10000; // save to Supabase every 10s

const safeNum = (v, fb = 0) => { const n = Number(v); return isFinite(n) ? n : fb; };

function calcTrajectory(price, imb, startTime) {
  const endPrice = price * (1 + imb * 0.005);
  return Array.from({ length: TRAJ_PTS + 1 }, (_, i) => {
    const t    = i / TRAJ_PTS;
    const ease = t * t * (3 - 2 * t);
    const base = price + (endPrice - price) * ease;
    const wave = Math.sin(t * Math.PI * 2.5) * Math.abs(imb) * price * 0.00022 * (1 - t * 0.6);
    return { time: startTime + t * TRAJ_MIN * 60000, price: base + wave };
  });
}

function calcImbalance(hist) {
  if (hist.length < 2) return 0;
  const slice = hist.slice(-Math.min(hist.length, 5));
  const pct   = (slice.at(-1).price - slice[0].price) / slice[0].price;
  return Math.max(-1, Math.min(1, pct / 0.003));
}

// ─── Supabase helpers ─────────────────────────────────────────
async function sbSavePrice(price) {
  try {
    await fetch(`${SB_URL}/rest/v1/btc_prices`, {
      method: "POST",
      headers: { ...SB_HEADERS, "Prefer": "return=minimal" },
      body: JSON.stringify({ price }),
    });
  } catch (_) {}
}

async function sbLoadHistory() {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60000).toISOString();
    const res = await fetch(
      `${SB_URL}/rest/v1/btc_prices?select=time,price&time=gte.${since}&order=time.asc`,
      { headers: SB_HEADERS }
    );
    const rows = await res.json();
    return Array.isArray(rows)
      ? rows.map(r => ({ time: new Date(r.time).getTime(), price: safeNum(r.price) })).filter(r => r.price > 0)
      : [];
  } catch (_) { return []; }
}

// ─── Main Component ───────────────────────────────────────────
export default function App() {
  const canvasRef  = useRef(null);
  const priceHist  = useRef([]);
  const curTrajs   = useRef([]);
  const cloudTrajs = useRef([]);
  const lastMin    = useRef(null);
  const animId     = useRef(null);
  const pulseT     = useRef(0);
  const dpr        = useRef(1);
  const wsTickRef  = useRef(null);
  const wsDepthRef = useRef(null);
  const livePrice  = useRef(null);

  const [info, setInfo] = useState({
    price: null, change24h: 0, bidPct: 50, askPct: 50,
    connected: false, error: null, loaded: false,
  });

  // ── Load history from Supabase on mount ───────────────────
  useEffect(() => {
    sbLoadHistory().then(rows => {
      if (rows.length > 0) {
        priceHist.current = rows;
        setInfo(d => ({ ...d, loaded: true, price: rows.at(-1).price }));
      } else {
        setInfo(d => ({ ...d, loaded: true }));
      }
    });
  }, []);

  // ── Save price to Supabase every 10s ─────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (livePrice.current) sbSavePrice(livePrice.current);
    }, SAVE_MS);
    return () => clearInterval(id);
  }, []);

  // ── Trajectory builder every 10s ─────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      const price = livePrice.current;
      if (!price) return;
      const now = Date.now();
      const min = Math.floor(now / 60000);
      if (lastMin.current !== null && min !== lastMin.current) {
        cloudTrajs.current = [...cloudTrajs.current, ...curTrajs.current]
          .filter(t => now - t.t0 < 5 * 60000);
        curTrajs.current = [];
      }
      lastMin.current = min;
      const imb = calcImbalance(priceHist.current);
      const pts = calcTrajectory(price, imb, now);
      curTrajs.current.push({ t0: now, pts });
      if (curTrajs.current.length > 6) curTrajs.current.shift();
    }, UPDATE_MS);
    return () => clearInterval(id);
  }, []);

  // ── WebSocket: Ticker ────────────────────────────────────
  const connectTicker = useCallback(() => {
    if (wsTickRef.current) wsTickRef.current.close();
    const ws = new WebSocket(WS_TICKER);
    ws.onopen = () => setInfo(d => ({ ...d, connected: true, error: null }));
    ws.onmessage = e => {
      const d = JSON.parse(e.data);
      const price     = parseFloat(d.c);
      const change24h = parseFloat(d.P);
      if (!price) return;
      livePrice.current = price;
      const now = Date.now();
      priceHist.current.push({ time: now, price });
      priceHist.current = priceHist.current.filter(p => now - p.time < HIST_MIN * 60000);
      setInfo(d2 => ({ ...d2, price, change24h }));
    };
    ws.onerror = () => setInfo(d => ({ ...d, error: "خطأ في الاتصال" }));
    ws.onclose = () => { setInfo(d => ({ ...d, connected: false })); setTimeout(connectTicker, 3000); };
    wsTickRef.current = ws;
  }, []);

  // ── WebSocket: Depth ────────────────────────────────────
  const connectDepth = useCallback(() => {
    if (wsDepthRef.current) wsDepthRef.current.close();
    const ws = new WebSocket(WS_DEPTH);
    ws.onmessage = e => {
      const d = JSON.parse(e.data);
      const bidVol = (d.bids || []).reduce((s, [, q]) => s + parseFloat(q), 0);
      const askVol = (d.asks || []).reduce((s, [, q]) => s + parseFloat(q), 0);
      const total  = bidVol + askVol;
      const bidPct = total > 0 ? (bidVol / total) * 100 : 50;
      setInfo(d2 => ({ ...d2, bidPct, askPct: 100 - bidPct }));
    };
    ws.onclose = () => setTimeout(connectDepth, 3000);
    wsDepthRef.current = ws;
  }, []);

  useEffect(() => {
    connectTicker(); connectDepth();
    return () => { wsTickRef.current?.close(); wsDepthRef.current?.close(); };
  }, [connectTicker, connectDepth]);

  // ── Canvas DPR ───────────────────────────────────────────
  useEffect(() => {
    dpr.current = window.devicePixelRatio || 1;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr.current;
    canvas.height = rect.height * dpr.current;
  }, []);

  // ── Draw ────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    const d   = dpr.current;
    const W   = canvas.width  / d;
    const H   = canvas.height / d;
    const now = Date.now();
    pulseT.current = (pulseT.current + 0.025) % (Math.PI * 2);

    ctx.save();
    ctx.scale(d, d);

    const PL = 74, PR = 14, PT = 20, PB = 38;
    const CW = W - PL - PR, CH = H - PT - PB;
    const timeStart = now - HIST_MIN * 60000;
    const timeEnd   = now + TRAJ_MIN * 60000;
    const timeRange = timeEnd - timeStart;

    const allP = [
      ...priceHist.current.map(p => p.price),
      ...curTrajs.current.flatMap(t => t.pts.map(p => p.price)),
      ...cloudTrajs.current.flatMap(t => t.pts.map(p => p.price)),
    ];

    ctx.fillStyle = "#040810";
    ctx.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 3) { ctx.fillStyle = "rgba(0,0,0,0.06)"; ctx.fillRect(0, y, W, 1); }

    if (allP.length === 0) {
      ctx.fillStyle = "#1a2a3a"; ctx.font = "13px 'Courier New'"; ctx.textAlign = "center";
      ctx.fillText("جاري الاتصال بـ Binance...", W / 2, H / 2 - 10);
      ctx.fillStyle = "#0e1a26"; ctx.font = "10px 'Courier New'";
      ctx.fillText("بيانات مباشرة ومجانية", W / 2, H / 2 + 12);
      ctx.restore(); return;
    }

    const rawMin = Math.min(...allP), rawMax = Math.max(...allP);
    const pad  = Math.max((rawMax - rawMin) * 0.15, rawMin * 0.001);
    const minP = rawMin - pad, maxP = rawMax + pad, pRange = maxP - minP;
    const tx = t => PL + ((t - timeStart) / timeRange) * CW;
    const ty = p => PT + CH - ((p - minP) / pRange) * CH;
    const nowX = tx(now);

    // Grid
    ctx.lineWidth = 1;
    for (let m = -HIST_MIN; m <= TRAJ_MIN; m++) {
      const x = tx(now + m * 60000);
      if (x < PL - 1 || x > PL + CW + 1) continue;
      ctx.strokeStyle = "rgba(255,255,255,0.024)";
      ctx.beginPath(); ctx.moveTo(x, PT); ctx.lineTo(x, PT + CH); ctx.stroke();
    }
    for (let i = 0; i <= 6; i++) {
      const y = PT + (i / 6) * CH;
      ctx.strokeStyle = "rgba(255,255,255,0.024)";
      ctx.beginPath(); ctx.moveTo(PL, y); ctx.lineTo(PL + CW, y); ctx.stroke();
    }

    ctx.fillStyle = "rgba(0,0,0,0.14)";
    ctx.fillRect(PL, PT, Math.max(0, nowX - PL), CH);

    ctx.setLineDash([3, 5]); ctx.strokeStyle = "rgba(80,150,255,0.18)"; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nowX, PT); ctx.lineTo(nowX, PT + CH); ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = "9px 'Courier New'"; ctx.fillStyle = "rgba(60,90,130,0.4)"; ctx.textAlign = "center";
    if (nowX - PL > 55) ctx.fillText("السابق", PL + (nowX - PL) / 2, PT + 13);
    if (PL + CW - nowX > 55) ctx.fillText("التوقع", nowX + (PL + CW - nowX) / 2, PT + 13);

    // Cloud
    cloudTrajs.current.forEach(traj => {
      const a = Math.max(0.01, 0.11 - (now - traj.t0) / 1000 / 700);
      ctx.strokeStyle = `rgba(80,140,255,${a})`; ctx.lineWidth = 0.8;
      ctx.beginPath(); let s = false;
      traj.pts.forEach(p => {
        if (p.time < timeStart) return;
        const x = tx(p.time), y = ty(p.price);
        s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true);
      });
      ctx.stroke();
    });

    // Previous trajectories
    curTrajs.current.slice(0, -1).forEach((traj, idx, arr) => {
      const a  = 0.07 + (idx / Math.max(arr.length, 1)) * 0.2;
      const up = traj.pts.at(-1).price >= traj.pts[0].price;
      ctx.strokeStyle = up ? `rgba(0,210,120,${a})` : `rgba(255,55,95,${a})`; ctx.lineWidth = 1;
      ctx.beginPath(); let s = false;
      traj.pts.forEach(p => { const x = tx(p.time), y = ty(p.price); s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true); });
      ctx.stroke();
    });

    // Latest trajectory
    const latest = curTrajs.current.at(-1);
    if (latest) {
      const up = latest.pts.at(-1).price >= latest.pts[0].price;
      const cv = up ? "0,255,140" : "255,50,90";
      [[8,0.05],[4,0.11],[2,0.22]].forEach(([lw,a]) => {
        ctx.strokeStyle = `rgba(${cv},${a})`; ctx.lineWidth = lw;
        ctx.beginPath(); let s = false;
        latest.pts.forEach(p => { const x = tx(p.time), y = ty(p.price); s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true); });
        ctx.stroke();
      });
      const endX = tx(latest.pts.at(-1).time);
      const lg = ctx.createLinearGradient(nowX, 0, endX, 0);
      lg.addColorStop(0, `rgba(${cv},0.95)`); lg.addColorStop(0.45, `rgba(${cv},0.65)`); lg.addColorStop(1, `rgba(${cv},0.07)`);
      ctx.strokeStyle = lg; ctx.lineWidth = 2; ctx.shadowColor = `rgb(${cv})`; ctx.shadowBlur = 12;
      ctx.beginPath(); let s = false;
      latest.pts.forEach(p => { const x = tx(p.time), y = ty(p.price); s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true); });
      ctx.stroke(); ctx.shadowBlur = 0;
      const ep = latest.pts.at(-1);
      ctx.fillStyle = `rgba(${cv},0.75)`; ctx.beginPath(); ctx.arc(tx(ep.time), ty(ep.price), 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = "10px 'Courier New'"; ctx.fillStyle = `rgba(${cv},0.9)`; ctx.textAlign = "left";
      ctx.fillText(`$${ep.price.toLocaleString("en",{maximumFractionDigits:0})}`, tx(ep.time) + 6, ty(ep.price) + 4);
    }

    // Price history
    if (priceHist.current.length > 1) {
      const hg = ctx.createLinearGradient(PL, 0, nowX, 0);
      hg.addColorStop(0, "rgba(180,210,255,0.08)"); hg.addColorStop(1, "rgba(220,235,255,0.92)");
      ctx.strokeStyle = hg; ctx.lineWidth = 1.8;
      ctx.beginPath();
      priceHist.current.forEach((p, i) => { const x = tx(p.time), y = ty(p.price); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
      ctx.stroke();
    }

    // Pulsing dot
    const cp = priceHist.current.at(-1)?.price;
    if (cp !== undefined) {
      const cy    = ty(cp);
      const pulse = 0.4 + 0.6 * (Math.sin(pulseT.current) * 0.5 + 0.5);
      ctx.fillStyle = `rgba(255,255,255,${0.1 * pulse})`;
      ctx.beginPath(); ctx.arc(nowX, cy, 3 + pulse * 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff"; ctx.shadowColor = "#88ccff"; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(nowX, cy, 3.5, 0, Math.PI * 2); ctx.fill(); ctx.shadowBlur = 0;
      ctx.font = "bold 13px 'Courier New'"; ctx.fillStyle = "#ddeeff"; ctx.textAlign = "left";
      ctx.fillText(`$${cp.toLocaleString("en")}`, nowX + 10, cy - 7);
    }

    // Y labels
    ctx.font = "10px 'Courier New'"; ctx.fillStyle = "rgba(65,95,135,0.75)"; ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const p = minP + ((5 - i) / 5) * pRange;
      ctx.fillText(`$${safeNum(p).toFixed(0)}`, PL - 6, PT + (i / 5) * CH + 3);
    }

    // X labels
    ctx.textAlign = "center";
    for (let m = -4; m <= 10; m += 2) {
      const x = tx(now + m * 60000);
      if (x < PL || x > PL + CW) continue;
      ctx.fillStyle = m === 0 ? "rgba(100,175,255,0.95)" : "rgba(65,95,135,0.65)";
      ctx.font = m === 0 ? "bold 10px 'Courier New'" : "10px 'Courier New'";
      ctx.fillText(m === 0 ? "الآن" : `${m > 0 ? "+" : ""}${m}د`, x, PT + CH + 22);
    }

    ctx.restore();
  }, []);

  useEffect(() => {
    const loop = () => { draw(); animId.current = requestAnimationFrame(loop); };
    animId.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId.current);
  }, [draw]);

  const { price, change24h, bidPct, askPct, connected, error, loaded } = info;
  const ch24up   = change24h >= 0;
  const isUp     = bidPct >= askPct;
  const dotColor = error ? "#ff5566" : connected ? "#00ff88" : "#ffcc00";
  const statusText = error ? error : connected
    ? `متصل · بيانات مباشرة · ${loaded ? "تم تحميل السجل ✓" : "جاري تحميل السجل..."}`
    : "جاري الاتصال...";

  return (
    <div style={{ background:"#040810", minHeight:"100vh", color:"#c0d0e0", fontFamily:"'Courier New',Courier,monospace", direction:"rtl", display:"flex", flexDirection:"column", alignItems:"center", padding:"14px 10px", gap:10 }}>

      <div style={{ width:"100%", maxWidth:880, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <div style={{ width:8, height:8, borderRadius:"50%", background:dotColor, boxShadow:`0 0 8px ${dotColor}`, animation:"blink 2s infinite" }} />
          <span style={{ fontSize:10, color:"#334455" }}>{statusText}</span>
        </div>
        <span style={{ fontSize:12, color:"#1a2a3a", letterSpacing:3 }}>BTC/USDT · TRAJECTORY</span>
      </div>

      <div style={{ width:"100%", maxWidth:880, display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8 }}>
        {[
          { label:"السعر الحالي",  value: price ? `$${safeNum(price).toLocaleString("en",{maximumFractionDigits:0})}` : "---", color:"#c0d8ff" },
          { label:"تغيّر 24 ساعة", value: price ? `${ch24up?"▲":"▼"} ${Math.abs(safeNum(change24h)).toFixed(2)}%`       : "---", color:ch24up?"#00ff88":"#ff4466" },
          { label:"زخم الشراء",    value: price ? `${safeNum(bidPct).toFixed(0)}%` : "---", color:"#00dd77" },
          { label:"زخم البيع",     value: price ? `${safeNum(askPct).toFixed(0)}%` : "---", color:"#ff5577" },
        ].map(({label,value,color}) => (
          <div key={label} style={{ background:"rgba(255,255,255,0.025)", border:"1px solid rgba(255,255,255,0.05)", borderRadius:6, padding:"8px 10px", textAlign:"center" }}>
            <div style={{ fontSize:9, color:"#445566", marginBottom:3 }}>{label}</div>
            <div style={{ fontSize:16, fontWeight:"bold", color }}>{value}</div>
          </div>
        ))}
      </div>

      <div style={{ width:"100%", maxWidth:880 }}>
        <div style={{ display:"flex", height:4, borderRadius:2, overflow:"hidden" }}>
          <div style={{ flex:safeNum(bidPct,50), background:"linear-gradient(90deg,#002a14,#00aa55)", transition:"flex 0.8s ease" }} />
          <div style={{ flex:safeNum(askPct,50), background:"linear-gradient(90deg,#aa2233,#3a0008)", transition:"flex 0.8s ease" }} />
        </div>
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:9, color:"#334455", marginTop:3 }}>
          <span style={{color:"#009944"}}>ضغط شراء {isUp?"▲":""}</span>
          <span style={{color:"#993344"}}>ضغط بيع {!isUp?"▼":""}</span>
        </div>
      </div>

      <canvas ref={canvasRef} style={{ width:"100%", maxWidth:880, height:460, borderRadius:8, border:"1px solid rgba(255,255,255,0.04)", display:"block" }} />

      <div style={{ display:"flex", gap:18, fontSize:10, color:"#334455", flexWrap:"wrap", justifyContent:"center" }}>
        {[["#c0d8ff","السعر الفعلي"],["#00ff88","توقع صعود"],["#ff4466","توقع هبوط"],["rgba(80,140,255,0.55)","سحابة الدقيقة السابقة"]].map(([c,l])=>(
          <span key={l}><span style={{color:c,marginLeft:4}}>─</span>{l}</span>
        ))}
      </div>

      <div style={{ fontSize:9, color:"#111d2a" }}>
        Binance WebSocket · Supabase · مجاني 100% · يحفظ السجل ويستعيده · سجل 24 ساعة
      </div>

      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
    </div>
  );
}

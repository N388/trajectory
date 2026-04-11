import { useState, useEffect, useRef, useCallback } from "react";

// ─── Constants ───────────────────────────────────────────────
const TRAJ_MIN    = 10;       // minutes trajectory extends forward
const TRAJ_PTS    = 120;      // points per trajectory curve
const HIST_MIN    = 5;        // minutes of price history shown
const UPDATE_MS   = 10000;    // fetch interval (ms)
const VELOCITY_W  = 0.003;    // 0.3% price change = full imbalance signal

// ─── Helpers ─────────────────────────────────────────────────
const safeNum = (v, fallback = 0) => {
  const n = Number(v);
  return isFinite(n) ? n : fallback;
};

// Parse price from any Claude response format
function parsePrice(text) {
  // Format 1: pipe-separated  84250.5|1.23
  const pipe = text.match(/(\d[\d,]*\.?\d*)\s*\|\s*(-?[\d.]+)/);
  if (pipe) return { price: parseFloat(pipe[1].replace(/,/g, "")), change24h: parseFloat(pipe[2]) };

  // Format 2: JSON object
  try {
    const jm = text.match(/\{[\s\S]*?\}/);
    if (jm) {
      const obj = JSON.parse(jm[0]);
      if (obj.price) return { price: safeNum(obj.price), change24h: safeNum(obj.change24h) };
    }
  } catch (_) {}

  // Format 3: bare dollar number  $84,250.50
  const bare = text.match(/\$?([\d,]{4,}\.?\d*)/);
  if (bare) return { price: parseFloat(bare[1].replace(/,/g, "")), change24h: 0 };

  return null;
}

// Calculate imbalance from real price velocity (no fake order-book data)
function calcImbalance(hist) {
  if (hist.length < 2) return 0;
  const n     = Math.min(hist.length, 5);
  const slice = hist.slice(-n);
  const pct   = (slice.at(-1).price - slice[0].price) / slice[0].price;
  return Math.max(-1, Math.min(1, pct / VELOCITY_W));
}

// Build trajectory curve from current price + imbalance
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

// ─── Fetch Bitcoin price via Anthropic API + web search ──────
async function fetchBTCPrice() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model:      "claude-sonnet-4-20250514",
      max_tokens: 200,
      tools:      [{ type: "web_search_20250305", name: "web_search" }],
      messages:   [{
        role:    "user",
        content: `Search for the current Bitcoin (BTC) price in USD and its 24h percentage change.
Reply with ONLY two numbers separated by a pipe character, like: 84250.50|1.23
No other text. Negative change like: 84250.50|-1.23`
      }]
    })
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const text = data.content
    .filter(b => b.type === "text")
    .map(b => b.text)
    .join("");

  const parsed = parsePrice(text);
  if (!parsed || parsed.price < 1000 || parsed.price > 10_000_000) {
    throw new Error("Invalid price: " + text.slice(0, 80));
  }
  return parsed;
}

// ─── Main Component ───────────────────────────────────────────
export default function App() {
  // Persistent data (refs — no re-render needed)
  const priceHist  = useRef([]);
  const curTrajs   = useRef([]);
  const cloudTrajs = useRef([]);
  const lastMin    = useRef(null);
  const fetching   = useRef(false);
  const lastFetch  = useRef(null);
  const animId     = useRef(null);
  const pulseT     = useRef(0);
  const canvasRef  = useRef(null);
  const dpr        = useRef(1);

  const [status, setStatus] = useState({
    price:     null,
    change24h: 0,
    imb:       0,
    phase:     "loading",   // "loading" | "ok" | "error" | "fetching"
    countdown: UPDATE_MS / 1000,
    errMsg:    ""
  });

  // ── Fetch & update ────────────────────────────────────────
  const doFetch = useCallback(async () => {
    if (fetching.current) return;           // prevent concurrent calls
    fetching.current = true;
    lastFetch.current = Date.now();
    setStatus(s => ({ ...s, phase: s.price ? "fetching" : "loading" }));

    try {
      const { price, change24h } = await fetchBTCPrice();
      const now = Date.now();
      const min = Math.floor(now / 60000);

      // Minute boundary → promote to cloud
      if (lastMin.current !== null && min !== lastMin.current) {
        cloudTrajs.current = [
          ...cloudTrajs.current,
          ...curTrajs.current,
        ].filter(t => now - t.t0 < 5 * 60000);
        curTrajs.current = [];
      }
      lastMin.current = min;

      priceHist.current.push({ time: now, price });
      priceHist.current = priceHist.current.filter(p => now - p.time < HIST_MIN * 60000);

      const imb = calcImbalance(priceHist.current);
      const pts = calcTrajectory(price, imb, now);
      curTrajs.current.push({ t0: now, pts });
      if (curTrajs.current.length > 6) curTrajs.current.shift();

      setStatus(s => ({ ...s, price, change24h, imb, phase: "ok", errMsg: "" }));
    } catch (e) {
      setStatus(s => ({ ...s, phase: "error", errMsg: e.message }));
    } finally {
      fetching.current = false;
    }
  }, []);

  // ── Fetch interval ────────────────────────────────────────
  useEffect(() => {
    doFetch();
    const id = setInterval(doFetch, UPDATE_MS);
    return () => clearInterval(id);
  }, [doFetch]);

  // ── Countdown timer ───────────────────────────────────────
  useEffect(() => {
    const id = setInterval(() => {
      if (!lastFetch.current) return;
      const cd = Math.max(0, Math.ceil((UPDATE_MS - (Date.now() - lastFetch.current)) / 1000));
      setStatus(s => ({ ...s, countdown: cd }));
    }, 500);
    return () => clearInterval(id);
  }, []);

  // ── Canvas setup (DPR) ────────────────────────────────────
  useEffect(() => {
    dpr.current = window.devicePixelRatio || 1;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    canvas.width  = rect.width  * dpr.current;
    canvas.height = rect.height * dpr.current;
  }, []);

  // ── Draw ──────────────────────────────────────────────────
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx  = canvas.getContext("2d");
    const d    = dpr.current;
    const W    = canvas.width  / d;  // logical pixels
    const H    = canvas.height / d;
    const now  = Date.now();
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

    // ── Background ──────────────────────────────────────────
    ctx.fillStyle = "#040810";
    ctx.fillRect(0, 0, W, H);
    // scanlines
    for (let y = 0; y < H; y += 3) {
      ctx.fillStyle = "rgba(0,0,0,0.06)";
      ctx.fillRect(0, y, W, 1);
    }

    // ── Loading screen ──────────────────────────────────────
    if (allP.length === 0) {
      ctx.fillStyle = "#1a2a3a";
      ctx.font = `13px 'Courier New'`;
      ctx.textAlign = "center";
      ctx.fillText("جاري جلب سعر البيتكوين…", W / 2, H / 2 - 14);
      ctx.fillStyle = "#0e1a26";
      ctx.font = `10px 'Courier New'`;
      ctx.fillText("Claude يبحث عبر الإنترنت", W / 2, H / 2 + 8);
      ctx.restore();
      return;
    }

    const rawMin = Math.min(...allP), rawMax = Math.max(...allP);
    const pad  = Math.max((rawMax - rawMin) * 0.15, rawMin * 0.001);
    const minP = rawMin - pad, maxP = rawMax + pad, pRange = maxP - minP;
    const tx = t => PL + ((t - timeStart) / timeRange) * CW;
    const ty = p => PT + CH - ((p - minP) / pRange) * CH;
    const nowX = tx(now);

    // ── Grid ────────────────────────────────────────────────
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

    // Past zone dim
    ctx.fillStyle = "rgba(0,0,0,0.14)";
    ctx.fillRect(PL, PT, Math.max(0, nowX - PL), CH);

    // Now line
    ctx.setLineDash([3, 5]);
    ctx.strokeStyle = "rgba(80,150,255,0.18)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(nowX, PT); ctx.lineTo(nowX, PT + CH); ctx.stroke();
    ctx.setLineDash([]);

    // Zone labels
    ctx.font = "9px 'Courier New'";
    ctx.fillStyle = "rgba(60,90,130,0.4)";
    ctx.textAlign = "center";
    if (nowX - PL > 55) ctx.fillText("السابق", PL + (nowX - PL) / 2, PT + 13);
    if (PL + CW - nowX > 55) ctx.fillText("التوقع", nowX + (PL + CW - nowX) / 2, PT + 13);

    // ── Cloud (past-minute trajectories) ────────────────────
    cloudTrajs.current.forEach(traj => {
      const ageSec = (now - traj.t0) / 1000;
      const α = Math.max(0.012, 0.11 - ageSec / 700);
      ctx.strokeStyle = `rgba(80,140,255,${α})`;
      ctx.lineWidth = 0.8;
      ctx.beginPath();
      let s = false;
      traj.pts.forEach(p => {
        if (p.time < timeStart) return;
        const x = tx(p.time), y = ty(p.price);
        s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true);
      });
      ctx.stroke();
    });

    // ── Previous trajectories in current minute ──────────────
    curTrajs.current.slice(0, -1).forEach((traj, idx, arr) => {
      const α  = 0.07 + (idx / Math.max(arr.length, 1)) * 0.2;
      const up = traj.pts.at(-1).price >= traj.pts[0].price;
      ctx.strokeStyle = up ? `rgba(0,210,120,${α})` : `rgba(255,55,95,${α})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      let s = false;
      traj.pts.forEach(p => {
        const x = tx(p.time), y = ty(p.price);
        s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true);
      });
      ctx.stroke();
    });

    // ── Latest trajectory (glowing) ─────────────────────────
    const latest = curTrajs.current.at(-1);
    if (latest) {
      const up = latest.pts.at(-1).price >= latest.pts[0].price;
      const cv = up ? "0,255,140" : "255,50,90";

      // Glow layers
      [[8, 0.05], [4, 0.11], [2, 0.22]].forEach(([lw, α]) => {
        ctx.strokeStyle = `rgba(${cv},${α})`;
        ctx.lineWidth = lw;
        ctx.beginPath();
        let s = false;
        latest.pts.forEach(p => {
          const x = tx(p.time), y = ty(p.price);
          s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true);
        });
        ctx.stroke();
      });

      // Main gradient line
      const endX = tx(latest.pts.at(-1).time);
      const lg = ctx.createLinearGradient(nowX, 0, endX, 0);
      lg.addColorStop(0, `rgba(${cv},0.95)`);
      lg.addColorStop(0.45, `rgba(${cv},0.65)`);
      lg.addColorStop(1, `rgba(${cv},0.07)`);
      ctx.strokeStyle = lg;
      ctx.lineWidth = 2;
      ctx.shadowColor = `rgb(${cv})`; ctx.shadowBlur = 12;
      ctx.beginPath();
      let s = false;
      latest.pts.forEach(p => {
        const x = tx(p.time), y = ty(p.price);
        s ? ctx.lineTo(x, y) : (ctx.moveTo(x, y), s = true);
      });
      ctx.stroke();
      ctx.shadowBlur = 0;

      // End dot + price tag
      const ep = latest.pts.at(-1);
      const ex = tx(ep.time), ey = ty(ep.price);
      ctx.fillStyle = `rgba(${cv},0.75)`;
      ctx.beginPath(); ctx.arc(ex, ey, 3, 0, Math.PI * 2); ctx.fill();
      ctx.font = "10px 'Courier New'";
      ctx.fillStyle = `rgba(${cv},0.9)`;
      ctx.textAlign = "left";
      ctx.fillText(`$${ep.price.toLocaleString("en", { maximumFractionDigits: 0 })}`, ex + 6, ey + 4);
    }

    // ── Price history line ───────────────────────────────────
    if (priceHist.current.length > 1) {
      const hg = ctx.createLinearGradient(PL, 0, nowX, 0);
      hg.addColorStop(0, "rgba(180,210,255,0.08)");
      hg.addColorStop(1, "rgba(220,235,255,0.92)");
      ctx.strokeStyle = hg;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      priceHist.current.forEach((p, i) => {
        const x = tx(p.time), y = ty(p.price);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      });
      ctx.stroke();
    }

    // ── Current price dot (pulsing) ──────────────────────────
    const cp = priceHist.current.at(-1)?.price;
    if (cp !== undefined) {
      const cy    = ty(cp);
      const pulse = 0.4 + 0.6 * (Math.sin(pulseT.current) * 0.5 + 0.5);
      ctx.fillStyle = `rgba(255,255,255,${0.1 * pulse})`;
      ctx.beginPath(); ctx.arc(nowX, cy, 3 + pulse * 5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#fff";
      ctx.shadowColor = "#88ccff"; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(nowX, cy, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
      ctx.font = "bold 13px 'Courier New'";
      ctx.fillStyle = "#ddeeff";
      ctx.textAlign = "left";
      ctx.fillText(`$${cp.toLocaleString("en")}`, nowX + 10, cy - 7);
    }

    // ── Y labels ────────────────────────────────────────────
    ctx.font = "10px 'Courier New'";
    ctx.fillStyle = "rgba(65,95,135,0.75)";
    ctx.textAlign = "right";
    for (let i = 0; i <= 5; i++) {
      const p = minP + ((5 - i) / 5) * pRange;
      ctx.fillText(`$${safeNum(p).toFixed(0)}`, PL - 6, PT + (i / 5) * CH + 3);
    }

    // ── X labels ────────────────────────────────────────────
    ctx.textAlign = "center";
    for (let m = -4; m <= 10; m += 2) {
      const x = tx(now + m * 60000);
      if (x < PL || x > PL + CW) continue;
      const isNow = m === 0;
      ctx.fillStyle = isNow ? "rgba(100,175,255,0.95)" : "rgba(65,95,135,0.65)";
      ctx.font = isNow ? "bold 10px 'Courier New'" : "10px 'Courier New'";
      ctx.fillText(
        isNow ? "الآن" : `${m > 0 ? "+" : ""}${m}د`,
        x, PT + CH + 22
      );
    }

    ctx.restore();
  }, []);

  // ── Animation loop ────────────────────────────────────────
  useEffect(() => {
    const loop = () => { draw(); animId.current = requestAnimationFrame(loop); };
    animId.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animId.current);
  }, [draw]);

  // ── UI ────────────────────────────────────────────────────
  const { price, change24h, imb, phase, countdown, errMsg } = status;
  const isUp    = imb >= 0;
  const ch24up  = change24h >= 0;
  const bidPct  = Math.round(50 + safeNum(imb) * 50);
  const askPct  = 100 - bidPct;
  const imbPct  = (Math.abs(safeNum(imb)) * 100).toFixed(1);

  const dotColor = phase === "ok" ? "#00ff88"
                 : phase === "loading" ? "#3399ff"
                 : phase === "fetching" ? "#ffcc00"
                 : "#ff5566";
  const statusText =
    phase === "loading"  ? "جاري البحث عن السعر…"
    : phase === "fetching" ? `يحدّث… (${countdown}s)`
    : phase === "error"    ? `خطأ — إعادة المحاولة خلال ${countdown}s`
    : `تحديث خلال ${countdown}s`;

  return (
    <div style={{
      background: "#040810", minHeight: "100vh", color: "#c0d0e0",
      fontFamily: "'Courier New', Courier, monospace", direction: "rtl",
      display: "flex", flexDirection: "column", alignItems: "center",
      padding: "14px 10px", gap: 10,
    }}>
      {/* ─ Header ─ */}
      <div style={{ width: "100%", maxWidth: 880, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: dotColor, boxShadow: `0 0 8px ${dotColor}`, animation: "blink 2s infinite" }} />
          <span style={{ fontSize: 10, color: "#334455" }}>{statusText}</span>
        </div>
        <span style={{ fontSize: 12, color: "#1a2a3a", letterSpacing: 3 }}>BTC/USDT · TRAJECTORY</span>
      </div>

      {/* ─ Stats ─ */}
      <div style={{ width: "100%", maxWidth: 880, display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 8 }}>
        {[
          {
            label: "السعر الحالي",
            value: price ? `$${safeNum(price).toLocaleString("en", { maximumFractionDigits: 0 })}` : "---",
            color: "#c0d8ff",
          },
          {
            label: "تغيّر 24 ساعة",
            value: price ? `${ch24up ? "▲" : "▼"} ${Math.abs(safeNum(change24h)).toFixed(2)}%` : "---",
            color: ch24up ? "#00ff88" : "#ff4466",
          },
          {
            label: "زخم الشراء",
            value: price ? `${bidPct}%` : "---",
            color: "#00dd77",
          },
          {
            label: "زخم البيع",
            value: price ? `${askPct}%` : "---",
            color: "#ff5577",
          },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)", borderRadius: 6, padding: "8px 10px", textAlign: "center" }}>
            <div style={{ fontSize: 9, color: "#445566", marginBottom: 3 }}>{label}</div>
            <div style={{ fontSize: 16, fontWeight: "bold", color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* ─ Momentum bar ─ */}
      <div style={{ width: "100%", maxWidth: 880 }}>
        <div style={{ display: "flex", height: 4, borderRadius: 2, overflow: "hidden" }}>
          <div style={{ flex: bidPct, background: "linear-gradient(90deg,#002a14,#00aa55)", transition: "flex 0.8s ease" }} />
          <div style={{ flex: askPct, background: "linear-gradient(90deg,#aa2233,#3a0008)", transition: "flex 0.8s ease" }} />
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#334455", marginTop: 3 }}>
          <span style={{ color: "#009944" }}>ضغط شراء · {imbPct}%{isUp ? " ▲" : ""}</span>
          <span style={{ color: "#993344" }}>ضغط بيع{!isUp ? " ▼ · " + imbPct + "%" : ""}</span>
        </div>
      </div>

      {/* ─ Canvas ─ */}
      <canvas
        ref={canvasRef}
        style={{ width: "100%", maxWidth: 880, height: 460, borderRadius: 8, border: "1px solid rgba(255,255,255,0.04)", display: "block" }}
      />

      {/* ─ Legend ─ */}
      <div style={{ display: "flex", gap: 18, fontSize: 10, color: "#334455", flexWrap: "wrap", justifyContent: "center" }}>
        {[["#c0d8ff", "السعر الفعلي"], ["#00ff88", "توقع صعود"], ["#ff4466", "توقع هبوط"], ["rgba(80,140,255,0.55)", "سحابة الدقيقة السابقة"]].map(([c, l]) => (
          <span key={l}><span style={{ color: c, marginLeft: 4 }}>─</span>{l}</span>
        ))}
      </div>

      <div style={{ fontSize: 9, color: "#111d2a" }}>
        البيانات عبر Anthropic web search · زخم مبني على سرعة تغيّر السعر الفعلي
      </div>

      <style>{`@keyframes blink{0%,100%{opacity:1}50%{opacity:0.3}}`}</style>
    </div>
  );
}

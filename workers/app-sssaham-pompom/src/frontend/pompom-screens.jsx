import { useState, useEffect, useRef } from "react";

const SCREENS = ["dashboard", "paywall", "quiz", "sentiment", "reveal"];

// ─── SHARED ATOMS ────────────────────────────────────────────────────────────
const mono = { fontFamily: "'JetBrains Mono', monospace" };
const display = { fontFamily: "'Syne', sans-serif", fontWeight: 800 };
const C = {
  bg: "#080810",
  surface: "#0f0f1c",
  card: "#13131f",
  border: "#1c1c2e",
  amber: "#f59e0b",
  amberDim: "rgba(245,158,11,0.12)",
  green: "#10b981",
  greenDim: "rgba(16,185,129,0.12)",
  red: "#ef4444",
  redDim: "rgba(239,68,68,0.12)",
  blue: "#3b82f6",
  text: "#e2e2f0",
  muted: "#52526e",
  mutedLight: "#8888aa",
};

function NavBar({ screen, setScreen }) {
  const tabs = [
    { id: "dashboard", icon: "⬡", label: "Home" },
    { id: "quiz", icon: "◈", label: "Quiz" },
    { id: "sentiment", icon: "◉", label: "Vote" },
  ];
  return (
    <div style={{
      position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)",
      width: "100%", maxWidth: 390,
      background: "rgba(8,8,16,0.96)", borderTop: `1px solid ${C.border}`,
      display: "flex", justifyContent: "space-around", padding: "10px 0 18px",
      zIndex: 100, backdropFilter: "blur(12px)",
    }}>
      {tabs.map(t => (
        <button key={t.id} onClick={() => setScreen(t.id)}
          style={{
            background: "none", border: "none", cursor: "pointer",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
            color: screen === t.id ? C.amber : C.muted,
            transition: "color 0.2s",
          }}>
          <span style={{ fontSize: 20, lineHeight: 1 }}>{t.icon}</span>
          <span style={{ ...mono, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            {t.label}
          </span>
        </button>
      ))}
    </div>
  );
}

function Badge({ children, color = C.amber }) {
  return (
    <span style={{
      ...mono, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.12em",
      background: `${color}18`, border: `1px solid ${color}40`,
      color, padding: "3px 8px", borderRadius: 2,
    }}>{children}</span>
  );
}

function Pill({ children, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? C.amber : "transparent",
      border: `1px solid ${active ? C.amber : C.border}`,
      color: active ? "#000" : C.muted,
      ...mono, fontSize: 11, padding: "6px 14px", borderRadius: 4,
      cursor: "pointer", transition: "all 0.2s", fontWeight: active ? 700 : 400,
    }}>{children}</button>
  );
}

// ─── SCREEN 1: DASHBOARD ─────────────────────────────────────────────────────
function useCountdown(target) {
  const [remaining, setRemaining] = useState({ h: 16, m: 59, s: 0 });
  useEffect(() => {
    const id = setInterval(() => {
      setRemaining(r => {
        let { h, m, s } = r;
        if (s > 0) return { h, m, s: s - 1 };
        if (m > 0) return { h, m: m - 1, s: 59 };
        if (h > 0) return { h: h - 1, m: 59, s: 59 };
        return r;
      });
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return remaining;
}

function Dashboard({ setScreen }) {
  const { h, m, s } = useCountdown();
  const [pulse, setPulse] = useState(false);

  useEffect(() => {
    const id = setInterval(() => setPulse(p => !p), 1200);
    return () => clearInterval(id);
  }, []);

  const stocks = [
    { code: "BBYB", score: 87, votes: 642, dir: "▲" },
    { code: "UCID", score: 74, votes: 431, dir: "▲" },
    { code: "PGAS", score: 61, votes: 289, dir: "▽" },
  ];

  return (
    <div style={{ padding: "20px 20px 90px", background: C.bg, minHeight: "100%", position: "relative" }}>
      {/* BG GLOW */}
      <div style={{
        position: "absolute", top: -60, right: -60, width: 280, height: 280,
        background: `radial-gradient(circle, ${C.amberDim} 0%, transparent 70%)`,
        pointerEvents: "none",
      }} />

      {/* TOP BAR */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 28 }}>
        <div>
          <div style={{ ...mono, fontSize: 10, color: C.muted, letterSpacing: "0.1em", textTransform: "uppercase" }}>
            Selamat pagi,
          </div>
          <div style={{ ...display, fontSize: 22, color: C.text, marginTop: 2 }}>
            pom<span style={{ color: C.amber }}>pom</span>.ai
          </div>
        </div>
        <div style={{
          width: 40, height: 40, borderRadius: "50%",
          background: `linear-gradient(135deg, ${C.amber}, #f97316)`,
          display: "flex", alignItems: "center", justifyContent: "center",
          ...mono, fontSize: 14, color: "#000", fontWeight: 700,
        }}>K</div>
      </div>

      {/* COUNTDOWN CARD */}
      <div style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: "20px 20px",
        marginBottom: 16, position: "relative", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", inset: 0,
          background: `linear-gradient(135deg, ${C.amberDim} 0%, transparent 60%)`,
        }} />
        <div style={{ position: "relative" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <Badge>● Window Aktif</Badge>
            <div style={{ ...mono, fontSize: 10, color: C.muted }}>Reveal jam 08:59</div>
          </div>
          <div style={{ ...mono, fontSize: 46, color: C.amber, letterSpacing: "-0.02em", lineHeight: 1 }}>
            {String(h).padStart(2,"0")}:{String(m).padStart(2,"0")}:{String(s).padStart(2,"0")}
          </div>
          <div style={{ ...mono, fontSize: 10, color: C.muted, marginTop: 6 }}>
            menuju reveal serentak
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
            <div style={{
              flex: 1, background: `${C.amber}15`, border: `1px solid ${C.amber}30`,
              borderRadius: 8, padding: "10px 12px",
            }}>
              <div style={{ ...mono, fontSize: 10, color: C.muted, marginBottom: 4 }}>TIKET LO</div>
              <div style={{ ...display, fontSize: 18, color: C.amber }}>PRO</div>
              <div style={{ ...mono, fontSize: 10, color: C.amber }}>Rp 10.000 ✓</div>
            </div>
            <div style={{
              flex: 1, background: `${C.green}10`, border: `1px solid ${C.green}25`,
              borderRadius: 8, padding: "10px 12px",
            }}>
              <div style={{ ...mono, fontSize: 10, color: C.muted, marginBottom: 4 }}>KOMUNITAS</div>
              <div style={{ ...display, fontSize: 18, color: C.green }}>1,284</div>
              <div style={{ ...mono, fontSize: 10, color: C.green }}>voter aktif</div>
            </div>
          </div>
        </div>
      </div>

      {/* LIVE CANDIDATES PREVIEW */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
          <div style={{ ...mono, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            Kandidat (tersembunyi)
          </div>
          <Badge color={C.green}>● Live Vote</Badge>
        </div>
        {stocks.map((s, i) => (
          <div key={s.code} style={{
            background: C.card, border: `1px solid ${C.border}`,
            borderRadius: 8, padding: "12px 14px", marginBottom: 8,
            display: "flex", alignItems: "center", gap: 12,
            opacity: i === 0 ? 1 : i === 1 ? 0.7 : 0.45,
          }}>
            <div style={{
              width: 36, height: 36, borderRadius: 8,
              background: `linear-gradient(135deg, ${C.border}, ${C.surface})`,
              display: "flex", alignItems: "center", justifyContent: "center",
              ...mono, fontSize: 11, color: C.amber, fontWeight: 700,
            }}>?</div>
            <div style={{ flex: 1 }}>
              <div style={{ ...display, fontSize: 14, color: C.text }}>████</div>
              <div style={{ ...mono, fontSize: 10, color: C.muted, marginTop: 2 }}>
                {s.votes} votes · Score {s.score}
              </div>
            </div>
            <div style={{
              ...mono, fontSize: 13,
              color: s.dir === "▲" ? C.green : C.red,
            }}>{s.dir}</div>
          </div>
        ))}
      </div>

      {/* CTA */}
      <button onClick={() => setScreen("quiz")}
        style={{
          width: "100%", padding: "14px", borderRadius: 8,
          background: `linear-gradient(135deg, ${C.amber}, #f97316)`,
          border: "none", cursor: "pointer",
          ...display, fontSize: 15, color: "#000",
          letterSpacing: "0.02em",
        }}>
        Main Quiz Sekarang →
      </button>
    </div>
  );
}

// ─── SCREEN 2: PAYWALL ────────────────────────────────────────────────────────
function Paywall({ setScreen }) {
  const [selected, setSelected] = useState("pro");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const tiers = [
    {
      id: "starter", label: "STARTER", price: "5.000", reveal: "09:10",
      features: ["Top 5 kandidat", "Voting result", "Reveal 09:10"],
      color: C.blue,
    },
    {
      id: "pro", label: "PRO", price: "10.000", reveal: "09:05",
      features: ["Top 5 + detail scoring", "5 mnt lebih awal", "Priority reveal 09:05"],
      color: C.amber, best: true,
    },
  ];

  function handleBuy() {
    setLoading(true);
    setTimeout(() => { setLoading(false); setDone(true); }, 1800);
  }

  if (done) return (
    <div style={{
      padding: "40px 24px", background: C.bg, minHeight: "100%",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      gap: 16,
    }}>
      <div style={{
        width: 72, height: 72, borderRadius: "50%",
        background: `linear-gradient(135deg, ${C.green}, #059669)`,
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 32,
        boxShadow: `0 0 40px ${C.green}50`,
      }}>✓</div>
      <div style={{ ...display, fontSize: 28, color: C.text, textAlign: "center" }}>
        Tiket <span style={{ color: C.amber }}>PRO</span> aktif!
      </div>
      <div style={{ ...mono, fontSize: 12, color: C.muted, textAlign: "center" }}>
        Reveal jam 09:05 · Window aktif sampai besok pagi
      </div>
      <div style={{
        background: C.card, border: `1px solid ${C.green}30`,
        borderRadius: 12, padding: "16px 20px", width: "100%",
        textAlign: "center",
      }}>
        <div style={{ ...mono, fontSize: 10, color: C.muted, marginBottom: 6 }}>AKTIVITAS SAMBIL NUNGGU</div>
        <div style={{ ...mono, fontSize: 12, color: C.green }}>Quiz · Vote · Briefing AI</div>
      </div>
      <button onClick={() => setScreen("quiz")} style={{
        width: "100%", padding: "14px", borderRadius: 8,
        background: C.green, border: "none", cursor: "pointer",
        ...display, fontSize: 15, color: "#fff",
      }}>Main Quiz Sekarang →</button>
    </div>
  );

  return (
    <div style={{ padding: "24px 20px 100px", background: C.bg, minHeight: "100%", position: "relative" }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 200,
        background: `radial-gradient(ellipse at 50% 0%, rgba(245,158,11,0.1), transparent 70%)`,
        pointerEvents: "none" }} />

      <div style={{ ...mono, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>
        Beli Tiket Sesi Ini
      </div>
      <div style={{ ...display, fontSize: 28, color: C.text, marginBottom: 4 }}>
        Pilih tier<span style={{ color: C.amber }}>.</span>
      </div>
      <div style={{ ...mono, fontSize: 12, color: C.muted, marginBottom: 24 }}>
        Window tutup dalam <span style={{ color: C.amber }}>16:42:11</span>
      </div>

      {tiers.map(t => (
        <div key={t.id} onClick={() => setSelected(t.id)} style={{
          background: selected === t.id ? `${t.color}10` : C.card,
          border: `2px solid ${selected === t.id ? t.color : C.border}`,
          borderRadius: 12, padding: "18px 18px",
          marginBottom: 12, cursor: "pointer",
          transition: "all 0.2s", position: "relative",
        }}>
          {t.best && (
            <div style={{
              position: "absolute", top: -10, right: 16,
              background: C.amber, color: "#000",
              ...mono, fontSize: 9, fontWeight: 700, textTransform: "uppercase",
              padding: "3px 10px", borderRadius: 4, letterSpacing: "0.1em",
            }}>POPULER</div>
          )}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
            <div>
              <div style={{ ...mono, fontSize: 10, color: C.muted, marginBottom: 4 }}>{t.label}</div>
              <div style={{ ...display, fontSize: 26, color: t.color }}>
                Rp {t.price}
              </div>
              <div style={{ ...mono, fontSize: 10, color: C.muted }}>per sesi</div>
            </div>
            <div style={{
              background: `${t.color}15`, border: `1px solid ${t.color}30`,
              borderRadius: 8, padding: "8px 12px", textAlign: "right",
            }}>
              <div style={{ ...mono, fontSize: 9, color: C.muted }}>REVEAL</div>
              <div style={{ ...mono, fontSize: 18, color: t.color, fontWeight: 700 }}>{t.reveal}</div>
            </div>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {t.features.map(f => (
              <div key={f} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ color: t.color, fontSize: 10 }}>◆</span>
                <span style={{ ...mono, fontSize: 11, color: C.mutedLight }}>{f}</span>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* TRUST BADGES */}
      <div style={{
        display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap",
      }}>
        {["✓ Audit trail", "✓ Midtrans", "✓ No lock-in"].map(b => (
          <span key={b} style={{ ...mono, fontSize: 10, color: C.muted, background: C.surface,
            border: `1px solid ${C.border}`, padding: "4px 10px", borderRadius: 4 }}>{b}</span>
        ))}
      </div>

      <button onClick={handleBuy} style={{
        width: "100%", padding: "15px", borderRadius: 8,
        background: loading ? C.border : `linear-gradient(135deg, ${C.amber}, #f97316)`,
        border: "none", cursor: loading ? "default" : "pointer",
        ...display, fontSize: 16, color: loading ? C.muted : "#000",
        transition: "all 0.3s",
      }}>
        {loading ? "Memproses..." : `Beli Tiket ${selected.toUpperCase()} →`}
      </button>
    </div>
  );
}

// ─── SCREEN 3: AI QUIZ ────────────────────────────────────────────────────────
const QUESTIONS = [
  {
    q: "Saham dengan rasio utang/ekuitas di bawah 0.5 umumnya dianggap...",
    opts: ["Sangat berisiko", "Konservatif & sehat", "Overvalued", "Tidak likuid"],
    correct: 1, xp: 50,
    explain: "D/E rasio rendah artinya perusahaan tidak terlalu bergantung pada hutang. Ini sinyal kesehatan finansial jangka panjang.",
  },
  {
    q: "Broker asing melakukan net buy besar di saham small-cap. Ini kemungkinan sinyal...",
    opts: ["Distribusi", "Akumulasi smart money", "Window dressing", "Panic selling"],
    correct: 1, xp: 75,
    explain: "Net buy broker asing di small-cap sering jadi sinyal akumulasi sebelum gerakan besar.",
  },
  {
    q: "Volume anomali 3x rata-rata 20 hari tapi harga flat. Paling mungkin terjadi...",
    opts: ["Breakout gagal", "Akumulasi tersembunyi", "Likuiditas rendah", "Rights issue"],
    correct: 1, xp: 100,
    explain: "Volume tinggi tanpa pergerakan harga = tanda akumulasi diam-diam. Smart money masuk pelan.",
  },
];

function Quiz({ setScreen }) {
  const [qi, setQi] = useState(0);
  const [selected, setSelected] = useState(null);
  const [answered, setAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const [done, setDone] = useState(false);
  const [streak, setStreak] = useState(0);

  const q = QUESTIONS[qi];

  function handleAnswer(i) {
    if (answered) return;
    setSelected(i);
    setAnswered(true);
    if (i === q.correct) {
      setScore(s => s + q.xp);
      setStreak(s => s + 1);
    } else {
      setStreak(0);
    }
  }

  function next() {
    if (qi + 1 >= QUESTIONS.length) { setDone(true); return; }
    setQi(qi + 1); setSelected(null); setAnswered(false);
  }

  if (done) return (
    <div style={{ padding: "32px 24px 100px", background: C.bg, minHeight: "100%" }}>
      <div style={{ textAlign: "center", marginBottom: 32 }}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>🏆</div>
        <div style={{ ...display, fontSize: 32, color: C.amber }}>Sesi Selesai!</div>
        <div style={{ ...mono, fontSize: 13, color: C.muted, marginTop: 8 }}>
          Skor hari ini
        </div>
        <div style={{ ...mono, fontSize: 52, color: C.amber, fontWeight: 700, lineHeight: 1.1, marginTop: 8 }}>
          +{score} XP
        </div>
      </div>
      <div style={{
        background: C.card, border: `1px solid ${C.border}`, borderRadius: 12,
        padding: "16px 20px", marginBottom: 16,
      }}>
        <div style={{ ...mono, fontSize: 10, color: C.muted, marginBottom: 12, textTransform: "uppercase" }}>Akurasi hari ini</div>
        <div style={{ display: "flex", justifyContent: "space-around" }}>
          {[
            { label: "Benar", val: "3/3", color: C.green },
            { label: "Streak", val: `${streak}🔥`, color: C.amber },
            { label: "Rank", val: "#142", color: C.blue },
          ].map(s => (
            <div key={s.label} style={{ textAlign: "center" }}>
              <div style={{ ...display, fontSize: 22, color: s.color }}>{s.val}</div>
              <div style={{ ...mono, fontSize: 9, color: C.muted, textTransform: "uppercase" }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>
      <button onClick={() => setScreen("sentiment")} style={{
        width: "100%", padding: "14px", borderRadius: 8,
        background: `linear-gradient(135deg, ${C.amber}, #f97316)`,
        border: "none", cursor: "pointer",
        ...display, fontSize: 15, color: "#000",
      }}>Lanjut: Vote Saham →</button>
    </div>
  );

  return (
    <div style={{ padding: "24px 20px 100px", background: C.bg, minHeight: "100%" }}>
      {/* HEADER */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <div style={{ ...mono, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
            AI Questionnaire
          </div>
          <div style={{ ...display, fontSize: 20, color: C.text }}>
            Soal {qi + 1}/{QUESTIONS.length}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ ...mono, fontSize: 9, color: C.muted }}>XP HARI INI</div>
          <div style={{ ...mono, fontSize: 20, color: C.amber, fontWeight: 700 }}>+{score}</div>
        </div>
      </div>

      {/* PROGRESS */}
      <div style={{ background: C.surface, borderRadius: 4, height: 4, marginBottom: 24, overflow: "hidden" }}>
        <div style={{
          background: `linear-gradient(90deg, ${C.amber}, #f97316)`,
          height: "100%", width: `${((qi) / QUESTIONS.length) * 100}%`,
          transition: "width 0.4s ease", borderRadius: 4,
        }} />
      </div>

      {/* STREAK */}
      {streak > 1 && (
        <div style={{
          background: `${C.amber}15`, border: `1px solid ${C.amber}30`,
          borderRadius: 8, padding: "8px 14px", marginBottom: 16,
          display: "flex", gap: 8, alignItems: "center",
        }}>
          <span style={{ fontSize: 16 }}>🔥</span>
          <span style={{ ...mono, fontSize: 11, color: C.amber }}>
            Streak {streak}x! Bonus XP aktif
          </span>
        </div>
      )}

      {/* QUESTION */}
      <div style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: "20px", marginBottom: 16,
        position: "relative", overflow: "hidden",
      }}>
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, height: 3,
          background: `linear-gradient(90deg, ${C.amber}, #f97316)`,
        }} />
        <div style={{ ...mono, fontSize: 10, color: C.amber, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 10 }}>
          ◆ {q.xp} XP
        </div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 16, color: C.text, lineHeight: 1.5, fontWeight: 400 }}>
          {q.q}
        </div>
      </div>

      {/* OPTIONS */}
      <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        {q.opts.map((o, i) => {
          let bg = C.card, border = C.border, color = C.text;
          if (answered) {
            if (i === q.correct) { bg = C.greenDim; border = C.green; color = C.green; }
            else if (i === selected && i !== q.correct) { bg = C.redDim; border = C.red; color = C.red; }
          } else if (selected === i) {
            bg = C.amberDim; border = C.amber; color = C.amber;
          }
          return (
            <button key={i} onClick={() => handleAnswer(i)} style={{
              background: bg, border: `1px solid ${border}`,
              borderRadius: 8, padding: "14px 16px",
              display: "flex", gap: 12, alignItems: "center",
              cursor: answered ? "default" : "pointer", textAlign: "left",
              transition: "all 0.2s",
            }}>
              <span style={{ ...mono, fontSize: 11, color: border, minWidth: 20 }}>
                {answered && i === q.correct ? "✓" : answered && i === selected ? "✗" : String.fromCharCode(65+i)}
              </span>
              <span style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 14, color, fontWeight: 300 }}>{o}</span>
            </button>
          );
        })}
      </div>

      {/* EXPLANATION */}
      {answered && (
        <div style={{
          background: `${C.green}10`, border: `1px solid ${C.green}25`,
          borderRadius: 8, padding: "12px 14px", marginBottom: 16,
        }}>
          <div style={{ ...mono, fontSize: 9, color: C.green, textTransform: "uppercase", marginBottom: 6 }}>
            ◆ Insight
          </div>
          <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: C.mutedLight, lineHeight: 1.5 }}>
            {q.explain}
          </div>
        </div>
      )}

      {answered && (
        <button onClick={next} style={{
          width: "100%", padding: "14px", borderRadius: 8,
          background: `linear-gradient(135deg, ${C.amber}, #f97316)`,
          border: "none", cursor: "pointer",
          ...display, fontSize: 15, color: "#000",
        }}>
          {qi + 1 >= QUESTIONS.length ? "Lihat Hasil →" : "Soal Berikutnya →"}
        </button>
      )}
    </div>
  );
}

// ─── SCREEN 4: SENTIMENT BATTLE ───────────────────────────────────────────────
const CANDIDATES = [
  { code: "BBYB", name: "Bank Bisnis Indonesia", sector: "Perbankan", bull: 642, bear: 198 },
  { code: "UCID", name: "Uni-Charm Indonesia", sector: "Konsumer", bull: 431, bear: 312 },
  { code: "WIFI", name: "Solusi Net Pratama", sector: "Teknologi", bull: 289, bear: 401 },
];

function Sentiment() {
  const [votes, setVotes] = useState({ BBYB: null, UCID: null, WIFI: null });
  const [active, setActive] = useState("BBYB");

  const c = CANDIDATES.find(x => x.code === active);
  const total = c.bull + c.bear + (votes[active] ? 1 : 0);
  const myVote = votes[active];

  const bullPct = Math.round((c.bull + (myVote === "bull" ? 1 : 0)) / total * 100);
  const bearPct = 100 - bullPct;

  function vote(dir) {
    setVotes(v => ({ ...v, [active]: dir }));
  }

  return (
    <div style={{ padding: "24px 20px 100px", background: C.bg, minHeight: "100%" }}>
      {/* HEADER */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ ...mono, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 4 }}>
          Sentiment Battle
        </div>
        <div style={{ ...display, fontSize: 24, color: C.text }}>
          Vote <span style={{ color: C.amber }}>kandidat</span>
        </div>
        <div style={{ ...mono, fontSize: 11, color: C.muted, marginTop: 4 }}>
          Vote dilock saat reveal jam 08:59 · Hasil transparan
        </div>
      </div>

      {/* SELECTOR */}
      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {CANDIDATES.map(c => (
          <button key={c.code} onClick={() => setActive(c.code)} style={{
            flex: 1, padding: "8px 6px", borderRadius: 8,
            background: active === c.code ? C.amberDim : C.surface,
            border: `1px solid ${active === c.code ? C.amber : C.border}`,
            cursor: "pointer", transition: "all 0.2s",
          }}>
            <div style={{ ...mono, fontSize: 12, color: active === c.code ? C.amber : C.muted, fontWeight: 700 }}>
              {c.code}
            </div>
            {votes[c.code] && (
              <div style={{ fontSize: 10, marginTop: 2 }}>
                {votes[c.code] === "bull" ? "🟢" : "🔴"}
              </div>
            )}
          </button>
        ))}
      </div>

      {/* STOCK CARD */}
      <div style={{
        background: C.card, border: `1px solid ${C.border}`,
        borderRadius: 12, padding: "18px 18px", marginBottom: 16,
      }}>
        <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
          <div style={{ ...display, fontSize: 24, color: C.text }}>{c.code}</div>
          <Badge color={C.blue}>{c.sector}</Badge>
        </div>
        <div style={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13, color: C.muted, marginBottom: 16 }}>
          {c.name}
        </div>

        {/* BATTLE BAR */}
        <div style={{ marginBottom: 12 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
            <span style={{ ...mono, fontSize: 12, color: C.green }}>▲ BULL {bullPct}%</span>
            <span style={{ ...mono, fontSize: 12, color: C.red }}>BEAR {bearPct}% ▽</span>
          </div>
          <div style={{ background: C.redDim, borderRadius: 4, height: 10, overflow: "hidden", border: `1px solid ${C.red}20` }}>
            <div style={{
              background: `linear-gradient(90deg, ${C.green}, #059669)`,
              height: "100%", width: `${bullPct}%`,
              transition: "width 0.6s ease", borderRadius: 4,
            }} />
          </div>
          <div style={{ ...mono, fontSize: 10, color: C.muted, marginTop: 6, textAlign: "center" }}>
            {total} total votes · Hasil locked saat reveal
          </div>
        </div>
      </div>

      {/* VOTE BUTTONS */}
      {!myVote ? (
        <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
          <button onClick={() => vote("bull")} style={{
            flex: 1, padding: "16px", borderRadius: 10,
            background: C.greenDim, border: `2px solid ${C.green}`,
            cursor: "pointer", ...display, fontSize: 16, color: C.green,
            transition: "all 0.2s",
          }}>▲ BULL</button>
          <button onClick={() => vote("bear")} style={{
            flex: 1, padding: "16px", borderRadius: 10,
            background: C.redDim, border: `2px solid ${C.red}`,
            cursor: "pointer", ...display, fontSize: 16, color: C.red,
            transition: "all 0.2s",
          }}>▽ BEAR</button>
        </div>
      ) : (
        <div style={{
          background: myVote === "bull" ? C.greenDim : C.redDim,
          border: `1px solid ${myVote === "bull" ? C.green : C.red}40`,
          borderRadius: 10, padding: "14px 16px", marginBottom: 16,
          textAlign: "center",
        }}>
          <div style={{ ...mono, fontSize: 11, color: myVote === "bull" ? C.green : C.red }}>
            Vote lo tercatat: {myVote === "bull" ? "▲ BULL" : "▽ BEAR"} · Locked saat reveal
          </div>
        </div>
      )}

      {/* MINI ACTIVITY FEED */}
      <div style={{ background: C.surface, borderRadius: 10, padding: "12px 14px" }}>
        <div style={{ ...mono, fontSize: 9, color: C.muted, textTransform: "uppercase", marginBottom: 10, letterSpacing: "0.1em" }}>
          Aktivitas komunitas
        </div>
        {[
          { user: "R***a", action: "vote BULL BBYB", time: "2m" },
          { user: "D***i", action: "quiz +100 XP", time: "4m" },
          { user: "S***o", action: "vote BEAR WIFI", time: "5m" },
          { user: "A***n", action: "vote BULL UCID", time: "7m" },
        ].map((a, i) => (
          <div key={i} style={{
            display: "flex", justifyContent: "space-between",
            borderBottom: i < 3 ? `1px solid ${C.border}` : "none",
            padding: "6px 0",
          }}>
            <span style={{ ...mono, fontSize: 11, color: C.mutedLight }}>
              <span style={{ color: C.amber }}>{a.user}</span> {a.action}
            </span>
            <span style={{ ...mono, fontSize: 10, color: C.muted }}>{a.time}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── SCREEN 5: REVEAL ─────────────────────────────────────────────────────────
function Reveal() {
  const [phase, setPhase] = useState("pre"); // pre → revealing → done
  const [revealIdx, setRevealIdx] = useState(-1);

  const picks = [
    { rank: 1, code: "BBYB", name: "Bank Bisnis Indonesia", score: 87, bull: 76, signal: "Strong Buy", color: C.green },
    { rank: 2, code: "UCID", name: "Uni-Charm Indonesia", score: 74, bull: 58, signal: "Buy", color: C.green },
    { rank: 3, code: "WIFI", name: "Solusi Net Pratama", score: 61, bull: 42, signal: "Watch", color: C.amber },
    { rank: 4, code: "BREN", name: "Barito Renewables", score: 55, bull: 39, signal: "Watch", color: C.amber },
    { rank: 5, code: "NPGF", name: "Nusantara Properti", score: 41, bull: 31, signal: "Neutral", color: C.muted },
  ];

  function startReveal() {
    setPhase("revealing");
    let i = 0;
    const id = setInterval(() => {
      setRevealIdx(i);
      i++;
      if (i >= picks.length) { clearInterval(id); setPhase("done"); }
    }, 700);
  }

  if (phase === "pre") return (
    <div style={{
      padding: "0", background: C.bg, minHeight: "100%",
      display: "flex", flexDirection: "column",
    }}>
      {/* DRAMATIC TOP */}
      <div style={{
        flex: 1, display: "flex", flexDirection: "column", alignItems: "center",
        justifyContent: "center", padding: "40px 24px",
        background: `radial-gradient(ellipse at 50% 30%, rgba(245,158,11,0.15), transparent 70%)`,
      }}>
        <div style={{ ...mono, fontSize: 10, color: C.muted, textTransform: "uppercase", letterSpacing: "0.2em", marginBottom: 16 }}>
          Reveal Serentak
        </div>
        <div style={{ ...display, fontSize: 56, color: C.amber, lineHeight: 1, marginBottom: 8 }}>
          08:59
        </div>
        <div style={{ ...mono, fontSize: 13, color: C.muted, marginBottom: 32, textAlign: "center" }}>
          1,284 voter menunggu hasil yang sama
        </div>

        <div style={{
          display: "flex", gap: 8, marginBottom: 32, flexWrap: "wrap", justifyContent: "center",
        }}>
          {["🟢 642 BULL BBYB", "🔵 431 BULL UCID", "🔴 401 BEAR WIFI"].map(b => (
            <span key={b} style={{ ...mono, fontSize: 10, color: C.mutedLight,
              background: C.surface, border: `1px solid ${C.border}`,
              padding: "5px 10px", borderRadius: 4 }}>{b}</span>
          ))}
        </div>

        {/* CARDS STACK */}
        <div style={{ position: "relative", width: 200, height: 120, marginBottom: 32 }}>
          {[0,1,2,3,4].map(i => (
            <div key={i} style={{
              position: "absolute",
              left: `${i * 8}px`, top: `${i * 4}px`,
              width: 140, height: 90, borderRadius: 10,
              background: `linear-gradient(135deg, #1a1a2e, #0f0f1c)`,
              border: `1px solid ${C.border}`,
              boxShadow: `0 4px 20px rgba(0,0,0,0.5)`,
              display: "flex", alignItems: "center", justifyContent: "center",
              ...display, fontSize: 28, color: `${C.amber}${60 - i*10}`,
            }}>?</div>
          ))}
        </div>
      </div>

      <div style={{ padding: "0 24px 100px" }}>
        <button onClick={startReveal} style={{
          width: "100%", padding: "18px", borderRadius: 10,
          background: `linear-gradient(135deg, ${C.amber}, #f97316)`,
          border: "none", cursor: "pointer",
          ...display, fontSize: 18, color: "#000",
          boxShadow: `0 8px 32px ${C.amber}40`,
        }}>
          🃏 REVEAL SEKARANG
        </button>
        <div style={{ ...mono, fontSize: 10, color: C.muted, textAlign: "center", marginTop: 10 }}>
          Semua 1,284 user melihat hasil yang sama saat ini
        </div>
      </div>
    </div>
  );

  return (
    <div style={{ padding: "24px 20px 100px", background: C.bg, minHeight: "100%" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
        <div style={{ ...display, fontSize: 22, color: C.text }}>
          Top <span style={{ color: C.amber }}>5</span> Picks
        </div>
        {phase === "done" && <Badge color={C.green}>● Teraudit</Badge>}
      </div>
      <div style={{ ...mono, fontSize: 11, color: C.muted, marginBottom: 20 }}>
        Sesi {new Date().toLocaleDateString("id-ID")} · 1,284 voter
      </div>

      {picks.map((p, i) => (
        <div key={p.code} style={{
          background: C.card, border: `1px solid ${i <= revealIdx ? p.color + "40" : C.border}`,
          borderRadius: 12, padding: "14px 16px", marginBottom: 10,
          transition: "all 0.4s ease",
          opacity: i <= revealIdx ? 1 : 0.2,
          transform: i <= revealIdx ? "translateX(0)" : "translateX(20px)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{
              width: 32, height: 32, borderRadius: 8,
              background: i <= revealIdx ? `${p.color}20` : C.surface,
              border: `1px solid ${i <= revealIdx ? p.color + "50" : C.border}`,
              display: "flex", alignItems: "center", justifyContent: "center",
              ...mono, fontSize: 13, color: i <= revealIdx ? p.color : C.muted, fontWeight: 700,
            }}>
              {i <= revealIdx ? p.rank : "?"}
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ ...display, fontSize: 16, color: i <= revealIdx ? C.text : C.muted }}>{p.code}</span>
                {i <= revealIdx && (
                  <span style={{
                    ...mono, fontSize: 9, color: p.color,
                    background: `${p.color}15`, border: `1px solid ${p.color}30`,
                    padding: "2px 7px", borderRadius: 3,
                  }}>{p.signal}</span>
                )}
              </div>
              <div style={{ ...mono, fontSize: 10, color: C.muted, marginTop: 2 }}>
                {i <= revealIdx ? p.name : "████████"}
              </div>
            </div>
            {i <= revealIdx && (
              <div style={{ textAlign: "right" }}>
                <div style={{ ...mono, fontSize: 14, color: p.color, fontWeight: 700 }}>{p.score}</div>
                <div style={{ ...mono, fontSize: 9, color: C.muted }}>🟢 {p.bull}%</div>
              </div>
            )}
          </div>
        </div>
      ))}

      {phase === "done" && (
        <div style={{
          background: `${C.green}08`, border: `1px solid ${C.green}25`,
          borderRadius: 10, padding: "12px 16px", marginTop: 4,
          display: "flex", gap: 10, alignItems: "center",
        }}>
          <span style={{ fontSize: 16 }}>🔏</span>
          <div>
            <div style={{ ...mono, fontSize: 10, color: C.green, textTransform: "uppercase", marginBottom: 2 }}>
              Audit trail aktif
            </div>
            <div style={{ ...mono, fontSize: 10, color: C.muted }}>
              Hash: a3f9...cc12 · 1,284 vote verified
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ROOT ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [screen, setScreen] = useState("dashboard");

  return (
    <div style={{
      width: "100%", maxWidth: 390, margin: "0 auto",
      background: C.bg, minHeight: "100vh",
      fontFamily: "'DM Sans', sans-serif",
      position: "relative", overflow: "hidden",
    }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;700;800&family=JetBrains+Mono:wght@400;700&family=DM+Sans:wght@300;400&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 0; }
        button { font-family: inherit; }
      `}</style>

      {/* SCREEN LABEL */}
      <div style={{
        position: "fixed", top: 0, left: "50%", transform: "translateX(-50%)",
        width: "100%", maxWidth: 390, zIndex: 90,
        background: "rgba(8,8,16,0.92)", backdropFilter: "blur(12px)",
        borderBottom: `1px solid ${C.border}`,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "10px 20px",
      }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {["dashboard","paywall","quiz","sentiment","reveal"].map((s, i) => (
            <button key={s} onClick={() => setScreen(s)} style={{
              width: 28, height: 28, borderRadius: 6,
              background: screen === s ? C.amberDim : C.surface,
              border: `1px solid ${screen === s ? C.amber : C.border}`,
              cursor: "pointer", color: screen === s ? C.amber : C.muted,
              ...mono, fontSize: 10, transition: "all 0.2s",
              display: "flex", alignItems: "center", justifyContent: "center",
            }}>
              {i + 1}
            </button>
          ))}
        </div>
        <div style={{ ...mono, fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.1em" }}>
          {screen}
        </div>
      </div>

      <div style={{ paddingTop: 50, overflowY: "auto", maxHeight: "100vh" }}>
        {screen === "dashboard" && <Dashboard setScreen={setScreen} />}
        {screen === "paywall" && <Paywall setScreen={setScreen} />}
        {screen === "quiz" && <Quiz setScreen={setScreen} />}
        {screen === "sentiment" && <Sentiment />}
        {screen === "reveal" && <Reveal />}
      </div>

      {(screen !== "paywall" && screen !== "reveal") && (
        <NavBar screen={screen} setScreen={setScreen} />
      )}
    </div>
  );
}

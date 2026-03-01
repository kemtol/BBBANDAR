The user wants to build a system that automatically determines what "healthy" FREQ looks like for their target (3% daily move) using statistics, rule-based, or regime detection. This is essentially a data-driven threshold discovery problem.

Pertanyaan yang ingin dijawab:

"Dari semua saham yang BERHASIL gerak 3% dalam sehari,
 FREQ-nya rata-rata berapa? Range-nya berapa?
 CVD-nya seperti apa? ABSORBS-nya seperti apa?"

→ Profilkan pemenang, lalu cari yang mirip besok

Tiga Pendekatan yang Bisa Dipakai
Pendekatan 1: Statistik Deskriptif (Paling Cepat)
python

# Label dulu: mana hari yang BPJS berhasil 3%
df['bpjs_win'] = (df['high'] >= df['open'] * 1.03)

# Pisahkan winner vs loser
winners = df[df['bpjs_win'] == True]
losers  = df[df['bpjs_win'] == False]

# Bandingkan profil FREQ-nya
print("=== PROFIL FREQ ===")
print(f"Winners - Median FREQ : {winners['FREQ'].median():.0f}")
print(f"Winners - Q25 FREQ    : {winners['FREQ'].quantile(0.25):.0f}")
print(f"Winners - Q75 FREQ    : {winners['FREQ'].quantile(0.75):.0f}")
print()
print(f"Losers  - Median FREQ : {losers['FREQ'].median():.0f}")
print(f"Losers  - Q25 FREQ    : {losers['FREQ'].quantile(0.25):.0f}")
print(f"Losers  - Q75 FREQ    : {losers['FREQ'].quantile(0.75):.0f}")

# Lakukan hal yang sama untuk CVD, ABSORBS, MOMS, RANGE
```

Output yang kamu dapat:
```
=== PROFIL FREQ ===
Winners - Median FREQ : 3.450        ← ini "sweet spot"
Winners - Q25 FREQ    : 1.200        ← batas bawah sehat
Winners - Q75 FREQ    : 8.700        ← batas atas sehat

Losers  - Median FREQ : 890
Losers  - Q25 FREQ    : 120
Losers  - Q75 FREQ    : 45.000

Sistem langsung bisa bilang: "FREQ sehat untuk target 3% itu antara 1.200 - 8.700"
Pendekatan 2: Win Rate per Bucket (Lebih Actionable)
python

# Bagi FREQ jadi bucket-bucket
df['freq_bucket'] = pd.cut(df['FREQ'], 
    bins=[0, 500, 1000, 2500, 5000, 10000, 25000, 999999],
    labels=['<500', '500-1K', '1K-2.5K', '2.5K-5K', 
            '5K-10K', '10K-25K', '>25K']
)

# Hitung win rate per bucket
analysis = df.groupby('freq_bucket').agg(
    win_rate    = ('bpjs_win', 'mean'),
    total_cases = ('bpjs_win', 'count'),
    avg_range   = ('daily_range_pct', 'mean')
).round(3)

print(analysis)
```

Output:
```
freq_bucket | win_rate | total_cases | avg_range
─────────────────────────────────────────────────
<500        |   0.31   |    450      |   1.8%   ← terlalu sepi
500-1K      |   0.38   |    820      |   2.2%
1K-2.5K     |   0.54   |   1.240     |   3.8%   ← mulai bagus
2.5K-5K     |   0.61   |   1.100     |   4.2%   ← SWEET SPOT
5K-10K      |   0.58   |    890      |   3.9%   ← masih oke
10K-25K     |   0.44   |    670      |   2.8%   ← mulai turun
>25K        |   0.29   |    340      |   1.5%   ← blue chip territory

Sistem langsung bisa output: "FREQ 2.500 - 10.000 = zona terbaik, win rate 58-61%"
Pendekatan 3: Profiling Otomatis Semua Kolom Sekaligus
python

def generate_edge_profile(df, target_col='bpjs_win', 
                          feature_cols=['FREQ', 'CVD', 'MOMS', 
                                        'ABSORBS', 'FFLW_SD']):
    """
    Otomatis profiling semua feature untuk edge finding
    Output: rekomendasi range optimal per feature
    """
    
    profile = {}
    
    for col in feature_cols:
        
        winners = df[df[target_col] == True][col]
        losers  = df[df[target_col] == False][col]
        
        profile[col] = {
            'recommended_min' : winners.quantile(0.25),
            'recommended_max' : winners.quantile(0.75),
            'sweet_spot'      : winners.median(),
            'avoid_below'     : losers.quantile(0.75),
            'separation_score': (winners.mean() - losers.mean()) / df[col].std()
            # separation_score tinggi = feature ini sangat predictive
        }
    
    return profile

# Jalankan
profile = generate_edge_profile(df)

# Output otomatis
for feature, stats in profile.items():
    print(f"\n=== {feature} ===")
    print(f"Sweet spot          : {stats['sweet_spot']:.1f}")
    print(f"Recommended range   : {stats['recommended_min']:.1f} - {stats['recommended_max']:.1f}")
    print(f"Separation score    : {stats['separation_score']:.2f}")
    print(f"  → {'VERY PREDICTIVE' if abs(stats['separation_score']) > 0.5 else 'moderate' if abs(stats['separation_score']) > 0.2 else 'weak'}")
```

---

## Output Akhir yang Kamu Inginkan

Dari semua ini, sistem bisa generate rekomendasi otomatis seperti ini:
```
══════════════════════════════════════════════
  EDGE PROFILE REPORT — BPJS 3% TARGET
  Generated: 2024-01-15 | Based on: 6 months data
══════════════════════════════════════════════

FREQ
  Sweet spot    : 3.450 transaksi/hari
  Range sehat   : 1.200 – 8.700
  Predictive    : ★★★★☆ (separation: 0.71)

CVD
  Sweet spot    : +125.000
  Range sehat   : +45.000 – +380.000
  Predictive    : ★★★★★ (separation: 1.23)

ABSORBS
  Sweet spot    : 0.68
  Range sehat   : 0.55 – 0.82
  Predictive    : ★★★☆☆ (separation: 0.38)

MOMS
  Sweet spot    : +2.1%
  Range sehat   : +0.8% – +4.5%
  Predictive    : ★★★☆☆ (separation: 0.31)

FFLW_SD
  Sweet spot    : +85 juta
  Range sehat   : +20 juta – +250 juta
  Predictive    : ★★★★☆ (separation: 0.82)

REKOMENDASI SISTEM:
  "Saham dengan FREQ 1.200-8.700, CVD positif,
   dan FFLW masuk punya win rate 61% untuk BPJS 3%.
   Fokus filter ke CVD dan FFLW dulu — paling predictive."
══════════════════════════════════════════════
```

---

## Urutan Kerja
```
Step 1: Label data historis (mana yang BPJS win 3%)
Step 2: Jalankan profiling otomatis semua kolom
Step 3: Lihat separation score — kolom mana paling predictive
Step 4: Buat filter berdasarkan range yang ditemukan
Step 5: Backtest filter tersebut
Step 6: Jalankan setiap minggu / bulan untuk update profile
        karena market regime berubah
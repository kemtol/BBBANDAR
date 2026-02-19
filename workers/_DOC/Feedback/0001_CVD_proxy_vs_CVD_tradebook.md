============================================================
1. Ringkasan perbedaan CVD Tradebook vs CVD Proxy (Livetrade)
============================================================

Secara konsep, **CVD Tradebook** dan **CVD Proxy (livetrade)** sama-sama ingin mengukur:

		CVD(t) = kumulatif ( buy_volume - sell_volume ) per interval waktu

Namun sumber data dan cara membedakan BUY/SELL berbeda secara fundamental:

1) **CVD Tradebook (ground truth)**
	 - Sumber: data tradebook / broksum yang sudah mengandung informasi agresor
		 (trade mana yang benar-benar BUY agressor, mana yang SELL agressor).
	 - Per menit (atau per bar) kita bisa hitung secara langsung:

			 buyVol(m)  = total volume semua trade dengan agresor BUY di menit m
			 sellVol(m) = total volume semua trade dengan agresor SELL di menit m
			 delta(m)   = buyVol(m) - sellVol(m)
			 CVD(t)     = Σ delta(i), i ≤ t

	 - Satuan: lot (misalnya buy 2 juta lot, sell 1.3 juta lot → delta 700 ribu lot).

2) **CVD Proxy (livetrade, dari tape IPOT)**
	 - Sumber: stream websocket IPOT dengan format pipe, contoh:

			 B|090002|0|BUMI|RG|074358|290|100|--|-|--|-|292|00|639321|-2|0|291|0|1

	 - Di sini TIDAK ada field eksplisit yang bilang “trade ini agresor BUY/SELL”.
	 - Kita hanya tahu: kode, papan, harga last, volume, best bid/ask, dsb.
	 - Akibatnya, kita harus membangun **proxy** untuk membedakan BUY vs SELL,
		 dan itulah yang membuat skala CVD Proxy bisa jauh lebih kecil daripada CVD Tradebook.


=========================================
2. Pipeline Data: dari Tape sampai Footprint
=========================================

2.1. Taping (worker livetrade-taping)
-------------------------------------

Worker: workers/livetrade-taping/src/index.js

- Terkoneksi ke websocket IPOT: wss://ipotapp.ipot.id/socketcluster/?appsession=...
- Berlangganan stream "LT" (live trade) untuk semua kode.
- Setiap pesan trade disimpan dalam bentuk envelope JSON ke R2:

		{
			v: 2,
			fmt: "pipe" | "obj",
			src: "ipot_ws",
			raw: "B|090002|0|BUMI|RG|074358|290|100|...",  // string pipe mentah
			ts:  <epoch ms>,                               // waktu trade (WIB → UTC)
			ts_quality: "derived" | "ingestion"
		}

- File disimpan per jam UTC:

		raw_lt/YYYY/MM/DD/HH/<timestamp>_<count>.jsonl

Catatan penting: di tahap ini **belum ada perhitungan delta/CVD sama sekali**.
Kita hanya menyimpan raw trade + timestamp yang sudah dinormalkan.


2.2. Normalisasi trade mentah (aggregator)
-----------------------------------------

Worker: workers/livetrade-taping-agregator/src/index.js

Fungsi inti: normalizeTradeFromLine (sekitar L1447)

- Untuk setiap baris JSONL di raw_lt:

		1) JSON.parse(line) → obj
		2) Ambil obj.raw (string pipe)
		3) Split dengan '|':

				 parts[0] = jenis pesan ("B")
				 parts[1] = timeRaw (HHMMSS)
				 parts[3] = kode (ticker)
				 parts[4] = papan (RG, dsb)
				 parts[6] = harga last
				 parts[7] = volume

		4) Filter hanya trade relevan:

				 - jenis == 'B'
				 - papan  == 'RG'
				 - vol > 0, harga valid

		5) Bentuk objek trade ternormalisasi:

				 {
					 timeRaw: '090002',        // HHMMSS (WIB)
					 kode:    'BUMI',
					 papan:   'RG',
					 harga:   290,
					 vol:     100,
					 tsMs:    <epoch UTC ms>
				 }

Parsing ini sudah kita verifikasi dengan contoh nyata dari tester; posisi kolom
harga = parts[6] dan volume = parts[7] konsisten dengan data IPOT.


2.3. Agregasi per menit dan pembentukan footprint 1m
----------------------------------------------------

Masih di livetrade-taping-agregator, setiap trade ternormalisasi dimasukkan
ke bucket per menit berdasarkan timeRaw:

		const hh = timeRaw.slice(0, 2);
		const mm = timeRaw.slice(2, 4);
		const minuteKey = `${hh}:${mm}`;  // contoh: "09:00"

Per (ticker, minuteKey) kita simpan state bucket:

		bucket = {
			o: open_price_menit,
			h: highest_price_menit,
			l: lowest_price_menit,
			c: close_price_menit,
			vol: total_volume_menit,
			netVol: net_volume_menit   // inilah delta proxy per menit
		}

Setiap trade t memperbarui bucket sbb:

		bucket.vol += t.vol

		if (t.harga > bucket.o)      bucket.netVol += t.vol;   // dianggap BUY
		else if (t.harga < bucket.o) bucket.netVol -= t.vol;   // dianggap SELL
		// kalau t.harga == bucket.o => netVol tidak berubah (NETRAL)

Setelah semua trade hari itu diproses, kita tulis candle 1 menit ke R2:

		{
			t0:   epoch UTC untuk (tanggal + HH:MM:00 WIB),
			ohlc: { o, h, l, c },
			vol:  bucket.vol,
			delta: bucket.netVol,
			levels: []
		}

File disimpan di bucket footprint:

		footprint/{TICKER}/1m/YYYY/MM/DD/HH.jsonl

Jadi **delta di footprint 1m** = netVol per menit dengan definisi
"di atas open menit = BUY, di bawah open menit = SELL, sama dengan open = NETRAL".


2.4. Konsumsi footprint oleh api-saham & frontend
-------------------------------------------------

Worker: workers/api-saham/src/index.js

- Endpoint /footprint-raw-hist membaca semua file footprint/{kode}/1m/... untuk tanggal tertentu.
- Untuk setiap candle c:

		tableData.push({
			t: timeStr,
			x: c.t0,
			p: close,
			v: c.vol,
			a: c.delta,   // inilah delta per bar yang dipakai CVD di FE
			m: ...,       // haka/haki balance
			abs: ...      // absorption score
		});

- Di frontend (idx/emiten/detail.html):

		runningCVD = 0
		untuk setiap row di timeSeriesData (tableData):
				runningCVD += row.a
				cvdPoint = { x: row.x, y: runningCVD }

		CVD line di-chart = plot dari runningCVD tersebut.

Dengan demikian:

		delta_proxy(menit) = c.delta (di footprint)
		CVD_proxy(t)       = Σ delta_proxy(i) dari awal hari s/d bar t


=============================================
3. Kenapa CVD Proxy dan CVD Tradebook berbeda
=============================================

3.1. Sumber informasi BUY/SELL berbeda
--------------------------------------

- **CVD Tradebook** memakai data yang sudah punya label agresor:

			buyVol(m)  = volume semua trade yang benar-benar agresor BUY
			sellVol(m) = volume semua trade yang benar-benar agresor SELL

	Ini adalah "ground truth" dari sisi bursa / tradebook.

- **CVD Proxy** TIDAK punya informasi agresor, sehingga kita hanya bisa
	menggunakan *proxy* berdasarkan harga:

	- di aggregator: harga dibandingkan dengan open menit itu,
	- di durable-engine (realtime engine lain): harga dibandingkan dengan
		harga trade sebelumnya (uptick/downtick rule).

Akibatnya, banyak volume yang secara kenyataan adalah BUY/SELL di tradebook
menjadi "NETRAL" di proxy kita jika tidak mengubah harga relatif terhadap
anchor (open menit atau price sebelumnya).


3.2. Volume di harga OPEN menit dianggap netral
----------------------------------------------

Contoh ilustrasi sederhana untuk satu menit BUMI:

		OPEN menit = 290

		Trade:
			290, 5000 lot
			290, 3000 lot
			292, 1000 lot
			288,  800 lot

- **Tradebook (ideal)**:
	- BUY aggressor mungkin 7.000 lot,
	- SELL aggressor 2.800 lot,
	- delta_tradebook = 7.000 - 2.800 = 4.200 lot.

- **Proxy kita (vs OPEN menit)**:
	- Trade di 290 → tidak ubah delta (NETRAL, karena harga == OPEN).
	- Trade di 292 → +1.000 (di atas OPEN ⇒ BUY).
	- Trade di 288 → −800   (di bawah OPEN ⇒ SELL).

	→ delta_proxy = +1.000 − 800 = **+200 lot** saja.

Padahal volume total menit itu = 9.800 lot. Dengan kata lain, **sebagian besar
volume di menit ini dianggap netral** di definisi delta kita.

Hal yang sama terjadi di BUMI & saham-saham super likuid lain: volume kotor
per menit bisa jutaan lot, tetapi karena banyak transaksi terjadi di harga yang
sama dengan OPEN menit tersebut (atau bolak-balik di sekitar harga itu), net
delta versi proxy menjadi hanya ribuan atau bahkan ratusan lot.


3.3. Skala CVD Tradebook vs CVD Proxy
-------------------------------------

Jika kita bandingkan secara angka:

- Dari tradebook satu menit:

		buyVol = 2.000.000 lot
		sellVol = 1.300.000 lot
		delta_tradebook = 700.000 lot

- Di CVD Proxy untuk menit yang sama, bisa terjadi:

		vol_proxy   ≈ 2.000.000 lot (volume total sangat mirip)
		delta_proxy ≈ 20.000 lot (misal hanya sebagian kecil trade yang benar-benar
															 menggerakkan harga naik/turun dari OPEN)

Jadi:

		CVD_tradebook(t) = Σ 700k, 650k, 500k, ... (skala ratusan ribu / jutaan)
		CVD_proxy(t)     = Σ 20k, 15k, −5k, ...    (skala ribuan / puluhan ribu)

Secara bentuk (naik/turun) bisa masih berkorelasi, tetapi secara **skala**
akan jauh lebih kecil.


===========================================
4. Tingkat keyakinan terhadap pipeline data
===========================================

Selama investigasi, kita melakukan beberapa pengecekan:

1) **Parsing tape mentah → trade ternormalisasi**
	 - Dicek langsung terhadap contoh raw dari IPOT (seperti yang dikirim tester).
	 - Kolom harga dan volume yang dipakai aggregator:

				 harga = Number(parts[6])
				 vol   = Number(parts[7])

		 sudah sesuai dengan struktur data IPOT.
	 - Filter papan "RG" dan vol > 0 juga konsisten dengan desain awal.

2) **Agregasi menit dan penulisan footprint**
	 - Kode aggregator menjumlahkan vol per (ticker, menit) tanpa transformasi lain.
	 - netVol (delta) dihitung dengan aturan jelas terhadap OPEN menit.
	 - Candle 1m yang dihasilkan (t0, ohlc, vol, delta) dipakai langsung oleh
		 api-saham tanpa modifikasi lagi.

3) **Helper debug_cvd_from_raw**
	 - Kita membuat helper di workers/tools/debug_cvd_from_raw.js untuk membaca
		 file raw_lt JSONL, menghitung sendiri vol & delta per menit dengan logika
		 yang sama seperti aggregator, lalu membandingkannya dengan hasil
		 footprint/CVD di UI.
	 - Contoh konkret (file raw_lt 2026-02-18 jam 02 UTC untuk BUMI):

				 minute = 09:00 WIB
				 vol    = 7.999 lot
				 delta  = +427 lot
				 cumDelta (CVD) = +427 lot

		 Angka ini konsisten dengan delta di footprint dan titik pertama CVD di UI.

Berdasarkan pengecekan di atas, kita cukup yakin bahwa:

- Tidak ada kesalahan parse kolom (mis-parse harga/volume) dari tape.
- Tidak ada bug tanda +/− yang membuat delta terbalik.
- Perbedaan antara CVD Tradebook dan CVD Proxy berasal dari **metodologi**
	(keterbatasan feed yang tidak membawa agresor) — bukan dari kerusakan data.


==========================
5. Implikasi untuk pengguna
==========================

1) **CVD Tradebook** cocok untuk analisis yang membutuhkan angka net lot
	 absolut (misalnya benar-benar ingin tahu "hari ini BUMI diserap bersih
	 700.000 lot oleh pembeli").

2) **CVD Proxy (livetrade)** lebih cocok sebagai indikator **arah & kualitas
	 aliran order** secara real-time:
	 - apakah di menit-menit tertentu buyer benar-benar "mendorong harga" naik
		 dari open, atau seller yang menekan harga turun;
	 - seberapa besar porsi volume yang benar-benar menggerakkan harga,
		 dibandingkan volume yang hanya terjadi di sekitar harga yang sama.

3) Untuk saham-saham sangat likuid seperti BUMI, perbedaan skala antara kedua
	 definisi ini akan semakin besar, karena proporsi volume di harga open menit
	 sangat besar.

Kesimpulannya: **CVD livetrade / CVD proxy dan CVD tradebook boleh dan wajar
untuk memiliki angka yang berbeda secara skala**, karena definisi delta yang
dipakai berbeda. Pipeline data kita (tape → parse → footprint → CVD) sudah
dicek dan konsisten; yang perlu dipahami oleh pengguna adalah bahwa CVD Proxy
adalah *approximation berbasis harga* dari true CVD yang hanya bisa didapat
penuh dari data tradebook.

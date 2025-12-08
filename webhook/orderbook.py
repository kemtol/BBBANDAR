import duckdb
import pandas as pd
import os
import json
from dotenv import load_dotenv

# Load Environment
load_dotenv()

BUCKET_NAME = os.getenv("BUCKET_NAME")
ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")
ACCESS_KEY = os.getenv("R2_ACCESS_KEY")
SECRET_KEY = os.getenv("R2_SECRET_KEY")

def bedah_orderbook(kode_saham="GOTO"):
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    
    # Konfigurasi R2
    con.execute(f"""
        SET s3_region='auto';
        SET s3_endpoint='{ACCOUNT_ID}.r2.cloudflarestorage.com';
        SET s3_access_key_id='{ACCESS_KEY}';
        SET s3_secret_access_key='{SECRET_KEY}';
        SET s3_url_style='path';
    """)

    print(f"🔍 Mengambil data Orderbook: {kode_saham}...")

    # --- QUERY YANG DIPERBAIKI ---
    # Kita menggunakan 'raw.data' untuk mengakses field 'data' di dalam struct 'raw'
    query = f"""
    SELECT 
        ts,
        raw.data as inner_json  -- FIX DISINI: Akses langsung struct
    FROM read_json_auto('s3://{BUCKET_NAME}/raw_ob/{kode_saham}/**/*.json')
    ORDER BY ts DESC
    LIMIT 20;
    """
    
    try:
        df = con.sql(query).df()
        
        if df.empty:
            print("⚠️ Data kosong atau path salah.")
            return

        print(f"\n📊 20 Snapshot Terakhir {kode_saham}:")
        print("="*60)
        
        for index, row in df.iterrows():
            try:
                # Cek apakah inner_json valid (tidak None)
                json_str = row['inner_json']
                if not json_str:
                    continue

                # Parse string JSON
                payload = json.loads(json_str)
                waktu = pd.to_datetime(row['ts'], unit='ms').time()
                subcmd = payload.get('subcmd', 'UNKNOWN')
                
                print(f"\n[{waktu}] Tipe: {subcmd}")

                # --- KASUS 1: DATA INIT (Array Rapi) ---
                if subcmd == "INIT" and 'BUY' in payload:
                    print("   --- SNAPSHOT AWAL ---")
                    # Tampilkan 3 Offer Terbawah
                    offers = payload.get('SELL', [])[:3] 
                    for o in reversed(offers): 
                        print(f"   [OFFER] Rp {o[0]:<4} : {o[1]:,.0f} Lot")
                    
                    print(f"   ------- {kode_saham} -------")
                    
                    # Tampilkan 3 Bid Teratas
                    bids = payload.get('BUY', [])[:3]
                    for b in bids:
                        print(f"   [BID]   Rp {b[0]:<4} : {b[1]:,.0f} Lot")

                # --- KASUS 2: DATA UPDATE (String Pipa) ---
                elif 'recinfo' in payload:
                    raw_str = payload['recinfo']
                    if '|;|' in raw_str:
                        # Pecah bagian Kanan (Depth)
                        depth_part = raw_str.split('|;|')[1]
                        parts = depth_part.split('|')
                        
                        best_bid = parts[0]
                        best_offer = parts[1]
                        print(f"   Best Bid: {best_bid} | Best Offer: {best_offer}")
                        
                        # Loop Triplet
                        for i in range(3, len(parts)-2, 3):
                            try:
                                p = parts[i]
                                b_vol = int(parts[i+1])
                                o_vol = int(parts[i+2])
                                
                                if b_vol > 0:
                                    print(f"   [BID+]  Rp {p:<4} : {b_vol:,.0f} Lot")
                                elif o_vol > 0:
                                    print(f"   [OFF+]  Rp {p:<4} : {o_vol:,.0f} Lot")
                            except: pass
            
            except Exception as e:
                print(f"   Gagal parsing baris ini: {e}")

    except Exception as e:
        print("Error DuckDB:", e)

if __name__ == "__main__":
    bedah_orderbook("GOTO")
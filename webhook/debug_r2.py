import duckdb
import os
from dotenv import load_dotenv

load_dotenv()

BUCKET_NAME = os.getenv("BUCKET_NAME")
ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID")
ACCESS_KEY = os.getenv("R2_ACCESS_KEY")
SECRET_KEY = os.getenv("R2_SECRET_KEY")

def debug_files():
    con = duckdb.connect()
    con.execute("INSTALL httpfs; LOAD httpfs;")
    
    # SETUP KONEKSI (Versi Aman Tanpa s3_ssl_verify)
    con.execute(f"""
        SET s3_region='auto';
        SET s3_endpoint='{ACCOUNT_ID}.r2.cloudflarestorage.com';
        SET s3_access_key_id='{ACCESS_KEY}';
        SET s3_secret_access_key='{SECRET_KEY}';
        SET s3_url_style='path';
    """)

    print(f"🔍 Checking bucket: {BUCKET_NAME}")

    try:
        print("\n--- Listing Files in 'raw_ob' ---")
        
        # PERBAIKAN DISINI: Ganti 'filename' jadi 'file'
        files = con.sql(f"SELECT file FROM glob('s3://{BUCKET_NAME}/raw_ob/**/*.json') LIMIT 5").fetchall()
        
        if not files:
            print("❌ NO FILES FOUND in raw_ob/ folder!")
            return
            
        for f in files:
            # f[0] adalah path filenya
            print(f"📄 Found: {f[0]}")
            
        # Intip isi file pertama
        target_file = files[0][0]
        print(f"\n--- Peeking into {target_file} ---")
        
        # Baca konten mentah
        content = con.sql(f"SELECT * FROM read_csv('{target_file}', columns={{'raw': 'VARCHAR'}}, delim=NULL, header=False, quote=NULL) LIMIT 1").fetchone()
        print(f"Raw Content:\n{content[0]}")
        
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    debug_files()
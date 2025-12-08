#!/usr/bin/env python3
import argparse
import requests
import time
import sys

WORKER_URL = "https://livetrade-taping-aggregator.mkemalw.workers.dev/step-backfill"

def run_backfill(date, limit, reset):
    print(f"🚀 Backfill date: {date}  |  limit={limit}  |  reset={reset}")

    cursor = None
    step = 1
    total_files = 0

    params = {
        "date": date,
        "limit": limit
    }

    if reset:
        params["reset"] = "true"

    while True:
        try:
            print(f"🔄 Batch {step}...", end="", flush=True)
            t0 = time.time()

            r = requests.get(WORKER_URL, params=params, timeout=60)
            t1 = time.time()

            if r.status_code != 200:
                print(f"\n❌ Server Error {r.status_code}: {r.text}")
                break

            data = r.json()
            status = data.get("status")
            duration = t1 - t0

            if status == "PROGRESS":
                processed = data.get("processed", 0)
                total_files += processed

                print(f"  ✅ OK ({processed} files) in {duration:.2f}s | Total: {total_files}")

                cursor = data.get("next_cursor")
                params = {
                    "date": date,
                    "limit": limit,
                    "cursor": cursor
                }
                step += 1

            elif status == "DONE":
                print("\n🎉 DONE!")
                print(f"📦 Total files processed: {total_files}")
                print(f"📊 Total emitters: {data.get('total_items')}")
                break

            elif status == "EMPTY":
                print("\n⚠️ Folder tanggal tersebut kosong.")
                break

            else:
                print(f"\n⚠️ Unknown status from server: {data}")
                break

        except Exception as e:
            print(f"\n❌ Script Error: {e}")
            break


def main():
    parser = argparse.ArgumentParser(description="Run livetrade backfill via Cloudflare Worker.")

    parser.add_argument("--date", required=True, help="Tanggal format YYYY-MM-DD")
    parser.add_argument("--limit", type=int, default=250, help="Limit file per batch (default 250)")
    parser.add_argument("--no-reset", action="store_true", help="Jangan pakai reset=true di batch pertama")

    args = parser.parse_args()

    run_backfill(
        date=args.date,
        limit=args.limit,
        reset=(not args.no_reset)
    )


if __name__ == "__main__":
    main()

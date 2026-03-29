#!/usr/bin/env python3
"""
RAG Heartbeat Monitor — per-agent context check + ingestion to Qdrant
Schedule: Every 15 minutes via cron (with AGENT_NAME env var set per agent)
Threshold: Context > 70% triggers ingestion
Usage: AGENT_NAME=elsa python3 rag_heartbeat_monitor.py
"""

import os
import sys
import json
import requests
import subprocess
from datetime import datetime

# Configuration
RAG_API           = "http://localhost:8000"
CONTEXT_THRESHOLD = 0.7   # 70%
AGENT_NAME        = os.environ.get("AGENT_NAME", "").strip()
OPENCLAW_DIR      = os.path.expanduser("~/.openclaw")

if not AGENT_NAME:
    print("ERROR: AGENT_NAME env var tidak di-set.")
    print("Contoh: AGENT_NAME=elsa python3 rag_heartbeat_monitor.py")
    sys.exit(1)

# Agent-specific collection — elsa -> agent_memory_elsa, dll
COLLECTION_NAME = f"agent_memory_{AGENT_NAME}"


def get_session_context():
    """Estimate context from per-agent session file sizes (active .jsonl only)."""
    try:
        session_dir = os.path.join(OPENCLAW_DIR, "agents", AGENT_NAME, "sessions")
        if not os.path.exists(session_dir):
            return 0.0
        total_size = sum(
            os.path.getsize(os.path.join(session_dir, f))
            for f in os.listdir(session_dir)
            if f.endswith(".jsonl") and not f.startswith("_archived_")
        )
        # 200KB = compact threshold; treat that as 100% context
        return min(total_size / (200 * 1024), 1.0)
    except Exception as e:
        print(f"  WARNING: Could not estimate context for {AGENT_NAME}: {str(e)[:100]}")
        return 0.5


def get_recent_memory_content():
    """Get content from per-agent memories JSON snapshots (last 3)."""
    memory_dir = os.path.join(OPENCLAW_DIR, "agents", AGENT_NAME, "memories")
    if not os.path.exists(memory_dir):
        return []
    try:
        files = sorted(
            [os.path.join(memory_dir, f) for f in os.listdir(memory_dir) if f.endswith(".json")],
            reverse=True
        )[:3]
        results = []
        for fpath in files:
            with open(fpath, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            parts = [data.get("context", "")]
            for key in ("decisions", "in_progress", "insights"):
                items = data.get(key, [])
                if items:
                    parts.append(key + ": " + "; ".join(items))
            content = " | ".join(p for p in parts if p)
            if content.strip():
                results.append((content, os.path.basename(fpath)))
        return results
    except Exception as e:
        print(f"  WARNING: Could not read agent memories for {AGENT_NAME}: {str(e)[:100]}")
        return []


def ingest_to_rag(content, source):
    """Ingest content to per-agent RAG collection.
    RAG API expects single Document with collection field inside."""
    try:
        import uuid
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        doc_id = "hb_" + AGENT_NAME + "_" + ts + "_" + source
        document = {
            "id": doc_id,
            "source": source,
            "content": content,
            "collection": COLLECTION_NAME,   # per-agent collection
            "metadata": {
                "agent": AGENT_NAME,
                "ingested_at": datetime.now().isoformat(),
                "context_trigger": ">" + str(int(CONTEXT_THRESHOLD * 100)) + "%",
                "strategy": "heartbeat_15min_threshold",
            }
        }
        response = requests.post(RAG_API + "/index", json=document, timeout=30)
        if response.status_code == 200:
            print("  OK Ingested " + str(len(content)) + " chars from " + source + " -> " + COLLECTION_NAME)
            return True
        print("  FAIL: HTTP " + str(response.status_code) + " -- " + response.text[:200])
        return False
    except Exception as e:
        print("  EXCEPTION: " + str(e)[:100])
        return False


def main():
    print("=== RAG HEARTBEAT MONITOR ===")
    print("Time       : " + datetime.now().isoformat())
    print("Agent      : " + AGENT_NAME)
    print("Collection : " + COLLECTION_NAME)
    print("Threshold  : >" + str(int(CONTEXT_THRESHOLD * 100)) + "%")
    print()

    print("Checking session context...")
    context_ratio = get_session_context()
    print("  Context: " + str(round(context_ratio * 100, 1)) + "%")

    if context_ratio <= CONTEXT_THRESHOLD:
        print("  OK Below threshold, skipping ingestion")
        return True

    print("  WARNING Above threshold, proceeding with ingestion")

    print("\nGetting recent memory snapshots for " + AGENT_NAME + "...")
    memory_contents = get_recent_memory_content()

    if not memory_contents:
        print("  WARNING No memory snapshots found for " + AGENT_NAME)
        print("  Run compact first: curl -s -X POST http://localhost:19191/compact -d '{\"agent\":\"" + AGENT_NAME + "\"}'")
        return False

    print("\nIngesting " + str(len(memory_contents)) + " snapshot(s) to '" + COLLECTION_NAME + "'...")
    success_count = 0
    for content, source in memory_contents:
        if content.strip():
            if ingest_to_rag(content, source):
                success_count += 1

    if success_count > 0:
        print("\nDone: " + str(success_count) + "/" + str(len(memory_contents)) + " snapshot(s) indexed to " + COLLECTION_NAME)
    else:
        print("\nFAIL: No successful ingestion")
    return success_count > 0


if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)

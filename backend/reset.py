"""
Wipe all Bina indexed data (SQLite + ChromaDB) and recreate empty directories.

Usage:
    python reset.py

Ollama models in ~/.ollama/models are NOT touched.
"""
import shutil
from pathlib import Path

BINA_HOME = Path.home() / ".bina"


def reset() -> None:
    print("Wiping ~/.bina/ ...")
    if BINA_HOME.exists():
        shutil.rmtree(BINA_HOME)
        print(f"  Deleted {BINA_HOME}")
    else:
        print(f"  {BINA_HOME} did not exist, nothing to delete")

    BINA_HOME.mkdir(parents=True, exist_ok=True)
    (BINA_HOME / "chroma").mkdir(exist_ok=True)
    print("  Recreated empty ~/.bina/ and ~/.bina/chroma/")
    print("Done. Ollama models in ~/.ollama/ are untouched.")


if __name__ == "__main__":
    reset()

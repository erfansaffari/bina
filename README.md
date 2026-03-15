# Bina v3 — Local AI Semantic File Manager

> بینا (Bina) — "one who sees clearly"

Bina is an AI-powered semantic file manager and workspace assistant for macOS. Unlike traditional search that relies on exact keywords, Bina reads, understands, and connects your documents in a knowledge graph, allowing you to find files by meaning or chat directly with your entire folder using natural language.

---

## What's New in v3?

Bina has evolved from a CLI tool into a full React/Electron desktop application with pluggable AI reasoning paths:

1. **Ask Bina (Railtracks Agent)**
   A complete conversational interface. You can search, summarize, or chat with your documents. The agent automatically figures out when to run semantic searches, read summaries, or fetch neighboring files in the knowledge graph.
2. **Per-Workspace AI Models**
   Each workspace can now have its own AI processing path.
   * **Hosted (Free & Fast):** Uses a powerful 120B parameter hosted model via HuggingFace API.
   * **Local (Private):** Runs 100% offline on your Mac using Ollama (`qwen3.5:2b`).
   * **User API:** Use your own OpenAI API key.
3. **Moorcheh Vector Store**
   Now uses the blazingly fast `moorcheh-sdk` for cloud-synced vector storage (with local ChromaDB fallback available).
4. **Knowledge Graph Visualizer**
   A beautiful, auto-clustering 2D force graph that groups your files by semantic similarity and community paths.

---

## 🚀 Quick Start (Development)

### 1. Backend Setup

Bina requires Python 3.11+.

```bash
# Clone the repository and setup the backend virtual environment:
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

You must provide a Moorcheh API Key for the vector store. Create a `.env` file in `~/.bina/.env`:
```
MOORCHEH_API_KEY=your_moorcheh_key_here
```

Start the FastAPI sidecar:
```bash
python backend/api.py
```

### 2. Frontend Setup

The frontend is an Electron app wrapping a React + Vite PWA.

```bash
# In a new terminal tab:
cd frontend
npm install
npm run dev
```

---

## 🧠 Local AI Path (Optional)

If you prefer to keep your files 100% private, you can choose the **Local AI** path during workspace creation. This requires Ollama.

1. Install Ollama: `brew install ollama`
2. Bina's smart onboarding will automatically pull the necessary models (`qwen3.5:2b` & `nomic-embed-text`) for you if you select the local path.

---

## Architecture Stack

Bina's v3 architecture is split into a seamless Electron IPC bridge communicating with a FastAPI Python sidecar.

* **Frontend:** React 18, Vite, Tailwind CSS, Zustand, `react-force-graph-2d`
* **Desktop Wrapper:** Electron 32
* **Backend:** FastAPI, Python 3.11+
* **Reasoning Agent:** Railtracks
* **Vector Store:** Moorcheh SDK (Router pattern with ChromaDB legacy fallback)
* **Metadata Store:** SQLite (`~/.bina/bina.db`)
* **Local Inference:** Ollama 

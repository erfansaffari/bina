# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for Bina backend sidecar
# Run from the project root: pyinstaller bina_api.spec

import sys
from PyInstaller.utils.hooks import collect_all, collect_data_files, collect_submodules

block_cipher = None

# Collect everything chromadb needs (lots of dynamic imports)
chroma_datas, chroma_binaries, chroma_hiddenimports = collect_all('chromadb')
# SQLAlchemy dialects
sqla_hiddenimports = collect_submodules('sqlalchemy')
# uvicorn / fastapi extras
uvicorn_hiddenimports = collect_submodules('uvicorn')
# tiktoken / tokenizers
tok_datas, tok_binaries, tok_hiddenimports = collect_all('tiktoken')

a = Analysis(
    ['backend/api.py'],
    pathex=['.'],          # root so store.py, pipeline.py, etc. are on sys.path
    binaries=chroma_binaries + tok_binaries,
    datas=(
        chroma_datas
        + tok_datas
        + collect_data_files('nltk')
        + collect_data_files('pypdf')
    ),
    hiddenimports=(
        chroma_hiddenimports
        + sqla_hiddenimports
        + uvicorn_hiddenimports
        + tok_hiddenimports
        + [
            # SQLite dialect
            'sqlalchemy.dialects.sqlite',
            # watchdog platform backend
            'watchdog.observers.fsevents',
            # Ollama
            'ollama',
            # openai
            'openai',
            # python-docx
            'docx',
            # PyMuPDF
            'pymupdf', 'fitz',
            # image handling
            'PIL', 'PIL.Image',
            # moorcheh / railtracks
            'moorcheh',
            'railtracks',
            # misc
            'httpx', 'httpcore', 'anyio',
            'starlette', 'pydantic',
            'multipart',
        ]
    ),
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='bina-api',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='bina-api',
)

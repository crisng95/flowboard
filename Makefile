.PHONY: help install install-dev update dev agent frontend extension clean

# HTTP port for the agent. This is the ONLY place it is configured — the
# agent reads it from uvicorn's `--port` below and nowhere else, so there
# is no matching variable in `.env`. Off the conventional 8101 because
# that port is commonly taken by other local services; override per run
# with `FLOWBOARD_HTTP_PORT=9000 make agent`. Moving it also means editing
# the extension (`background.js`, `manifest.json`) and the frontend's Vite
# proxy, all three of which hardcode the agent's address.
FLOWBOARD_HTTP_PORT ?= 8434

# Prefer uv (https://github.com/astral-sh/uv) — ~10× faster than pip.
# Falls back to stdlib venv + pip when uv is not installed.
HAS_UV := $(shell command -v uv 2>/dev/null)

help:
	@echo "Flowboard dev commands:"
	@echo "  make install      - install runtime deps (agent + frontend)"
	@echo "  make install-dev  - install agent with dev extras (ruff, pytest)"
	@echo "  make update       - upgrade existing deps (agent + frontend)"
	@echo "  make dev          - hint: run agent + frontend in separate terminals"
	@echo "  make agent        - run agent only (FastAPI on :$(FLOWBOARD_HTTP_PORT))"
	@echo "  make frontend     - run frontend only (Vite on :5173)"
	@echo "  make extension    - package extension (unpacked: load from ./extension)"
	@echo "  make clean        - remove build + cache"

install:
ifdef HAS_UV
	cd agent && uv venv && uv pip install --python .venv/bin/python -e .
else
	cd agent && python -m venv .venv && .venv/bin/pip install -e .
endif
	cd frontend && npm install

install-dev:
ifdef HAS_UV
	cd agent && uv venv && uv pip install --python .venv/bin/python -e ".[dev]"
else
	cd agent && python -m venv .venv && .venv/bin/pip install -e ".[dev]"
endif
	cd frontend && npm install

update:
ifdef HAS_UV
	cd agent && uv pip install --python .venv/bin/python -U -e .
else
	cd agent && .venv/bin/pip install -U -e .
endif
	cd frontend && npm update

dev:
	@echo "Run 'make agent' and 'make frontend' in separate terminals."
	@echo "Load ./extension as unpacked extension in chrome://extensions."

agent:
	cd agent && .venv/bin/uvicorn flowboard.main:app --reload --port $(FLOWBOARD_HTTP_PORT)

frontend:
	cd frontend && npm run dev

clean:
	rm -rf agent/.venv agent/**/__pycache__ frontend/node_modules frontend/dist

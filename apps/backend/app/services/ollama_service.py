"""Ollama LLM client with two backend modes behind one interface.

Backends:
  1. **native**  – direct Ollama REST API  (``/api/generate``, ``/api/tags``)
  2. **openai**  – OpenAI-compatible chat endpoint Ollama exposes at ``/v1``

Selected via ``PT_OLLAMA_CLIENT_MODE`` env var (default: ``native``).
"""

from __future__ import annotations

import abc
import logging

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

# ── Abstract interface ──

class LLMClient(abc.ABC):
    """Minimal contract every backend must satisfy."""

    @abc.abstractmethod
    async def generate(self, prompt: str, model: str, temperature: float) -> str: ...

    @abc.abstractmethod
    async def list_models(self) -> list[dict]: ...

# ── Backend 1: native Ollama REST API ──

class NativeOllamaClient(LLMClient):
    def __init__(self, base_url: str):
        self._base_url = base_url

    async def generate(self, prompt: str, model: str, temperature: float) -> str:
        async with httpx.AsyncClient(base_url=self._base_url, timeout=300) as c:
            resp = await c.post(
                "/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": False,
                    "options": {"temperature": temperature},
                },
            )
            resp.raise_for_status()
            return resp.json().get("response", "")

    async def list_models(self) -> list[dict]:
        async with httpx.AsyncClient(base_url=self._base_url, timeout=10) as c:
            resp = await c.get("/api/tags")
            resp.raise_for_status()
            return resp.json().get("models", [])

# ── Backend 2: OpenAI-compatible /v1 endpoint ──

class OpenAICompatClient(LLMClient):
    """Uses the ``/v1/chat/completions`` endpoint that Ollama exposes."""

    def __init__(self, base_url: str):
        # Ollama's OpenAI compat lives at <base>/v1
        self._base_url = base_url.rstrip("/") + "/v1"
        self._tags_url = base_url  # /api/tags is only on the native port

    async def generate(self, prompt: str, model: str, temperature: float) -> str:
        async with httpx.AsyncClient(base_url=self._base_url, timeout=300) as c:
            resp = await c.post(
                "/chat/completions",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "stream": False,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            choices = data.get("choices", [])
            if choices:
                return choices[0].get("message", {}).get("content", "")
            return ""

    async def list_models(self) -> list[dict]:
        # Model listing still uses the native Ollama endpoint for richer info.
        async with httpx.AsyncClient(base_url=self._tags_url, timeout=10) as c:
            resp = await c.get("/api/tags")
            resp.raise_for_status()
            return resp.json().get("models", [])

# ── Singleton factory ──

_client: LLMClient | None = None

def get_client() -> LLMClient:
    global _client
    if _client is None:
        mode = settings.ollama_client_mode.lower()
        if mode == "openai":
            logger.info("Using OpenAI-compatible Ollama client at %s/v1", settings.ollama_base_url)
            _client = OpenAICompatClient(settings.ollama_base_url)
        else:
            logger.info("Using native Ollama client at %s", settings.ollama_base_url)
            _client = NativeOllamaClient(settings.ollama_base_url)
    return _client

# ── Module-level convenience (keeps existing call sites working) ──

async def list_models() -> list[dict]:
    return await get_client().list_models()

async def generate(
    prompt: str,
    model: str | None = None,
    temperature: float | None = None,
) -> str:
    model = model or settings.default_model
    temp = temperature if temperature is not None else settings.summary_temperature
    logger.info("LLM generate  model=%s  prompt_len=%d  temp=%.2f", model, len(prompt), temp)
    return await get_client().generate(prompt, model, temp)

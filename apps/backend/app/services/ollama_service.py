"""Ollama LLM client with two backend modes behind one interface.

Backends:
  1. **native**  – direct Ollama REST API  (``/api/generate``, ``/api/tags``)
  2. **openai**  – OpenAI-compatible chat endpoint Ollama exposes at ``/v1``

Selected via ``PT_OLLAMA_CLIENT_MODE`` env var (default: ``native``).
"""

from __future__ import annotations

import abc
import json
import logging
from collections.abc import Awaitable, Callable

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


class LLMClient(abc.ABC):
    """Minimal contract every backend must satisfy."""

    @abc.abstractmethod
    async def generate(self, prompt: str, model: str, temperature: float) -> str: ...

    @abc.abstractmethod
    async def list_models(self) -> list[dict]: ...

    @abc.abstractmethod
    async def get_context_size(self, model: str) -> int: ...

    @abc.abstractmethod
    async def generate_stream(
        self,
        prompt: str,
        model: str,
        temperature: float,
        on_token: Callable[[str], Awaitable[None]],
    ) -> str: ...


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

    async def get_context_size(self, model: str) -> int:
        try:
            async with httpx.AsyncClient(base_url=self._base_url, timeout=30) as c:
                resp = await c.post("/api/show", json={"name": model})
                resp.raise_for_status()
                data = resp.json()

            model_info = data.get("modelinfo", {})
            for key, value in model_info.items():
                if "context_length" in key:
                    try:
                        return int(value)
                    except (TypeError, ValueError):
                        pass

            parameters = data.get("parameters", "")
            if isinstance(parameters, str):
                for line in parameters.splitlines():
                    if "num_ctx" in line:
                        parts = line.split()
                        for part in parts:
                            try:
                                return int(part)
                            except ValueError:
                                pass

            return 4096
        except Exception:
            return 4096

    async def generate_stream(
        self,
        prompt: str,
        model: str,
        temperature: float,
        on_token: Callable[[str], Awaitable[None]],
    ) -> str:
        full_text = ""
        async with httpx.AsyncClient(base_url=self._base_url, timeout=300) as c:
            async with c.stream(
                "POST",
                "/api/generate",
                json={
                    "model": model,
                    "prompt": prompt,
                    "stream": True,
                    "options": {"temperature": temperature},
                },
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    try:
                        data = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if not data.get("done", False):
                        token = data.get("response", "")
                        if token:
                            full_text += token
                            await on_token(token)
        return full_text


class OpenAICompatClient(LLMClient):
    """Uses the ``/v1/chat/completions`` endpoint that Ollama exposes."""

    def __init__(self, base_url: str):
        self._base_url = base_url.rstrip("/") + "/v1"
        self._tags_url = base_url

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
        async with httpx.AsyncClient(base_url=self._tags_url, timeout=10) as c:
            resp = await c.get("/api/tags")
            resp.raise_for_status()
            return resp.json().get("models", [])

    async def get_context_size(self, model: str) -> int:
        try:
            async with httpx.AsyncClient(base_url=self._tags_url, timeout=30) as c:
                resp = await c.post("/api/show", json={"name": model})
                resp.raise_for_status()
                data = resp.json()

            model_info = data.get("modelinfo", {})
            for key, value in model_info.items():
                if "context_length" in key:
                    try:
                        return int(value)
                    except (TypeError, ValueError):
                        pass

            parameters = data.get("parameters", "")
            if isinstance(parameters, str):
                for line in parameters.splitlines():
                    if "num_ctx" in line:
                        parts = line.split()
                        for part in parts:
                            try:
                                return int(part)
                            except ValueError:
                                pass

            return 4096
        except Exception:
            return 4096

    async def generate_stream(
        self,
        prompt: str,
        model: str,
        temperature: float,
        on_token: Callable[[str], Awaitable[None]],
    ) -> str:
        full_text = ""
        async with httpx.AsyncClient(base_url=self._base_url, timeout=300) as c:
            async with c.stream(
                "POST",
                "/chat/completions",
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "temperature": temperature,
                    "stream": True,
                },
            ) as resp:
                resp.raise_for_status()
                async for line in resp.aiter_lines():
                    if not line:
                        continue
                    if line.startswith("data:"):
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            data = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        choices = data.get("choices", [])
                        if choices:
                            token = choices[0].get("delta", {}).get("content", "")
                            if token:
                                full_text += token
                                await on_token(token)
        return full_text


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

async def get_context_size(model: str | None = None) -> int:
    model = model or settings.default_model
    return await get_client().get_context_size(model)

async def generate_stream(
    prompt: str,
    model: str | None = None,
    temperature: float | None = None,
    on_token: Callable[[str], Awaitable[None]] | None = None,
) -> str:
    model = model or settings.default_model
    temp = temperature if temperature is not None else settings.summary_temperature
    if on_token is None:
        async def _noop(t: str) -> None:
            pass
        on_token = _noop
    return await get_client().generate_stream(prompt, model, temp, on_token)

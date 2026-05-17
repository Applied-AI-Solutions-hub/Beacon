from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass


@dataclass(frozen=True)
class ModelResponse:
    ok: bool
    text: str
    provider: str


class LocalModelAdapter:
    """Small adapter for local Ollama or NIM/OpenAI-compatible chat endpoints.

    Environment variables:
    - OFFICECLAW_MODEL_PROVIDER: off, ollama, nim, or openai-compatible
    - OFFICECLAW_MODEL_BASE_URL: defaults to Ollama's local HTTP endpoint
    - OFFICECLAW_MODEL_NAME: defaults to llama3.1 for Ollama-style local runs
    - OFFICECLAW_MODEL_API_KEY: optional bearer token for NIM/OpenAI-compatible endpoints
    """

    def __init__(self) -> None:
        self.provider = os.getenv("OFFICECLAW_MODEL_PROVIDER", "off").strip().lower()
        self.base_url = os.getenv("OFFICECLAW_MODEL_BASE_URL", "http://localhost:11434").rstrip("/")
        self.model = os.getenv("OFFICECLAW_MODEL_NAME", "llama3.1")
        self.api_key = os.getenv("OFFICECLAW_MODEL_API_KEY", "")

    def enabled(self) -> bool:
        return self.provider not in {"", "off", "none", "heuristic"}

    def complete(self, prompt: str, *, timeout: int = 20) -> ModelResponse:
        if not self.enabled():
            return ModelResponse(False, "Local model adapter is disabled; deterministic heuristics are active.", self.provider or "off")
        if self.provider == "ollama":
            return self._ollama(prompt, timeout=timeout)
        if self.provider in {"nim", "openai", "openai-compatible", "openai_compatible"}:
            return self._openai_compatible(prompt, timeout=timeout)
        return ModelResponse(False, f"Unsupported local model provider: {self.provider}", self.provider)

    def _ollama(self, prompt: str, *, timeout: int) -> ModelResponse:
        payload = {"model": self.model, "prompt": prompt, "stream": False}
        return self._post_json(f"{self.base_url}/api/generate", payload, timeout=timeout, parser=lambda data: data.get("response", ""))

    def _openai_compatible(self, prompt: str, *, timeout: int) -> ModelResponse:
        payload = {"model": self.model, "messages": [{"role": "user", "content": prompt}], "temperature": 0.2}
        return self._post_json(
            f"{self.base_url}/chat/completions",
            payload,
            timeout=timeout,
            parser=lambda data: data.get("choices", [{}])[0].get("message", {}).get("content", ""),
        )

    def _post_json(self, url: str, payload: dict, *, timeout: int, parser) -> ModelResponse:
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        request = urllib.request.Request(url, data=json.dumps(payload).encode("utf-8"), headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                data = json.loads(response.read().decode("utf-8"))
            return ModelResponse(True, str(parser(data)).strip(), self.provider)
        except (urllib.error.URLError, TimeoutError, KeyError, IndexError, json.JSONDecodeError) as exc:
            return ModelResponse(False, f"Local model request failed: {exc}", self.provider)

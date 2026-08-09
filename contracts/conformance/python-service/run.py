"""Run the shared dev-only transport conformance cases for service adapters."""

from __future__ import annotations

import asyncio
import importlib
import json
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Protocol


@dataclass(frozen=True)
class Response:
    status: int
    headers: dict[str, str]
    body: dict[str, Any]


class Adapter(Protocol):
    def apps(self, root: Path) -> dict[str, Any]: ...


def _asgi_request(app: Any, method: str, path: str, *, headers: dict[str, str], body: bytes) -> Response:
    sent: list[dict[str, Any]] = []
    pending = [body]

    async def receive() -> dict[str, Any]:
        chunk = pending.pop(0) if pending else b""
        return {"type": "http.request", "body": chunk, "more_body": bool(pending)}

    async def send(message: dict[str, Any]) -> None:
        sent.append(message)

    async def run() -> None:
        await app(
            {
                "type": "http",
                "method": method,
                "path": path,
                "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
                "query_string": b"",
            },
            receive,
            send,
        )

    asyncio.run(run())
    start = next(item for item in sent if item["type"] == "http.response.start")
    raw = b"".join(item.get("body", b"") for item in sent if item["type"] == "http.response.body")
    return Response(
        int(start["status"]),
        {k.decode().lower(): v.decode() for k, v in start.get("headers", [])},
        json.loads(raw.decode() or "{}"),
    )


def request(app: Any, method: str, path: str, *, headers: dict[str, str], body: bytes) -> Response:
    if type(app).__name__ == "FastAPI":
        from fastapi.testclient import TestClient

        with TestClient(app) as client:
            result = client.request(method, path, headers=headers, content=body)
        return Response(result.status_code, {k.lower(): v for k, v in result.headers.items()}, result.json())
    return _asgi_request(app, method, path, headers=headers, body=body)


def _assert_error(response: Response, status: int) -> None:
    assert response.status == status, response
    assert response.body.get("ok") is False, response
    assert isinstance(response.body.get("error"), str), response


def run_cases(factory: Callable[[Path], dict[str, Any]], paths: dict[str, str]) -> None:
    with tempfile.TemporaryDirectory(prefix="kiwi-conformance-") as raw:
        apps = factory(Path(raw))
        assert set(apps) == {"fallback", "fastapi"}, apps
        for stack, app in apps.items():
            malformed = request(
                app,
                "POST",
                "/no-such-route",
                headers={"content-type": "application/json", "authorization": "Bearer conformance-secret"},
                body=b"not-json",
            )
            _assert_error(malformed, 404)
            assert "conformance-secret" not in json.dumps(malformed.body), (stack, malformed)

            wrong_method = request(
                app,
                "DELETE",
                paths["known_post"],
                headers={"content-type": "application/json"},
                body=b"not-json",
            )
            _assert_error(wrong_method, 405)

            oversized = request(
                app,
                "POST",
                paths["known_post"],
                headers={"content-type": "application/json", "content-length": "2000000"},
                body=b"{}",
            )
            _assert_error(oversized, 413)

            exact_shape = request(
                app,
                "POST",
                paths["known_post"],
                headers={"content-type": "application/json"},
                body=b"{}",
            )
            assert exact_shape.status in {400, 404}, (stack, exact_shape)


def main(argv: Iterable[str]) -> int:
    specs = list(argv)
    if not specs:
        raise SystemExit("usage: run.py module:function [module:function ...]")
    for spec in specs:
        module_name, function_name = spec.split(":", 1)
        module = importlib.import_module(module_name)
        factory = getattr(module, function_name)
        paths = getattr(module, "paths", lambda: {"known_post": "/products"})()
        run_cases(factory, paths)
        print(f"conformance passed: {spec}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

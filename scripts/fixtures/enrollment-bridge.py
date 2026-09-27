# Copyright 2026 harrylabsj
# SPDX-License-Identifier: Apache-2.0
"""Local cross-repository test transport; ephemeral accounts/keys only."""
import asyncio
import json
import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlsplit

config = json.loads(Path(sys.argv[1]).read_text())
os.environ.update({
    "KIWI_CATALOG_EMAIL_VERIFICATION_MODE": "console",
    "KIWI_CATALOG_PUBLIC_BASE_URL": "https://catalog.example",
    "KIWI_CATALOG_PUBLIC_ORIGIN": "https://catalog.example",
    "KIWI_CATALOG_OWNER_TOKEN_SECRET": "cross-test-only-owner-secret",
    "KIWI_CATALOG_ISSUER_KEY_FILE": config["issuer"],
    "KIWI_CATALOG_ISSUER_KID": "cross-test-issuer",
    "KIWI_CATALOG_ISSUER_KEYS_FILE": "",
    "KIWI_CATALOG_ADMIN_TOKEN": "cross-test-only-admin",
})
from kiwi_catalog.api.app import create_catalog_app
from kiwi_catalog.discovery.fetcher import FetchResult

request = json.load(sys.stdin)
app = create_catalog_app(config["db"])


def challenge_post(self, url, body, **kwargs):
    assert url == "https://runtime.example/.well-known/kiwi-binding-challenge", url
    result = subprocess.run(
        ["node", config["responder"], sys.argv[1]],
        input=json.dumps(body), text=True, capture_output=True, check=True,
    )
    response = json.loads(result.stdout.strip().splitlines()[-1])
    return FetchResult(url=url, status_code=response["status"], body=json.dumps(response["body"]),
                       raw_bytes=json.dumps(response["body"]).encode(), fetched_at=0)


async def call():
    messages = []
    raw = json.dumps(request.get("body", {})).encode() if "body" in request else b""
    async def receive():
        return {"type": "http.request", "body": raw, "more_body": False}
    async def send(msg):
        messages.append(msg)
    headers = [(key.lower().encode(), str(value).encode()) for key, value in request.get("headers", {}).items()]
    target = urlsplit(request["path"])
    await app({"type": "http", "method": request["method"], "path": target.path,
               "query_string": target.query.encode(), "headers": headers, "scheme": "https", "http_version": "1.1",
               "client": ("198.51.100.27", 10000), "server": ("catalog.example", 443)}, receive, send)
    start = next(msg for msg in messages if msg["type"] == "http.response.start")
    content = b"".join(msg.get("body", b"") for msg in messages if msg["type"] == "http.response.body")
    return {"status": start["status"], "headers": {k.decode(): v.decode() for k, v in start["headers"]},
            "text": content.decode()}


with patch("kiwi_catalog.discovery.fetcher.ProfileFetcher.post_json", challenge_post):
    print(json.dumps(asyncio.run(call())))

import json
import sys
import threading
from http.client import HTTPConnection, RemoteDisconnected
from http.server import ThreadingHTTPServer
from io import BytesIO
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1]))

import tts_server
from tts_server import safe_static_path, validate_text


def test_static_path_allows_module_but_not_tts_runtime(monkeypatch, tmp_path: Path) -> None:
    static_root = tmp_path / "app" / "static"
    content_root = tmp_path / "content"
    (static_root / "js").mkdir(parents=True)
    content_root.mkdir()
    (static_root / "js" / "main.js").write_text("export {};", encoding="utf-8")
    (content_root / "topics.json").write_text("{}", encoding="utf-8")
    monkeypatch.setattr("tts_server.STATIC_ROOT", static_root)
    monkeypatch.setattr("tts_server.CONTENT_ROOT", content_root)

    assert safe_static_path("/js/main.js") == static_root / "js" / "main.js"
    assert safe_static_path("/content/topics.json") == content_root / "topics.json"
    assert safe_static_path("/../local-tts/python/python.exe") is None


def test_validate_text_rejects_empty_and_overlong_values() -> None:
    assert validate_text("  hello  ") == "hello"
    for invalid in ("", "x" * 6001):
        try:
            validate_text(invalid)
        except ValueError:
            pass
        else:
            raise AssertionError("expected ValueError")


def request_server(
    method: str,
    path: str,
    *,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, str], bytes]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), tts_server.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    connection = HTTPConnection("127.0.0.1", server.server_port, timeout=2)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        try:
            response = connection.getresponse()
        except RemoteDisconnected:
            return 0, {}, b""
        return response.status, dict(response.getheaders()), response.read()
    finally:
        connection.close()
        server.shutdown()
        thread.join()
        server.server_close()


def test_invalid_tts_payload_returns_400_without_loading_model(monkeypatch) -> None:
    def synthesize_never_called(_: str) -> bytes:
        raise AssertionError("synthesis should not run for invalid input")

    monkeypatch.setattr(tts_server, "synthesize", synthesize_never_called)

    status, _, body = request_server(
        "POST",
        "/tts",
        body=b'{"text": 42}',
        headers={"Content-Type": "application/json"},
    )

    assert status == 400
    assert json.loads(body)["error"] == "text must be a string"


def test_malformed_tts_json_returns_400_without_loading_model(monkeypatch) -> None:
    def synthesize_never_called(_: str) -> bytes:
        raise AssertionError("synthesis should not run for invalid input")

    monkeypatch.setattr(tts_server, "synthesize", synthesize_never_called)

    status, _, body = request_server(
        "POST",
        "/tts",
        body=b"\xff",
        headers={"Content-Type": "application/json"},
    )

    assert status == 400
    assert "error" in json.loads(body)


def test_cors_allows_only_default_local_origins() -> None:
    status, headers, _ = request_server(
        "OPTIONS",
        "/tts",
        headers={"Origin": "http://127.0.0.1:8000"},
    )

    assert status == 204
    assert headers["Access-Control-Allow-Origin"] == "http://127.0.0.1:8000"

    _, disallowed_headers, _ = request_server(
        "GET",
        "/health",
        headers={"Origin": "https://untrusted.example"},
    )

    assert "Access-Control-Allow-Origin" not in disallowed_headers


def test_tts_requires_json_content_type_before_synthesis(monkeypatch) -> None:
    def synthesize_never_called(_: str) -> bytes:
        raise AssertionError("synthesis should not run without JSON content")

    monkeypatch.setattr(tts_server, "synthesize", synthesize_never_called)

    status, _, body = request_server(
        "POST",
        "/tts",
        body=b'{"text": "Read this"}',
        headers={"Content-Type": "text/plain"},
    )

    assert status == 400
    assert "application/json" in json.loads(body)["error"]


def test_tts_rejects_a_disallowed_origin_before_synthesis(monkeypatch) -> None:
    def synthesize_never_called(_: str) -> bytes:
        raise AssertionError("synthesis should not run for an untrusted origin")

    monkeypatch.setattr(tts_server, "synthesize", synthesize_never_called)

    status, _, body = request_server(
        "POST",
        "/tts",
        body=b'{"text": "Read this"}',
        headers={
            "Content-Type": "text/plain",
            "Origin": "https://untrusted.example",
        },
    )

    assert status == 403
    assert "error" in json.loads(body)


def test_tts_rejects_an_oversized_body_before_reading_it() -> None:
    class RecordingBody:
        def __init__(self) -> None:
            self.read_sizes: list[int] = []

        def read(self, size: int) -> bytes:
            self.read_sizes.append(size)
            return b"{}"

    class FakeHandler:
        path = "/tts"
        headers = {
            "Content-Length": str(1024 * 1024),
            "Content-Type": "application/json",
        }

        def __init__(self) -> None:
            self.rfile = RecordingBody()
            self.wfile = BytesIO()
            self.status: int | None = None

        def send_response(self, status: int) -> None:
            self.status = status

        def send_header(self, *_: str) -> None:
            pass

        def end_headers(self) -> None:
            pass

    handler = FakeHandler()

    tts_server.Handler.do_POST(handler)

    assert handler.status == 413
    assert handler.rfile.read_sizes == []

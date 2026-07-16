import hashlib
import json
import mimetypes
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
APP_ROOT = ROOT.parent
CACHE_DIR = ROOT / "cache"
CACHE_DIR.mkdir(exist_ok=True)

HOST = "127.0.0.1"
PORT = int(os.environ.get("EMA_TTS_PORT", "8767"))
IDLE_SECONDS = int(os.environ.get("EMA_TTS_IDLE_SECONDS", "90"))
VOICE_NAME = os.environ.get("EMA_TTS_VOICE", "F1")
STATIC_ROOT = APP_ROOT / "app" / "static"
CONTENT_ROOT = APP_ROOT / "content"
STATIC_EXTENSIONS = {".html", ".css", ".js", ".json", ".svg", ".png", ".ico"}
MAX_TEXT_LENGTH = 6000
MAX_REQUEST_BODY_BYTES = 128 * 1024
DEFAULT_ALLOWED_ORIGINS = ("http://127.0.0.1:8000", "http://localhost:8000")
ALLOWED_ORIGINS = frozenset(
    origin
    for origin in (
        value.strip()
        for value in os.environ.get(
            "EMA_TTS_ALLOWED_ORIGINS", ",".join(DEFAULT_ALLOWED_ORIGINS)
        ).split(",")
    )
    if origin and origin != "*"
)

_tts = None
_voice_style = None
_last_heartbeat = 0.0
_saw_trainer = False
_shutdown_requested = False
_shutdown_lock = threading.Lock()


def get_tts():
    global _tts
    if _tts is None:
        from supertonic import TTS

        # Supertonic downloads model assets on first use.
        _tts = TTS()
    return _tts


def get_voice_style(tts):
    global _voice_style
    if _voice_style is None:
        if not hasattr(tts, "get_voice_style"):
            raise RuntimeError("Supertonic TTS object cannot load voice styles.")
        _voice_style = tts.get_voice_style(VOICE_NAME)
    return _voice_style


def synthesize(text):
    text = " ".join(text.split())
    if not text:
        raise ValueError("No text provided.")

    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]
    out_path = CACHE_DIR / f"{digest}.wav"
    if out_path.exists():
        return out_path.read_bytes()

    tts = get_tts()

    # Supertonic requires an explicit voice style.
    if hasattr(tts, "synthesize"):
        audio = tts.synthesize(text, voice_style=get_voice_style(tts), lang="en")
    elif hasattr(tts, "generate"):
        audio = tts.generate(text)
    elif hasattr(tts, "tts"):
        audio = tts.tts(text)
    else:
        raise RuntimeError("Supertonic TTS object has no known synthesis method.")

    if isinstance(audio, tuple):
        audio = audio[0]

    if hasattr(tts, "save_audio"):
        tts.save_audio(audio, str(out_path))
    elif hasattr(tts, "save"):
        tts.save(audio, str(out_path))
    else:
        try:
            import soundfile as sf

            sample_rate = getattr(tts, "sample_rate", 24000)
            sf.write(str(out_path), audio, sample_rate)
        except Exception as exc:
            raise RuntimeError("Could not save Supertonic audio output.") from exc

    return out_path.read_bytes()


def mark_trainer_active():
    global _last_heartbeat, _saw_trainer
    _last_heartbeat = time.monotonic()
    _saw_trainer = True


def request_shutdown(server, reason):
    global _shutdown_requested
    with _shutdown_lock:
        if _shutdown_requested:
            return
        _shutdown_requested = True

    print(reason)

    def stop_server():
        time.sleep(0.2)
        server.shutdown()

    threading.Thread(target=stop_server, daemon=True).start()


def idle_monitor(server):
    while True:
        time.sleep(5)
        if _shutdown_requested:
            return
        if _saw_trainer and time.monotonic() - _last_heartbeat > IDLE_SECONDS:
            request_shutdown(server, "No trainer heartbeat detected; stopping local TTS.")
            return


def validate_text(value: object) -> str:
    if not isinstance(value, str):
        raise ValueError("text must be a string")
    text = " ".join(value.split())
    if not text:
        raise ValueError("text is required")
    if len(text) > MAX_TEXT_LENGTH:
        raise ValueError(f"text must be at most {MAX_TEXT_LENGTH} characters")
    return text


def safe_static_path(raw_path: str) -> Path | None:
    relative = unquote(urlparse(raw_path).path).lstrip("/") or "index.html"
    root = CONTENT_ROOT if relative.startswith("content/") else STATIC_ROOT
    relative = relative.removeprefix("content/")
    path = (root / relative).resolve()
    try:
        path.relative_to(root.resolve())
    except ValueError:
        return None
    return path if path.is_file() and path.suffix.lower() in STATIC_EXTENSIONS else None


class Handler(BaseHTTPRequestHandler):
    server_version = "EmaCramLocalTTS/1.0"

    def end_headers(self):
        origin = self.headers.get("Origin")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS, GET")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Vary", "Origin")
        super().end_headers()

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))
            return

        if self.path == "/heartbeat":
            if self.headers.get("Origin") not in ALLOWED_ORIGINS:
                self.send_response(403)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Origin is not allowed."}).encode("utf-8"))
                return
            mark_trainer_active()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"ok": True}).encode("utf-8"))
            return

        static_path = safe_static_path(self.path)
        if static_path:
            content_type = mimetypes.guess_type(str(static_path))[0] or "application/octet-stream"
            data = static_path.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        self.send_response(404)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"error": "Not found"}).encode("utf-8"))

    def do_POST(self):
        if self.path == "/heartbeat":
            if self.headers.get("Origin") not in ALLOWED_ORIGINS:
                self.send_response(403)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": "Origin is not allowed."}).encode("utf-8"))
                return
            mark_trainer_active()
            self.send_response(204)
            self.end_headers()
            return

        if self.path != "/tts":
            self.send_response(404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Not found"}).encode("utf-8"))
            return

        origin = self.headers.get("Origin")
        if origin and origin not in ALLOWED_ORIGINS:
            self.send_response(403)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Origin is not allowed."}).encode("utf-8"))
            return

        content_type = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if content_type != "application/json":
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(
                json.dumps({"error": "Content-Type must be application/json."}).encode("utf-8")
            )
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 0:
                raise ValueError("Content-Length must be non-negative")
        except (TypeError, ValueError) as exc:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode("utf-8"))
            return

        if length > MAX_REQUEST_BODY_BYTES:
            self.send_response(413)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Request body is too large."}).encode("utf-8"))
            return

        try:
            payload = json.loads(self.rfile.read(length) or b"{}")
        except (json.JSONDecodeError, UnicodeDecodeError, RecursionError):
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Invalid JSON payload."}).encode("utf-8"))
            return

        try:
            if not isinstance(payload, dict):
                raise ValueError("payload must be a JSON object")
            text = validate_text(payload.get("text", ""))
        except (TypeError, ValueError) as exc:
            self.send_response(400)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": str(exc)}).encode("utf-8"))
            return

        try:
            audio = synthesize(text)
        except Exception:
            traceback.print_exc()
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "Speech synthesis failed."}).encode("utf-8"))
            return

        self.send_response(200)
        self.send_header("Content-Type", "audio/wav")
        self.send_header("Content-Length", str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)

    def log_message(self, fmt, *args):
        sys.stdout.write("%s - %s\n" % (self.address_string(), fmt % args))


def main():
    print(f"EMA Cram local TTS listening at http://{HOST}:{PORT}")
    print(f"Trainer URL: http://{HOST}:{PORT}/index.html")
    print("First speech request can take a while because Supertonic may download/load the model.")
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    threading.Thread(target=idle_monitor, args=(server,), daemon=True).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("Stopping local TTS.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

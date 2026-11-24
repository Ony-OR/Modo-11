#!/usr/bin/env python3
"""Servidor local, sin dependencias, para el Pre-ICFES Saber 11."""

from __future__ import annotations

import argparse
import hashlib
import json
import mimetypes
import socket
import threading
import time
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
QUESTIONS_PATH = ROOT / "questions.json"
HISTORY_PATH = ROOT / "progress.json"
MAX_BODY_BYTES = 128_000
STATIC_FILES = {
    "/static/style.css": STATIC / "style.css",
    "/static/app.js": STATIC / "app.js",
}
HISTORY_LOCK = threading.RLock()
QUESTIONS_CACHE = None
QUESTIONS_MTIME = None
STUDY_CACHE = None
STUDY_MTIME = None
STARTED_AT = time.monotonic()


def load_questions():
    global QUESTIONS_CACHE, QUESTIONS_MTIME
    try:
        mtime = QUESTIONS_PATH.stat().st_mtime_ns
    except OSError:
        raise
    if QUESTIONS_CACHE is not None and mtime == QUESTIONS_MTIME:
        return QUESTIONS_CACHE
    with QUESTIONS_PATH.open("r", encoding="utf-8") as file:
        questions = json.load(file)
    if not isinstance(questions, list):
        raise ValueError("El banco de preguntas debe ser una lista.")
    required = {"id", "area", "topic", "competency", "difficulty", "prompt", "options", "answer", "explanation", "tip"}
    ids = set()
    for index, question in enumerate(questions):
        if not isinstance(question, dict) or not required.issubset(question):
            raise ValueError("Pregunta incompleta en la posición %d." % (index + 1))
        question_id = str(question["id"])
        if not question_id or question_id in ids:
            raise ValueError("El banco contiene identificadores vacíos o repetidos.")
        ids.add(question_id)
        if not isinstance(question["options"], list) or len(question["options"]) < 2:
            raise ValueError("La pregunta %s no tiene opciones válidas." % question_id)
        keys = [str(option.get("key", "")) for option in question["options"] if isinstance(option, dict)]
        if len(keys) != len(question["options"]) or len(set(keys)) != len(keys):
            raise ValueError("La pregunta %s tiene opciones inválidas." % question_id)
        if str(question["answer"]) not in keys:
            raise ValueError("La respuesta correcta de %s no coincide con sus opciones." % question_id)
    QUESTIONS_CACHE = questions
    QUESTIONS_MTIME = mtime
    return questions


def load_study():
    global STUDY_CACHE, STUDY_MTIME
    try:
        mtime = (ROOT / "study.json").stat().st_mtime_ns
    except OSError:
        raise
    if STUDY_CACHE is not None and mtime == STUDY_MTIME:
        return STUDY_CACHE
    with (ROOT / "study.json").open("r", encoding="utf-8") as file:
        study = json.load(file)
    if not isinstance(study, dict):
        raise ValueError("La guía de estudio no es válida.")
    STUDY_CACHE = study
    STUDY_MTIME = mtime
    return study


def read_history():
    with HISTORY_LOCK:
        if not HISTORY_PATH.exists():
            return []
        try:
            with HISTORY_PATH.open("r", encoding="utf-8") as file:
                data = json.load(file)
            return data if isinstance(data, list) else []
        except (OSError, json.JSONDecodeError):
            return []


def save_history(history):
    with HISTORY_LOCK:
        kept = history[-100:]
        temporary = HISTORY_PATH.with_suffix(".tmp")
        with temporary.open("w", encoding="utf-8") as file:
            json.dump(kept, file, ensure_ascii=False, indent=2)
        temporary.replace(HISTORY_PATH)


def clear_history():
    with HISTORY_LOCK:
        if HISTORY_PATH.exists():
            HISTORY_PATH.unlink()


def public_question(question):
    return {
        key: question[key]
        for key in ("id", "area", "topic", "competency", "difficulty", "prompt", "options")
    }


class StudyHandler(BaseHTTPRequestHandler):
    server_version = "PreICFESLocal/2.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, format_string, *args):
        print("%s - %s" % (self.address_string(), format_string % args))

    def send_bytes(self, body, content_type, status=200):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy", "geolocation=(), camera=(), microphone=()")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def send_json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_bytes(body, "application/json; charset=utf-8", status)

    def read_json_body(self):
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            raise ValueError("Longitud de solicitud inválida.")
        if length < 1 or length > MAX_BODY_BYTES:
            raise ValueError("La solicitud está vacía o supera el límite permitido.")
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise ValueError("El contenido no es JSON válido.")

    def send_file(self, file_path, content_type):
        try:
            body = file_path.read_bytes()
        except OSError:
            self.send_json({"error": "No se encontró el archivo solicitado."}, 404)
            return
        etag = '"' + hashlib.sha256(body).hexdigest()[:16] + '"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Cache-Control", "public, max-age=60")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Cache-Control", "public, max-age=60")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/health":
            self.send_json({
                "status": "ok",
                "questions": len(load_questions()) if QUESTIONS_PATH.exists() else 0,
                "uptime_seconds": round(time.monotonic() - STARTED_AT),
            })
            return
        if path == "/":
            self.send_file(STATIC / "index.html", "text/html; charset=utf-8")
            return

        if path in STATIC_FILES:
            file_path = STATIC_FILES[path]
            content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
            if content_type.startswith("text/") or content_type == "application/javascript":
                content_type += "; charset=utf-8"
            self.send_file(file_path, content_type)
            return

        if path == "/api/questions":
            try:
                questions = load_questions()
            except (OSError, json.JSONDecodeError, ValueError):
                self.send_json({"error": "No se pudo cargar el banco de preguntas."}, 500)
                return
            query = parse_qs(urlparse(self.path).query)
            area = query.get("area", [""])[0].strip()
            if area:
                questions = [question for question in questions if question["area"].lower() == area.lower()]
            self.send_json({
                "questions": [public_question(q) for q in questions],
                "total": len(questions),
            })
            return

        if path == "/api/study":
            try:
                self.send_json(load_study())
            except (OSError, json.JSONDecodeError, ValueError):
                self.send_json({"error": "No se pudo cargar la guía de estudio."}, 500)
            return

        if path == "/api/progress":
            self.send_json({"attempts": read_history()[-20:]})
            return

        self.send_json({"error": "Ruta no encontrada."}, 404)

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ("/api/grade", "/api/attempt"):
            self.send_json({"error": "Ruta no encontrada."}, 404)
            return
        try:
            payload = self.read_json_body()
        except ValueError as error:
            self.send_json({"error": str(error)}, 400)
            return

        try:
            questions = load_questions()
        except (OSError, json.JSONDecodeError, ValueError):
            self.send_json({"error": "No se pudo cargar el banco de preguntas."}, 500)
            return
        by_id = {question["id"]: question for question in questions}

        if path == "/api/grade":
            if not isinstance(payload, dict):
                self.send_json({"error": "El cuerpo debe ser un objeto JSON."}, 400)
                return
            question = by_id.get(str(payload.get("question_id", "")))
            choice = str(payload.get("choice", ""))
            if question is None:
                self.send_json({"error": "Pregunta no encontrada."}, 404)
                return
            valid_choices = {option["key"] for option in question["options"]}
            if choice not in valid_choices:
                self.send_json({"error": "Opción no válida."}, 400)
                return
            self.send_json(
                {
                    "correct": choice == question["answer"],
                    "correct_answer": question["answer"],
                    "explanation": question["explanation"],
                    "tip": question["tip"],
                }
            )
            return

        if path == "/api/attempt":
            if not isinstance(payload, dict):
                self.send_json({"error": "El cuerpo debe ser un objeto JSON."}, 400)
                return
            items = payload.get("items")
            if not isinstance(items, list) or not items or len(items) > 50:
                self.send_json({"error": "El simulacro debe tener entre 1 y 50 preguntas."}, 400)
                return

            seen = set()
            area_scores = {}
            correct_total = 0
            for item in items:
                if not isinstance(item, dict):
                    self.send_json({"error": "Respuesta inválida."}, 400)
                    return
                question_id = str(item.get("question_id", ""))
                choice = str(item.get("choice", ""))
                question = by_id.get(question_id)
                if question is None or question_id in seen:
                    self.send_json({"error": "La lista contiene una pregunta inválida o repetida."}, 400)
                    return
                if choice not in {option["key"] for option in question["options"]}:
                    self.send_json({"error": "La lista contiene una opción inválida."}, 400)
                    return
                seen.add(question_id)
                area = question["area"]
                area_scores.setdefault(area, {"correct": 0, "total": 0})
                area_scores[area]["total"] += 1
                if choice == question["answer"]:
                    area_scores[area]["correct"] += 1
                    correct_total += 1

            for score in area_scores.values():
                score["percent"] = round(score["correct"] * 100 / score["total"])

            duration = payload.get("duration_seconds", 0)
            if isinstance(duration, bool) or not isinstance(duration, (int, float)):
                duration = 0
            duration = max(0, min(86400, int(duration)))
            result = {
                "id": str(uuid4()),
                "date": datetime.now().astimezone().isoformat(timespec="minutes"),
                "mode": str(payload.get("mode", "Práctica"))[:40],
                "correct": correct_total,
                "total": len(items),
                "percent": round(correct_total * 100 / len(items)),
                "areas": area_scores,
                "duration_seconds": duration,
            }
            history = read_history()
            history.append(result)
            try:
                save_history(history)
            except OSError:
                self.send_json(
                    {"error": "El resultado se calculó, pero no se pudo guardar el historial."},
                    500,
                )
                return
            self.send_json({"result": result})
            return

        self.send_json({"error": "Ruta no encontrada."}, 404)

    def do_DELETE(self):
        path = urlparse(self.path).path
        if path != "/api/progress":
            self.send_json({"error": "Ruta no encontrada."}, 404)
            return
        try:
            clear_history()
        except OSError:
            self.send_json({"error": "No se pudo borrar el historial."}, 500)
            return
        self.send_json({"attempts": []})

    def do_HEAD(self):
        path = urlparse(self.path).path
        if path == "/":
            body = (STATIC / "index.html").read_bytes()
            self.send_bytes(body, "text/html; charset=utf-8")
            return
        if path in STATIC_FILES:
            file_path = STATIC_FILES[path]
            body = file_path.read_bytes()
            content_type = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
            self.send_bytes(body, content_type)
            return
        self.send_json({"error": "Ruta no encontrada."}, 404)

    def do_PUT(self):
        self.send_json({"error": "Método no permitido."}, 405)

    def do_PATCH(self):
        self.send_json({"error": "Método no permitido."}, 405)


def local_ip():
    """Obtiene la dirección de la red local sin enviar datos a Internet."""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        sock.connect(("192.0.2.1", 1))
        return sock.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        sock.close()


def main():
    parser = argparse.ArgumentParser(description="Pre-ICFES Saber 11 en tu red local.")
    parser.add_argument("--host", default="0.0.0.0", help="Dirección de escucha.")
    parser.add_argument("--port", type=int, default=8765, help="Puerto local (por defecto: 8765).")
    args = parser.parse_args()

    try:
        server = ThreadingHTTPServer((args.host, args.port), StudyHandler)
    except OSError as error:
        print("No se pudo iniciar el servidor: %s" % error)
        raise SystemExit(1)

    print("Pre-ICFES listo.")
    print("En este equipo: http://127.0.0.1:%s" % args.port)
    if args.host in ("0.0.0.0", ""):
        print("En tu celular (misma red Wi-Fi): http://%s:%s" % (local_ip(), args.port))
    print("Deja esta ventana abierta mientras estudias. Para detenerlo, presiona Ctrl+C.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

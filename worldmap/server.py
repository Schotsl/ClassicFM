#!/usr/bin/env python3
import argparse
import json
import math
import os
import time
import webbrowser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
STATE_DIR = ROOT / "state"
COUNTRIES_PATH = ROOT / "static" / "countries.json"
CALIBRATION_PATH = STATE_DIR / "calibration.json"
SELECTED_COUNTRIES_PATH = STATE_DIR / "selected_countries.json"
DISPLAY_EFFECT_PATH = STATE_DIR / "display_effect.json"

DEFAULT_CALIBRATION = {
    "x": 0,
    "y": 0,
    "scaleX": 1,
    "scaleY": 1,
    "rotation": 0,
    "opacity": 1,
    "fill": "#ffffff",
    "background": "#000000",
    "baseWidth": 1024,
    "baseHeight": 600,
}
DEFAULT_SELECTED_COUNTRIES = {"countries": []}
DEFAULT_DISPLAY_EFFECT = {"mode": "normal", "surpriseRunId": 0, "surpriseStartedAt": 0}


def read_json(path, fallback):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback.copy()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_suffix(f"{path.suffix}.tmp")
    temporary_path.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    os.replace(temporary_path, path)


def clamp_number(value, fallback, minimum, maximum):
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback

    if not math.isfinite(number):
        return fallback

    return max(minimum, min(maximum, number))


def normalize_color(value, fallback):
    if not isinstance(value, str):
        return fallback

    color = value.strip()
    if len(color) != 7 or color[0] != "#":
        return fallback

    hex_digits = "0123456789abcdefABCDEF"
    if not all(character in hex_digits for character in color[1:]):
        return fallback

    return color.lower()


def known_country_ids():
    countries = read_json(COUNTRIES_PATH, {"countries": []})
    return {country["id"] for country in countries.get("countries", [])}


def normalize_calibration(payload):
    legacy_scale = clamp_number(payload.get("scale"), 1, 0.1, 5)
    fill = payload.get("fill")
    background = payload.get("background")
    if fill is None:
        fill = payload.get("background")
        background = DEFAULT_CALIBRATION["background"]

    return {
        "x": clamp_number(payload.get("x"), DEFAULT_CALIBRATION["x"], -2000, 2000),
        "y": clamp_number(payload.get("y"), DEFAULT_CALIBRATION["y"], -2000, 2000),
        "scaleX": clamp_number(payload.get("scaleX"), legacy_scale, 0.1, 5),
        "scaleY": clamp_number(payload.get("scaleY"), legacy_scale, 0.1, 5),
        "rotation": clamp_number(
            payload.get("rotation"), DEFAULT_CALIBRATION["rotation"], -360, 360
        ),
        "opacity": clamp_number(payload.get("opacity"), DEFAULT_CALIBRATION["opacity"], 0, 1),
        "fill": normalize_color(fill, DEFAULT_CALIBRATION["fill"]),
        "background": normalize_color(background, DEFAULT_CALIBRATION["background"]),
        "baseWidth": DEFAULT_CALIBRATION["baseWidth"],
        "baseHeight": DEFAULT_CALIBRATION["baseHeight"],
    }


def normalize_selected_countries(payload):
    ids = known_country_ids()
    selected = payload.get("countries", [])
    if not isinstance(selected, list):
        selected = []

    countries = []
    seen = set()
    for country_id in selected:
        if not isinstance(country_id, str) or country_id not in ids or country_id in seen:
            continue
        countries.append(country_id)
        seen.add(country_id)

    countries.sort()
    return {"countries": countries}


class WorldmapHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        path = unquote(urlparse(self.path).path)

        if path == "/api/state":
            self.send_json({
                "calibration": normalize_calibration(read_json(CALIBRATION_PATH, DEFAULT_CALIBRATION)),
                "selectedCountries": read_json(SELECTED_COUNTRIES_PATH, DEFAULT_SELECTED_COUNTRIES),
                "displayEffect": read_json(DISPLAY_EFFECT_PATH, DEFAULT_DISPLAY_EFFECT),
            })
            return

        if path == "/":
            self.path = "/index.html"
        elif path == "/display":
            self.path = "/display.html"
        elif path == "/calibrate":
            self.path = "/calibrate.html"
        elif path in {"/suprise", "/surprise"}:
            self.path = "/suprise.html"

        super().do_GET()

    def do_POST(self):
        path = unquote(urlparse(self.path).path)

        try:
            payload = self.read_json_body()
        except ValueError:
            self.send_error(HTTPStatus.BAD_REQUEST, "Invalid JSON")
            return

        if path == "/api/calibration":
            calibration = normalize_calibration(payload)
            write_json(CALIBRATION_PATH, calibration)
            self.send_json(calibration)
            return

        if path == "/api/selected-countries":
            selected_countries = normalize_selected_countries(payload)
            write_json(SELECTED_COUNTRIES_PATH, selected_countries)
            effect = read_json(DISPLAY_EFFECT_PATH, DEFAULT_DISPLAY_EFFECT)
            effect["mode"] = "normal"
            write_json(DISPLAY_EFFECT_PATH, effect)
            self.send_json(selected_countries)
            return

        if path == "/api/surprise":
            effect = read_json(DISPLAY_EFFECT_PATH, DEFAULT_DISPLAY_EFFECT)
            next_effect = {
                "mode": "normal",
                "surpriseRunId": int(effect.get("surpriseRunId", 0)) + 1,
                "surpriseStartedAt": round(time.time() * 1000),
            }
            write_json(DISPLAY_EFFECT_PATH, next_effect)
            self.send_json(next_effect)
            return

        if path == "/api/display-mode":
            mode = payload.get("mode")
            if mode not in {"normal", "blank"}:
                self.send_error(HTTPStatus.BAD_REQUEST, "Invalid display mode")
                return

            effect = read_json(DISPLAY_EFFECT_PATH, DEFAULT_DISPLAY_EFFECT)
            effect["mode"] = mode
            write_json(DISPLAY_EFFECT_PATH, effect)
            self.send_json(effect)
            return

        self.send_error(HTTPStatus.NOT_FOUND, "Unknown API route")

    def read_json_body(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw_body = self.rfile.read(length)
        try:
            return json.loads(raw_body.decode("utf-8"))
        except json.JSONDecodeError as error:
            raise ValueError from error

    def send_json(self, data, status=HTTPStatus.OK):
        body = json.dumps(data, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def ensure_state_files():
    if not CALIBRATION_PATH.exists():
        write_json(CALIBRATION_PATH, DEFAULT_CALIBRATION)
    if not SELECTED_COUNTRIES_PATH.exists():
        write_json(SELECTED_COUNTRIES_PATH, DEFAULT_SELECTED_COUNTRIES)
    if not DISPLAY_EFFECT_PATH.exists():
        write_json(DISPLAY_EFFECT_PATH, DEFAULT_DISPLAY_EFFECT)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--open", action="store_true")
    parser.add_argument("--open-path", default="/")
    args = parser.parse_args()

    ensure_state_files()

    if not COUNTRIES_PATH.exists():
        raise FileNotFoundError(
            "Missing static/countries.json. Run: .venv/bin/python build_country_data.py"
        )

    server = ThreadingHTTPServer((args.host, args.port), WorldmapHandler)
    print(f"Serving worldmap on http://{args.host}:{args.port}")
    if args.open:
        browser_host = "127.0.0.1" if args.host == "0.0.0.0" else args.host
        webbrowser.open(f"http://{browser_host}:{args.port}{args.open_path}")
    server.serve_forever()


if __name__ == "__main__":
    main()

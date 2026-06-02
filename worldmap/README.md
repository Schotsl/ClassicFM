# Worldmap

Pi-friendly web app for projecting selected countries onto a physical world map.

## Run Locally

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python build_country_data.py
.venv/bin/python server.py --host 0.0.0.0 --port 8000
```

To open a local browser window from the Python process:

```bash
.venv/bin/python server.py --host 0.0.0.0 --port 8000 --open
```

Open:

- `http://localhost:8000/` for country selection.
- `http://localhost:8000/display` for the clean projection output.
- `http://localhost:8000/calibrate` for alignment.
- `http://localhost:8000/suprise` for the one-time gift reveal control.

## Persisted State

The app writes plain JSON files:

- `state/calibration.json` stores `x`, `y`, `scaleX`, `scaleY`, `rotation`, and `opacity`.
- `state/selected_countries.json` stores the selected country IDs.
- `state/display_effect.json` stores display mode and surprise trigger state.

These files are read on startup, so calibration and selected countries survive reboot as long as the project folder is persisted.

## Display Behavior

The display route uses a `1024x600` canvas. Selected countries are filled bright white. Unselected countries are not drawn. Keep this route open on the Pi display.

The calibration route lights up a random 50% of countries in white so the projection can be aligned against the physical map.

The control route is for the remote phone and saves selected countries. The suprise route is also for the remote phone; its big toggle blanks the Pi display when off, and when switched on it flashes random countries on the Pi display for about 10 seconds before settling on the countries stored in `state/selected_countries.json`.

## Deployment Notes

The frame Pi is deployed under `/home/schotsl/worldmap` and runs the app through user systemd services:

- `worldmap.service` serves the app on port `8000`.
- `worldmap-kiosk.service` opens Chromium on `/display`.
- `worldmap-healthcheck.timer` checks the local HTTP endpoint and restarts the app if it fails.
- `worldmap-port80-proxy.service` forwards plain `http://<pi-address>/` traffic to the app on port `8000`.

Reliability tuning on the Pi:

- The hardware watchdog is enabled through systemd.
- CPU speed is capped at `arm_freq=800` with `arm_boost=0`.
- Journald retention is limited to keep SD-card writes down.
- Unused desktop and background services were trimmed back for kiosk use.

Calibration now supports:

- `x` and `y` offsets
- `scaleX` and `scaleY`
- `rotation`
- `opacity`
- `fill`
- `background`

The current calibration and country selection stay in `state/*.json` on the Pi, so they persist across reboot.

## Hotspot Preparation

The Pi is prepared to host its own NetworkManager hotspot on `192.168.4.1`. The QR-code credentials live in the root-owned `/etc/worldmap-hotspot.conf` file, and the prepared NetworkManager profile is named `worldmap-hotspot`.

```bash
/home/schotsl/.local/bin/worldmap-hotspot-prepare
```

The profile is inactive by default and has autoconnect disabled. The first activation should use the rollback-protected test command:

```bash
/home/schotsl/.local/bin/worldmap-hotspot-activate-test
```

That command switches Wi-Fi to the hotspot and schedules an automatic rollback to the current home Wi-Fi after five minutes. If the hotspot works, connect to it, open `http://192.168.4.1/`, and commit the hotspot from SSH:

```bash
ssh schotsl@192.168.4.1 /home/schotsl/.local/bin/worldmap-hotspot-commit
```

To manually restore the home Wi-Fi:

```bash
/home/schotsl/.local/bin/worldmap-hotspot-restore
```

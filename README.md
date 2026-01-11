# Classic FM Buffer Player

This repo contains a Bun application that plays ClassicFM with a one-hour buffer to ensure continuous music even when Wi-Fi is spotty. It was made especially for my grandma!

## Requirements

- Bun
- ffmpeg (`brew install ffmpeg`)

## Usage

```bash
bun install
bun start
```

## Health Endpoint

```bash
curl http://localhost/
```

```json
{
  "status": "healthy",
  "buffer": {
    "sizeMB": 55.2,
    "targetMB": 56.25,
    "percentage": 98,
    "minutes": 57
  },
  "playback": "playing",
  "nextRebuild": "2026-01-11T03:00:00.000Z"
}
```

## Manual Buffer Rebuild

```bash
curl -X POST http://localhost:3000/rebuild
```

```json
{
  "status": "started"
}
```

Returns `202` when the rebuild starts, or `409` if one is already running.

## Config (env vars)

Copy `.env.example` to `.env` and set `STREAM_URL`.

| Variable                 | Default | Description                           |
| ------------------------ | ------- | ------------------------------------- |
| `STREAM_URL`             | —       | MP3 stream URL                        |
| `BUFFER_DURATION`        | 1 hour  | Buffer size                           |
| `INITIAL_BUFFER_MINUTES` | 1       | Initial buffer before playback starts |
| `HEALTH_PORT`            | 3000    | Health endpoint port                  |
| `REBUILD_HOUR`           | 4       | Hour to rebuild buffer (0-23)         |
| `BITRATE_KBPS`           | 24      | Expected bitrate in KB/s              |

## How it works

1. Connects to the MP3 stream and continuously appends bytes to a circular buffer sized by `BUFFER_DURATION`
2. Waits for `INITIAL_BUFFER_MINUTES`, then feeds ~100ms chunks to `ffplay`
3. If the buffer runs low, playback pauses until it refills; if the player exits, it is restarted
4. At `REBUILD_HOUR`, playback pauses, the buffer clears, refills to target, then resumes
5. A health endpoint reports buffer and playback state

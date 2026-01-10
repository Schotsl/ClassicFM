# Classic FM Buffer Player

Streams Classic FM with a 1-hour buffer for WiFi dropout protection. Uses Effect for functional programming.

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
curl http://localhost:3002/health
```

```json
{
  "status": "healthy",
  "buffer": { "sizeMB": 55.2, "targetMB": 56.25, "percentage": 98, "minutes": 57 },
  "playback": "playing",
  "nextRebuild": "2026-01-11T03:00:00.000Z"
}
```

## Config (env vars)

| Variable | Default | Description |
|----------|---------|-------------|
| `STREAM_URL` | classic.nl stream | MP3 stream URL |
| `BUFFER_DURATION` | 1 hour | Buffer size |
| `INITIAL_BUFFER_MINUTES` | 1 | Initial buffer before playback starts |
| `HEALTH_PORT` | 3002 | Health endpoint port |
| `REBUILD_HOUR` | 4 | Hour to rebuild buffer (0-23) |

## How it works

1. Streams MP3 from Classic FM into a 1-hour circular buffer
2. Pipes buffered audio to `ffplay` for playback
3. If WiFi drops, continues playing from buffer
4. At 4 AM daily, pauses to rebuild fresh buffer

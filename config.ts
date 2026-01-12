import { Config, Duration } from "effect";
import { tmpdir } from "os";

export const AppConfig = {
  StreamUrl: Config.string("STREAM_URL"),
  BufferDuration: Config.duration("BUFFER_DURATION").pipe(Config.withDefault(Duration.hours(1))),
  BufferTempDir: Config.string("BUFFER_TEMP_DIR").pipe(Config.withDefault(tmpdir())),
  InitialBufferMinutes: Config.integer("INITIAL_BUFFER_MINUTES").pipe(Config.withDefault(1)),
  HealthPort: Config.integer("HEALTH_PORT").pipe(Config.withDefault(3000)),
  RebuildHour: Config.integer("REBUILD_HOUR").pipe(Config.withDefault(4)),
  // 192kbps = 24KB/s
  BitrateKBps: Config.integer("BITRATE_KBPS").pipe(Config.withDefault(24)),
};

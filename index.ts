import { Effect, Console, Logger, LogLevel, ManagedRuntime } from "effect";
import { MainLayer } from "./layers/MainLayer";
import { PlaybackService } from "./services/PlaybackService";
import { SchedulerService } from "./services/SchedulerService";
import { HealthService } from "./services/HealthService";
import {
  captureExceptionSync,
  flushSentry,
  initSentry,
  initSentryOnce,
} from "./utils/sentry";

initSentryOnce();

const program = Effect.gen(function* () {
  yield* initSentry();
  yield* Console.log("🎵 Classic FM Buffer Player");

  const health = yield* HealthService;
  const playback = yield* PlaybackService;
  const scheduler = yield* SchedulerService;

  yield* health.start();
  yield* playback.start();
  yield* scheduler.start();

  yield* Console.log("✅ Running! Press Ctrl+C to stop");
  yield* Effect.never;
});

const shutdown = Effect.gen(function* () {
  yield* Console.log("\n🛑 Shutting down...");

  const playback = yield* PlaybackService;
  const scheduler = yield* SchedulerService;
  const health = yield* HealthService;

  yield* playback.stop();
  yield* scheduler.stop();
  yield* health.stop();
  yield* flushSentry();
});

const runtime = ManagedRuntime.make(MainLayer);
const programWithLogs = program.pipe(
  Effect.provide(Logger.minimumLogLevel(LogLevel.Info))
);
const shutdownWithLogs = shutdown.pipe(
  Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
  Effect.catchAll(() => Effect.void)
);

let shuttingDown = false;
const handleShutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;

  runtime
    .runPromise(shutdownWithLogs)
    .finally(() => runtime.dispose().finally(() => process.exit(0)));
};

process.on("SIGINT", handleShutdown);
process.on("SIGTERM", handleShutdown);
process.on("uncaughtException", (err) => {
  captureExceptionSync(err, {
    tags: { component: "process", event: "uncaughtException" },
  });
});
process.on("unhandledRejection", (reason) => {
  captureExceptionSync(reason, {
    tags: { component: "process", event: "unhandledRejection" },
  });
});

runtime.runPromise(programWithLogs).catch((e) => {
  console.error("Fatal:", e);
  captureExceptionSync(e, { tags: { component: "runtime", event: "fatal" } });
  runtime.dispose().finally(() => process.exit(1));
});

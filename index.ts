import { Effect, Console, Logger, LogLevel, ManagedRuntime } from "effect";
import { MainLayer } from "./layers/MainLayer";
import { PlaybackService } from "./services/PlaybackService";
import { SchedulerService } from "./services/SchedulerService";
import { HealthService } from "./services/HealthService";
import { captureExceptionSync, flushSentry, initSentry, initSentryOnce } from "./utils/sentry";

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
const programWithLogs = program.pipe(Effect.provide(Logger.minimumLogLevel(LogLevel.Info)));
const shutdownWithLogs = shutdown.pipe(
  Effect.provide(Logger.minimumLogLevel(LogLevel.Info)),
  Effect.catchAll(() => Effect.void),
);

let shuttingDown = false;
let shutdownExitCode = 0;
const handleShutdown = (exitCode = 0) => {
  shutdownExitCode = Math.max(shutdownExitCode, exitCode);
  if (shuttingDown) return;
  shuttingDown = true;

  runtime
    .runPromise(shutdownWithLogs)
    .finally(() => runtime.dispose().finally(() => process.exit(shutdownExitCode)));
};

const reportFatal = (error: unknown, tags: { component: string; event: string }) => {
  captureExceptionSync(error, { tags });
  handleShutdown(1);
};

const handleFatal = (error: unknown, event: "uncaughtException" | "unhandledRejection") => {
  reportFatal(error, { component: "process", event });
};

process.on("SIGINT", () => handleShutdown(0));
process.on("SIGTERM", () => handleShutdown(0));
process.on("uncaughtException", (err) => handleFatal(err, "uncaughtException"));
process.on("unhandledRejection", (reason) => handleFatal(reason, "unhandledRejection"));

runtime.runPromise(programWithLogs).catch((e) => {
  console.error("Fatal:", e);
  reportFatal(e, { component: "runtime", event: "fatal" });
});

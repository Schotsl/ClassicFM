import { Context, Effect, Layer, Ref, Stream, Schedule, Duration, Fiber } from "effect";
import { Subprocess } from "bun";
import { BufferService } from "./BufferService";
import { StreamService } from "./StreamService";
import { AppConfig } from "../config";
import { addBreadcrumb, captureException, captureMessage } from "../utils/sentry";

type PlaybackState = "stopped" | "buffering" | "playing" | "paused";
type PlaybackRunResult = "stopped" | "restart";
type PlayerProcess = Subprocess<"pipe", "ignore", "ignore">;

export class PlaybackService extends Context.Tag("PlaybackService")<
  PlaybackService,
  {
    readonly start: () => Effect.Effect<void>;
    readonly pause: () => Effect.Effect<void>;
    readonly resume: () => Effect.Effect<void>;
    readonly stop: () => Effect.Effect<void>;
    readonly getState: () => Effect.Effect<PlaybackState>;
  }
>() {}

export const PlaybackServiceLive = Layer.effect(
  PlaybackService,
  Effect.gen(function* () {
    const buffer = yield* BufferService;
    const stream = yield* StreamService;
    const bitrateKBps = yield* AppConfig.BitrateKBps;
    const initialBufferMinutes = yield* AppConfig.InitialBufferMinutes;

    const stateRef = yield* Ref.make<PlaybackState>("stopped");
    const bufferFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
    const playbackFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
    const playerRef = yield* Ref.make<PlayerProcess | null>(null);

    // Continuously fill buffer from stream
    const bufferLoop = Effect.gen(function* () {
      yield* Effect.log("Starting buffer fill");

      while (true) {
        const audioStream = yield* stream.connect().pipe(
          Effect.retry(
            Schedule.exponential(Duration.seconds(1)).pipe(Schedule.intersect(Schedule.recurs(5))),
          ),
          Effect.catchAll((e) =>
            captureMessage("Stream connect failed", "warning", {
              tags: { component: "stream", event: "connect" },
              extra: {
                error: e instanceof Error ? e.message : String(e),
              },
            }).pipe(
              Effect.zipRight(Effect.logError(e)),
              Effect.zipRight(Effect.sleep(Duration.seconds(2))),
              Effect.as(Stream.empty as Stream.Stream<Uint8Array, Error>),
            ),
          ),
        );

        yield* Stream.runForEach(audioStream, (chunk) =>
          Ref.get(stateRef).pipe(
            Effect.flatMap((s) => (s === "stopped" ? Effect.void : buffer.append(chunk))),
          ),
        ).pipe(
          Effect.catchAll((e) =>
            captureMessage("Stream read failed", "warning", {
              tags: { component: "stream", event: "read" },
              extra: {
                error: e instanceof Error ? e.message : String(e),
              },
            }).pipe(
              Effect.zipRight(Effect.logError(e)),
              Effect.zipRight(Effect.sleep(Duration.seconds(2))),
            ),
          ),
        );
      }
    });

    // Play audio via ffplay
    const playbackLoop = Effect.gen(function* () {
      yield* Effect.log("Starting audio playback");
      yield* addBreadcrumb({
        category: "playback",
        message: "Playback loop starting",
        level: "info",
      });
      if (initialBufferMinutes > 0) {
        yield* Effect.log(`Waiting for initial buffer (${initialBufferMinutes} min)...`);
      }
      yield* buffer.waitForMinutes(initialBufferMinutes);
      yield* Effect.log("Buffer ready");

      const chunkDurationMs = 100;
      const bytesPerChunk = Math.floor((bitrateKBps * 1024 * chunkDurationMs) / 1000); // 100ms chunks
      const writeChunk = (player: PlayerProcess, chunk: Uint8Array) =>
        Effect.gen(function* () {
          if (!player.stdin) {
            return yield* Effect.fail(new Error("Player stdin unavailable"));
          }
          yield* Effect.try({
            try: () => player.stdin.write(chunk),
            catch: (e) => new Error(`Player write failed: ${e}`),
          });
          yield* Effect.tryPromise({
            try: () => Promise.resolve(player.stdin.flush()),
            catch: (e) => new Error(`Player flush failed: ${e}`),
          });
        });

      const runLoop = (player: PlayerProcess) =>
        Effect.gen(function* () {
          let nextWriteAt: number | null = null;
          while (true) {
            const state = yield* Ref.get(stateRef);

            if (state === "stopped") return "stopped" as PlaybackRunResult;

            if (player.exitCode !== null) {
              yield* Effect.logError(`Player exited with code ${player.exitCode}`);
              yield* captureMessage("Player exited", "error", {
                tags: { component: "playback", event: "player_exit" },
                extra: {
                  exitCode: player.exitCode,
                  pid: player.pid,
                  state,
                },
              });
              return "restart" as PlaybackRunResult;
            }

            if (state === "paused") {
              nextWriteAt = null;
              yield* Effect.sleep(Duration.millis(100));
              continue;
            }

            const bufSize = yield* buffer.size();

            if (bufSize < bytesPerChunk) {
              if (state === "playing") {
                yield* Ref.set(stateRef, "buffering");
                yield* Effect.log("Buffer low, waiting...");
                yield* addBreadcrumb({
                  category: "buffer",
                  message: "Buffer low during playback",
                  level: "warning",
                  data: { bufSize, bytesPerChunk },
                });
              }
              nextWriteAt = null;
              yield* Effect.sleep(Duration.millis(500));
              continue;
            }

            if (state === "buffering") {
              yield* Ref.set(stateRef, "playing");
              yield* Effect.log("Resuming playback");
              yield* addBreadcrumb({
                category: "playback",
                message: "Playback resumed",
                level: "info",
              });
              nextWriteAt = performance.now();
            }

            if (nextWriteAt === null) {
              nextWriteAt = performance.now();
            }

            const chunk = yield* buffer.consume(bytesPerChunk);
            if (chunk) {
              const wrote = yield* writeChunk(player, chunk).pipe(
                Effect.as(true),
                Effect.catchAll((e) =>
                  captureException(e, {
                    tags: { component: "playback", event: "write" },
                    extra: {
                      bufferSize: bufSize,
                      bytesPerChunk,
                      state,
                    },
                  }).pipe(Effect.zipRight(Effect.logError(e)), Effect.as(false)),
                ),
              );
              if (!wrote) return "restart" as PlaybackRunResult;
            }

            const now = performance.now();
            nextWriteAt = Math.max(nextWriteAt + chunkDurationMs, now);
            const sleepMs = nextWriteAt - now;
            if (sleepMs > 0) {
              yield* Effect.sleep(Duration.millis(sleepMs));
            }
          }
        });

      let firstStart = true;
      while (true) {
        const state = yield* Ref.get(stateRef);
        if (state === "stopped") break;

        const isFirstStart = firstStart;
        yield* Effect.log(isFirstStart ? "Starting player" : "Restarting player");
        yield* addBreadcrumb({
          category: "playback",
          message: isFirstStart ? "Player starting" : "Player restarting",
          level: isFirstStart ? "info" : "warning",
        });
        firstStart = false;

        const runResult = yield* Effect.try({
          try: () =>
            Bun.spawn(["ffplay", "-nodisp", "-autoexit", "-af", "volume=1.3", "-i", "-"], {
              stdin: "pipe",
              stdout: "ignore",
              stderr: "ignore",
            }),
          catch: (e) => new Error(`Failed to spawn player: ${e}`),
        }).pipe(
          Effect.tap((player) => Ref.set(playerRef, player)),
          Effect.flatMap((player) =>
            runLoop(player).pipe(
              Effect.ensuring(
                Effect.sync(() => player.kill()).pipe(Effect.zipRight(Ref.set(playerRef, null))),
              ),
            ),
          ),
          Effect.catchAll((e) =>
            captureException(e, {
              tags: { component: "playback", event: "spawn" },
            }).pipe(Effect.zipRight(Effect.logError(e)), Effect.as("restart" as PlaybackRunResult)),
          ),
        );

        if (runResult === "stopped") break;

        const current = yield* Ref.get(stateRef);
        if (current === "stopped") break;
        if (current === "playing") {
          yield* Ref.set(stateRef, "buffering");
        }

        yield* addBreadcrumb({
          category: "playback",
          message: "Player restart scheduled",
          level: "warning",
        });
        yield* Effect.sleep(Duration.seconds(1));
      }
    });

    const start = () =>
      Effect.gen(function* () {
        if ((yield* Ref.get(stateRef)) !== "stopped") return;

        yield* Ref.set(stateRef, "buffering");
        yield* Effect.log("Starting playback service");
        yield* addBreadcrumb({
          category: "playback",
          message: "Playback service started",
          level: "info",
        });

        const fiber = yield* Effect.fork(bufferLoop);
        yield* Ref.set(bufferFiberRef, fiber);

        const playbackFiber = yield* Effect.fork(playbackLoop);
        yield* Ref.set(playbackFiberRef, playbackFiber);
      });

    const pause = () =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((s) =>
          s === "playing" || s === "buffering"
            ? Ref.set(stateRef, "paused").pipe(Effect.tap(() => Effect.log("Paused")))
            : Effect.void,
        ),
      );

    const resume = () =>
      Ref.get(stateRef).pipe(
        Effect.flatMap((s) =>
          s === "paused"
            ? Ref.set(stateRef, "buffering").pipe(Effect.tap(() => Effect.log("Resumed")))
            : Effect.void,
        ),
      );

    const stop = () =>
      Effect.gen(function* () {
        yield* Ref.set(stateRef, "stopped");

        const fiber = yield* Ref.get(bufferFiberRef);
        if (fiber) {
          yield* Fiber.interrupt(fiber);
          yield* Ref.set(bufferFiberRef, null);
        }

        const playbackFiber = yield* Ref.get(playbackFiberRef);
        if (playbackFiber) {
          yield* Fiber.interrupt(playbackFiber);
          yield* Ref.set(playbackFiberRef, null);
        }

        const player = yield* Ref.get(playerRef);
        if (player) player.kill();

        yield* Effect.log("Stopped");
        yield* addBreadcrumb({
          category: "playback",
          message: "Playback service stopped",
          level: "info",
        });
      });

    const getState = () => Ref.get(stateRef);

    return { start, pause, resume, stop, getState };
  }),
);

import { Context, Effect, Layer, Duration, Fiber, Ref } from "effect";
import { BufferService } from "./BufferService";
import { PlaybackService } from "./PlaybackService";
import { AppConfig } from "../config";
import { nextHourInfo } from "../utils";

export class SchedulerService extends Context.Tag("SchedulerService")<
  SchedulerService,
  {
    readonly start: () => Effect.Effect<void>;
    readonly stop: () => Effect.Effect<void>;
    readonly getNextRebuildTime: () => Effect.Effect<Date>;
    readonly rebuildNow: () => Effect.Effect<boolean>;
  }
>() {}

export const SchedulerServiceLive = Layer.effect(
  SchedulerService,
  Effect.gen(function* () {
    const buffer = yield* BufferService;
    const playback = yield* PlaybackService;
    const rebuildHour = yield* AppConfig.RebuildHour;

    const fiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
    const rebuildLockRef = yield* Ref.make(false);

    const performRebuild = Effect.gen(function* () {
      yield* Effect.log(`Rebuilding buffer at ${rebuildHour}:00`);
      yield* playback.pause();
      yield* buffer.clear();
      yield* Effect.log("Waiting for buffer to refill...");
      yield* buffer.waitForTarget();
      yield* playback.resume();
      yield* Effect.log("Buffer rebuild complete");
    });

    const rebuildNow = () =>
      Ref.modify(rebuildLockRef, (locked) => (locked ? [false, locked] : [true, true])).pipe(
        Effect.flatMap((acquired) =>
          acquired
            ? performRebuild.pipe(
                Effect.ensuring(Ref.set(rebuildLockRef, false)),
                Effect.as(true),
              )
            : Effect.succeed(false),
        ),
      );

    const loop = Effect.gen(function* () {
      while (true) {
        const { ms } = yield* nextHourInfo(rebuildHour);
        yield* Effect.log(`Next rebuild in ${Math.round(ms / 3600000)} hours`);
        yield* Effect.sleep(Duration.millis(ms));
        yield* rebuildNow();
      }
    });

    const start = () =>
      Effect.gen(function* () {
        if (yield* Ref.get(fiberRef)) return;
        const fiber = yield* Effect.fork(loop);
        yield* Ref.set(fiberRef, fiber);
      });

    const stop = () =>
      Ref.get(fiberRef).pipe(
        Effect.flatMap((f) => (f ? Fiber.interrupt(f) : Effect.void)),
        Effect.tap(() => Ref.set(fiberRef, null)),
      );

    const getNextRebuildTime = () => nextHourInfo(rebuildHour).pipe(Effect.map((info) => info.at));

    return { start, stop, getNextRebuildTime, rebuildNow };
  }),
);

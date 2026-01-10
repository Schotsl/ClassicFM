import { Context, Effect, Layer, Stream, Option, Duration } from "effect";
import { AppConfig } from "../config";

export class StreamService extends Context.Tag("StreamService")<
  StreamService,
  {
    readonly connect: () => Effect.Effect<Stream.Stream<Uint8Array, Error>, Error>;
  }
>() {}

export const StreamServiceLive = Layer.effect(
  StreamService,
  Effect.gen(function* () {
    const streamUrl = yield* AppConfig.StreamUrl;
    const streamConnectTimeoutMs = 15000;
    const streamReadTimeout = Duration.seconds(15);

    const connect = (): Effect.Effect<Stream.Stream<Uint8Array, Error>, Error> =>
      Effect.gen(function* () {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), streamConnectTimeoutMs);
        const response = yield* Effect.tryPromise({
          try: async () => {
            try {
              return await fetch(streamUrl, { signal: controller.signal });
            } finally {
              clearTimeout(timeout);
            }
          },
          catch: (e) => new Error(`Connection failed: ${e}`),
        });

        if (!response.ok || !response.body) {
          controller.abort();
          return yield* Effect.fail(new Error(`Stream error: ${response.status}`));
        }

        const reader = response.body.getReader();
        const cleanup = Effect.sync(() => {
          controller.abort();
          void reader.cancel().catch(() => {});
          try {
            reader.releaseLock();
          } catch {
            // ignore
          }
        });

        return Stream.unfoldEffect(reader, (r) =>
          Effect.tryPromise({
            try: () => r.read(),
            catch: (e) => new Error(`Read failed: ${e}`),
          }).pipe(
            Effect.map((result) =>
              result.done
                ? Option.none<readonly [Uint8Array, typeof r]>()
                : Option.some([result.value, r] as const),
            ),
          ),
        ).pipe(
          Stream.timeoutFail(() => new Error("Stream read timed out"), streamReadTimeout),
          Stream.ensuring(cleanup),
        );
      });

    return { connect };
  }),
);

import { Context, Effect, Layer, Ref, Duration } from "effect";
import { AppConfig } from "../config";

export interface BufferHealth {
  durationMinutes: number;
  currentSize: number;
  targetSize: number;
  percentage: number;
  isHealthy: boolean;
}

interface BufferState {
  chunks: Uint8Array[];
  totalSize: number;
  headIndex: number;
}

export class BufferService extends Context.Tag("BufferService")<
  BufferService,
  {
    readonly size: () => Effect.Effect<number>;
    readonly clear: () => Effect.Effect<void>;
    readonly append: (chunk: Uint8Array) => Effect.Effect<void>;
    readonly consume: (bytes: number) => Effect.Effect<Uint8Array | null>;
    readonly getHealth: () => Effect.Effect<BufferHealth>;
    readonly waitForTarget: () => Effect.Effect<void>;
    readonly waitForMinutes: (minutes: number) => Effect.Effect<void>;
  }
>() {}

export const BufferServiceLive = Layer.effect(
  BufferService,
  Effect.gen(function* () {
    // Calculate the target size of the buffer in bytes based on config duration and bitrate
    const bufferDuration = yield* AppConfig.BufferDuration;
    const bitrateKBps = yield* AppConfig.BitrateKBps;
    const targetSize = Math.floor(Duration.toSeconds(bufferDuration) * bitrateKBps * 1024);

    const stateRef = yield* Ref.make<BufferState>({
      chunks: [],
      totalSize: 0,
      headIndex: 0,
    });

    const compactState = (chunks: Uint8Array[], headIndex: number) => {
      if (headIndex > 1024 && headIndex > chunks.length / 2) {
        return { chunks: chunks.slice(headIndex), headIndex: 0 };
      }
      return { chunks, headIndex };
    };

    const append = (chunk: Uint8Array) =>
      Ref.update(stateRef, (state) => {
        const { chunks } = state;
        let { totalSize, headIndex } = state;
        chunks.push(chunk);
        totalSize += chunk.length;

        // Trim if over target size by advancing the head.
        if (totalSize > targetSize) {
          while (totalSize > targetSize && headIndex < chunks.length - 1) {
            totalSize -= chunks[headIndex]!.length;
            headIndex += 1;
          }

          if (totalSize > targetSize && headIndex === chunks.length - 1) {
            const excess = totalSize - targetSize;
            chunks[headIndex] = chunks[headIndex]!.slice(excess);
            totalSize = targetSize;
          }
        }

        const compacted = compactState(chunks, headIndex);
        return {
          chunks: compacted.chunks,
          headIndex: compacted.headIndex,
          totalSize,
        };
      });

    const consume = (bytes: number): Effect.Effect<Uint8Array | null> =>
      Ref.modify(stateRef, (state) => {
        const { chunks } = state;
        let { totalSize, headIndex } = state;
        if (headIndex >= chunks.length || totalSize === 0) {
          return [null, state];
        }

        const collected: Uint8Array[] = [];
        let remaining = bytes;
        let total = 0;

        while (remaining > 0 && headIndex < chunks.length) {
          const first = chunks[headIndex]!;

          if (first.length <= remaining) {
            collected.push(first);
            total += first.length;
            remaining -= first.length;
            headIndex += 1;
          } else {
            const head = first.slice(0, remaining);
            collected.push(head);
            chunks[headIndex] = first.slice(remaining);
            total += head.length;
            remaining = 0;
          }
        }

        if (total === 0) {
          return [null, state];
        }

        totalSize = Math.max(0, totalSize - total);
        const output = new Uint8Array(total);
        let offset = 0;
        for (const part of collected) {
          output.set(part, offset);
          offset += part.length;
        }

        const compacted = compactState(chunks, headIndex);
        return [
          output,
          {
            chunks: compacted.chunks,
            headIndex: compacted.headIndex,
            totalSize,
          },
        ];
      });

    const getHealth = () =>
      Effect.gen(function* () {
        const { totalSize: currentSize } = yield* Ref.get(stateRef);
        const percentage = Math.min(100, (currentSize / targetSize) * 100);
        return {
          currentSize,
          targetSize,
          percentage: Math.round(percentage * 100) / 100,
          durationMinutes: Math.round(currentSize / (bitrateKBps * 1024) / 60),
          isHealthy: percentage >= 80,
        };
      });

    const clear = () => Ref.set(stateRef, { chunks: [], totalSize: 0, headIndex: 0 });

    const size = () => Ref.get(stateRef).pipe(Effect.map((state) => state.totalSize));

    const waitForSize = (size: number) =>
      Effect.gen(function* () {
        if (size <= 0) return;
        while (true) {
          const { totalSize } = yield* Ref.get(stateRef);
          if (totalSize >= size) return;
          yield* Effect.sleep(Duration.seconds(1));
        }
      });

    const waitForTarget = () => waitForSize(targetSize);

    const waitForMinutes = (minutes: number) => {
      const size = Math.min(targetSize, Math.floor(minutes * 60 * bitrateKBps * 1024));
      return waitForSize(size);
    };

    return { append, consume, getHealth, clear, size, waitForTarget, waitForMinutes };
  }),
);

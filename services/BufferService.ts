import { Context, Effect, Layer, Duration, SynchronizedRef } from "effect";
import { promises as fs } from "fs";
import { join } from "path";
import { AppConfig } from "../config";

export interface BufferHealth {
  durationMinutes: number;
  currentSize: number;
  targetSize: number;
  percentage: number;
  isHealthy: boolean;
}

interface BufferState {
  totalSize: number;
  readOffset: number;
  writeOffset: number;
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

export const BufferServiceLive = Layer.scoped(
  BufferService,
  Effect.gen(function* () {
    const bufferDuration = yield* AppConfig.BufferDuration;
    const bitrateKBps = yield* AppConfig.BitrateKBps;
    const bufferTempDir = yield* AppConfig.BufferTempDir;
    const targetSize = Math.floor(Duration.toSeconds(bufferDuration) * bitrateKBps * 1024);

    const bufferFile = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await fs.mkdir(bufferTempDir, { recursive: true });
          const dir = await fs.mkdtemp(join(bufferTempDir, "classicfm-buffer-"));
          const path = join(dir, "buffer.dat");
          const handle = await fs.open(path, "w+");
          return { dir, path, handle };
        },
        catch: (e) => new Error(`Failed to create buffer file: ${e}`),
      }).pipe(Effect.orDie),
      (resource) =>
        Effect.tryPromise({
          try: async () => {
            await resource.handle.close();
            await fs.rm(resource.dir, { recursive: true, force: true });
          },
          catch: (e) => new Error(`Failed to cleanup buffer file: ${e}`),
        }).pipe(Effect.catchAll(() => Effect.void)),
    );

    const stateRef = yield* SynchronizedRef.make<BufferState>({
      totalSize: 0,
      readOffset: 0,
      writeOffset: 0,
    });

    const writeFully = (data: Uint8Array, position: number) =>
      Effect.tryPromise({
        try: async () => {
          let offset = 0;
          while (offset < data.length) {
            const { bytesWritten } = await bufferFile.handle.write(
              data,
              offset,
              data.length - offset,
              position + offset,
            );
            if (bytesWritten === 0) {
              throw new Error("Write returned 0 bytes");
            }
            offset += bytesWritten;
          }
        },
        catch: (e) => new Error(`Buffer write failed: ${e}`),
      }).pipe(Effect.orDie);

    const readFully = (data: Uint8Array, position: number) =>
      Effect.tryPromise({
        try: async () => {
          let offset = 0;
          while (offset < data.length) {
            const { bytesRead } = await bufferFile.handle.read(
              data,
              offset,
              data.length - offset,
              position + offset,
            );
            if (bytesRead === 0) {
              throw new Error("Read returned 0 bytes");
            }
            offset += bytesRead;
          }
        },
        catch: (e) => new Error(`Buffer read failed: ${e}`),
      }).pipe(Effect.orDie);

    const writeChunk = (chunk: Uint8Array, writeOffset: number) =>
      Effect.gen(function* () {
        const endSpace = targetSize - writeOffset;
        if (chunk.length <= endSpace) {
          yield* writeFully(chunk, writeOffset);
          return (writeOffset + chunk.length) % targetSize;
        }

        const first = chunk.subarray(0, endSpace);
        const second = chunk.subarray(endSpace);
        yield* writeFully(first, writeOffset);
        yield* writeFully(second, 0);
        return second.length;
      });

    const append = (chunk: Uint8Array) =>
      SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          if (chunk.length === 0 || targetSize <= 0) {
            return [undefined, state] as const;
          }

          if (chunk.length >= targetSize) {
            const tail = chunk.subarray(chunk.length - targetSize);
            yield* writeFully(tail, 0);
            return [
              undefined,
              {
                totalSize: targetSize,
                readOffset: 0,
                writeOffset: 0,
              },
            ] as const;
          }

          const newWriteOffset = yield* writeChunk(chunk, state.writeOffset);
          const overflow = Math.max(0, state.totalSize + chunk.length - targetSize);
          const newReadOffset =
            overflow > 0 ? (state.readOffset + overflow) % targetSize : state.readOffset;
          const newTotal = Math.min(targetSize, state.totalSize + chunk.length);

          return [
            undefined,
            {
              totalSize: newTotal,
              readOffset: newReadOffset,
              writeOffset: newWriteOffset,
            },
          ] as const;
        }),
      );

    const consume = (bytes: number): Effect.Effect<Uint8Array | null> =>
      SynchronizedRef.modifyEffect(stateRef, (state) =>
        Effect.gen(function* () {
          if (bytes <= 0 || state.totalSize === 0 || targetSize <= 0) {
            return [null, state] as const;
          }

          const toRead = Math.min(bytes, state.totalSize);
          const output = new Uint8Array(toRead);
          const endSpace = targetSize - state.readOffset;

          if (toRead <= endSpace) {
            yield* readFully(output, state.readOffset);
          } else {
            const first = output.subarray(0, endSpace);
            const second = output.subarray(endSpace);
            yield* readFully(first, state.readOffset);
            yield* readFully(second, 0);
          }

          const newReadOffset = (state.readOffset + toRead) % targetSize;

          return [
            output,
            {
              totalSize: state.totalSize - toRead,
              readOffset: newReadOffset,
              writeOffset: state.writeOffset,
            },
          ] as const;
        }),
      );

    const getHealth = () =>
      Effect.gen(function* () {
        const { totalSize: currentSize } = yield* SynchronizedRef.get(stateRef);
        const percentage = targetSize > 0 ? Math.min(100, (currentSize / targetSize) * 100) : 0;
        return {
          currentSize,
          targetSize,
          percentage: Math.round(percentage * 100) / 100,
          durationMinutes: Math.round(currentSize / (bitrateKBps * 1024) / 60),
          isHealthy: percentage >= 80,
        };
      });

    const clear = () =>
      SynchronizedRef.set(stateRef, {
        totalSize: 0,
        readOffset: 0,
        writeOffset: 0,
      });

    const size = () =>
      SynchronizedRef.get(stateRef).pipe(Effect.map((state) => state.totalSize));

    const waitForSize = (size: number) =>
      Effect.gen(function* () {
        if (size <= 0) return;
        while (true) {
          const { totalSize } = yield* SynchronizedRef.get(stateRef);
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

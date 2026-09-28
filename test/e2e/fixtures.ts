import { deflateSync, crc32 } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppDeps } from "../../src/app.js";
import { saveRecord, fileDir } from "../../src/storage/store.js";
import type { FileRecord } from "../../src/types.js";

export const E2E_USER = "100000000000000001";
export const E2E_EMPTY_USER = "100000000000000002";
/** Fixed so dates on tiles never change between runs. */
export const FIXED_CREATED_AT = Date.UTC(2026, 0, 15, 12, 0, 0);

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** A solid-colour RGB PNG, so fixtures need no binary files in the repo. */
export function solidPng(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Bytes that sniff as MP4 (ftyp isom). The browser cannot play it; screenshots only need a stable frame. */
export function fakeMp4(): Buffer {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(24, 0);
  b.write("ftypisom", 4, "ascii");
  return b;
}

async function put(
  deps: AppDeps,
  record: FileRecord,
  bytes: Buffer,
): Promise<void> {
  await mkdir(fileDir(deps.config, record.id), { recursive: true });
  await writeFile(
    path.join(fileDir(deps.config, record.id), record.name),
    bytes,
  );
  await saveRecord(deps.redis, { ...record, size: bytes.length });
}

export async function seedFixtures(deps: AppDeps): Promise<void> {
  const base = {
    userId: E2E_USER,
    channelId: "200000000000000001",
    createdAt: FIXED_CREATED_AT,
    expiresAt: 0,
  };
  await put(
    deps,
    {
      ...base,
      id: "e2eimagecyan00000000001",
      name: "cyan-square.png",
      mime: "image/png",
      kind: "image",
      size: 0,
      width: 320,
      height: 320,
      createdAt: FIXED_CREATED_AT - 2000,
    },
    solidPng(320, 320, [63, 193, 243]),
  );
  await put(
    deps,
    {
      ...base,
      id: "e2eimagegold00000000002",
      name: "gold-wide.png",
      mime: "image/png",
      kind: "image",
      size: 0,
      width: 640,
      height: 320,
      createdAt: FIXED_CREATED_AT - 1000,
    },
    solidPng(640, 320, [245, 197, 24]),
  );
  await put(
    deps,
    {
      ...base,
      id: "e2evideo000000000000003",
      name: "clip.mp4",
      mime: "video/mp4",
      kind: "video",
      size: 0,
      width: 1280,
      height: 720,
    },
    fakeMp4(),
  );
}

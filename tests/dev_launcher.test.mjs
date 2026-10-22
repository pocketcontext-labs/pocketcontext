import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertPortAvailable,
  parseOptions,
  projectOptions,
} from "../scripts/dev.mjs";

test("launcher requires an explicit database and valid port", () => {
  assert.throws(() => parseOptions([]), /explicit development database/);
  assert.throws(
    () => parseOptions(["--db", "--binary", "bin/pocketcontext"]),
    /Usage/,
  );
  assert.throws(
    () => parseOptions(["--db", "example.db", "--vite-port", "0"]),
    /Port/,
  );
  assert.throws(
    () => parseOptions(["--db", "example.db", "--take-over"]),
    /Usage/,
  );
});

test("launcher reads only explicit project settings and refuses missing databases", async () => {
  const folder = await mkdtemp(join(tmpdir(), "pocketcontext-launcher-"));
  try {
    const db = join(folder, "pocketcontext.db");
    await assert.rejects(
      projectOptions(parseOptions(["--db", db])),
      /Initialize/,
    );
    await writeFile(db, "synthetic");
    assert.equal((await projectOptions(parseOptions(["--db", folder]))).db, db);
    assert.equal((await projectOptions(parseOptions(["--db", db]))).port, 8096);
    await writeFile(
      join(folder, "pocketcontext.json"),
      JSON.stringify({ port: 18123 }),
    );
    assert.equal(
      (await projectOptions(parseOptions(["--db", db]))).port,
      18123,
    );
    await assert.rejects(
      projectOptions(parseOptions(["--db", db, "--vite-port", "18123"])),
      /different ports/,
    );
    await writeFile(
      join(folder, "pocketcontext.json"),
      JSON.stringify({ port: "18123" }),
    );
    await assert.rejects(projectOptions(parseOptions(["--db", db])), /Port/);
    await writeFile(join(folder, "pocketcontext.json"), "broken JSON");
    await assert.rejects(
      projectOptions(parseOptions(["--db", db])),
      SyntaxError,
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("launcher refuses an occupied port without touching its listener", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await assert.rejects(assertPortAvailable(port), /already in use/);
    assert.equal(server.listening, true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  await assertPortAvailable(port);
});

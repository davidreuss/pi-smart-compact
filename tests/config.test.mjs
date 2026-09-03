import { describe, it, afterEach } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");
const configPath = path.join(root, "src", "config.ts");
const tmpRoots = [];

async function makeTempConfigPath(name = "smart-boundary.json") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pi-smart-compact-u2-config-"));
  tmpRoots.push(dir);
  return path.join(dir, name);
}

afterEach(async () => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop();
    await chmodTreeWritable(dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

async function chmodTreeWritable(target) {
  await chmod(target, 0o700).catch(() => undefined);
}

async function loadConfigModule() {
  return import(pathToFileURL(configPath).href);
}

function resultTokens(result) {
  if (typeof result === "number") return result;
  if (result && typeof result === "object") {
    return result.tokens ?? result.boundaryTokens ?? result.boundary ?? result.value;
  }
  return undefined;
}

function resultWarning(result) {
  if (result && typeof result === "object") {
    return result.warning ?? result.message ?? result.error ?? result.reason;
  }
  return undefined;
}

async function makeStore(filePath) {
  const mod = await loadConfigModule();

  if (typeof mod.createSmartBoundaryConfig === "function") {
    const store = mod.createSmartBoundaryConfig({ configPath: filePath, path: filePath });
    return normalizeStore(store, filePath);
  }

  if (typeof mod.createConfigStore === "function") {
    const store = mod.createConfigStore({ configPath: filePath, path: filePath });
    return normalizeStore(store, filePath);
  }

  if (typeof mod.readSmartBoundaryConfig === "function" && typeof mod.writeSmartBoundaryConfig === "function") {
    return {
      read: (options = {}) => mod.readSmartBoundaryConfig({ configPath: filePath, path: filePath, ...options }),
      write: (tokens, options = {}) => mod.writeSmartBoundaryConfig(tokens, { configPath: filePath, path: filePath, ...options }),
      reset: (options = {}) => mod.resetSmartBoundaryConfig?.({ configPath: filePath, path: filePath, ...options }),
    };
  }

  throw new TypeError("config module must expose a test-path-overridable smart-boundary config store");
}

function normalizeStore(store, filePath) {
  assert.ok(store && typeof store === "object", "config factory should return a store object");
  const read = store.read ?? store.get ?? store.getBoundary ?? store.readBoundary;
  const write = store.write ?? store.set ?? store.setBoundary ?? store.writeBoundary;
  const reset = store.reset ?? store.remove ?? store.resetBoundary ?? store.clear;

  assert.equal(typeof read, "function", "config store must expose a read/get operation");
  assert.equal(typeof write, "function", "config store must expose a write/set operation");
  assert.equal(typeof reset, "function", "config store must expose a reset/remove operation");

  return {
    read: (options = {}) => read.call(store, { configPath: filePath, path: filePath, ...options }),
    write: (tokens, options = {}) => write.call(store, tokens, { configPath: filePath, path: filePath, ...options }),
    reset: (options = {}) => reset.call(store, { configPath: filePath, path: filePath, ...options }),
  };
}

describe("U2 smart-boundary global config", () => {
  it("falls back to the 100000-token default when the config file is missing", async () => {
    const filePath = await makeTempConfigPath();
    const store = await makeStore(filePath);

    const read = await store.read();

    assert.equal(resultTokens(read), 100_000);
  });

  it("persists a custom boundary and reloads it through a new store instance", async () => {
    const filePath = await makeTempConfigPath();
    const firstStore = await makeStore(filePath);
    await firstStore.write(120_000);

    const secondStore = await makeStore(filePath);
    const reloaded = await secondStore.read();

    assert.equal(resultTokens(reloaded), 120_000);
    const onDisk = await readFile(filePath, "utf8");
    assert.match(onDisk, /120000/, "custom boundary should be written to the extension-owned config file");
  });

  it("reset removes the custom boundary and returns future reads to the default", async () => {
    const filePath = await makeTempConfigPath();
    const store = await makeStore(filePath);
    await store.write(120_000);

    await store.reset();
    const read = await store.read();

    assert.equal(resultTokens(read), 100_000);
  });

  it("falls back to default with a warning for corrupt config content", async () => {
    const filePath = await makeTempConfigPath();
    await writeFile(filePath, "{ this is not json", "utf8");
    const store = await makeStore(filePath);

    const read = await store.read();

    assert.equal(resultTokens(read), 100_000);
    assert.ok(String(resultWarning(read) ?? "").trim().length > 0, "corrupt config fallback should surface a warning/reason");
  });

  it("falls back to default with a warning when the configured path cannot be read as a file", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "pi-smart-compact-u2-unreadable-"));
    tmpRoots.push(dir);
    const unreadablePath = path.join(dir, "config-as-directory");
    await mkdir(unreadablePath);
    const store = await makeStore(unreadablePath);

    const read = await store.read();

    assert.equal(resultTokens(read), 100_000);
    assert.ok(String(resultWarning(read) ?? "").trim().length > 0, "unreadable config fallback should surface a warning/reason");
  });
});

describe("U2 smart-boundary per-model override", () => {
  const modelKey = "fireworks/accounts/fireworks/models/glm-5p3";
  const otherModelKey = "amazon-bedrock/global.anthropic.claude-sonnet-5";

  it("falls back to the global boundary when no per-model override is set", async () => {
    const filePath = await makeTempConfigPath();
    const store = await makeStore(filePath);
    await store.write(150_000);

    const read = await store.read({ modelKey });

    assert.equal(resultTokens(read), 150_000);
  });

  it("persists a per-model override without changing the global default", async () => {
    const filePath = await makeTempConfigPath();
    const store = await makeStore(filePath);
    await store.write(300_000, { modelKey });

    const globalRead = await store.read();
    const modelRead = await store.read({ modelKey });

    assert.equal(resultTokens(globalRead), 100_000, "global default should stay at its prior value");
    assert.equal(resultTokens(modelRead), 300_000, "the overridden model should use its own boundary");

    const onDisk = await readFile(filePath, "utf8");
    assert.match(onDisk, /300000/, "per-model override should be written to the extension-owned config file");
  });

  it("keeps overrides for other models independent", async () => {
    const filePath = await makeTempConfigPath();
    const store = await makeStore(filePath);
    await store.write(300_000, { modelKey });
    await store.write(50_000, { modelKey: otherModelKey });

    assert.equal(resultTokens(await store.read({ modelKey })), 300_000);
    assert.equal(resultTokens(await store.read({ modelKey: otherModelKey })), 50_000);
  });

  it("resetting a per-model override falls back to the global boundary without touching other overrides", async () => {
    const filePath = await makeTempConfigPath();
    const store = await makeStore(filePath);
    await store.write(120_000);
    await store.write(300_000, { modelKey });
    await store.write(50_000, { modelKey: otherModelKey });

    await store.reset({ modelKey });

    assert.equal(resultTokens(await store.read({ modelKey })), 120_000, "reset model should fall back to the global boundary");
    assert.equal(resultTokens(await store.read({ modelKey: otherModelKey })), 50_000, "unrelated override should be untouched");
    assert.equal(resultTokens(await store.read()), 120_000, "global boundary should be untouched");
  });

  it("a full reset clears per-model overrides along with the global boundary", async () => {
    const filePath = await makeTempConfigPath();
    const store = await makeStore(filePath);
    await store.write(120_000);
    await store.write(300_000, { modelKey });

    await store.reset();

    assert.equal(resultTokens(await store.read()), 100_000);
    assert.equal(resultTokens(await store.read({ modelKey })), 100_000);
  });
});

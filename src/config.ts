import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import nodePath from "node:path";

import { DEFAULT_SMART_BOUNDARY_TOKENS, PACKAGE_NAME } from "./constants.js";

export const SMART_BOUNDARY_CONFIG_ENV = "PI_SMART_COMPACT_CONFIG_PATH";

export interface SmartBoundaryConfigOptions {
  configPath?: string;
  path?: string;
  /** Model key ("provider/id") to resolve/write a per-model override instead of the global default. */
  modelKey?: string;
}

export interface SmartBoundaryConfigReadResult {
  tokens: number;
  boundaryTokens: number;
  source: "default" | "custom" | "custom-model";
  modelKey?: string;
  perModelBoundaryTokens?: Record<string, number>;
  warning?: string;
}

export interface SmartBoundaryConfigStore {
  read(options?: SmartBoundaryConfigOptions): Promise<SmartBoundaryConfigReadResult>;
  write(tokens: number, options?: SmartBoundaryConfigOptions): Promise<SmartBoundaryConfigReadResult>;
  reset(options?: SmartBoundaryConfigOptions): Promise<SmartBoundaryConfigReadResult>;
}

interface OnDiskSmartBoundaryConfig {
  smartBoundaryTokens?: unknown;
  boundaryTokens?: unknown;
  tokens?: unknown;
  perModelBoundaryTokens?: unknown;
}

export function createSmartBoundaryConfig(options: SmartBoundaryConfigOptions = {}): SmartBoundaryConfigStore {
  return {
    read: (overrideOptions = {}) => readSmartBoundaryConfig(mergeOptions(options, overrideOptions)),
    write: (tokens, overrideOptions = {}) => writeSmartBoundaryConfig(tokens, mergeOptions(options, overrideOptions)),
    reset: (overrideOptions = {}) => resetSmartBoundaryConfig(mergeOptions(options, overrideOptions)),
  };
}

export const createConfigStore = createSmartBoundaryConfig;

export async function readSmartBoundaryConfig(
  options: SmartBoundaryConfigOptions = {},
): Promise<SmartBoundaryConfigReadResult> {
  const filePath = resolveSmartBoundaryConfigPath(options);
  const modelKey = normalizeModelKey(options.modelKey);

  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as OnDiskSmartBoundaryConfig;
    const tokens = extractBoundaryTokens(parsed);

    if (tokens === undefined) {
      return defaultResult(`Could not read smart-boundary config at ${filePath}: missing a positive whole-number boundary.`, modelKey);
    }

    const perModel = extractPerModelBoundaryTokens(parsed);
    const override = modelKey ? perModel?.[modelKey] : undefined;
    const perModelField =
      perModel && Object.keys(perModel).length > 0 ? { perModelBoundaryTokens: perModel } : {};

    if (override !== undefined) {
      return { tokens: override, boundaryTokens: override, source: "custom-model", modelKey, ...perModelField };
    }

    return { tokens, boundaryTokens: tokens, source: "custom", ...(modelKey ? { modelKey } : {}), ...perModelField };
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return defaultResult(undefined, modelKey);
    }

    return defaultResult(`Could not read smart-boundary config at ${filePath}: ${errorMessage(error)}. Using default.`, modelKey);
  }
}

export async function writeSmartBoundaryConfig(
  tokens: number,
  options: SmartBoundaryConfigOptions = {},
): Promise<SmartBoundaryConfigReadResult> {
  assertPositiveWholeTokens(tokens);

  const filePath = resolveSmartBoundaryConfigPath(options);
  const modelKey = normalizeModelKey(options.modelKey);
  await mkdir(nodePath.dirname(filePath), { recursive: true });

  const existing = await readExistingConfig(filePath);
  const nextGlobalTokens = modelKey ? existing.smartBoundaryTokens ?? DEFAULT_SMART_BOUNDARY_TOKENS : tokens;
  const nextPerModel = modelKey ? { ...existing.perModelBoundaryTokens, [modelKey]: tokens } : existing.perModelBoundaryTokens;

  const onDisk: OnDiskSmartBoundaryConfig = {
    smartBoundaryTokens: nextGlobalTokens,
    ...(nextPerModel && Object.keys(nextPerModel).length > 0 ? { perModelBoundaryTokens: nextPerModel } : {}),
  };

  const tempPath = nodePath.join(
    nodePath.dirname(filePath),
    `${nodePath.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
  );
  const payload = `${JSON.stringify(onDisk, null, 2)}\n`;

  try {
    await writeFile(tempPath, payload, "utf8");
    await rename(tempPath, filePath);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    throw error;
  }

  return modelKey
    ? { tokens, boundaryTokens: tokens, source: "custom-model", modelKey }
    : { tokens, boundaryTokens: tokens, source: "custom" };
}

export async function resetSmartBoundaryConfig(
  options: SmartBoundaryConfigOptions = {},
): Promise<SmartBoundaryConfigReadResult> {
  const filePath = resolveSmartBoundaryConfigPath(options);
  const modelKey = normalizeModelKey(options.modelKey);

  if (modelKey) {
    const existing = await readExistingConfig(filePath);
    const perModel = { ...existing.perModelBoundaryTokens };
    delete perModel[modelKey];

    const onDisk: OnDiskSmartBoundaryConfig = {
      smartBoundaryTokens: existing.smartBoundaryTokens ?? DEFAULT_SMART_BOUNDARY_TOKENS,
      ...(Object.keys(perModel).length > 0 ? { perModelBoundaryTokens: perModel } : {}),
    };

    try {
      await mkdir(nodePath.dirname(filePath), { recursive: true });
      await writeFile(filePath, `${JSON.stringify(onDisk, null, 2)}\n`, "utf8");
    } catch (error) {
      return defaultResult(`Could not remove smart-boundary override for ${modelKey} at ${filePath}: ${errorMessage(error)}. Using default.`, modelKey);
    }

    return { tokens: onDisk.smartBoundaryTokens as number, boundaryTokens: onDisk.smartBoundaryTokens as number, source: "custom", modelKey };
  }

  try {
    await unlink(filePath);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      return defaultResult(`Could not remove smart-boundary config at ${filePath}: ${errorMessage(error)}. Using default.`);
    }
  }

  return defaultResult();
}

export function resolveSmartBoundaryConfigPath(options: SmartBoundaryConfigOptions = {}): string {
  return (
    options.configPath ??
    options.path ??
    process.env[SMART_BOUNDARY_CONFIG_ENV] ??
    nodePath.join(process.env.XDG_CONFIG_HOME ?? nodePath.join(os.homedir(), ".config"), PACKAGE_NAME, "config.json")
  );
}

function mergeOptions(
  base: SmartBoundaryConfigOptions,
  override: SmartBoundaryConfigOptions,
): SmartBoundaryConfigOptions {
  return { ...base, ...override };
}

function extractBoundaryTokens(config: OnDiskSmartBoundaryConfig): number | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const candidate = config.smartBoundaryTokens ?? config.boundaryTokens ?? config.tokens;
  return isPositiveWholeNumber(candidate) ? candidate : undefined;
}

function extractPerModelBoundaryTokens(config: OnDiskSmartBoundaryConfig): Record<string, number> | undefined {
  const candidate = config?.perModelBoundaryTokens;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(candidate as Record<string, unknown>)) {
    if (isPositiveWholeNumber(value)) {
      result[key] = value;
    }
  }

  return result;
}

async function readExistingConfig(filePath: string): Promise<{ smartBoundaryTokens?: number; perModelBoundaryTokens: Record<string, number> }> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as OnDiskSmartBoundaryConfig;
    return {
      smartBoundaryTokens: extractBoundaryTokens(parsed),
      perModelBoundaryTokens: extractPerModelBoundaryTokens(parsed) ?? {},
    };
  } catch {
    return { perModelBoundaryTokens: {} };
  }
}

function normalizeModelKey(modelKey: string | undefined): string | undefined {
  const trimmed = modelKey?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function assertPositiveWholeTokens(tokens: number): void {
  if (!isPositiveWholeNumber(tokens)) {
    throw new RangeError("Smart boundary must be a positive whole-number token count.");
  }
}

function isPositiveWholeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function defaultResult(warning?: string, modelKey?: string): SmartBoundaryConfigReadResult {
  return {
    tokens: DEFAULT_SMART_BOUNDARY_TOKENS,
    boundaryTokens: DEFAULT_SMART_BOUNDARY_TOKENS,
    source: "default",
    ...(modelKey ? { modelKey } : {}),
    ...(warning ? { warning } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

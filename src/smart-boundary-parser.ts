export type SmartBoundaryParseResult =
  | { ok: true; action: "show"; modelKey?: string }
  | { ok: true; action: "reset"; modelKey?: string }
  | { ok: true; action: "set"; tokens: number; boundaryTokens: number; modelKey?: string; warning?: string }
  | { ok: false; action: "error"; message: string };

const INTEGER_TOKENS_PATTERN = /^[0-9]+$/;
const K_TOKENS_PATTERN = /^([0-9]+)k$/i;
const MAX_SAFE_TOKEN_COUNT = BigInt(Number.MAX_SAFE_INTEGER);

const INVALID_BOUNDARY_MESSAGE =
  "Invalid smart boundary. Use a positive whole-number token count, such as 100k or 120000, or 'reset'. " +
  "Prefix with a model id (provider/id) to set a per-model override, such as 'fireworks/accounts/fireworks/models/glm-5p3 150k'.";

export function parseSmartBoundaryInput(input: string | undefined | null): SmartBoundaryParseResult {
  const trimmed = String(input ?? "").trim();

  if (trimmed.length === 0) {
    return { ok: true, action: "show" };
  }

  const [firstToken, ...rest] = trimmed.split(/\s+/);
  const modelKey = firstToken.includes("/") ? firstToken : undefined;
  const remainder = modelKey ? rest.join(" ").trim() : trimmed;
  const modelKeyField = modelKey ? { modelKey } : {};

  if (remainder.length === 0) {
    return { ok: true, action: "show", ...modelKeyField };
  }

  if (remainder.toLowerCase() === "reset") {
    return { ok: true, action: "reset", ...modelKeyField };
  }

  const parsedTokens = parseTokenValue(remainder);
  if (parsedTokens === undefined) {
    return { ok: false, action: "error", message: INVALID_BOUNDARY_MESSAGE };
  }

  if (parsedTokens <= 0) {
    return {
      ok: false,
      action: "error",
      message: "Invalid smart boundary. The boundary must be a positive whole-number token count.",
    };
  }

  return { ok: true, action: "set", tokens: parsedTokens, boundaryTokens: parsedTokens, ...modelKeyField };
}

export const parseSmartBoundaryCommand = parseSmartBoundaryInput;
export const parseSmartBoundary = parseSmartBoundaryInput;

function parseTokenValue(value: string): number | undefined {
  if (INTEGER_TOKENS_PATTERN.test(value)) {
    return safeTokenNumber(BigInt(value));
  }

  const kMatch = K_TOKENS_PATTERN.exec(value);
  if (kMatch) {
    return safeTokenNumber(BigInt(kMatch[1]) * 1_000n);
  }

  return undefined;
}

function safeTokenNumber(value: bigint): number | undefined {
  if (value > MAX_SAFE_TOKEN_COUNT) {
    return undefined;
  }

  return Number(value);
}

export default parseSmartBoundaryInput;

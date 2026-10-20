export interface TokenSaverOptions {
  apiKey?: string;
  baseURL?: string;
  proxyURL?: string;
  local?: boolean;
  route?: boolean;
  cache?: boolean;
  compress?: boolean;
}

export interface Billing {
  model: string;
  costUsd: number;
  baselineUsd: number;
  savedUsd: number;
  cached: boolean;
  tokensSaved: number;
  route: string;
}

export interface Savings {
  requests: number;
  cacheHits: number;
  tokensSaved: number;
  costActualUsd: number;
  costBaselineUsd: number;
  savedUsd: number;
  savedPct: number;
}

export declare class TokenSaver {
  constructor(opts?: TokenSaverOptions);
  create(params: Record<string, unknown>): Promise<Record<string, unknown> & { billing: Billing }>;
  readonly savings: Savings;
}

export default TokenSaver;

export declare const PRICING: Record<string, { in: number; out: number }>;
export declare function compressPrompt(text: string): { text: string; saved: number };
export declare function routeModel(messages: unknown[], requested: string, enabled: boolean): { model: string; reason: string };
export declare function estimateTokens(text: string): number;
export declare function calcCost(model: string, inTok: number, outTok: number): number;

import { ERROR_CODES, type Capability, type ErrorCode, type ErrorShape } from '@ironbird/core';

export type BridgePlatform = 'ios' | 'android';

export interface HelloFrame {
  type: 'hello';
  protocol: 1;
  token?: string;
  marker: string;
  app: { id: string; platform: BridgePlatform; name?: string; bridgeVersion: string };
  capabilities: Capability[];
}

export type OutboundFrame =
  | HelloFrame
  | { type: 'pong'; t: number }
  | { type: 'response'; id: string; ok: true; result: unknown }
  | { type: 'response'; id: string; ok: false; error: ErrorShape }
  | { type: 'notify'; kind: 'event' | 'state' | 'warning'; data: unknown };

export type InboundFrame =
  | { type: 'welcome'; protocol: number; targetId: string }
  | { type: 'reject'; code: ErrorCode; message: string }
  | { type: 'request'; id: string; op: string; params: Record<string, unknown> }
  | { type: 'ping'; t: number };

const isErrorCode = (value: unknown): value is ErrorCode => typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Validates one frame from the daemon. Returns `undefined` for anything that is not one of the
 * four frame shapes the protocol defines, so a malformed or hostile message is dropped rather
 * than acted on (architecture.md §9). Payload validation happens later, in the app's own
 * registry, when the operation runs.
 */
export function parseInbound(raw: unknown): InboundFrame | undefined {
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  switch (parsed['type']) {
    case 'welcome': {
      const { protocol, targetId } = parsed;
      return typeof protocol === 'number' && typeof targetId === 'string' ? { type: 'welcome', protocol, targetId } : undefined;
    }
    case 'reject': {
      const { code, message } = parsed;
      return isErrorCode(code) && typeof message === 'string' ? { type: 'reject', code, message } : undefined;
    }
    case 'request': {
      const { id, op, params } = parsed;
      if (typeof id !== 'string' || typeof op !== 'string') return undefined;
      return { type: 'request', id, op, params: isRecord(params) ? params : {} };
    }
    case 'ping': {
      const { t } = parsed;
      return typeof t === 'number' ? { type: 'ping', t } : undefined;
    }
    default:
      return undefined;
  }
}

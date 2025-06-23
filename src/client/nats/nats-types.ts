import type { RealtimeProviderOptions } from "@synet/patterns/realtime";

/**
 * NATS-specific configuration options
 */
export interface NatsOptions {
  /**
   * Authentication options
   */
  user?: string;
  password?: string;
  token?: string;
  nkeyPath?: {
    pub: string; // Path to NKey public key file
    seed: string;
  };

  nkey?: string;

  /**
   * Connection options
   */
  maxReconnects?: number;
  reconnectTimeWait?: number;

  /**
   * Subject prefix for all topics
   * @default "topic"
   */
  subjectPrefix?: string;

  /**
   * Enable verbose logging
   */
  debug?: boolean;
}

export interface NatsProviderOptions
  extends RealtimeProviderOptions<NatsOptions> {
  // Common options

  auth?: {
    enabled: boolean;
    validateToken?: (token: string) => Promise<boolean>;
    extractClaims?: (token: string) => Promise<Record<string, unknown>>;
  };

  reconnect?: {
    enabled: boolean;
    maxAttempts?: number;
    initialDelayMs?: number;
    maxDelayMs?: number;
  };

  // Transport-specific options
  transportOptions?: NatsOptions;
}

export interface AuthOptions {
  user?: string;
  pass?: string;
  token?: string;
  nkey?: string; // Path to NKey seed file
  nkeySeed?: string; // NKey seed as a string
  sigCB?: (nonce: Uint8Array) => Uint8Array;
}

import type { RealtimeEvent } from "@synet/patterns/realtime";
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

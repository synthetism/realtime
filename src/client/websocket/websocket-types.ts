export interface WebsocketOptions {
  headers?: Record<string, string>;
  protocols?: string[];
  topicInPath?: boolean;
  heartbeat?: number;
}

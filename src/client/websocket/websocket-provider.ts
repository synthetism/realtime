import type {
  RealtimeProvider,
  RealtimeChannel,
  RealtimeProviderOptions,
  RealtimeEvent,
} from "@synet/patterns/realtime";
import type { WebsocketOptions } from "./websocket-types";
import { WebSocketRealtimeChannel } from "./websocket-channel";
/**
 * WebSocket-based implementation of RealtimeProvider
 */
export class WebSocketRealtimeProvider implements RealtimeProvider {
  private channels: Map<string, RealtimeChannel> = new Map();

  constructor(
    public readonly baseUrl: string,
    private options: RealtimeProviderOptions<WebsocketOptions> = {},
  ) {}

  createChannel<
    TIn extends RealtimeEvent = RealtimeEvent,
    TOut extends RealtimeEvent = RealtimeEvent,
  >(
    topic: string,
    options: RealtimeProviderOptions<WebsocketOptions> = {},
  ): RealtimeChannel<TIn, TOut> {
    // Create WebSocket URL with topic
    const wsUrl = this.getWebSocketUrl(topic, options);

    // Create the channel
    const channel = new WebSocketRealtimeChannel<TIn, TOut>(wsUrl, {
      ...options,
      reconnect: this.options.reconnect ?? options.reconnect,
      authToken: this.options.authToken ?? options.authToken,
      ...options.transportOptions,
    });

    // Start connecting in background - doesn't wait for connection to complete
    channel.connect().catch((error) => {
      console.error(`Error connecting to channel ${topic}:`, error);
    });

    // Store the channel
    this.channels.set(channel.id, channel as RealtimeChannel);

    return channel;
  }

  /**
   * Remove a channel
   */
  async removeChannel(channel: RealtimeChannel): Promise<void> {
    // Close the channel
    await channel.close();

    // Remove from our collection
    this.channels.delete(channel.id);
  }

  getChannels(): RealtimeChannel[] {
    return Array.from(this.channels.values());
  }

  async disconnect(): Promise<void> {
    const closePromises = Array.from(this.channels.values()).map((channel) =>
      channel.close(),
    );

    await Promise.all(closePromises);
    this.channels.clear();
  }

  private getWebSocketUrl(
    topic: string,
    options: RealtimeProviderOptions<WebsocketOptions>,
  ): string {
    const url = new URL(this.baseUrl);

    // Add topic as path or query param
    if (this.options.transportOptions?.topicInPath) {
      url.pathname = `/${topic}${url.pathname}`;
    } else {
      url.searchParams.append("topic", topic);
    }

    // Add auth token if provided
    if (options.authToken) {
      url.searchParams.append("token", options.authToken);
    }

    // Convert http(s) to ws(s)
    if (url.protocol === "http:") {
      url.protocol = "ws:";
    } else if (url.protocol === "https:") {
      url.protocol = "wss:";
    }

    return url.toString();
  }
}

/**
 * Options for WebSocket provider
 */
interface WebSocketProviderOptions {
  /**
   * Whether to include topic in path (true) or as query param (false)
   */
  topicInPath?: boolean;
}

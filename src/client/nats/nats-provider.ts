import type {
  RealtimeProvider,
  RealtimeChannel,
  RealtimeProviderOptions,
  RealtimeEvent,
} from "@synet/patterns/realtime";
import type { NatsOptions } from "./nats-types";
import { NatsRealtimeChannel } from "./nats-channel";

/**
 * NATS-based implementation of RealtimeProvider
 */
export class NatsRealtimeProvider implements RealtimeProvider {
  private channels: Map<string, RealtimeChannel> = new Map();

  constructor(
    public readonly baseUrl: string,
    private options: RealtimeProviderOptions<NatsOptions> = {},
  ) {}

  /**
   * Create a channel for the specified topic
   */
  createChannel<
    TIn extends RealtimeEvent = RealtimeEvent,
    TOut extends RealtimeEvent = RealtimeEvent,
  >(
    topic: string,
    options: RealtimeProviderOptions<NatsOptions> = {},
  ): RealtimeChannel<TIn, TOut> {
    // Create NATS URL with topic
    const natsUrl = this.getNatsUrl(topic, options);

    // Create the channel with merged options
    const channel = new NatsRealtimeChannel<TIn, TOut>(natsUrl, {
      ...this.options,
      ...options,
      reconnect: this.options.reconnect ?? options.reconnect,
      authToken: this.options.authToken ?? options.authToken,
      transportOptions: {
        ...this.options.transportOptions,
        ...options.transportOptions,
      },
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

  /**
   * Get all active channels
   */
  getChannels(): RealtimeChannel[] {
    return Array.from(this.channels.values());
  }

  /**
   * Close all channels and clean up resources
   */
  async disconnect(): Promise<void> {
    const closePromises = Array.from(this.channels.values()).map((channel) =>
      channel.close(),
    );

    await Promise.all(closePromises);
    this.channels.clear();
  }

  /**
   * Create a NATS URL with topic as query parameter
   */
  private getNatsUrl(
    topic: string,
    options: RealtimeProviderOptions<NatsOptions>,
  ): string {
    // Start with the base URL
    const url = new URL(this.baseUrl);

    // Add topic as query param
    url.searchParams.append("topic", topic);

    // Add auth token if provided
    if (options.authToken || this.options.authToken) {
      url.searchParams.append(
        "token",
        options.authToken || this.options.authToken || "",
      );
    }

    return url.toString();
  }
}

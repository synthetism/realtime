import type {
  RealtimeProvider,
  RealtimeChannel,
  RealtimeProviderOptions,
  RealtimeEvent,
} from "@synet/patterns/realtime";
import type { NatsOptions } from "./nats-types";
import { NatsRealtimeChannel } from "./nats-channel";
import type { Logger } from "@synet/logger";
/**
 * NATS-based implementation of RealtimeProvider
 */
export class NatsRealtimeProvider implements RealtimeProvider {
  private channels: Map<string, RealtimeChannel> = new Map();

  constructor(
    public readonly baseUrl: string,
    private options: RealtimeProviderOptions<NatsOptions> = {},
    private logger?: Logger,
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
    const natsUrl = this.baseUrl;

    // Create the channel with merged options
    const channel = new NatsRealtimeChannel<TIn, TOut>(
      natsUrl,
      topic,
      this.options,
      this.logger,
    );

    // Start connecting in background - doesn't wait for connection to complete
    channel.connect().catch((error) => {
      this.logger?.error(`Error connecting to channel ${topic}:`, error);
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
}

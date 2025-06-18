import type {
    RealtimeChannel, 
    ChannelOptions,
} from '@synet/patterns/realtime';
import type { RealtimeProvider, RealtimeProviderOptions } from '@synet/patterns/realtime';
import type { RealtimeEvent } from '@synet/patterns/realtime';
import { GunRealtimeChannel } from './gun-channel';
import type { GunOptions } from './gun-types';
import GunInstance from 'gun';
import chalk from 'chalk';

/**
 * GUN implementation of RealtimeProvider
 */
export class GunRealtimeProvider implements RealtimeProvider {
  private gun: any; // Using any for Gun type due to its dynamic nature
  private channels: Map<string, RealtimeChannel> = new Map();

  /**
   * Create a new GUN provider
   * @param url URL of the GUN server (e.g., http://localhost:8765)
   * @param options Provider configuration options
   */
  constructor(public readonly url: string, private options: RealtimeProviderOptions<GunOptions> = {}) {
    // Initialize GUN with the provided URL
   this.url = url;
    
    // Configure Gun with explicit peer and disable local storage
    this.gun = GunInstance({  // Type assertion to bypass TypeScript checking
      peers: [url],
      localStorage: false,
      radisk: false,
      web: false,
      multicast: false,
      axe: false
  });
    
    console.log(`GUN initialized with peer: ${url}`);
    
  }
  
  /**
 * Create a channel for real-time communication
 */
createChannel<TIn extends RealtimeEvent = RealtimeEvent, TOut extends RealtimeEvent = RealtimeEvent>(
  topic: string,
  options?: ChannelOptions
): RealtimeChannel<TIn, TOut> {
  // Check if we already have a channel for this topic
  const existingChannel = Array.from(this.channels.values())
    .find(channel => 
      channel instanceof GunRealtimeChannel && 
      channel.topic === topic
    );
  
  if (existingChannel) {
    // Return the existing channel with the correct type
    console.log(chalk.red(`Reusing existing channel for topic: ${topic}`));
    return existingChannel as RealtimeChannel<TIn, TOut>;
  }
  
  // Create a GUN node for this topic
  const topicNode = this.gun.get(topic);
  
  // Create a channel wrapper around the GUN node
  const channel = new GunRealtimeChannel<TIn, TOut>(topicNode, topic, {
    ...options,
    authToken: this.options.authToken
  });
  
  // Store and return the channel
  this.channels.set(channel.id, channel as RealtimeChannel);
  return channel;
  }
  
  /**
   * Remove a channel and stop receiving events
   * @param channel The channel to remove
   */
  async removeChannel(channel: RealtimeChannel): Promise<void> {
    if (this.channels.has(channel.id)) {
      await channel.close();
      this.channels.delete(channel.id);
    }
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
    // Close all channels
    const closePromises = Array.from(this.channels.values()).map(channel => channel.close());
    await Promise.all(closePromises);
    
    // Clear channels map
    this.channels.clear();
  }
}
import { ChannelState } from "@synet/patterns/realtime";
import type {
  RealtimeChannel,
  RealtimeProviderOptions,
  RealtimeEvent,
  EventSelector,
} from "@synet/patterns/realtime/client";
import type { NatsOptions } from "./nats-types";
import type { Logger } from "@synet/logger";
import { AbstractNatsConnector } from "./abstract-nats-connector";

/**
 * NATS implementation of RealtimeChannel
 */
export class NatsRealtimeChannel<
    TIn extends RealtimeEvent = RealtimeEvent,
    TOut extends RealtimeEvent = RealtimeEvent,
  >
  extends AbstractNatsConnector<TIn, TOut>
  implements RealtimeChannel<TIn, TOut>
{
  protected clientInbox: string;

  constructor(
    protected url: string,
    protected readonly topic: string = "default",
    protected options: RealtimeProviderOptions<NatsOptions> = {},
    protected logger?: Logger,
  ) {
    super(url, topic, options, logger);
    // Extract topic from url query parameters
    //const urlObj = new URL(url);
    //this.topic = urlObj.searchParams.get("topic") || "default";
    this.clientInbox = `client.${this.id}`;
  }

  protected async setupSubscriptions(): Promise<void> {
    if (!this.natsConnection) return;

    try {
      // Subscribe to general topic
      const subjectPrefix =
        this.options.transportOptions?.subjectPrefix || "topic";
      const topicSubject = `${subjectPrefix}.${this.topic}`;
      this.subscription = this.natsConnection.subscribe(topicSubject);

      // Process messages in background
      (async () => {
        if (!this.subscription) return;

        for await (const msg of this.subscription) {
          try {
            const event = JSON.parse(this.stringCodec.decode(msg.data)) as TIn;
            this.notifyHandlers(event.type, event);
          } catch (error) {
            this.logger?.error("Error processing topic message:", error);
          }
        }
      })().catch((err) =>
        this.logger?.error("Error in topic subscription:", err),
      );

      // Subscribe to personal inbox
      const inboxSub = this.natsConnection.subscribe(this.clientInbox);

      // Process inbox messages in background
      (async () => {
        for await (const msg of inboxSub) {
          try {
            const event = JSON.parse(this.stringCodec.decode(msg.data)) as TIn;
            this.notifyHandlers(event.type, event);
          } catch (error) {
            this.logger?.error("Error processing inbox message:", error);
          }
        }
      })().catch((err) => console.error("Error in inbox subscription:", err));
    } catch (error) {
      console.error("Error setting up subscriptions:", error);
      throw error;
    }
  }

  protected async sendConnectionMessage(): Promise<void> {
    if (!this.natsConnection) return;

    try {
      const connectionMessage = {
        clientId: this.id,
        topic: this.topic,
        clientInbox: this.clientInbox,
        timestamp: new Date(),
      };

      // Send with request-reply to ensure server processes it
      const resp = await this.natsConnection.request(
        "control.connect",
        this.stringCodec.encode(JSON.stringify(connectionMessage)),
        { timeout: 5000 },
      );

      // Process confirmation
      const confirmation = JSON.parse(this.stringCodec.decode(resp.data));
      if (this.options.transportOptions?.debug) {
        this.logger?.debug(`Connection to topic ${this.topic} established`);
      }
    } catch (error) {
      this.logger?.error(
        "Error sending connection message:",
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  }

  /**
   * Subscribe to events
   */
  on<T extends TIn = TIn>(
    selector: EventSelector,
    handler: (event: T) => void,
  ): () => void {
    let eventType: string;

    if (typeof selector === "string") {
      eventType = selector;
    } else if (selector.type && selector.source) {
      eventType = `${selector.source}.${selector.type}`;
    } else if (selector.type) {
      eventType = selector.type;
    } else if (selector.source) {
      eventType = `${selector.source}.*`;
    } else {
      eventType = "*";
    }

    if (!this.eventHandlers.has(eventType)) {
      this.eventHandlers.set(eventType, new Set());
    }

    const handlers = this.eventHandlers.get(eventType);
    if (handlers) {
      handlers.add(handler as (event: TIn) => void);
    }

    return () => {
      const handlers = this.eventHandlers.get(eventType);
      if (handlers) {
        handlers.delete(handler as (event: TIn) => void);
        if (handlers.size === 0) {
          this.eventHandlers.delete(eventType);
        }
      }
    };
  }

  /**
   * Send an event to the channel
   */
  async publish(event: TOut): Promise<void> {
    // If connecting, wait for the connection to complete
    if (this.state === ChannelState.CONNECTING && this.connectionPromise) {
      await this.connectionPromise;
    }
    // If disconnected or error, try to establish connection
    else if (this.state !== ChannelState.CONNECTED) {
      await this.connect();
    }

    // At this point we should be connected, but double-check
    if (!this.natsConnection || this.state !== ChannelState.CONNECTED) {
      throw new Error(
        `Cannot publishing event: channel not connected (state: ${this.state})`,
      );
    }

    try {
      // Add client ID if not present
      const completeEvent = {
        ...event,
        clientId: event.clientId || this.id,
        timestamp: event.timestamp || new Date(),
      };

      // Publish to topic
      const subjectPrefix =
        this.options.transportOptions?.subjectPrefix || "topic";
      const subject = `${subjectPrefix}.${this.topic}`;
      this.natsConnection.publish(
        subject,
        this.stringCodec.encode(JSON.stringify(completeEvent)),
      );
    } catch (error) {
      console.error("Error publishing event:", error);
      throw error;
    }
  }

  getState(): ChannelState {
    return this.state;
  }

  getId(): string {
    return this.id;
  }
}

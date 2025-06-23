import type {
  RealtimeEvent,
  EventChannel,
} from "@synet/patterns/realtime/client";
import { ChannelState } from "@synet/patterns/realtime";
import type { NatsProviderOptions } from "./nats-types";
import type { Logger } from "@synet/logger";
import { AbstractNatsConnector } from "./abstract-nats-connector";

export class NatsEventChannel<TEvent extends RealtimeEvent = RealtimeEvent>
  extends AbstractNatsConnector<TEvent, TEvent>
  implements EventChannel<TEvent>
{
  constructor(
    protected url: string,
    protected readonly topic: string,
    protected options: NatsProviderOptions = {},
    protected logger?: Logger,
  ) {
    super(url, topic, options, logger);
  }

  protected async sendConnectionMessage(): Promise<void> {
    if (!this.natsConnection) return Promise.resolve();

    try {
      const connectionMessage = {
        clientId: this.id,
        topic: this.topic,
        timestamp: new Date(),
      };

      // Send with request-reply to ensure server processes it
      this.natsConnection.publish(
        "control.connect",
        this.stringCodec.encode(JSON.stringify(connectionMessage)),
      );
    } catch (error) {
      this.logger?.error(
        "Error sending connection message:",
        error instanceof Error ? error.message : "Unknown error",
      );
      throw error;
    }
  }

  protected async setupSubscriptions(): Promise<void> {
    if (!this.natsConnection) return;

    const subjectPrefix =
      this.options.transportOptions?.subjectPrefix || "topic";
    const topicSubject = `${subjectPrefix}.${this.topic}`;

    // Subscribe to topic
    this.subscription = this.natsConnection.subscribe(topicSubject);

    // Process incoming messages
    (async () => {
      if (!this.subscription) return;

      for await (const msg of this.subscription) {
        try {
          const event = JSON.parse(this.stringCodec.decode(msg.data)) as TEvent;
          this.notifyHandlers(event.type, event);
        } catch (error) {
          this.logger?.error("Error processing message:", error);
        }
      }
    })();
  }

  on<T extends TEvent>(type: string, handler: (event: T) => void): () => void {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, new Set());
    }

    const handlers = this.eventHandlers.get(type);
    if (handlers) {
      handlers.add(handler as (event: TEvent) => void);
    }

    this.eventHandlers.get(type);

    return () => {
      const handlers = this.eventHandlers.get(type);
      if (handlers) {
        handlers.delete(handler as (event: TEvent) => void);
        if (handlers.size === 0) {
          this.eventHandlers.delete(type);
        }
      }
    };
  }

  getId(): string {
    return this.id;
  }
  async publish(event: TEvent): Promise<void> {
    if (this.state === ChannelState.CONNECTING && this.connectionPromise) {
      await this.connectionPromise;
    } else if (this.state !== ChannelState.CONNECTED) {
      await this.connect();
    }

    if (!this.natsConnection || this.state !== ChannelState.CONNECTED) {
      throw new Error(
        `Cannot publishing event: channel not connected (state: ${this.state})`,
      );
    }

    const completeEvent = {
      ...event,
      clientId: this.id || "anonymous",
      timestamp: event.timestamp || new Date(),
    };
    const subjectPrefix =
      this.options.transportOptions?.subjectPrefix || "topic";
    const subject = `${subjectPrefix}.${this.topic}`;

    this.natsConnection.publish(
      subject,
      this.stringCodec.encode(JSON.stringify(completeEvent)),
    );
  }
}

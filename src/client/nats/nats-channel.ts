import { connect, StringCodec, type  NatsConnection, type Subscription } from "nats";
import crypto from "node:crypto";
import { ChannelState } from "@synet/patterns/realtime";
import type {
  RealtimeChannel,
  RealtimeProviderOptions,
  RealtimeEvent,
  EventSelector,
} from "@synet/patterns/realtime/client";
import type { NatsOptions } from "./nats-types";
import type { Logger } from "@synet/logger";
/**
 * NATS implementation of RealtimeChannel
 */
export class NatsRealtimeChannel<
  TIn extends RealtimeEvent = RealtimeEvent,
  TOut extends RealtimeEvent = RealtimeEvent
> implements RealtimeChannel<TIn, TOut> {
  readonly id = crypto.randomUUID();
  private natsConnection: NatsConnection | null = null;
  private state: ChannelState = ChannelState.DISCONNECTED;
  private eventHandlers = new Map<string, Set<(event: TIn) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connectionPromise: Promise<void> | null = null;
  private subscription: Subscription | null = null;
  private stringCodec = StringCodec();
  private clientInbox: string;
  private topic: string;

  constructor(
    private url: string,
    private options: RealtimeProviderOptions<NatsOptions> = {},
    private logger?: Logger
  ) {
    // Extract topic from url query parameters
    const urlObj = new URL(url);
    this.topic = urlObj.searchParams.get("topic") || "default";
    this.clientInbox = `client.${this.id}`;
  }

 /**
 * Connect to the NATS channel
 */
connect(): Promise<void> {
  // If already connecting or connected, return the existing promise
  if (this.connectionPromise) {
    return this.connectionPromise;
  }

  if (this.state === ChannelState.CONNECTED) {
    return Promise.resolve();
  }

  this.state = ChannelState.CONNECTING;

  // Fix: Remove async from the executor function and use proper Promise chaining
  this.connectionPromise = new Promise<void>((resolve, reject) => {
    const natsConfig = {
      servers: this.url,
      user: this.options.transportOptions?.user,
      pass: this.options.transportOptions?.password,
      token: this.options.transportOptions?.token,
      reconnect: this.options.reconnect?.enabled !== false,
      maxReconnectAttempts: this.options.transportOptions?.maxReconnects || 
                          this.options.reconnect?.maxAttempts || -1,
      reconnectTimeWait: this.options.transportOptions?.reconnectTimeWait || 
                        this.options.reconnect?.initialDelayMs || 1000,
    };

    // Connect to NATS server using proper Promise chaining
    connect(natsConfig)
      .then(async nc => {
        this.natsConnection = nc;
        
        // Set up connection status handlers
        this.monitorConnectionStatus();
        
        // Set up subscriptions and send connection message
        return this.setupSubscriptions()
          .then(() => this.sendConnectionMessage())
          .then(() => {
            // Update state
            this.state = ChannelState.CONNECTED;
            this.reconnectAttempts = 0;
            resolve();
          });
      })
      .catch(error => {
        this.state = ChannelState.ERROR;
        this.connectionPromise = null;
        reject(error);
      });
  });

  return this.connectionPromise;
}

/**
 * Monitor NATS connection status changes
 */
private monitorConnectionStatus(): void {

// Start an async task to monitor status - don't await it
(async () => {
  try {
    
    if (!this.natsConnection) return;
    const status = this.natsConnection.status();
      for await (const s of status) {
        switch (s.type) {
          case "reconnecting":
            this.state = ChannelState.CONNECTING;
            console.log(`Reconnecting to NATS server (attempt ${this.reconnectAttempts++})...`);
            break;
            
          case "reconnect":
            this.state = ChannelState.CONNECTED;
            this.reconnectAttempts = 0;
            console.log("Reconnected to NATS server");
            // Re-establish subscriptions after reconnect
            this.setupSubscriptions().catch(err => 
              console.error("Error setting up subscriptions after reconnect:", err)
            );
            break;
            
          case "disconnect":
            this.state = ChannelState.DISCONNECTED;
            console.log("Disconnected from NATS server");
            break;
            
          case "error":
            this.state = ChannelState.ERROR;
            console.error("NATS connection error:", s.data);
            break;
           
          case "pingTimer":
            // This is a normal health check - only log in debug mode
            if (this.options.transportOptions?.debug) {
              console.log("NATS ping check active");
            }
          break;

          case "staleConnection":
            // Connection might be stale - prepare for possible disconnect
            console.warn("NATS connection may be stale, monitoring for disconnect...");
            this.state = ChannelState.CONNECTING; // Mark as potentially problematic
            break;
            

          case "update":
            // Server discovered or removed
            break;
            
          case "ldm":
            // LDM mode change
            break;
            
          default:
            console.log(`NATS status update: ${s.type}`);
            break;
        }
      }
    } catch (err) {
      console.error("Error monitoring NATS status:", err);
    }
  })();
}

  private async setupSubscriptions(): Promise<void> {
    if (!this.natsConnection) return;
    
    try {
      // Subscribe to general topic
      const subjectPrefix = this.options.transportOptions?.subjectPrefix || "topic";
      const topicSubject = `${subjectPrefix}.${this.topic}`;
      this.subscription = await this.natsConnection.subscribe(topicSubject);
      
      // Process messages in background
      (async () => {
        if (!this.subscription) return;
        
        for await (const msg of this.subscription) {
          try {
            const event = JSON.parse(this.stringCodec.decode(msg.data)) as TIn;
            this.processIncomingEvent(event);
          } catch (error) {
            console.error("Error processing topic message:", error);
          }
        }
      })().catch(err => console.error("Error in topic subscription:", err));
      
      // Subscribe to personal inbox
      const inboxSub = await this.natsConnection.subscribe(this.clientInbox);
      
      // Process inbox messages in background
      (async () => {
        for await (const msg of inboxSub) {
          try {
            const event = JSON.parse(this.stringCodec.decode(msg.data)) as TIn;
            this.processIncomingEvent(event);
          } catch (error) {
            console.error("Error processing inbox message:", error);
          }
        }
      })().catch(err => console.error("Error in inbox subscription:", err));
      
    } catch (error) {
      console.error("Error setting up subscriptions:", error);
      throw error;
    }
  }

  private async sendConnectionMessage(): Promise<void> {
    if (!this.natsConnection) return;
    
    try {
      const connectionMessage = {
        clientId: this.id,
        topic: this.topic,
        clientInbox: this.clientInbox,
        timestamp: new Date()
      };
      
      // Send with request-reply to ensure server processes it
      const resp = await this.natsConnection.request(
        "control.connect", 
        this.stringCodec.encode(JSON.stringify(connectionMessage)),
        { timeout: 5000 }
      );
      
      // Process confirmation
      const confirmation = JSON.parse(this.stringCodec.decode(resp.data));
      if (this.options.transportOptions?.debug) {
        console.log("Connection established:", confirmation);
      }
    } catch (error) {
      console.error("Error sending connection message:", error);
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
  async emit(event: TOut): Promise<void> {
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
        `Cannot emit event: channel not connected (state: ${this.state})`
      );
    }
    
    try {
      // Add client ID if not present
      const completeEvent = {
        ...event,
        clientId: event.clientId || this.id
      };
      
      // Publish to topic
      const subjectPrefix = this.options.transportOptions?.subjectPrefix || "topic";
      const subject = `${subjectPrefix}.${this.topic}`;
      this.natsConnection.publish(
        subject, 
        this.stringCodec.encode(JSON.stringify(completeEvent))
      );
    } catch (error) {
      console.error("Error emitting event:", error);
      throw error;
    }
  }

  /**
   * Close the channel
   */
  async close(): Promise<void> {
    if (this.state === ChannelState.DISCONNECTED || !this.natsConnection) {
      return;
    }

    this.state = ChannelState.DISCONNECTING;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      // Unsubscribe
      if (this.subscription) {
        this.subscription.unsubscribe();
      }
      
      // Notify server about disconnection
      const disconnectMessage = {
        clientId: this.id,
        topic: this.topic,
        timestamp: new Date()
      };
      this.natsConnection.publish(
        "control.disconnect",
        this.stringCodec.encode(JSON.stringify(disconnectMessage))
      );

      try {
        // Use request instead of publish to ensure delivery
        await this.natsConnection.request(
          "control.disconnect", 
          this.stringCodec.encode(JSON.stringify(disconnectMessage)),
          { timeout: 3000 } // 3 second timeout
        );
        this.logger?.debug('Disconnect notification confirmed by server');
      } catch (error) {
        // Even if the server doesn't respond, we'll still proceed with disconnect
        this.logger?.warn('Failed to confirm disconnect notification:', error);
      }

      // Close NATS connection
      await this.natsConnection.drain();
      await this.natsConnection.close();
      this.natsConnection = null;
      
      this.state = ChannelState.DISCONNECTED;
    } catch (error) {
      console.error("Error closing channel:", error);
      this.state = ChannelState.ERROR;
    }
  }

  getState(): ChannelState {
    return this.state;
  }

  private processIncomingEvent(event: TIn): void {
    // Process exact type handlers
    const exactHandlers = this.eventHandlers.get(event.type);
    if (exactHandlers) {
      for (const handler of exactHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`Error in event handler for ${event.type}:`, error);
        }
      }
    }

    // Process wildcard handlers
    const wildcardHandlers = this.eventHandlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`Error in wildcard handler for ${event.type}:`, error);
        }
      }
    }
  }

  public async manualReconnect(): Promise<void> {
  // Clear existing connection resources
  if (this.natsConnection) {
    try {
      await this.natsConnection.close();
    } catch (err) {
      console.error("Error closing existing connection:", err);
    }
    this.natsConnection = null;
  }
  
  this.reconnectAttempts = 0;
  this.connectionPromise = null;
  
  // Establish fresh connection
  return this.connect();
  }
}
import {
  connect,
  StringCodec,
  type NatsConnection,
  type Subscription,
} from "nats";
import crypto from "node:crypto";
import type { Logger } from "@synet/logger";
import type {
  RealtimeServer,
  RealtimeServerOptions,
  RealtimeServerStats,
  ClientConnectedEventData,
  ClientDisconnectedEventData,
  MessageReceivedEventData,
  ServerEventType,
  RealtimeEvent,
  Topic,
} from "@synet/patterns/realtime";
import chalk from "chalk";
/**
 * NATS-specific options
 */
export interface NatsServerOptions {
  url?: string;
  user?: string;
  password?: string;
  token?: string;
  reconnect?: {
    enabled: boolean;
    maxAttempts: number;
    delayMs: number;
  };
}

/**
 * Client information for tracking connections
 */
interface ClientInfo {
  clientId: string;
  subscriptions: Set<string>;
  lastSeen: number;
  metadata?: Record<string, unknown>;
}

// Add to nats-types.ts or directly in nats-realtime-server.ts
export interface ControlConnectMessage {
  clientId?: string;
  topic?: string;
  clientInbox?: string;
  timestamp: Date | string;
  replyTo?: string;
  metadata?: Record<string, unknown>;
}

export interface ControlDisconnectMessage {
  clientId: string;
  timestamp: Date | string;
  topics: Topic[];
}

export interface ControlSubscribeMessage {
  clientId: string;
  topic: string;
}

export interface ControlUnsubscribeMessage {
  clientId: string;
  topic: string;
}

// Union type for any control message
export type ControlMessage =
  | ControlConnectMessage
  | ControlDisconnectMessage
  | ControlSubscribeMessage
  | ControlUnsubscribeMessage;

export class NatsRealtimeServer implements RealtimeServer {
  private natsConnection?: NatsConnection;
  private clients: Map<string, ClientInfo> = new Map();
  private subscriptions: Map<Topic, Set<string>> = new Map(); // topic -> client ids
  private stats: RealtimeServerStats;
  private startTime: number = Date.now();
  private eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();
  private natsSubscriptions: Map<string, Subscription> = new Map();
  private stringCodec = StringCodec();

  constructor(
    private options: RealtimeServerOptions<NatsServerOptions> = {},
    private logger?: Logger,
  ) {
    this.stats = {
      connectedClients: 0,
      totalTopics: 0,
      messagesSent: 0,
      messagesReceived: 0,
      uptime: 0,
    };
  }

  async start(): Promise<void> {
    const natsUrl =
      this.options.transportOptions?.url || "nats://localhost:4222";

    try {
      // Connect to NATS server
      this.natsConnection = await connect({
        servers: natsUrl,
        user: this.options.transportOptions?.user,
        pass: this.options.transportOptions?.password,
        token: this.options.transportOptions?.token,
        reconnect: this.options.transportOptions?.reconnect?.enabled !== false,
        maxReconnectAttempts:
          this.options.transportOptions?.reconnect?.maxAttempts || -1,
        reconnectTimeWait:
          this.options.transportOptions?.reconnect?.delayMs || 1000,
      });

      this.logger?.info(`NATS RealtimeServer connected to ${natsUrl}`);

      // Set up subscription for client connection messages
      await this.setupControlSubscriptions();

      // Start periodic cleanup of stale clients
      this.startStaleClientCleanup();
    } catch (error) {
      console.error("Failed to connect to NATS server:", error);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.natsConnection) return;

    // Unsubscribe from all topics
    for (const subscription of this.natsSubscriptions.values()) {
      subscription.unsubscribe();
    }

    // Drain and close connection to NATS server
    await this.natsConnection.drain();
    await this.natsConnection.close();

    // Clean up resources
    this.natsSubscriptions.clear();
    this.clients.clear();
    this.subscriptions.clear();

    this.logger?.info("NATS RealtimeServer stopped");
  }

  async broadcast(topic: Topic, event: RealtimeEvent): Promise<void> {
    if (!this.natsConnection) {
      throw new Error("NATS server not started");
    }

    try {
      // Convert event to string for transmission
      const message = JSON.stringify(event);

      // Publish to NATS topic
      this.natsConnection.publish(
        `topic.${topic}`,
        this.stringCodec.encode(message),
      );

      // Update stats
      this.stats.messagesSent++;

      // Log broadcast
      this.logger?.debug(`Broadcasted to ${topic}: Event ${event.type}`);
    } catch (error) {
      this.logger?.error(`Failed to broadcast to ${topic}:`, error);
      throw error;
    }
  }

  async sendToClient(clientId: string, event: RealtimeEvent): Promise<void> {
    if (!this.natsConnection) {
      throw new Error("NATS server not started");
    }

    const client = this.clients.get(clientId);
    if (!client) {
      throw new Error(`Client ${clientId} not connected`);
    }

    try {
      // Convert event to string
      const message = JSON.stringify(event);

      // Send directly to client's inbox
      this.natsConnection.publish(
        `client.${clientId}`,
        this.stringCodec.encode(message),
      );

      // Update stats
      this.stats.messagesSent++;

      // Log
      this.logger?.info(
        `Sent direct message to client ${clientId}: ${event.type}`,
      );
    } catch (error) {
      console.error(`Failed to send to client ${clientId}:`, error);
      throw error;
    }
  }

  getStats(): RealtimeServerStats {
    return {
      ...this.stats,
      connectedClients: this.clients.size,
      totalTopics: this.subscriptions.size,
      uptime: Date.now() - this.startTime,
    };
  }

  on<T extends ServerEventType>(
    event: T,
    handler: (data: unknown) => void,
  ): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }

    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.add(handler);
    }
  }

  /**
   * Set up subscriptions for client control messages
   */
  private async setupControlSubscriptions(): Promise<void> {
    if (!this.natsConnection) return;

    try {
      // Subscribe to client connection messages
      const connectSub = await this.natsConnection.subscribe("control.connect");
      this.natsSubscriptions.set("control.connect", connectSub);

      // Process connection requests
      (async () => {
        for await (const msg of connectSub) {
          try {
            const data = JSON.parse(this.stringCodec.decode(msg.data));
            this.handleClientConnection(data, msg.reply);
          } catch (error) {
            console.error("Error processing client connection message:", error);
          }
        }
      })().catch((err) =>
        console.error("Error in control.connect subscription:", err),
      );

      // Subscribe to client disconnection messages
      const disconnectSub =
        await this.natsConnection.subscribe("control.disconnect");
      this.natsSubscriptions.set("control.disconnect", disconnectSub);

      // Process disconnection requests
      (async () => {
        for await (const msg of disconnectSub) {
          try {
            const data = JSON.parse(this.stringCodec.decode(msg.data));
            this.handleClientDisconnection(data.clientId);
          } catch (error) {
            this.logger?.error(
              "Error processing client disconnection message:",
              error,
            );
          }
        }
      })().catch((err) =>
        this.logger?.error("Error in control.disconnect subscription:", err),
      );

      // Subscribe to subscription requests
      const subscribeSub =
        await this.natsConnection.subscribe("control.subscribe");
      this.natsSubscriptions.set("control.subscribe", subscribeSub);

      // Process subscription requests
      (async () => {
        for await (const msg of subscribeSub) {
          try {
            const data = JSON.parse(this.stringCodec.decode(msg.data));
            this.subscribeClientToTopic(data.clientId, data.topic);

            // Reply to confirm subscription if a reply subject is provided
            if (msg.reply) {
              const response = JSON.stringify({
                success: true,
                topic: data.topic,
              });
              this.natsConnection?.publish(
                msg.reply,
                this.stringCodec.encode(response),
              );
            }
          } catch (error) {
            this.logger?.error("Error processing subscription request:", error);
          }
        }
      })().catch((err) =>
        this.logger?.error("Error in control.subscribe subscription:", err),
      );

      // Subscribe to unsubscription requests
      const unsubscribeSub = this.natsConnection.subscribe(
        "control.unsubscribe",
      );
      this.natsSubscriptions.set("control.unsubscribe", unsubscribeSub);

      // Process unsubscription requests
      (async () => {
        for await (const msg of unsubscribeSub) {
          try {
            const data = JSON.parse(this.stringCodec.decode(msg.data));
            this.unsubscribeClientFromTopic(data.clientId, data.topic);
          } catch (error) {
            this.logger?.error(
              "Error processing unsubscription request:",
              error,
            );
          }
        }
      })().catch((err) =>
        this.logger?.error("Error in control.unsubscribe subscription:", err),
      );

      this.logger?.info("Control subscriptions set up");
    } catch (error) {
      this.logger?.error("Failed to set up control subscriptions:", error);
      throw error;
    }
  }

  /**
   * Handle a new client connection
   */
  private handleClientConnection(
    connectionData: ControlConnectMessage,
    replySubject?: string,
  ): void {
    // Generate client ID if not provided
    const clientId = connectionData.clientId || crypto.randomUUID();
    const topic = connectionData.topic || "default";

    this.logger?.info(
      `Client ${clientId} connecting to topic: ${chalk.bold(topic)}`,
    );
    this.logger?.debug("Connection data", connectionData);

    // Store client information
    this.clients.set(clientId, {
      clientId,
      subscriptions: new Set(),
      lastSeen: Date.now(),
      metadata: connectionData.metadata || {},
    });

    // Subscribe to topic if provided
    if (topic) {
      this.subscribeClientToTopic(clientId, topic);
    }

    // Update stats
    this.stats.connectedClients = this.clients.size;

    // Emit connection event
    const eventData: ClientConnectedEventData = {
      clientId,
      topic,
      timestamp: new Date(),
      metadata: connectionData.metadata || {},
    };

    this.emit("client.connected", eventData);
    this.logger?.info(
      `Client ${clientId} connected and subscribed to: ${chalk.bold(topic)}`,
    );

    // Send confirmation via reply subject if provided
    if (replySubject && this.natsConnection) {
      const confirmation = JSON.stringify({
        id: crypto.randomUUID(),
        type: "connection.established",
        source: "server",
        timestamp: new Date(),
        data: { clientId, subscribedTopic: topic },
      });

      this.natsConnection.publish(
        replySubject,
        this.stringCodec.encode(confirmation),
      );
    }
  }

  /**
   * Subscribe a client to a topic
   */
  private subscribeClientToTopic(clientId: string, topic: Topic): void {
    // Create topic if it doesn't exist
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
      this.createTopicSubscription(topic);
    }

    // Add client to topic subscribers
    const subscribers = this.subscriptions.get(topic);
    if (subscribers) {
      subscribers.add(clientId);
    }

    // Update client's subscription list
    const client = this.clients.get(clientId);
    if (client) {
      client.subscriptions.add(topic);
      client.lastSeen = Date.now();
    }

    this.logger?.info(`Client ${clientId} subscribed to topic: ${topic}`);
  }

  /**
   * Unsubscribe a client from a topic
   */
  private unsubscribeClientFromTopic(clientId: string, topic: Topic): void {
    // Remove client from topic subscribers
    const subscribers = this.subscriptions.get(topic);
    if (subscribers) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this.subscriptions.delete(topic);
        this.removeTopicSubscription(topic);
      }
    }

    // Update client's subscription list
    const client = this.clients.get(clientId);
    if (client) {
      client.subscriptions.delete(topic);
      client.lastSeen = Date.now();
    }

    this.logger?.info(`Client ${clientId} unsubscribed from topic: ${topic}`);
  }

  /**
   * Handle client disconnection
   */
  private handleClientDisconnection(clientId: string): void {
    this.logger?.info(`Client ${clientId} disconnected`);

    // Get client info
    const client = this.clients.get(clientId);
    if (!client) return;

    // Get subscribed topics before removal
    const subscribedTopics: Topic[] = Array.from(client.subscriptions);

    // Remove client
    this.clients.delete(clientId);

    // Remove from all topic subscriptions
    for (const topic of subscribedTopics) {
      const subscribers = this.subscriptions.get(topic);
      if (subscribers) {
        subscribers.delete(clientId);
        if (subscribers.size === 0) {
          this.subscriptions.delete(topic);
          this.removeTopicSubscription(topic);
        }
      }
    }

    // Update stats
    this.stats.connectedClients = this.clients.size;

    // Emit disconnection event
    const eventData: ClientDisconnectedEventData = {
      clientId,
      topics: subscribedTopics,
      timestamp: new Date(),
    };

    this.emit("client.disconnected", eventData);
  }

  /**
   * Create a NATS subscription for a topic
   */
  private async createTopicSubscription(topic: Topic): Promise<void> {
    if (!this.natsConnection) return;

    // Check if we already have a subscription
    if (this.natsSubscriptions.has(`topic.${topic}`)) return;

    try {
      // Create NATS subscription
      const subscription = await this.natsConnection.subscribe(
        `topic.${topic}`,
      );
      this.natsSubscriptions.set(`topic.${topic}`, subscription);

      // Set up message handler
      (async () => {
        for await (const msg of subscription) {
          try {
            const event = JSON.parse(this.stringCodec.decode(msg.data));

            // Update stats
            this.stats.messagesReceived++;

            // Emit message received event
            const messageEvent: MessageReceivedEventData = {
              clientId: event.clientId || "server",
              message: event,
              timestamp: new Date(),
            };

            this.emit("message.received", messageEvent);

            // Forward to subscribers
            await this.forwardMessageToSubscribers(topic, event);
          } catch (error) {
            this.logger?.error(
              `Error processing message on topic ${topic}:`,
              error,
            );
          }
        }
      })().catch((err) =>
        this.logger?.error(`Error in topic.${topic} subscription:`, err),
      );

      this.logger?.info(`Created subscription for topic: ${topic}`);
    } catch (error) {
      this.logger?.error(
        `Failed to create subscription for topic ${topic}:`,
        error,
      );
    }
  }

  /**
   * Remove a NATS subscription for a topic
   */
  private removeTopicSubscription(topic: Topic): void {
    const subKey = `topic.${topic}`;
    const subscription = this.natsSubscriptions.get(subKey);

    if (subscription) {
      subscription.unsubscribe();
      this.natsSubscriptions.delete(subKey);
      this.logger?.info(`Removed subscription for topic: ${topic}`);
    }
  }

  /**
   * Forward a message to all clients subscribed to a topic
   */
  private async forwardMessageToSubscribers(
    topic: Topic,
    event: RealtimeEvent,
  ): Promise<void> {
    if (!this.natsConnection) return;

    const subscribers = this.subscriptions.get(topic);
    if (!subscribers || subscribers.size === 0) return;

    const message = JSON.stringify(event);
    const messageData = this.stringCodec.encode(message);

    // Forward to each client's individual inbox
    const sendPromises: Promise<void>[] = [];

    for (const clientId of subscribers) {
      const client = this.clients.get(clientId);
      if (client) {
        // Update client's last seen timestamp
        client.lastSeen = Date.now();

        // In NATS, each client would have a unique inbox
        const clientInbox = `client.${clientId}`;

        sendPromises.push(
          (async () => {
            try {
              if (this.natsConnection) {
                this.natsConnection.publish(clientInbox, messageData);
                this.stats.messagesSent++;
              } else {
                console.error(
                  `Cannot forward message to client ${clientId}: No NATS connection`,
                );
              }
            } catch (error) {
              console.error(
                `Failed to forward message to client ${clientId}:`,
                error,
              );
            }
          })(),
        );
      }
    }

    // Wait for all sends to complete
    if (sendPromises.length > 0) {
      await Promise.all(sendPromises);
    }

    this.logger?.info(
      `Forwarded message to ${sendPromises.length} clients on topic ${topic}`,
    );
  }

  /**
   * Start periodic cleanup of stale clients
   */
  private startStaleClientCleanup(): void {
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      const staleTimeThreshold = 5 * 60 * 1000; // 5 minutes

      for (const [clientId, client] of this.clients.entries()) {
        if (now - client.lastSeen > staleTimeThreshold) {
          this.logger?.info(`Removing stale client: ${clientId}`);
          this.handleClientDisconnection(clientId);
        }
      }
    }, 60 * 1000); // Check every minute

    // Make sure cleanup interval doesn't prevent Node from exiting
    cleanupInterval.unref();
  }

  /**
   * Emit an event to all registered handlers
   */
  private emit(event: ServerEventType, data: unknown): void {
    const handlers = this.eventHandlers.get(event) || new Set();

    for (const handler of handlers) {
      try {
        handler(data);
      } catch (error) {
        console.error(`Error in event handler for ${event}:`, error);
      }
    }
  }
}

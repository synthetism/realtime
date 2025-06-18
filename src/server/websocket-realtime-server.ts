import WebSocket, { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import crypto from "node:crypto";
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
} from "@synet/patterns/realtime/server";
import type { Logger } from "@synet/logger";

/**
 * WebSocket-specific options
 */
export interface WebSocketServerOptions {
  port?: number;
  host?: string;
  heartbeat?: {
    enabled: boolean;
    intervalMs: number;
    timeoutMs: number;
  };
}

export class WebSocketRealtimeServer implements RealtimeServer {
  private wsServer?: WebSocketServer;
  private clients: Map<string, WebSocket> = new Map();
  private subscriptions: Map<Topic, Set<string>> = new Map(); // topic -> client ids
  private stats: RealtimeServerStats;
  private startTime: number = Date.now();
  private eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();

  constructor(
    private options: RealtimeServerOptions<WebSocketServerOptions> = {},
    private logger?: Logger, // Use console for simplicity, can be replaced with a proper Logger interface
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
    const port = this.options.transportOptions?.port || 3030;
    this.wsServer = new WebSocketServer({ port });

    this.wsServer.on("connection", (socket, request) => {
      this.handleNewConnection(socket, request);
    });

    this.logger?.info(`Websocket server listening on port ${port}`);
  }

  async stop(): Promise<void> {
    if (!this.wsServer) return;

    // Close all client connections
    const disconnectPromises = Array.from(this.clients.values()).map(
      (client) =>
        new Promise<void>((resolve) => {
          client.close();
          resolve();
        }),
    );
    await Promise.all(disconnectPromises);

    // Close server
    return new Promise((resolve) => {
      if (this.wsServer) {
        this.wsServer.close(() => {
          this.clients.clear();
          this.subscriptions.clear();
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async broadcast(topic: Topic, event: RealtimeEvent): Promise<void> {
    const clientIds = this.subscriptions.get(topic);
    if (!clientIds || clientIds.size === 0) {
      this.logger?.info(`No subscribers for topic: ${topic}`);
      return;
    }

    const message = JSON.stringify(event);
    let sentCount = 0;

    for (const clientId of clientIds) {
      const client = this.clients.get(clientId);
      if (client && client.readyState === WebSocket.OPEN) {
        try {
          client.send(message);
          sentCount++;
        } catch (error) {
          console.error(`Failed to send to client ${clientId}:`, error);
        }
      }
    }

    this.stats.messagesSent += sentCount;
    this.logger?.debug(
      `Broadcasted to ${topic}: ${sentCount} clients received event`,
    );
  }

  private handleNewConnection(
    socket: WebSocket,
    request: IncomingMessage,
  ): void {
    const clientId = crypto.randomUUID();
    this.clients.set(clientId, socket);

    // Parse topic from URL path or query parameter
    const url = new URL(request.url || "/", `http://${request.headers.host}`);
    const topic =
      url.searchParams.get("topic") ||
      url.pathname.split("/").filter(Boolean)[0] ||
      "default";

    this.subscribeClientToTopic(clientId, topic);

    this.logger?.info(
      `Client ${clientId} connected and subscribed to: ${topic}`,
    );
    const eventData: ClientConnectedEventData = {
      clientId,
      topic,
      timestamp: new Date(),
      metadata: {
        ip: request.socket.remoteAddress,
        userAgent: request.headers["user-agent"] as string | undefined,
      },
    };

    // Emit with proper typing
    this.emit("client.connected", eventData);

    // Handle client disconnection
    socket.on("close", () => {
      this.handleClientDisconnection(clientId);
    });

    // Handle client messages (minimal - just for subscribe/unsubscribe)
    socket.on("message", (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === "subscribe" && message.topic) {
          this.subscribeClientToTopic(clientId, message.topic);
        } else if (message.type === "unsubscribe" && message.topic) {
          this.unsubscribeClientFromTopic(clientId, message.topic);
        }
        // Note: We don't handle 'publish' here - that's for bidirectional later
      } catch (error) {
        console.error("Error processing client message:", error);
      }
    });

    // Send connection confirmation
    socket.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        type: "connection.established",
        source: "server",
        timestamp: new Date(),
        data: { clientId, subscribedTopic: topic },
      }),
    );
  }

  private subscribeClientToTopic(clientId: string, topic: Topic): void {
    if (!this.subscriptions.has(topic)) {
      this.subscriptions.set(topic, new Set());
    }
    const subscribers = this.subscriptions.get(topic);
    if (subscribers) {
      subscribers.add(clientId);
    }

    this.logger?.info(`Client ${clientId} subscribed to topic: ${topic}`);
  }

  private unsubscribeClientFromTopic(clientId: string, topic: Topic): void {
    const subscribers = this.subscriptions.get(topic);
    if (subscribers) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this.subscriptions.delete(topic);
      }
    }

    this.logger?.info(`Client ${clientId} unsubscribed from topic: ${topic}`);
  }

  private handleClientDisconnection(clientId: string): void {
    this.logger?.info(`Client ${clientId} disconnected`);

    const subscribedTopics: Topic[] = [];
    for (const [topic, subscribers] of this.subscriptions.entries()) {
      if (subscribers.has(clientId)) {
        subscribedTopics.push(topic);
      }
    }

    this.clients.delete(clientId);

    // Remove from all topic subscriptions
    for (const [topic, subscribers] of this.subscriptions.entries()) {
      subscribers.delete(clientId);
      if (subscribers.size === 0) {
        this.subscriptions.delete(topic);
      }
    }

    // Create properly typed event data
    const eventData: ClientDisconnectedEventData = {
      clientId,
      topics: subscribedTopics,
      timestamp: new Date(),
    };

    // Emit with proper typing
    this.emit("client.disconnected", eventData);
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
   * Emit an event to all registered handlers
   * @param event The event type
   * @param data The event data
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
  // ... other methods (getStats, on, stop, etc.)
}

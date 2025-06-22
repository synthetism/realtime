import Gun from "gun";
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import type { Logger } from "@synet/logger";
import type { 
  RealtimeServer, 
  RealtimeServerOptions,
  RealtimeServerStats,  
  ServerEventType,
  RealtimeEvent,
  Topic
} from "@synet/patterns/realtime/server";

/**
 * GUN-specific options
 */
export interface GunServerOptions {
  port?: number;
  host?: string;
  storagePath?: string;
  multicast?: boolean;
  peers?: string[];
  axe?: boolean;
  checkInterval?: number; // How often to check events in ms
}

export class GunRealtimeServer implements RealtimeServer {
  private httpServer?: http.Server;
  private gun?: any; // GUN doesn't have great TypeScript types
  private clients: Map<string, { lastSeen: number; topics: Set<string> }> = new Map();
  private subscriptions: Map<Topic, Set<string>> = new Map(); // topic -> client ids
  private stats: RealtimeServerStats;
  private startTime: number = Date.now();
  private eventHandlers: Map<string, Set<(data: unknown) => void>> = new Map();
  private topicSubscriptions: Map<string, { eventType: string; callback: any }> = new Map();
  private checkIntervalId?: NodeJS.Timeout;

  constructor(
    private options: RealtimeServerOptions<GunServerOptions> = {},
    private logger?: Logger,
) {
    this.stats = {
      connectedClients: 0,
      totalTopics: 0,
      messagesSent: 0,
      messagesReceived: 0,
      uptime: 0
    };
  }

  async start(): Promise<void> {
    const port = this.options.transportOptions?.port || 8765;
    const storagePath = this.options.transportOptions?.storagePath || 'storage/gun';
    const dataDir = path.join(storagePath);
    
    // Ensure storage directory exists
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    
    // Create HTTP server
    this.httpServer = http.createServer();
    
    // Initialize GUN with our HTTP server
    this.gun = Gun({
      web: this.httpServer,
      file: path.join(dataDir, "radata"),
      multicast: this.options.transportOptions?.multicast !== false,
      peers: this.options.transportOptions?.peers || [],
      axe: this.options.transportOptions?.axe !== false
    });

    // Start HTTP server
    this.httpServer.listen(port, () => {
      this.logger?.info(`🔫 GUN RealtimeServer running at http://localhost:${port}/gun`);
      this.logger?.info(`Data stored in: ${path.join(dataDir, "radata")}`);
    });
        
  }

  async stop(): Promise<void> {
    // Clear event checking interval
    if (this.checkIntervalId) {
      clearInterval(this.checkIntervalId);
    }
    
    // Unsubscribe from all topics
    for (const [topic, sub] of this.topicSubscriptions.entries()) {
      try {
        // Gun doesn't have a clean unsubscribe mechanism,
        // but we can off() specific callbacks
        if (this.gun && sub.callback) {
          this.gun.get(topic).get(sub.eventType).off(sub.callback);
        }
      } catch (error) {
        this.logger?.error(`Error unsubscribing from topic ${topic}:`, error);
      }
    }
    
    // Clear maps
    this.topicSubscriptions.clear();
    this.subscriptions.clear();
    this.clients.clear();
    
    // Close HTTP server
    return new Promise<void>((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.logger?.info('🔫 GUN RealtimeServer stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  async broadcast(topic: Topic, event: RealtimeEvent): Promise<void> {
    if (!this.gun) {
      throw new Error("GUN server not initialized");
    }

    try {

      
      // Store the event in GUN under the topic structure
      this.gun.get(topic).get(event.type).put({
        id: event.id,
        source: event.source,
        type: event.type,
        timestamp: event.timestamp.toISOString(),
        data: event.data, // Store directly, not as a reference
        metadata: event.metadata
      });
      
      // Also store as simple direct data to avoid reference issues
      this.gun.get(topic).get(event.type).put({
        id: event.id,
        source: event.source,
        type: event.type,
        timestamp: event.timestamp.toISOString(),
        data: event.data, // Store directly, not as a reference
        metadata: event.metadata
      });
      
      // Update stats
      this.stats.messagesSent++;

      this.logger?.debug(`Broadcasted to ${topic}: Event ${event.type} (${event.id})`);
      return Promise.resolve();
    } catch (error) {
      this.logger?.error(`Error broadcasting to ${topic}:`, error);
      return Promise.reject(error);
    }
  }

  getStats(): RealtimeServerStats {
    return {
      ...this.stats,
      connectedClients: this.clients.size,
      totalTopics: this.subscriptions.size,
      uptime: Date.now() - this.startTime
    };
  }
  
  on<T extends ServerEventType>(event: T, handler: (data: unknown) => void): void {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, new Set());
    }
    
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.add(handler);
    }
  }

 

}
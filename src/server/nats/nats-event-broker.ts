// Simplified NATS server

import { connect, StringCodec, type NatsConnection} from "nats";
import type { Logger } from "@synet/logger";
import fs from "node:fs";
import type { 
  RealtimeServerOptions,
  RealtimeEvent,
  EventBrokerServer
} from "@synet/patterns/realtime";
import * as nkeys from 'ts-nkeys';
import type { AuthOptions, NatsServerOptions } from "./nats-types";

export class NatsEventBrokerServer<TEvent extends RealtimeEvent = RealtimeEvent> implements EventBrokerServer<TEvent> {
  private natsConnection?: NatsConnection;
  private stats = { messageCount: 0, clientCount: 0 };
  private eventHandlers = new Map<string, Set<(event: TEvent) => void>>();
  private stringCodec = StringCodec();

  constructor(    
      private options: RealtimeServerOptions<NatsServerOptions> = {},
      private logger?: Logger
    ) {}
  
  async start(): Promise<void> {
    const natsUrl = this.options.transportOptions?.url || "nats://localhost:4222";

    const authOptions: AuthOptions = {};

     if (this.options.auth) {
      // Set user/password if provided
      if (this.options.transportOptions?.user) {
        authOptions.user = this.options.transportOptions.user;
        authOptions.pass = this.options.transportOptions.password;
        this.logger?.debug('Using user/password authentication for NATS');
      }
      
      // Set token if provided
      if (this.options.transportOptions?.token) {
        authOptions.token = this.options.transportOptions.token;
        this.logger?.debug('Using token authentication for NATS');
      }
      
      // Set nkey if provided
      if (this.options.transportOptions?.nkeyPath) {
        try {

          const nkey_pub = fs.readFileSync(this.options.transportOptions.nkeyPath.pub, 'utf8').trim();
          const nkey_seed = fs.readFileSync(this.options.transportOptions.nkeyPath.seed, 'utf8').trim();

          authOptions.nkey = nkey_pub;

          authOptions.sigCB = (nonce: Uint8Array): Uint8Array => {
          // Convert nonce to Buffer if it's not already
          const nonceBuffer = Buffer.isBuffer(nonce) 
            ? nonce 
            : Buffer.from(nonce);
                      
          const sk = nkeys.fromSeed(Buffer.from(nkey_seed));  
          // Sign and return
          return sk.sign(nonceBuffer);
         };

          this.logger?.debug('Using NKey authentication for NATS');
        } catch (error) {
          this.logger?.error(`Failed to read NKey from ${this.options.transportOptions.nkeyPath}:`, error);
          throw error;
        }
      }
    }
    
   this.natsConnection = await connect({
      servers: natsUrl,
      ...authOptions,
      reconnect: this.options.transportOptions?.reconnect?.enabled !== false,
      maxReconnectAttempts: this.options.transportOptions?.reconnect?.maxAttempts || -1,
      reconnectTimeWait: this.options.transportOptions?.reconnect?.delayMs || 1000,
    });



    this.logger?.debug(`NATS Event Broker connected to ${natsUrl}`);
    
    await this.setupSubscriptions();

  }

 private async setupSubscriptions(): Promise<void> {
  
    if (!this.natsConnection) return;

        // Set up minimal control channel for connection tracking
    const controlSub = this.natsConnection.subscribe("control.*");
    
    (async () => {
      for await (const msg of controlSub) {
        try {

          console.log("Control message received:", msg.subject);
          // Simple connection tracking for stats only
          if (msg.subject === "control.connect") {
            this.stats.clientCount++;
            
            // Notify handlers about the connection event
            const connectData = JSON.parse(this.stringCodec.decode(msg.data)) as TEvent;
            this.notifyHandlers("connection",connectData);
          } else if (msg.subject === "control.disconnect") {
            this.stats.clientCount--;
            
            // Notify handlers about the disconnect event
            const disconnectData = JSON.parse(this.stringCodec.decode(msg.data)) as TEvent;
            this.notifyHandlers("disconnection", disconnectData);

          }
        } catch (error) {
          this.logger?.error("Error processing control message:", error);
        }
      }
    })();
    
    // Subscribe to all topic messages for monitoring
    const topicSub = this.natsConnection.subscribe("topic.*");
    
    (async () => {
      for await (const msg of topicSub) {
        try {
          this.stats.messageCount++;
          const event = JSON.parse(this.stringCodec.decode(msg.data));
          
          // Notify handlers about the event
          this.notifyHandlers(event.type, event);
          this.notifyHandlers("*", event);
        } catch (error) {
          this.logger?.error("Error processing topic message:", error);
        }
      }
    })();

  }

  on(type: string, handler: (event: TEvent) => void): () => void {
    if (!this.eventHandlers.has(type)) {
      this.eventHandlers.set(type, new Set());
    }

    const handlers = this.eventHandlers.get(type);
    if (handlers) {
      handlers.add(handler);
    }
    
    return () => {
      const handlers = this.eventHandlers.get(type);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.eventHandlers.delete(type);
        }
      }
    };
  }

  private notifyHandlers(type: string, event: TEvent): void {
    // Notify type-specific handlers
    const handlers = this.eventHandlers.get(type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          this.logger?.error(`Error in event handler for ${type}:`, error);
        }
      }
    }
  }

  getStats(): { messageCount: number; clientCount: number } {
    return { ...this.stats };
  }
  
   async stop(): Promise<void> {    
    await this.natsConnection?.close();

  }
}
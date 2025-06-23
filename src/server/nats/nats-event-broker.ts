// Simplified NATS server

import { 
  connect, 
  StringCodec, 
  type NatsConnection, 
  type NKeyAuth, 
  type Auth,
  type ConnectionOptions
} from "nats";
import type { Logger } from "@synet/logger";
import fs from "node:fs";
import type { 
  RealtimeServerOptions,
  RealtimeEvent,
  EventBrokerServer
} from "@synet/patterns/realtime";
import * as nkeys from 'ts-nkeys';
import type { NatsServerOptions } from "./nats-types";
import { AbstractNatsConnector } from "./abstract-nats-connector";
import chalk from "chalk";

export class NatsEventBrokerServer<TEvent extends RealtimeEvent = RealtimeEvent> 
  extends AbstractNatsConnector<TEvent> 
  implements EventBrokerServer<TEvent> {
  protected natsConnection?: NatsConnection;
  protected stats = { messageCount: 0, clientCount: 0 };
  protected eventHandlers = new Map<string, Set<(event: TEvent) => void>>();
  protected stringCodec = StringCodec();

  constructor(    
      protected options: RealtimeServerOptions<NatsServerOptions> = {},
      protected logger?: Logger      
  ) {
    
    super(options, logger);
  }
  
  async start(): Promise<void> {
    const natsUrl = this.options.transportOptions?.url || "nats://localhost:4222";

   const natsOptions: ConnectionOptions = {
      servers: natsUrl,
      ...this.getNatsAuth(),
      reconnect: this.options.transportOptions?.reconnect?.enabled !== false,
      maxReconnectAttempts: this.options.transportOptions?.reconnect?.maxAttempts || -1,
      reconnectTimeWait: this.options.transportOptions?.reconnect?.delayMs || 1000,
    };

     
   this.natsConnection = await connect(natsOptions);
 
      
    this.logger?.debug(`NATS Event Broker connected to ${natsUrl}`);
    
    await this.setupSubscriptions();

  }

  protected async setupSubscriptions(): Promise<void> {
  
    if (!this.natsConnection) return;

        // Set up minimal control channel for connection tracking
    const controlSub = this.natsConnection.subscribe("control.*");
    
    (async () => {
      for await (const msg of controlSub) {
        try {
     
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


  getStats(): { messageCount: number; clientCount: number } {
    return { ...this.stats };
  }
  
   async stop(): Promise<void> {    
    await this.natsConnection?.close();

  }
}
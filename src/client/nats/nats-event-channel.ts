
import { connect, StringCodec, type  NatsConnection, type Subscription } from "nats";
import crypto from "node:crypto";
import type {
  RealtimeEvent,
  RealtimeProviderOptions,
  EventChannel, 
} from "@synet/patterns/realtime/client";
import { ChannelState } from "@synet/patterns/realtime";
import type { NatsOptions, NatsProviderOptions } from "./nats-types";
import type { Logger } from "@synet/logger";
import fs from "node:fs";
import * as nkeys from 'ts-nkeys';

interface AuthOptions {
  user?: string;
  pass?: string;  
  token?: string;
  nkey?: string; // Path to NKey seed file
  sigCB?: (nonce: Uint8Array) => Uint8Array;
}

export class NatsEventChannel<TEvent extends RealtimeEvent = RealtimeEvent> implements EventChannel<TEvent> {
  readonly id = crypto.randomUUID();
  private natsConnection?: NatsConnection;
  private state: ChannelState = ChannelState.DISCONNECTED;
  private subscription?: Subscription;
  private stringCodec = StringCodec();
  private eventHandlers = new Map<string, Set<(event: TEvent) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  
  constructor(
    private url: string,
    public readonly topic: string,
    private options: NatsProviderOptions = {},
    private logger?: Logger
  ) {}
  
  async connect(): Promise<void> {


      if (this.state === ChannelState.CONNECTED) {
        return Promise.resolve();
      }

     this.state = ChannelState.CONNECTING;

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
    

     const natsConfig = {
      servers: this.url,
      ...authOptions,
      reconnect: this.options.reconnect?.enabled !== false,
      maxReconnectAttempts: this.options.transportOptions?.maxReconnects || 
                          this.options.reconnect?.maxAttempts || -1,
      reconnectTimeWait: this.options.transportOptions?.reconnectTimeWait || 
                        this.options.reconnect?.initialDelayMs || 1000,
    };

    this.natsConnection = await connect(natsConfig);
    
    this.state = ChannelState.CONNECTED;

    const subjectPrefix = this.options.transportOptions?.subjectPrefix || "topic";
    const topicSubject = `${subjectPrefix}.${this.topic}`;

    // Subscribe to topic
    this.subscription = this.natsConnection.subscribe(topicSubject);
    
    // Process incoming messages
    (async () => {
      if (!this.subscription) return;
      
      for await (const msg of this.subscription) {
        try {
          const event = JSON.parse(this.stringCodec.decode(msg.data)) as TEvent;
          this.notifyHandlers(event);
        } catch (error) {
          console.error("Error processing message:", error);
        }
      }
    })();
    
     const connectionMessage = {
        clientId: this.id,
        topic: this.topic,
        timestamp: new Date()
      };

    // Notify server of connection
    this.natsConnection.publish("control.connect", this.stringCodec.encode(
      JSON.stringify(connectionMessage)
    ));
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
    if (!this.natsConnection) {
      await this.connect();
    }
    
    const completeEvent = {
      ...event,
      clientId: this.id || 'anonymous',
      timestamp: event.timestamp || new Date()
    };
    
    this.natsConnection?.publish(
      `topic.${this.topic}`,
      this.stringCodec.encode(JSON.stringify(completeEvent))
    );
  }
  
  private notifyHandlers(event: TEvent): void {
    // Notify type-specific handlers
    const handlers = this.eventHandlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`Error in handler for ${event.type}:`, error);
        }
      }
    }
    
    // Notify wildcard handlers
    const wildcardHandlers = this.eventHandlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error('Error in wildcard handler:', error);
        }
      }
    }
  }
  
  async close(): Promise<void> {

    
      if (this.state === ChannelState.DISCONNECTED || !this.natsConnection) {
          return;
      }
    
      this.logger?.debug(`Closing NATS channel ${this.id} for topic ${this.topic} (${this.state})`);

      this.state = ChannelState.DISCONNECTING;
  
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
   
      if (this.subscription) {
        this.subscription.unsubscribe();
      }

       const disconnectMessage = {
        clientId: this.id,
        topic: this.topic,
        timestamp: new Date()
      };
      
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
      await this.natsConnection.close();

      this.natsConnection = undefined;

      this.state = ChannelState.DISCONNECTED;
   
  }
}
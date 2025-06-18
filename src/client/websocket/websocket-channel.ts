import { ChannelState } from "@synet/patterns/realtime";
import type {
  RealtimeChannel,
  RealtimeProviderOptions,
  RealtimeEvent,
  EventSelector,
} from "@synet/patterns/realtime/client";
import type { WebsocketOptions } from "./websocket-types";
import crypto from "node:crypto"; // Add this import
/**
 * WebSocket implementation of RealtimeChannel
 */
export class WebSocketRealtimeChannel<
  TIn extends RealtimeEvent = RealtimeEvent,
  TOut extends RealtimeEvent = RealtimeEvent,
> implements RealtimeChannel<TIn, TOut>
{
  readonly id = crypto.randomUUID();
  private socket: WebSocket | null = null;
  private state: ChannelState = ChannelState.DISCONNECTED;
  private eventHandlers = new Map<string, Set<(event: TIn) => void>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private connectionPromise: Promise<void> | null = null;

  constructor(
    private url: string,
    private options: RealtimeProviderOptions<WebsocketOptions> = {},
  ) {
    if (this.options.authToken) {
      const urlObj = new URL(this.url);
      urlObj.searchParams.set("token", this.options.authToken);
      this.url = urlObj.toString();
    }
  }

  /**
   * Connect to the WebSocket channel
   * Returns immediately but establishes connection in background
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

    this.connectionPromise = new Promise<void>((resolve, reject) => {
      try {
        this.socket = new WebSocket(this.url);

        this.socket.onopen = () => {
          this.state = ChannelState.CONNECTED;
          this.reconnectAttempts = 0;
          resolve();
        };

        this.socket.onclose = (event) => {
          const previousState = this.state;
          this.state = ChannelState.DISCONNECTED;
          this.connectionPromise = null;

          if (
            previousState === ChannelState.CONNECTED &&
            this.options.reconnect?.enabled
          ) {
            this.scheduleReconnect();
          }

          if (previousState === ChannelState.CONNECTING) {
            reject(new Error(`Failed to connect: ${event.code}`));
          }
        };

        this.socket.onerror = (error) => {
          const previousState = this.state;
          this.state = ChannelState.ERROR;

          if (previousState === ChannelState.CONNECTING) {
            this.connectionPromise = null;
            reject(error);
          }
        };

        this.socket.onmessage = (message) => {
          try {
            const event = JSON.parse(message.data) as TIn;
            this.processIncomingEvent(event);
          } catch (error) {
            console.error("Error processing message:", error);
          }
        };
      } catch (error) {
        this.state = ChannelState.ERROR;
        this.connectionPromise = null;
        reject(error);
      }
    });

    // Connection happens in background, we don't await it here
    return this.connectionPromise;
  }

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

  /*
  async emit(RealtimeEvent: TOut): Promise<void> {
    if (this.state !== ChannelState.CONNECTED || !this.socket) {
      throw new Error(`Cannot emit RealtimeEvent: channel not connected (state: ${this.state})`);
    }
    
    this.socket.send(JSON.stringify(RealtimeEvent));
  } */

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
    if (!this.socket || this.state !== ChannelState.CONNECTED) {
      throw new Error(
        `Cannot emit event: channel not connected (state: ${this.state})`,
      );
    }

    this.socket.send(JSON.stringify(event));
  }

  async close(): Promise<void> {
    if (this.state === ChannelState.DISCONNECTED || !this.socket) {
      return;
    }

    this.state = ChannelState.DISCONNECTING;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    return new Promise<void>((resolve) => {
      if (!this.socket) {
        this.state = ChannelState.DISCONNECTED;
        resolve();
        return;
      }

      this.socket.onclose = () => {
        this.state = ChannelState.DISCONNECTED;
        this.socket = null;
        resolve();
      };

      this.socket.close();
    });
  }

  getState(): ChannelState {
    return this.state;
  }

  private processIncomingEvent(RealtimeEvent: TIn): void {
    // Process exact type handlers
    const exactHandlers = this.eventHandlers.get(RealtimeEvent.type);
    if (exactHandlers) {
      for (const handler of exactHandlers) {
        try {
          handler(RealtimeEvent);
        } catch (error) {
          console.error(
            `Error in RealtimeEvent handler for ${RealtimeEvent.type}:`,
            error,
          );
        }
      }
    }

    // Process wildcard handlers
    const wildcardHandlers = this.eventHandlers.get("*");
    if (wildcardHandlers) {
      for (const handler of wildcardHandlers) {
        try {
          handler(RealtimeEvent);
        } catch (error) {
          console.error(
            `Error in wildcard handler for ${RealtimeEvent.type}:`,
            error,
          );
        }
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const maxAttempts = this.options.reconnect?.maxAttempts ?? 5;
    if (this.reconnectAttempts >= maxAttempts) {
      return;
    }

    const initialDelay = this.options.reconnect?.initialDelayMs ?? 1000;
    const maxDelay = this.options.reconnect?.maxDelayMs ?? 30000;

    // Exponential backoff
    const delay = Math.min(
      initialDelay * 2 ** this.reconnectAttempts,
      maxDelay,
    );

    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        console.error("Reconnection failed:", error);
        this.scheduleReconnect();
      });
    }, delay);
  }
}

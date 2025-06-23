import {
  connect,
  StringCodec,
  type NatsConnection,
  type NKeyAuth,
  type Auth,
  type ConnectionOptions,
  type Subscription,
} from "nats";
import type { Logger } from "@synet/logger";
import type {
  RealtimeServerOptions,
  RealtimeEvent,
} from "@synet/patterns/realtime";
import { ChannelState } from "@synet/patterns/realtime";
import * as nkeys from "ts-nkeys";
import type { NatsOptions, NatsProviderOptions } from "./nats-types";
import chalk from "chalk";

export abstract class AbstractNatsConnector<TEventIn, TEventOut> {
  readonly id = crypto.randomUUID();
  protected natsConnection?: NatsConnection | null = null;
  protected readonly stringCodec = StringCodec();
  protected eventHandlers = new Map<string, Set<(event: TEventIn) => void>>();
  protected reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  protected reconnectAttempts = 0;
  protected connectionPromise: Promise<void> | null = null;
  protected state: ChannelState = ChannelState.DISCONNECTED;
  protected subscription?: Subscription;

  constructor(
    protected url: string,
    protected readonly topic: string,
    protected options: NatsProviderOptions = {},
    protected logger?: Logger,
  ) {}

  // Hook methods - subclasses can override if needed
  protected onBeforeClose(): Promise<void> {
    return Promise.resolve();
  }
  protected onAfterClose(): Promise<void> {
    return Promise.resolve();
  }

  // Getters for controlled access
  protected get connection(): NatsConnection | null | undefined {
    return this.natsConnection;
  }
  protected get currentState(): ChannelState {
    return this.state;
  }

  /**
   * Abstract method to send a connection message after connecting
   * Subclasses should implement this to send their specific connection data
   */

  protected abstract sendConnectionMessage(): Promise<void>;
  protected abstract setupSubscriptions(): Promise<void>;

  /**
   * Connect to the NATS channel
   */
  connect(): Promise<void> {
    // If already connecting or connected, return the existing promise
    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.state = ChannelState.CONNECTING;

    // Fix: Remove async from the executor function and use proper Promise chaining
    this.connectionPromise = new Promise<void>((resolve, reject) => {
      const natsConfig = {
        servers: this.url,
        ...this.getNatsAuth(),
        reconnect: this.options.reconnect?.enabled !== false,
        maxReconnectAttempts:
          this.options.transportOptions?.maxReconnects ||
          this.options.reconnect?.maxAttempts ||
          -1,
        reconnectTimeWait:
          this.options.transportOptions?.reconnectTimeWait ||
          this.options.reconnect?.initialDelayMs ||
          5000,
      } as ConnectionOptions;

      // Connect to NATS server using proper Promise chaining
      connect(natsConfig)
        .then(async (nc: NatsConnection) => {
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
        .catch((error: unknown) => {
          this.state = ChannelState.ERROR;
          this.connectionPromise = null;
          reject(error);
        });
    });

    return this.connectionPromise;
  }

  protected getNatsAuth = (): Partial<ConnectionOptions> => {
    if (!this.options.auth?.enabled) {
      return {};
    }

    this.logger?.debug(chalk.yellow("Preparing NATS authenticator..."));

    const authOptions: Partial<ConnectionOptions> = {};

    if (this.options.transportOptions?.nkey) {
      try {
        const nkeySeed = this.options.transportOptions.nkey;
        if (
          !nkeySeed ||
          typeof nkeySeed !== "string" ||
          !nkeySeed.startsWith("SU")
        ) {
          throw new Error("Invalid or missing NKey seed provided in options.");
        }

        // This is the correct implementation based on your core.d.ts
        authOptions.authenticator = (nonce?: string): Auth => {
          if (!nonce) {
            this.logger?.warn(
              "NATS server requested authentication but didn't provide a nonce.",
            );
            // Return void, which corresponds to NoAuth
            return;
          }

          // 1. Create keypair from the user-provided seed.
          const keyPair = nkeys.fromSeed(Buffer.from(nkeySeed));

          // 2. Sign the server-provided nonce.
          const signature = keyPair.sign(Buffer.from(nonce));

          // 3. The signature must be base64 encoded.
          const b64Signature = Buffer.from(signature).toString("base64");

          // 4. Return the NKeyAuth object with the public key and the signature.
          const creds: NKeyAuth = {
            nkey: keyPair.getPublicKey().toString(),
            sig: b64Signature,
          };

          this.logger?.debug("Autheticated with NKey");

          return creds;
        };
      } catch (error) {
        this.logger?.error("Fatal error setting up NKey authenticator:", error);
        throw error;
      }
    } else if (this.options.transportOptions?.user) {
      authOptions.user = this.options.transportOptions.user;
      authOptions.pass = this.options.transportOptions.password;
    } else if (this.options.transportOptions?.token) {
      authOptions.token = this.options.transportOptions.token;
    }

    return authOptions;
  };

  protected notifyHandlers(type: string, event: TEventIn): void {
    // Process exact type handlers
    const exactHandlers = this.eventHandlers.get(type);
    if (exactHandlers) {
      for (const handler of exactHandlers) {
        try {
          handler(event);
        } catch (error) {
          console.error(`Error in event handler for ${type}:`, error);
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
          console.error(`Error in wildcard handler for ${type}:`, error);
        }
      }
    }
  }

  /**
   * Monitor NATS connection status changes
   */
  protected monitorConnectionStatus(): void {
    // Start an async task to monitor status - don't await it
    (async () => {
      try {
        if (!this.natsConnection) return;
        const status = this.natsConnection.status();
        for await (const s of status) {
          switch (s.type) {
            case "reconnecting":
              this.state = ChannelState.CONNECTING;
              console.log(
                `Reconnecting to NATS server (attempt ${this.reconnectAttempts++})...`,
              );
              break;

            case "reconnect":
              this.state = ChannelState.CONNECTED;
              this.reconnectAttempts = 0;
              console.log("Reconnected to NATS server");
              // Re-establish subscriptions after reconnect
              this.setupSubscriptions().catch((err) =>
                console.error(
                  "Error setting up subscriptions after reconnect:",
                  err,
                ),
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
              console.warn(
                "NATS connection may be stale, monitoring for disconnect...",
              );
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

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    const maxAttempts = this.options.reconnect?.maxAttempts ?? 30;
    if (maxAttempts > 0 && this.reconnectAttempts >= maxAttempts) {
      this.logger?.warn(
        `Maximum reconnection attempts (${maxAttempts}) reached, giving up`,
      );
      return;
    }

    const initialDelay = this.options.reconnect?.initialDelayMs ?? 10000;
    const maxDelay = this.options.reconnect?.maxDelayMs ?? 30000;

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      initialDelay * 1.5 ** this.reconnectAttempts,
      maxDelay,
    );
    // Add jitter (±20%)
    const jitter = 0.2;
    const delay = baseDelay * (1 + jitter * (Math.random() * 2 - 1));

    this.reconnectAttempts++;

    this.logger?.info(
      `Scheduling reconnection attempt ${this.reconnectAttempts}/${maxAttempts === -1 ? "∞" : maxAttempts} in ${Math.round(delay)}ms`,
    );

    this.reconnectTimer = setTimeout(() => {
      // Reset connection state
      this.state = ChannelState.CONNECTING;

      if (this.natsConnection) {
        try {
          // Attempt to close existing connection if it exists
          this.natsConnection.close().catch((err) => {
            this.logger?.warn(
              `Error while closing stale connection: ${err.message}`,
            );
          });
        } catch (error) {
          // Ignore errors during close of potentially dead connection
        }
        this.natsConnection = undefined;
      }

      // Attempt to reconnect
      this.connect()
        .then(() => {
          this.logger?.info(
            `Successfully reconnected after ${this.reconnectAttempts} attempts`,
          );
          this.reconnectAttempts = 0;
        })
        .catch((error) => {
          this.logger?.error(
            `Reconnection attempt ${this.reconnectAttempts} failed:  ${error.message}`,
          );
          this.scheduleReconnect(); // Schedule another attempt
        });
    }, delay);
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
        timestamp: new Date(),
      };

      try {
        // Use request instead of publish to ensure delivery
        this.natsConnection.publish(
          "control.disconnect",
          this.stringCodec.encode(JSON.stringify(disconnectMessage)),
        );
        this.logger?.debug("Disconnect notification confirmed by server");
      } catch (error) {
        // Even if the server doesn't respond, we'll still proceed with disconnect
        this.logger?.warn("Failed to confirm disconnect notification:", error);
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

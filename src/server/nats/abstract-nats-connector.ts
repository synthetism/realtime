
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
import chalk from "chalk";

export abstract class AbstractNatsConnector<TEvent> {
  protected natsConnection?: NatsConnection;
  protected readonly stringCodec = StringCodec();
  protected eventHandlers = new Map<string, Set<(event: TEvent) => void>>();

   constructor(    
      protected options: RealtimeServerOptions<NatsServerOptions> = {},
      protected logger?: Logger
   ) {}

   protected getNatsAuth = (): Partial<ConnectionOptions> => {
      if (!this.options.auth?.enabled) {
        return {};
      }

      console.log(chalk.bold("NATS Authentication Options:"));
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
                "NATS server requested authentication but didn't provide a nonce."
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
            
           this.logger?.debug(
            'Autheticated with NKey'
           );

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

   public on(type: string, handler: (event: TEvent) => void): () => void {
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

   protected notifyHandlers(type: string, event: TEvent): void {
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

  /**
   * Abstract method to be implemented by subclasses for their specific
   * subscription logic after a connection is established.
   */
  protected abstract setupSubscriptions(): Promise<void>;
}
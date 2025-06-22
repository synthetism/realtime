export interface NatsServerOptions {
  url?: string;
  user?: string;
  password?: string;
  token?: string;
  reconnect?: {
    enabled: boolean;
    maxAttempts: number;
    delayMs: number;
  },
  nkeyPath?: {
    pub: string; // Path to NKey public key file
    seed:string;
  }
  
}

export interface AuthOptions {
  user?: string;
  pass?: string;  
  token?: string;
  nkey?: string; // Path to NKey seed file
  sigCB?: (nonce: Uint8Array) => Uint8Array;
}
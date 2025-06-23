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
  nkey?:string;
  
}

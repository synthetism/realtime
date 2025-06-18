import { NatsRealtimeProvider } from "./nats-provider";
import type { RealtimeProviderOptions } from "@synet/patterns/realtime/client";
import type { NatsOptions } from "./nats-types";

/**
 * Creates a new NATS client
 * @param natsUrl The URL of the NATS server
 * @param options Configuration options for the NATS client
 */
export function createNatsClient(
  natsUrl: string,
  options: RealtimeProviderOptions<NatsOptions> = {},
): NatsRealtimeProvider {
  return new NatsRealtimeProvider(natsUrl, options);
}

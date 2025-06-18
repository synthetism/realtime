import { GunRealtimeProvider } from "./gun-provider";
import type { RealtimeProviderOptions } from "@synet/patterns/realtime/client";
import type { GunOptions } from "./gun-types";

/**
 * Creates a new GUN client
 * @param gunUrl The URL of the GUN server
 * @param options Configuration options for the GUN client
 */
export function createGunClient(
  gunUrl: string,
  options: RealtimeProviderOptions<GunOptions> = {},
): GunRealtimeProvider {
  return new GunRealtimeProvider(gunUrl, options);
}


# @synet/realtime

Real-time communication implementations of [@synet/patterns](https://www.npmjs.com/package/@synet/patterns) interfaces for seamless client-server communication across different transport protocols.

This package offers concrete implementations of the abstract real-time communication patterns defined in [@synthetism/patterns](https://github.com/synthetism/patterns), allowing you to build robust real-time applications with minimal boilerplate.

## Available Implementations

### Client

- **NATS** - High-performance message broker implementation with reliable delivery and persistence
- **WebSocket** - Standard WebSocket implementation for broad compatibility and easy browser integration
- **GUN** - Decentralized peer-to-peer database implementation for offline-first applications

### Server

- **NATS** - Server-side implementation with topic-based routing and client tracking
- **WebSocket** - Standard WebSocket server with subscriptions and broadcast capabilities
- **GUN** - Peer-to-peer node implementation that acts as both a server and sync point

## Quick Start

### Setting up a client

```typescript
import { createNatsClient } from "@synet/realtime";
import { GatewayRealtimeClient } from "./infrastructure/services/gateway-realtime-client";

// Configure connection
const natsUrl = process.env.NATS_URL || "nats://localhost:4222";
const provider = createNatsClient(
  natsUrl,
  {
    reconnect: {
      enabled: true,
      maxAttempts: 5,
    },
    transportOptions: {
      user: process.env.NATS_USER,
      password: process.env.NATS_PASSWORD,
      debug: true,
    },
  }
);

// Create and export client
export const client = new GatewayRealtimeClient(provider);
```

### Subscribing to events

#### Method 1: Using Channel API

```typescript
// Subscribe to a topic
const channel = client.subscribe("users");

// Listen for specific event types
channel.on<GatewayEvent>("users.created", (event: GatewayEvent) => {
  console.log("Event received on users.created channel:", event);
  analyticsService.update(event);
});
```

#### Method 2: Using EventEmitter API

```typescript
// Direct subscription to event emitter
client.getEventEmitter().subscribe("users.updated", {
  update: (event) => {
    console.log("Direct EventEmitter subscription fired:", event);
    analyticsService.update(event);
  }
});

// Subscribe to multiple events
client.getEventEmitter().subscribe("notifications.notification", {
  update: (event) => {
    console.log("Notification received:", event);
  }
});
```

### Setting up a server

```typescript
import { WebSocketRealtimeServer } from "@synet/realtime";

// Create server instance
const server = new WebSocketRealtimeServer({
  transportOptions: {
    port: 3030,
    host: "0.0.0.0"
  }
});

// Start the server
await server.start();

// Listen for client connections
server.on("client.connected", (data) => {
  console.log("Client connected:", data);
});

// Broadcast events to subscribed clients
server.broadcast("users", {
  id: crypto.randomUUID(),
  type: "users.created",
  source: "server",
  timestamp: new Date(),
  data: { 
    id: "user-123", 
    name: "Jane Doe",
    email: "jane@example.com"
  }
});
```

## Development Status

These implementations are functional and provide working client-server communication capabilities. All client types can communicate with their corresponding server types successfully. However, the library is still in an early stage of development and the APIs may evolve as we refine patterns and add new features.

## License

MIT

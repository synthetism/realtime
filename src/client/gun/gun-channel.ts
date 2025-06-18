import type { 
    RealtimeChannel, 
    ChannelOptions, 
    EventSelector,
    RealtimeEvent
} from '@synet/patterns/realtime';
import { ChannelState } from '@synet/patterns/realtime';
import crypto from 'node:crypto';

/**
 * GUN implementation of RealtimeChannel
 */
export class GunRealtimeChannel<TIn extends RealtimeEvent = RealtimeEvent, TOut extends RealtimeEvent = RealtimeEvent> 
  implements RealtimeChannel<TIn, TOut> {
  readonly id = crypto.randomUUID();
  private state: ChannelState = ChannelState.DISCONNECTED;
  private eventHandlers = new Map<string, Set<(event: TIn) => void>>();
  private unsubscribers: Array<() => void> = [];

  private recentlyProcessedEvents = new Set<string>();
  
  /**
   * Create a new GUN channel
   * @param gunNode The GUN node to use for this channel
   * @param topic The topic this channel is subscribed to
   * @param options Channel configuration options
   */
  constructor(
    private gunNode: any,
    public readonly topic: string,
    private options: ChannelOptions = {}
  ) {
    // Initialize connection
    this.connect();
  }
  
  /**
   * Get the current state of the channel
   */
  getState(): ChannelState {
    return this.state;
  }
  
  /**
   * Connect to the channel
   */
  async connect(): Promise<void> {
    if (this.state === ChannelState.CONNECTED) {
      return;
    }
    
    this.state = ChannelState.CONNECTING;
    
    try {
      // No explicit connection needed for GUN, 
      // it's automatically connected when created
      this.state = ChannelState.CONNECTED;
    } catch (error) {
      this.state = ChannelState.ERROR;
      throw error;
    }
  }
  
  /**
   * Subscribe to events on this channel
   * @param selector Event selector (type or pattern)
   * @param handler Function to call when event is received
   */
  on<T extends TIn = TIn>(
    selector: EventSelector,
    handler: (event: T) => void
  ): () => void {
    // Create a handler key based on the selector
    const selectorKey = typeof selector === 'string' 
      ? selector 
      : JSON.stringify(selector);
    
    //console.log('SelectorKey: ', selectorKey);
    // Get or create handler set for this selector
    //

    if (!this.eventHandlers.has(selectorKey)) {
        this.eventHandlers.set(selectorKey, new Set());
    }
    

    const handlers = this.eventHandlers.get(selectorKey);
    
    // Add the handler
     if (handlers) {
       handlers.add(handler as (event: TIn) => void);
    
      //console.log(`Added handler for selector ${selectorKey}:`, handler);
      // Set up GUN subscription if this is the first handler for this selector
       if (handlers.size === 1) {

        //console.log(`Setting up GUN subscription for ${this.topic} with selector:`, selector);
        this.setupGunSubscription(selector);

      }
     }
    
    // Return unsubscribe function
    return () => {
      const handlers = this.eventHandlers.get(selectorKey);
      if (handlers) {
        handlers.delete(handler as (event: TIn) => void);
        if (handlers.size === 0) {
          this.eventHandlers.delete(selectorKey);
        }
      }
    };
  }
  
  /**
   * Set up a GUN subscription for events matching the selector
   */

private setupGunSubscription(selector: EventSelector): void {
  console.log(`Setting up GUN subscription for ${this.topic} with selector:`, selector);
 
  this.gunNode.map().on((data: any, key: string) => {
    if (!data) return;
    
    try {
      const event = this.gunDataToEvent(data, key);
     
      // If the event is currently resolving references, defer notification.
      // The notification will happen via notifyHandlersWithResolvedData once resolution is complete.
      if ((event as any)._isResolvingReferences) {
        // console.log(`Event ${event.id} is resolving references, deferring initial notification.`);
        return; 
      }
  
      // Process events that are fully formed (no pending resolutions)
      if (event.id && this.recentlyProcessedEvents.has(event.id)) {
          console.log(`Skipping duplicate event (non-deferred) with ID: ${event.id}`);
          return;
      }

      if (this.eventMatchesSelector(event, selector)) {
        // console.log(`Event (non-deferred) matches selector ${typeof selector === 'string' ? selector : JSON.stringify(selector)}`);
        
        if (event.id) {
            this.recentlyProcessedEvents.add(event.id);
            setTimeout(() => { this.recentlyProcessedEvents.delete(event.id); }, 5000); // Consistent timeout
        }

        const handlers = this.eventHandlers.get(
          typeof selector === 'string' ? selector : JSON.stringify(selector)
        );
        
        if (handlers) {
          // console.log(`Notifying ${handlers.size} handlers (non-deferred) for selector ${selector}`);
          for (const handler of handlers) {
            handler(event as TIn);
          }
        }
      }
    } catch (error) {
      console.error('Error processing GUN event in setupGunSubscription:', error);
    }
  });
}


/**
 * Convert GUN data to a RealtimeEvent, resolving any references
 */
private gunDataToEvent(data: any, key: string): TIn {
  // Handle cases where data might not be a typical GUN event structure
  if (!data || typeof data !== 'object' || !('type' in data && 'id' in data)) {
    let eventType = key;
    if (eventType.endsWith('/data')) eventType = eventType.replace('/data', '');
    const parts = eventType.split('/');
    if (parts.length > 1) eventType = parts[parts.length - 1];

    const constructedEvent: Partial<RealtimeEvent> = {
      id: (typeof data === 'object' && data?.id) || crypto.randomUUID(),
      source: (typeof data === 'object' && data?.source) || 'gun',
      type: eventType,
      timestamp: new Date(),
      data: data,
    };
    return constructedEvent as TIn;
  }

  const event = { ...data } as any; // Use 'any' for internal flags
  event._isResolvingReferences = false; // Initialize flag

  if (typeof event.timestamp === 'string') {
    event.timestamp = new Date(event.timestamp);
  }

  const resolutionPromises: Promise<void>[] = [];

  // Helper to create a resolution promise
  const createResolutionPromise = (field: 'data' | 'metadata', referencePath: string) => {
    event._isResolvingReferences = true;
    // Set initial placeholder for the field being resolved
    event[field] = { _placeholder: true, _reference: referencePath, _originalField: field };
    
    return this.resolveGunReference(referencePath)
      .then(resolvedValue => {
        if (resolvedValue !== null) {
          event[field] = resolvedValue;
        } else {
          console.warn(`Failed to resolve ${field} reference ${referencePath} for event ${event.id}`);
          // Keep placeholder or set an error state for the field
          event[field] = { _placeholder: true, _reference: referencePath, _error: 'resolution_failed', _originalField: field };
        }
      })
      .catch(error => {
        console.error(`Error resolving ${field} reference ${referencePath} for event ${event.id}:`, error);
        event[field] = { _placeholder: true, _reference: referencePath, _error: 'resolution_error', _originalField: field };
      });
  };

  if (event.data && typeof event.data === 'object' && event.data['#']) {
    resolutionPromises.push(createResolutionPromise('data', event.data['#']));
  }

  if (event.metadata && typeof event.metadata === 'object' && event.metadata['#']) {
    resolutionPromises.push(createResolutionPromise('metadata', event.metadata['#']));
  }

  if (event._isResolvingReferences) {
    Promise.all(resolutionPromises)
      .then(() => {
        event._isResolvingReferences = undefined; // Clean up the flag
        // console.log(`All references resolved for event ${event.id}, notifying handlers.`);
        this.notifyHandlersWithResolvedData(event as TIn); // Notify with the (now) fully resolved event
      })
      .catch(err => {
        console.error(`Error during bulk resolution for event ${event.id}:`, err);
        event._isResolvingReferences = undefined;
       
      });
  }
  
  // This event is returned synchronously. If _isResolvingReferences is true, 
  // setupGunSubscription should ignore it for immediate notification.
  return event as TIn;
}


/**
 * Resolve a GUN reference to get the actual data
*/

private resolveGunReference(reference: string): Promise<any> {
  return new Promise<any>((resolve) => {
    // Split the reference path
    const path = reference.split('/');
    
    // Navigate to the reference in the gun database
    let node = this.gunNode.back(-1); // Go to root of GUN graph
    
    // Navigate through the path
    for (const segment of path) {
      node = node.get(segment);
    }
    
    // Get the data
    node.once((data: any) => {
      console.log('data:', data);
      resolve(data);
    });
    
    // Add timeout to prevent hanging
    setTimeout(() => {
      resolve(null); // Resolve with null if can't get data in time
    }, 5000);

  });
}

/**
 * Notify handlers with an event that has resolved data
 */
private notifyHandlersWithResolvedData(resolvedEvent: TIn): void { // Changed signature
  if (resolvedEvent.id && this.recentlyProcessedEvents.has(resolvedEvent.id)) {
      console.log(`Skipping duplicate event (post-resolution) with ID: ${resolvedEvent.id}`);
      return;
  }

  if (resolvedEvent.id) {
      this.recentlyProcessedEvents.add(resolvedEvent.id);
      setTimeout(() => { this.recentlyProcessedEvents.delete(resolvedEvent.id); }, 5000); // Consistent timeout
  }
  
  // console.log('Notifying handlers with resolved data:', resolvedEvent);
  
  for (const [selectorKey, handlers] of this.eventHandlers.entries()) {
    let currentSelector: EventSelector;
    try {
      currentSelector = selectorKey === '*' ? '*' : JSON.parse(selectorKey);
    } catch {
      currentSelector = selectorKey;
    }
    
    if (this.eventMatchesSelector(resolvedEvent, currentSelector)) {
      for (const handler of handlers) {
        handler(resolvedEvent);
      }
    }
  }
}
  /**
   * Check if an event matches a selector
   */
  private eventMatchesSelector(event: TIn, selector: EventSelector): boolean {
    if (selector === '*') {
      return true;
    }
    
    if (typeof selector === 'string') {
      return event.type === selector;
    }
    
    // Object selector with source and/or type
    const sourceMatch = !selector.source || event.source === selector.source;
    const typeMatch = !selector.type || event.type === selector.type;
    
    return sourceMatch && typeMatch;
  }
  
  /**
   * Send an event through this channel
   * @param event The event to send
   */
async emit(event: TOut): Promise<void> {
  if (this.state !== ChannelState.CONNECTED) {
    await this.connect();
  }
  
  // Ensure event has required fields and convert Date to ISO string
  const completeEvent: any = {
    ...event,
    id: event.id || crypto.randomUUID(),
    // Convert Date to string to avoid GUN serialization issues
    timestamp: (event.timestamp instanceof Date) 
      ? event.timestamp.toISOString() 
      : event.timestamp || new Date().toISOString()
  };
  
  // Convert any nested Date objects to strings
  this.serializeDates(completeEvent);
  
  // Store the event in GUN with the type as the key
  const key = event.type;
  this.gunNode.get(key).put(completeEvent);
}

/**
 * Recursively serialize Date objects to ISO strings to avoid GUN serialization issues
 */
private serializeDates(obj: any): void {
  if (!obj || typeof obj !== 'object') return;
  
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    
    if (value instanceof Date) {
      obj[key] = value.toISOString();
    } else if (typeof value === 'object' && value !== null) {
      this.serializeDates(value);
    }
  }
}
  
  /**
   * Close the channel
   */
  async close(): Promise<void> {
    // Run all unsubscribe functions
    for (const unsubscribe of this.unsubscribers) {
      unsubscribe();
    }
    
    this.unsubscribers = [];
    this.eventHandlers.clear();
    this.state = ChannelState.DISCONNECTED;
  }
}
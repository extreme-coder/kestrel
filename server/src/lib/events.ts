/**
 * In-process pub/sub for optimization progress.
 *
 * Stands in for the socket.io channel the original used. SSE is a better fit here than
 * WebSockets: progress is strictly server-to-client, and SSE is plain HTTP — it needs no
 * upgrade handshake, survives proxies, and reconnects on its own.
 */

export interface ProgressEvent {
  requestId: string
  status: 'pending' | 'running' | 'complete' | 'failed'
  evaluated: number
  iterations: number
  temperature: number
  best?: { latitude: number; longitude: number; score: number; powerKw: number } | undefined
  last?:
    | { latitude: number; longitude: number; score: number | null; accepted: boolean }
    | undefined
  error?: string | undefined
}

type Listener = (event: ProgressEvent) => void

export class ProgressBus {
  private readonly listeners = new Map<string, Set<Listener>>()

  subscribe(requestId: string, listener: Listener): () => void {
    let set = this.listeners.get(requestId)
    if (!set) {
      set = new Set()
      this.listeners.set(requestId, set)
    }
    set.add(listener)

    return () => {
      const current = this.listeners.get(requestId)
      if (!current) return
      current.delete(listener)
      if (current.size === 0) this.listeners.delete(requestId)
    }
  }

  publish(event: ProgressEvent): void {
    const set = this.listeners.get(event.requestId)
    if (!set) return
    for (const listener of [...set]) {
      try {
        listener(event)
      } catch {
        // A broken subscriber must not stall the worker or its siblings.
      }
    }
  }

  subscriberCount(requestId: string): number {
    return this.listeners.get(requestId)?.size ?? 0
  }
}

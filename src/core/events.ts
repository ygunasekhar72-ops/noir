import { EventEmitter } from "node:events";

/**
 * Central event bus for the harness. The TUI, web app, plugins and extensions
 * all subscribe to these events; the agent loop and tools publish them.
 */
export interface HarnessEvents {
  "agent:start": { input: string };
  "agent:delta": { text: string };
  "agent:message": { role: string; content: string; toolCalls?: unknown[] };
  "tool:start": { name: string; args: Record<string, unknown> };
  "tool:end": { name: string; ok: boolean; result: string };
  "compaction": { phase: "start" | "saved" | "summarizing" | "done"; detail?: string };
  "swarm": { phase: "plan" | "work" | "synthesize" | "done"; detail?: string };
  "session": { phase: "new" | "resume" | "save"; detail?: string };
  "error": { message: string };
  "log": { message: string };
}

export type HarnessEventName = keyof HarnessEvents;

export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(100);
  }

  pub<K extends HarnessEventName>(name: K, payload: HarnessEvents[K]): void {
    this.emit(name, payload);
  }

  sub<K extends HarnessEventName>(name: K, listener: (payload: HarnessEvents[K]) => void): (payload: HarnessEvents[K]) => void {
    this.on(name, listener as (...args: unknown[]) => void);
    return listener;
  }

  unsub<K extends HarnessEventName>(name: K, listener: (payload: HarnessEvents[K]) => void): void {
    this.off(name, listener as (...args: unknown[]) => void);
  }
}

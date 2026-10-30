export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

/** Один запрос пользователя (ход основного цикла) со всеми его сабагентами. */
export type Entry = {
  at: number
  project: string
  model: string
  prompt: string
  /** Сколько это стоило бы по API, в долларах. */
  usd: number
  /** На сколько пунктов вырос 5-часовой лимит за этот ход (по всему аккаунту). */
  p5: number
  p7: number
  inTok: number
  outTok: number
  cacheRead: number
  cacheWrite: number
  tools: Record<string, number>
  subagents: number
}

export type Window = '5h' | '7d'
export type By = 'project' | 'model' | 'tool' | 'top'

declare module 'claude-code' {
  interface PluginState {
    'usage-crab': {
      limits: Shaped<Limit[]>
      limitsAt: number
      log: Shaped<Entry[]>
      now: number
      window: Window
      by: By
      pollNote: string
      working: boolean
      pinned: 'full' | 'none'
    }
  }
}

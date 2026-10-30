export type GuardEvent = {
  at: number
  /** Вид секрета или описание остановленной команды; само значение не хранится. */
  kind: string
  where: string
  action: 'masked' | 'blocked'
}

declare module 'claude-code' {
  interface PluginState {
    'secret-guard': {
      events: Shaped<GuardEvent[]>
      count: number
      pausedUntil: number
    }
  }
}

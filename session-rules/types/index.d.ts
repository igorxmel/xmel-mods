export type Rule = { name: string; title: string; text: string }

declare module 'claude-code' {
  interface PluginState {
    'session-rules': {
      rules: Shaped<Rule[]>
      enabled: string[]
      projectDefaults: string[]
      cwd: string
      dir: string
      openRule: string
      editRule: string
      note: string
    }
  }
}

// Поиск и маскировка секретов. Чистые функции: без $ и без состояния.

import { HIDDEN_WORD, KIND_NAMES } from './strings'
import type { Lang } from './strings'

export type Found = { kind: string; value: string }

type Pattern = {
  kind: string
  re: RegExp
  /** Номер группы с самим секретом; 0 — всё совпадение. */
  group?: number
}

// Порядок важен: сначала длинные и точные форматы, потом общие.
const PATTERNS: Pattern[] = [
  {
    kind: 'private-key',
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'openai-key', re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g },
  { kind: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws-key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: 'google-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'stripe-key', re: /\b(?:sk|rk)_(?:live|test)_[0-9A-Za-z]{20,}/g },
  { kind: 'telegram-token', re: /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g },
  { kind: 'discord-token', re: /\b[MNO][A-Za-z\d_-]{23,27}\.[A-Za-z\d_-]{6}\.[A-Za-z\d_-]{27,}\b/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // postgres://user:ПАРОЛЬ@host
  { kind: 'url-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]+:([^@\s/]{3,})@/gi, group: 1 },
  // KEY=значение в .env, конфигах, выводе env и прямо посреди сообщения
  {
    kind: 'env-secret',
    re: /(?<![A-Za-z0-9_])(?:export[ \t]+|set[ \t]+|\$env:)?[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|PASS|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY|CREDENTIALS?|DSN|DATABASE_URL|CONN(?:ECTION)?_?STR(?:ING)?)[A-Za-z0-9_]*[ \t]*[=:][ \t]*["']?([^\s"'#]{4,})/gm,
    group: 1,
  },
  // password: значение в YAML и похожих конфигах
  {
    kind: 'config-secret',
    re: /^[ \t]*(?:password|passwd|secret|client_secret|token|api_key|apikey|bot_token|access_token)[ \t]*[:=][ \t]*["']?([^\s"'#]{4,})/gim,
    group: 1,
  },
  // "password": "значение" в JSON
  {
    kind: 'json-secret',
    re: /"(?:password|passwd|secret|client_secret|token|access_token|refresh_token|api_?key|apiKey|private_key|bot_token)"\s*:\s*"([^"]{4,})"/gi,
    group: 1,
  },
]

const PLACEHOLDER =
  /^(?:your|xxx+|\*+|changeme|change_me|example|placeholder|todo|none|null|true|false|undefined|<.*>|\$\{.*\}|\$[A-Z_]+|%[A-Z_]+%|\[(?:скрыто|hidden).*)/i

// Уже скрытое место на любом языке.
const MASKED = /\[(?:скрыто|hidden): [^\]]*\]/g

export function maskLabel(kind: string, value: string, lang: Lang = 'en'): string {
  const tail = value.length >= 16 ? `, …${value.slice(-4)}` : ''
  return `[${HIDDEN_WORD[lang]}: ${KIND_NAMES[lang][kind] ?? kind}${tail}]`
}

/** Находит секреты в тексте, не трогая уже скрытые места. */
export function findSecrets(text: string, known: Iterable<string> = []): Found[] {
  const found: Found[] = []
  const seen = new Set<string>()
  const clean = text.replace(MASKED, ' ')
  for (const p of PATTERNS) {
    p.re.lastIndex = 0
    for (const m of clean.matchAll(p.re)) {
      const value = m[p.group ?? 0]
      if (!value || seen.has(value) || PLACEHOLDER.test(value)) continue
      seen.add(value)
      found.push({ kind: p.kind, value })
    }
  }
  for (const value of known) {
    if (value.length >= 6 && !seen.has(value) && clean.includes(value)) {
      seen.add(value)
      found.push({ kind: 'known-secret', value })
    }
  }
  return found
}

/** Заменяет найденные секреты метками. Длинные значения заменяются первыми. */
export function maskText(text: string, found: readonly Found[], lang: Lang = 'en'): string {
  let out = text
  for (const f of [...found].sort((a, b) => b.value.length - a.value.length)) {
    out = out.split(f.value).join(maskLabel(f.kind, f.value, lang))
  }
  return out
}

// ---------- файлы, которым не место в git ----------

const SENSITIVE_FILE =
  /(?:^|[\\/])(?:\.env(?:\.(?!example$|sample$|template$|dist$|defaults?$)[\w.-]+)?|[^\\/]+\.(?:pem|key|p12|pfx|jks|keystore|ppk)|id_(?:rsa|ed25519|ecdsa|dsa)|credentials\.json|service[-_]?account[^\\/]*\.json|secrets?\.(?:json|ya?ml|toml|env))$/i

export const isSensitiveFile = (path: string) => SENSITIVE_FILE.test(path.trim().replace(/^["']|["']$/g, ''))

export type GitStep = {
  /** Папка, в которой выполнится команда (после cd и git -C). */
  dir: string
  verb: 'add' | 'commit'
  args: string[]
}

/** Грубый разбор командной строки: какие git add / git commit в ней будут и где. */
export function gitSteps(command: string, cwd: string): GitStep[] {
  const steps: GitStep[] = []
  let dir = cwd
  const join = (base: string, p: string) =>
    /^([a-z]:)?[\\/]/i.test(p) ? p : `${base.replace(/[\\/]+$/, '')}/${p}`
  for (const raw of command.split(/&&|\|\||;|\n|\|/)) {
    const words = raw.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map(w => w.replace(/^["']|["']$/g, '')) ?? []
    if (words[0] === 'cd' && words[1]) {
      dir = join(dir, words[1])
      continue
    }
    if (words[0] !== 'git') continue
    let i = 1
    let here = dir
    while (i < words.length && words[i]!.startsWith('-')) {
      if (words[i] === '-C' && words[i + 1]) {
        here = join(here, words[i + 1]!)
        i += 2
      } else if (words[i] === '-c') i += 2
      else i += 1
    }
    const verb = words[i]
    if (verb === 'add' || verb === 'commit') steps.push({ dir: here, verb, args: words.slice(i + 1) })
  }
  return steps
}

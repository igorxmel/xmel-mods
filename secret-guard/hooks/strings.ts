import type { EngineInterface as Engine } from 'claude-code'

// ---------- язык интерфейса ----------
// Выбор языка общий для всех модов xmel-mods: он лежит в одном файле, и любой
// мод подхватывает его за несколько секунд. По умолчанию английский.
// Язык влияет и на метки вида [hidden: …], которые видит модель.

export type Lang = 'en' | 'ru'
export const DEFAULT_LANG: Lang = 'en'
export const otherLang = (l: Lang): Lang => (l === 'en' ? 'ru' : 'en')
export const parseLang = (text: string | undefined): Lang | undefined => {
  const v = text?.trim().toLowerCase()
  return v === 'en' || v === 'ru' ? v : undefined
}

async function langPath($: Engine): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return `${home.replace(/\\/g, '/')}/.claude/xmel-mods-lang.txt`
}

export async function loadLang($: Engine): Promise<Lang> {
  try {
    const path = await langPath($)
    if (!(await $.fs.exists(path))) return DEFAULT_LANG
    return parseLang(await $.fs.read(path)) ?? DEFAULT_LANG
  } catch {
    return DEFAULT_LANG
  }
}

export async function saveLang($: Engine, lang: Lang): Promise<void> {
  try {
    await $.fs.write(await langPath($), lang)
  } catch {
    // не записалось — язык поменяется только в этой сессии
  }
}

// ---------- виды секретов ----------
// В событиях и в коде вид секрета — короткий ключ; название на языке интерфейса
// берётся только при показе.

export const KIND_NAMES: Record<Lang, Record<string, string>> = {
  en: {
    'private-key': 'private key',
    'anthropic-key': 'Anthropic key',
    'openai-key': 'OpenAI key',
    'github-token': 'GitHub token',
    'gitlab-token': 'GitLab token',
    'slack-token': 'Slack token',
    'aws-key': 'AWS key',
    'google-key': 'Google key',
    'stripe-key': 'Stripe key',
    'telegram-token': 'Telegram bot token',
    'discord-token': 'Discord token',
    jwt: 'JWT',
    'url-password': 'password in URL',
    'env-secret': 'secret from .env',
    'config-secret': 'secret in config',
    'json-secret': 'secret in JSON',
    'known-secret': 'known secret',
  },
  ru: {
    'private-key': 'приватный ключ',
    'anthropic-key': 'ключ Anthropic',
    'openai-key': 'ключ OpenAI',
    'github-token': 'токен GitHub',
    'gitlab-token': 'токен GitLab',
    'slack-token': 'токен Slack',
    'aws-key': 'ключ AWS',
    'google-key': 'ключ Google',
    'stripe-key': 'ключ Stripe',
    'telegram-token': 'токен Telegram-бота',
    'discord-token': 'токен Discord',
    jwt: 'JWT',
    'url-password': 'пароль в URL',
    'env-secret': 'секрет из .env',
    'config-secret': 'секрет в конфиге',
    'json-secret': 'секрет в JSON',
    'known-secret': 'известный секрет',
  },
}

/** Метка-замена: «hidden» и «скрыто» оба считаются уже скрытым местом. */
export const HIDDEN_WORD: Record<Lang, string> = { en: 'hidden', ru: 'скрыто' }

/** Ключ вида события, который начинается так, — остановленная git-команда. */
export const GIT_KIND = 'git-files:'
/** Откуда пришёл секрет, если это не инструмент. */
export const WHERE_MESSAGE = 'message'

// ---------- тексты ----------

const EN = {
  cmdDescription: 'Secret guard: what was hidden, pause and resume',
  cmdArgumentHint: '[pause [minutes] | resume | open | lang [en|ru]]',
  statusOn: '🛡️ Guard is on',
  statusCount: (n: number) => `🛡️ Guard: hidden/stopped ${n}`,
  statusPaused: (until: string) => `🛡️ Guard paused until ${until}`,
  statusResumed: '🛡️ Guard is on',
  toastHidden: (kinds: string, tool: string) => `🛡️ Hidden from the model: ${kinds} (${tool})`,
  toastBlocked: (files: string) => `🛡️ Stopped a commit of: ${files}`,
  toastMessage: (kinds: string) => `🛡️ Hidden in your message: ${kinds}`,
  catchHidden: '[secret-guard: could not check this output for secrets and hid it entirely]',
  gitKind: (files: string) => `secret files in git: ${files}`,
  whereMessage: 'your message',
  denyGit: (files: string) =>
    `secret-guard: this command would send files with secrets to git: ${files}. ` +
    "Do not add them. Add them to .gitignore; if a file is already in the index — `git rm --cached <file>`. " +
    'If the user really wants to commit, they will press “Pause” on the guard or run /secrets pause themselves.',
  denyGitFailed:
    'secret-guard could not check this git command for secrets. Check the files by hand or ask the user to run /secrets pause.',
  chatNote: (kinds: string) =>
    `🛡️ secret-guard: hid ${kinds} from the model in your message. ` +
    'If you need to pass the secret to Claude, run /secrets pause and send it again.',
  panelOpened: 'The guard panel is open.',
  pausedFor: (min: number) => `Guard paused for ${min} min: secrets are not hidden, git is not checked.`,
  resumed: 'The guard is working again.',
  headPaused: (until: string) => `Guard paused until ${until}.`,
  headWorking: 'Guard is working.',
  remembered: (n: number) => `Remembered values from .env and output: ${n}.`,
  recent: 'Recent:\n',
  nothing: 'Nothing hidden or stopped yet.',
  cmdFooter:
    '/secrets open — panel, /secrets pause [min] — pause (10 min by default), /secrets resume — turn on, /secrets lang [en|ru] — language.',
  langSet: (name: string) => `Language: ${name}.`,
  langName: 'English',
  bandPaused: (until: string) => `⏸ Guard paused until ${until}`,
  bandWorking: '🛡️ Guard is on',
  bandHidden: (n: number) => ` · hidden ${n}`,
  bandResume: '▶ Resume',
  bandPause: '⏸ Pause 10 min',
  bandDetails: '🛡️ Details',
  paneTitle: '🛡️ Secret guard',
  panePaused: '⏸ Guard paused',
  paneWorking: '🛡️ Guard is on',
  panePausedHint: (until: string) => `Until ${until}: secrets are not hidden, git is not checked.`,
  paneWorkingHint: 'Hides secrets from the model and stops commits of .env and keys.',
  resumeNow: '▶ Resume now',
  pause: 'Pause:',
  min10: '10 min',
  min30: '30 min',
  hour1: '1 hour',
  hiddenThisSession: 'Hidden or stopped this session:',
  rememberedLine: (k: number) => `Remembered values from .env and output: ${k}`,
  forget: 'Forget remembered values',
  recentTitle: 'Recent',
  neverShown: 'Secret values are never shown or written to disk.',
}

export type Dict = typeof EN

const RU: Dict = {
  cmdDescription: 'Страж секретов: что скрыто, пауза и возобновление',
  cmdArgumentHint: '[pause [минут] | resume | open | lang [en|ru]]',
  statusOn: '🛡️ Страж включён',
  statusCount: n => `🛡️ Страж: скрыто/остановлено ${n}`,
  statusPaused: until => `🛡️ Страж на паузе до ${until}`,
  statusResumed: '🛡️ Страж включён',
  toastHidden: (kinds, tool) => `🛡️ Скрыл от модели: ${kinds} (${tool})`,
  toastBlocked: files => `🛡️ Не дал закоммитить: ${files}`,
  toastMessage: kinds => `🛡️ Скрыл в сообщении: ${kinds}`,
  catchHidden: '[secret-guard: не смог проверить этот вывод на секреты и скрыл его]',
  gitKind: files => `файлы с секретами в git: ${files}`,
  whereMessage: 'твоё сообщение',
  denyGit: files =>
    `secret-guard: эта команда отправит в git файлы с секретами: ${files}. ` +
    'Не добавляй их. Добавь их в .gitignore; если файл уже в индексе — `git rm --cached <файл>`. ' +
    'Если пользователь осознанно хочет закоммитить, он сам нажмёт «Пауза» у стража или выполнит /secrets pause.',
  denyGitFailed:
    'secret-guard не смог проверить эту git-команду на секреты. Проверь файлы вручную или попроси пользователя выполнить /secrets pause.',
  chatNote: kinds =>
    `🛡️ secret-guard: в твоём сообщении скрыл от модели ${kinds}. ` +
    'Если секрет нужно передать Claude, выполни /secrets pause и отправь ещё раз.',
  panelOpened: 'Панель стража открыта.',
  pausedFor: min => `Страж на паузе ${min} мин: секреты не скрываются, git не проверяется.`,
  resumed: 'Страж снова работает.',
  headPaused: until => `Страж на паузе до ${until}.`,
  headWorking: 'Страж работает.',
  remembered: n => `Запомнено значений из .env и вывода: ${n}.`,
  recent: 'Последнее:\n',
  nothing: 'Пока ничего не скрыто и не остановлено.',
  cmdFooter:
    '/secrets open — панель, /secrets pause [мин] — пауза (по умолчанию 10 мин), /secrets resume — включить, /secrets lang [en|ru] — язык.',
  langSet: name => `Язык: ${name}.`,
  langName: 'Русский',
  bandPaused: until => `⏸ Страж на паузе до ${until}`,
  bandWorking: '🛡️ Страж работает',
  bandHidden: n => ` · скрыто ${n}`,
  bandResume: '▶ Включить',
  bandPause: '⏸ Пауза 10 мин',
  bandDetails: '🛡️ Подробнее',
  paneTitle: '🛡️ Страж секретов',
  panePaused: '⏸ Страж на паузе',
  paneWorking: '🛡️ Страж работает',
  panePausedHint: until => `До ${until}: секреты не скрываются, git не проверяется.`,
  paneWorkingHint: 'Прячет секреты от модели и не даёт закоммитить .env и ключи.',
  resumeNow: '▶ Включить сейчас',
  pause: 'Пауза:',
  min10: '10 мин',
  min30: '30 мин',
  hour1: '1 час',
  hiddenThisSession: 'Скрыто или остановлено за сессию:',
  rememberedLine: k => `Запомнено значений из .env и вывода: ${k}`,
  forget: 'Забыть запомненные значения',
  recentTitle: 'Последнее',
  neverShown: 'Значения секретов нигде не показываются и не записываются на диск.',
}

export const STRINGS: Record<Lang, Dict> = { en: EN, ru: RU }

/** Название вида секрета или остановленной git-команды на языке интерфейса. */
export function kindName(lang: Lang, kind: string): string {
  if (kind.startsWith(GIT_KIND)) return STRINGS[lang].gitKind(kind.slice(GIT_KIND.length).trim())
  return KIND_NAMES[lang][kind] ?? kind
}

/** Откуда пришёл секрет: «твоё сообщение» или имя инструмента. */
export const whereName = (lang: Lang, where: string): string =>
  where === WHERE_MESSAGE ? STRINGS[lang].whereMessage : where

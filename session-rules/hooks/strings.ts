import type { EngineInterface as Engine } from 'claude-code'

// ---------- язык интерфейса ----------
// Выбор языка общий для всех модов xmel-mods: он лежит в одном файле, и любой
// мод подхватывает его за несколько секунд. По умолчанию английский.

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

// ---------- тексты ----------

const EN = {
  paneTitle: '📏 Session rules',
  statusOn: (names: string) => `📏 Rules: ${names}`,
  statusOff: '📏 Rules: off',
  askToSave: (topic: string, dir: string, name: string) =>
    `Collect the rules on the topic “${topic}” that we worked out together in this session ` +
    `and write them to the file ${dir}/${name}.md. Format: the first line is a heading "# ...", ` +
    'then a short list of rules in the imperative mood, without retelling the discussion. ' +
    'If the file already exists, update it without losing the earlier rules. ' +
    'The rules panel will pick the file up on its own.',
  readme: [
    'This folder holds rule sets for the session-rules mod.',
    'Each set is a separate file <name>.md. The first line is "# Title", then the rules themselves.',
    'Turn them on with the /rules command or in the rules panel, separately in each session.',
  ].join('\r\n'),
  folderOpened: (win: string) => `Opened the folder: ${win}`,
  folderFailed: (errors: string, win: string) => `Could not open the file explorer (${errors}). Folder: ${win}`,
  saved: (name: string) => `Saved ${name}.md`,
  help: [
    'Commands:',
    '  /rules              — open the rules panel',
    '  /rules list         — list the rule sets',
    '  /rules on <name>    — turn a set on in this session',
    '  /rules off <name>   — turn it off',
    '  /rules auto <name>  — turn it on automatically in this project folder',
    '  /rules save <name>  — ask Claude to write the rules worked out in this session to a file',
    '  /rules reload       — re-read the rules folder',
    '  /rules lang [en|ru] — switch the interface language',
  ].join('\n'),
  cmdDescription: 'Turn rule sets on or off for this session',
  cmdArgumentHint: '[on|off|auto|save|list|reload|lang] [name]',
  panelOpened: (dir: string) => `The rules panel is open. Rule files live in ${dir}`,
  found: (n: number) => `Rule sets found: ${n}`,
  noneYet: (dir: string) => `No rule sets yet. Put .md files in ${dir} or use /rules save <name>.`,
  needName: 'Give a name: /rules save commits',
  saveAsked: (path: string) => `Asked Claude to write the rules to ${path}`,
  notFound: (arg: string) => `Rule set “${arg}” not found. /rules list shows what exists.`,
  autoOn: (name: string) => `“${name}” will turn on by itself in this project folder.`,
  autoOff: (name: string) => `“${name}” no longer turns on by itself in this folder.`,
  turnedOn: (name: string) => `Turned on: ${name}`,
  turnedOff: (name: string) => `Turned off: ${name}`,
  contextOn: (name: string) =>
    `From now on the rule set “${name}” applies in this session (it is in the system prompt).`,
  contextOff: (name: string) => `The rule set “${name}” no longer applies in this session.`,
  langSet: (name: string) => `Language: ${name}.`,
  langName: 'English',
  composeTitle: '# Rules turned on by the user for this session',
  composeIntro: 'The user turned these rule sets on themselves. Follow them while they are here.',
  composeSet: (name: string, text: string) => `\n## Rule set “${name}”\n${text}`,
  editHint: 'Enter saves, Shift+Enter adds a new line.',
  save: 'Save',
  cancel: 'Cancel',
  edit: '✏️ Edit',
  none: 'No rule sets yet.',
  noneHint: 'Create a set below or ask Claude to write the rules from this session.',
  auto: '★ auto',
  notAuto: '☆ auto',
  hide: '▾ hide',
  show: '▸ show',
  createManual: 'New set by hand',
  createManualPlaceholder: 'for example: code style',
  create: 'Create',
  createFromSession: 'New set from this session (Claude writes it)',
  createFromSessionPlaceholder: 'for example: commits',
  record: 'Write',
  openFolder: '📂 Rules folder',
  reload: 'Reload',
  crabButton: '🦀 Limits',
  files: (dir: string) => `Files: ${dir}`,
  legend: '● — applies in this session · ★ auto — turns on by itself in this folder',
}

export type Dict = typeof EN

const RU: Dict = {
  paneTitle: '📏 Правила сессии',
  statusOn: names => `📏 Правила: ${names}`,
  statusOff: '📏 Правила: выкл',
  askToSave: (topic, dir, name) =>
    `Собери правила на тему «${topic}», которые мы с тобой выработали в этой сессии, ` +
    `и запиши их в файл ${dir}/${name}.md. Формат: первая строка — заголовок "# ...", ` +
    'дальше короткий список правил в повелительном наклонении, без пересказа истории ' +
    'обсуждения. Если файл уже есть, обнови его, не теряя прежних правил. ' +
    'Панель правил подхватит файл сама.',
  readme: [
    'Здесь лежат наборы правил для мода session-rules.',
    'Каждый набор — отдельный файл <имя>.md. Первая строка "# Заголовок", дальше сами правила.',
    'Включаются командой /rules или в панели правил, в каждой сессии отдельно.',
  ].join('\r\n'),
  folderOpened: win => `Открыл папку: ${win}`,
  folderFailed: (errors, win) => `Не смог открыть проводник (${errors}). Папка: ${win}`,
  saved: name => `Сохранил ${name}.md`,
  help: [
    'Команды:',
    '  /rules              — открыть панель правил',
    '  /rules list         — список правил',
    '  /rules on <имя>     — включить правило в этой сессии',
    '  /rules off <имя>    — выключить',
    '  /rules auto <имя>   — включать автоматически в этой папке проекта',
    '  /rules save <имя>   — попросить Claude записать выработанные в этой сессии правила в файл',
    '  /rules reload       — перечитать папку с правилами',
    '  /rules lang [en|ru] — сменить язык интерфейса',
  ].join('\n'),
  cmdDescription: 'Включить или выключить наборы правил для этой сессии',
  cmdArgumentHint: '[on|off|auto|save|list|reload|lang] [имя]',
  panelOpened: dir => `Панель правил открыта. Файлы правил лежат в ${dir}`,
  found: n => `Найдено правил: ${n}`,
  noneYet: dir => `Правил пока нет. Положи .md файлы в ${dir} или используй /rules save <имя>.`,
  needName: 'Укажи имя: /rules save commits',
  saveAsked: path => `Попросил Claude записать правила в ${path}`,
  notFound: arg => `Правило «${arg}» не найдено. /rules list покажет, какие есть.`,
  autoOn: name => `«${name}» будет включаться само в этой папке проекта.`,
  autoOff: name => `«${name}» больше не включается само в этой папке.`,
  turnedOn: name => `Включено: ${name}`,
  turnedOff: name => `Выключено: ${name}`,
  contextOn: name => `С этого момента в этой сессии действует набор правил «${name}» (он в системном промпте).`,
  contextOff: name => `Набор правил «${name}» в этой сессии больше не действует.`,
  langSet: name => `Язык: ${name}.`,
  langName: 'Русский',
  composeTitle: '# Правила, включённые пользователем для этой сессии',
  composeIntro: 'Пользователь сам включил эти наборы правил. Соблюдай их, пока они здесь.',
  composeSet: (name, text) => `\n## Набор «${name}»\n${text}`,
  editHint: 'Enter — сохранить, Shift+Enter — новая строка.',
  save: 'Сохранить',
  cancel: 'Отмена',
  edit: '✏️ Изменить',
  none: 'Правил пока нет.',
  noneHint: 'Создай набор ниже или попроси Claude записать правила из этой сессии.',
  auto: '★ авто',
  notAuto: '☆ авто',
  hide: '▾ скрыть',
  show: '▸ показать',
  createManual: 'Новый набор вручную',
  createManualPlaceholder: 'например: стиль кода',
  create: 'Создать',
  createFromSession: 'Новый набор из этой сессии (запишет Claude)',
  createFromSessionPlaceholder: 'например: commits',
  record: 'Записать',
  openFolder: '📂 Папка с правилами',
  reload: 'Перечитать',
  crabButton: '🦀 Лимиты',
  files: dir => `Файлы: ${dir}`,
  legend: '● — действует в этой сессии · ★ авто — включается само в этой папке',
}

export const STRINGS: Record<Lang, Dict> = { en: EN, ru: RU }

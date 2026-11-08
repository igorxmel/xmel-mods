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

// ---------- краб: настроения, занятия, время суток ----------

export type Mood = 'chill' | 'busy' | 'sweaty' | 'saving' | 'asleep' | 'weekOut' | 'unknown'
export type Activity = 'walk' | 'coding' | 'coffee' | 'dance' | 'wave' | 'reading'
export type DayPart = 'night' | 'morning' | 'day' | 'evening'

type PhraseSet = {
  mood: Record<Mood, readonly string[]>
  working: readonly string[]
  activity: Partial<Record<Activity, readonly string[]>>
  day: Record<DayPart, readonly string[]>
}

const PHRASES_EN: PhraseSet = {
  mood: {
    chill: [
      'Plenty in the tank, claws are itching to work',
      'Calm sea, calm limits',
      'Feel free to take on something big',
      'Click-clack! I’m ready',
      'Fresh as a morning tide',
    ],
    busy: [
      'Halfway through, still going strong',
      'Nice steady pace',
      'Claws at work, plenty left',
      'Scuttling sideways, but confidently',
      'Not speeding up, not slowing down',
    ],
    sweaty: [
      'Phew… the 5-hour limit is almost gone, maybe go easy?',
      'Claws are smoking, a break is coming',
      'A little more and the 5-hour limit runs out',
      'Great time for small tasks',
      'Sweating, but holding on until the reset',
    ],
    saving: [
      'Free right now, but the week is nearly eaten — let’s pace ourselves',
      'The 5-hour limit is fine, but stretch the week',
      'We’ll postpone the heavy stuff until the weekly reset',
      'Short sessions, light models — the week will thank you',
      'Tiptoeing: the weekly limit is running low',
    ],
    asleep: [
      'The 5-hour limit is gone. Sleeping until the reset… zZz',
      'The tide went out, waiting for the next one… zZz',
      'Claws are resting until the reset',
      'Break time! A good moment to stretch your back',
    ],
    weekOut: [
      'The week is over. Hibernating… zZz',
      'I’m in my burrow until the weekly reset',
      'Weekly limit is done — resting with a clear conscience',
    ],
    unknown: ['Numbers will arrive after the first reply', 'Sniffing out the limits…'],
  },
  working: [
    'Coding together with Claude…',
    'Tap-tap on the keys',
    'Compiling thoughts',
    'Almost done, hold on',
  ],
  activity: {
    coffee: ['Coffee break, limits can wait', 'Sea cappuccino is the best'],
    dance: ['Dancing while there’s budget!', 'Crab disco 🕺'],
    wave: ['Hi! 👋', 'I’m here if you need me'],
    reading: ['Reading the docs while it’s quiet', 'Studying how to spend less'],
  },
  day: {
    morning: [
      'Good morning! Limits fresh as a sea breeze',
      'Morning coffee and the first commit',
      'The sun is rising — claws are waking up',
    ],
    day: [
      'Noon, prime working time',
      'Sun at its peak, code in progress',
      'Crabs are especially productive by day',
    ],
    evening: [
      'Beautiful sunset. Maybe time to wrap up?',
      'Evening tide — time for a review',
      'A couple more tasks and off to the sand',
    ],
    night: [
      'Night, stars, code… romantic',
      'Owls code, crabs too',
      'Getting late. Sleep is good for code too',
      'The moon is out — limits are resting',
    ],
  },
}

const PHRASES_RU: PhraseSet = {
  mood: {
    chill: [
      'Запаса полно, клешни чешутся поработать',
      'Море спокойное, лимиты тоже',
      'Можно смело браться за большое',
      'Щёлк-щёлк! Я готов',
      'Свежий, как утренний прилив',
    ],
    busy: [
      'Половина позади, но я ещё бодр',
      'Работаем в хорошем темпе',
      'Клешни в деле, запас ещё есть',
      'Бегу боком, но уверенно',
      'Не разгоняемся, но и не тормозим',
    ],
    sweaty: [
      'Фух… пятичасовой почти всё, может, полегче?',
      'Клешни дымятся, скоро передышка',
      'Ещё чуть-чуть — и пятичасовой кончится',
      'Самое время для мелких задач',
      'Потею, но держусь до сброса',
    ],
    saving: [
      'Сейчас свободно, но неделя почти съедена — бережём',
      'Пятичасовой в норме, а неделю лучше растянуть',
      'Тяжёлое отложим до сброса недели',
      'Короткие сессии, лёгкие модели — неделя скажет спасибо',
      'Иду на цыпочках: недельный лимит на исходе',
    ],
    asleep: [
      'Пятичасовой всё. Сплю до сброса… zZz',
      'Прилив ушёл, жду следующего… zZz',
      'Клешни отдыхают до сброса',
      'Перерыв! Самое время размять спину',
    ],
    weekOut: [
      'Неделя закончилась. Впадаю в спячку… zZz',
      'До сброса недели я в норке',
      'Недельный всё — отдыхаем с чистой совестью',
    ],
    unknown: ['Цифры придут после первого ответа', 'Принюхиваюсь к лимитам…'],
  },
  working: ['Кодю вместе с Claude…', 'Тук-тук по клавишам', 'Компилирую мысли', 'Щас-щас, почти готово'],
  activity: {
    coffee: ['Кофе-брейк, лимиты подождут', 'Морской капучино — лучший'],
    dance: ['Танцую, пока запас есть!', 'Краб-диско 🕺'],
    wave: ['Привет! 👋', 'Я тут, если что'],
    reading: ['Читаю документацию, пока тихо', 'Изучаю, как расходовать меньше'],
  },
  day: {
    morning: [
      'Доброе утро! Лимиты свежие, как бриз',
      'Утренний кофе и первый коммит',
      'Солнце встаёт — клешни просыпаются',
    ],
    day: ['Полдень, самое рабочее время', 'Солнце в зените, код в процессе', 'Днём крабы особенно продуктивны'],
    evening: [
      'Закат красивый. Может, пора закругляться?',
      'Вечерний прилив — время для ревью',
      'Ещё пару задач — и на песочек',
    ],
    night: [
      'Ночь, звёзды, код… романтика',
      'Совы кодят, крабы тоже',
      'Поздновато. Сон тоже полезен для кода',
      'Луна светит — лимиты отдыхают',
    ],
  },
}

export const PHRASES: Record<Lang, PhraseSet> = { en: PHRASES_EN, ru: PHRASES_RU }

// ---------- остальные тексты ----------

const EN = {
  paneTitle: '🦀 Limits',
  statusLine: (p5: string, p7: string) => `🦀 5h ${p5} · wk ${p7}`,
  noData: 'no data',
  resetUnknown: 'reset time unknown',
  resetDone: 'already reset',
  resetsIn: (span: string, when: string) => `resets in ${span} (${when})`,
  units: { d: 'd', h: 'h', m: 'm' },
  days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  windows: {
    five_hour: '5 hours',
    seven_day: 'Week',
    seven_day_opus: 'Week Opus',
    seven_day_sonnet: 'Week Sonnet',
  } as Record<string, string>,
  noFolder: 'no folder',
  connector: 'connector',
  noTools: 'no tools (text only)',
  unknownModel: 'unknown',
  noPrompt: '(no text)',
  cmdDescription: 'Usage crab: 5 hours, week and where the usage went',
  cmdArgumentHint: '[lang en|ru]',
  cmdOpened: 'The crab is on duty.',
  langSet: (name: string) => `Language: ${name}.`,
  langName: 'English',
  crabAlt: (saying: string) => `Crab: ${saying}`,
  pinOn: '📌 opens at startup',
  pinOff: '📍 open at startup',
  refresh: '↻ Refresh',
  updatedAgo: (min: number) => `updated ${min} min ago`,
  autoEvery: ' · auto every 5 min',
  noteBackoff: (hhmm: string) =>
    `The server asks to poll less often, waiting until ${hhmm}. Numbers come from model replies for now.`,
  noteBackoffLeft: (min: number) =>
    `The server asked to wait, ~${min} more min. Numbers come from model replies for now.`,
  noteNoTraffic:
    'Not polling myself: CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC is set. ' +
    'Numbers update after model replies and are shared across sessions.',
  noteNoSubscription: 'not polling: this session is not on a subscription',
  notePollStatus: (status: number) => `poll failed: status ${status}`,
  notePollEmpty: 'poll: no limits in the response',
  notePollError: (why: string) => `poll failed: ${why}`,
  whereItWent: 'Where it went',
  over: 'Over:',
  by: 'By:',
  win5h: '5 hours',
  win7d: 'Week',
  byProject: 'Projects',
  byModel: 'Models',
  byTool: 'Tools',
  byTop: 'Heaviest',
  emptyLog: 'Nothing yet: tracking starts with a reply in any session that has this mod.',
  emptyWindow: 'Nothing spent in this window yet.',
  subShort: 'sub.',
  calls: 'calls',
  requests: 'req.',
  total: (n: number) => `Total ${n} req.`,
  subagentTurns: (n: number) => ` · ${n} subagent turns`,
  tokens: (i: string, o: string, cw: string, cr: string) =>
    `Tokens: in ${i} · out ${o} · cache write ${cw} · cache read ${cr}`,
  footnote:
    'The share is based on token cost: an expensive model and a long context use up the limit faster. ' +
    'No money is charged. Only sessions with this mod are counted.',
  rulesButton: '📏 Session rules',
  bandFive: '5h',
  bandWeek: 'wk',
  bandDetails: '🦀 Details',
  bandRules: '📏 Rules',
  bandReset: (span: string) => `↻ ${span}`,
  paceEarly: 'Pace: too early to tell',
  paceOk: (elapsed: number, proj: number) =>
    `On track: ${elapsed}% of the window gone, ~${proj}% by reset`,
  paceTight: (elapsed: number, proj: number) =>
    `Tight: ${elapsed}% of the window gone, ~${proj}% by reset`,
  paceOver: (elapsed: number, early: string, at: string) =>
    `Runs out ~${early} before reset (around ${at}): ${elapsed}% of the window gone`,
  paceLegend:
    '│ marks where even use would be by now. The forecast assumes the current pace holds.',
}

export type Dict = typeof EN

const RU: Dict = {
  paneTitle: '🦀 Лимиты',
  statusLine: (p5, p7) => `🦀 5ч ${p5} · нед ${p7}`,
  noData: 'нет данных',
  resetUnknown: 'время сброса неизвестно',
  resetDone: 'уже сбросился',
  resetsIn: (span, when) => `сброс через ${span} (${when})`,
  units: { d: 'д', h: 'ч', m: 'м' },
  days: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
  windows: {
    five_hour: '5 часов',
    seven_day: 'Неделя',
    seven_day_opus: 'Нед. Opus',
    seven_day_sonnet: 'Нед. Sonnet',
  },
  noFolder: 'без папки',
  connector: 'коннектор',
  noTools: 'без инструментов (только текст)',
  unknownModel: 'неизвестно',
  noPrompt: '(без текста)',
  cmdDescription: 'Краб с лимитами: 5 часов, неделя и на что ушёл расход',
  cmdArgumentHint: '[lang en|ru]',
  cmdOpened: 'Краб на посту.',
  langSet: name => `Язык: ${name}.`,
  langName: 'Русский',
  crabAlt: saying => `Краб: ${saying}`,
  pinOn: '📌 открывается при запуске',
  pinOff: '📍 открывать при запуске',
  refresh: '↻ Обновить',
  updatedAgo: min => `обновлено ${min} мин назад`,
  autoEvery: ' · само раз в 5 мин',
  noteBackoff: hhmm => `Сервер просит спрашивать реже, жду до ${hhmm}. Цифры пока из ответов модели.`,
  noteBackoffLeft: min => `Сервер просил подождать, ещё ~${min} мин. Цифры пока из ответов модели.`,
  noteNoTraffic:
    'Сам не опрашиваю: в настройках включён CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. ' +
    'Цифры обновляются после ответов модели и общие для всех сессий.',
  noteNoSubscription: 'сам не опрашиваю: сессия не через подписку',
  notePollStatus: status => `опрос не удался: ответ ${status}`,
  notePollEmpty: 'опрос: в ответе нет лимитов',
  notePollError: why => `опрос не удался: ${why}`,
  whereItWent: 'На что ушло',
  over: 'За:',
  by: 'По:',
  win5h: '5 часов',
  win7d: 'Неделя',
  byProject: 'Проекты',
  byModel: 'Модели',
  byTool: 'Инструменты',
  byTop: 'Самые тяжёлые',
  emptyLog: 'Пока пусто: учёт начнётся с ответа в любой сессии с этим модом.',
  emptyWindow: 'В этом окне ещё ничего не потрачено.',
  subShort: 'сабаг.',
  calls: 'выз.',
  requests: 'запр.',
  total: n => `Всего ${n} запр.`,
  subagentTurns: n => ` · ${n} ходов сабагентов`,
  tokens: (i, o, cw, cr) => `Токены: ввод ${i} · вывод ${o} · кэш-запись ${cw} · кэш-чтение ${cr}`,
  footnote:
    'Доля считается по стоимости токенов: дорогая модель и длинный контекст съедают лимит быстрее. ' +
    'Никаких денег не списывается. Учитываются только сессии с этим модом.',
  rulesButton: '📏 Правила сессии',
  bandFive: '5ч',
  bandWeek: 'нед',
  bandDetails: '🦀 Подробнее',
  bandRules: '📏 Правила',
  bandReset: span => `↻ ${span}`,
  paceEarly: 'Темп: пока рано судить',
  paceOk: (elapsed, proj) => `В графике: прошло ${elapsed}% окна, к сбросу выйдет ~${proj}%`,
  paceTight: (elapsed, proj) => `Впритык: прошло ${elapsed}% окна, к сбросу выйдет ~${proj}%`,
  paceOver: (elapsed, early, at) =>
    `Кончится за ~${early} до сброса (около ${at}): прошло ${elapsed}% окна`,
  paceLegend: '│ — где был бы расход при ровной трате. Прогноз считает, что нынешний темп сохранится.',
}

export const STRINGS: Record<Lang, Dict> = { en: EN, ru: RU }

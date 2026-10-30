import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, SessionRateLimit } from 'claude-code'

import type { By, Entry, Limit, Window } from '../types'

const PANE = 'usage-crab'
const HOUR = 3_600_000
const WINDOW_MS: Record<Window, number> = { '5h': 5 * HOUR, '7d': 7 * 24 * HOUR }
const KEEP_MS = 8 * 24 * HOUR
const KEEP_MAX = 4000
const CRAB = '#D97757'

const limits = atom({ plugin: 'usage-crab', key: 'limits' } as const, [], { shape: 'limits-1' })
const limitsAt = atom({ plugin: 'usage-crab', key: 'limitsAt' } as const, 0)
const log = atom({ plugin: 'usage-crab', key: 'log' } as const, [], { shape: 'log-1' })
const nowAtom = atom({ plugin: 'usage-crab', key: 'now' } as const, 0)
const windowAtom = atom({ plugin: 'usage-crab', key: 'window' } as const, '5h')
const byAtom = atom({ plugin: 'usage-crab', key: 'by' } as const, 'project')
const pollNote = atom({ plugin: 'usage-crab', key: 'pollNote' } as const, '')
/** Идёт ли сейчас ответ Claude в этой сессии: тогда краб кодит. */
const working = atom({ plugin: 'usage-crab', key: 'working' } as const, false)
/** Что открывать при запуске сессии: большую панель, мини-окошко или ничего. */
const pinned = atom({ plugin: 'usage-crab', key: 'pinned' } as const, 'full')
const MINI = 'usage-crab-mini'

async function openView($: Engine, _view: 'full') {
  // Мини-окошко из прошлой версии больше не нужно — закрываем, если висит.
  await $.ui.close({ id: MINI })
  await $.ui.open({ id: PANE, title: '🦀 Лимиты' })
}

async function setPinned($: Engine, value: 'full' | 'none') {
  await update($, pinned, () => value)
  await $.store.set('pinned', value)
}
const POLL_MS = 5 * 60_000
const SYNC_MS = 20_000

// ---------- общие для всех сессий данные ----------
// Лимиты одни на аккаунт, а сессий может быть несколько. Каждая пишет то, что
// узнала, в общий файл и раз в 20 секунд подтягивает из него чужое. Журнал
// расхода — по файлу на сессию, чтобы параллельные сессии не затирали друг друга.

type SharedLimits = { at: number; polledAt: number; backoffUntil?: number; limits: Limit[] }

let sessionId = ''

async function dataDir($: Engine): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return `${home.replace(/\\/g, '/')}/.claude/usage-crab`
}

async function readJson<T>($: Engine, path: string): Promise<T | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return JSON.parse(await $.fs.read(path)) as T
  } catch {
    return undefined
  }
}

async function readShared($: Engine): Promise<SharedLimits> {
  const got = await readJson<SharedLimits>($, `${await dataDir($)}/limits.json`)
  return {
    at: got?.at ?? 0,
    polledAt: got?.polledAt ?? 0,
    backoffUntil: got?.backoffUntil ?? 0,
    limits: Array.isArray(got?.limits) ? got.limits : [],
  }
}

/**
 * Сливает показания разных сессий. Внутри одного окна процент только растёт,
 * поэтому берём наибольший; у окна со сбросом позже — новое окно, берём его.
 */
function mergeLimits(...lists: readonly (readonly Limit[])[]): Limit[] {
  const byKind = new Map<string, Limit>()
  for (const list of lists) {
    for (const l of list) {
      if (!(l.kind in WINDOW_NAMES)) continue
      const cur = byKind.get(l.kind)
      if (!cur) {
        byKind.set(l.kind, l)
        continue
      }
      const a = cur.resetsAt ? Date.parse(cur.resetsAt) : NaN
      const b = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      const sameWindow = Number.isNaN(a) || Number.isNaN(b) || Math.abs(a - b) < 10 * 60_000
      if (sameWindow) {
        byKind.set(l.kind, {
          kind: l.kind,
          percentUsed: Math.max(cur.percentUsed, l.percentUsed),
          resetsAt: cur.resetsAt ?? l.resetsAt,
        })
      } else if (b > a) {
        byKind.set(l.kind, l)
      }
    }
  }
  return [...byKind.values()]
}

const sameLimits = (a: readonly Limit[], b: readonly Limit[]) =>
  JSON.stringify([...a].sort((x, y) => x.kind.localeCompare(y.kind))) ===
  JSON.stringify([...b].sort((x, y) => x.kind.localeCompare(y.kind)))

function showStatus($: Engine, list: readonly Limit[]) {
  const p5 = pick(list, 'five_hour')
  const p7 = pick(list, 'seven_day')
  $.ui.status(`🦀 5ч ${p5 ? pct(p5.percentUsed) : '—'} · нед ${p7 ? pct(p7.percentUsed) : '—'}`)
}

/** Подтягивает в эту сессию то, что узнали другие. */
async function syncFromShared($: Engine) {
  const shared = await readShared($)
  if (shared.limits.length === 0) return
  const cur = await read($, limits)
  const merged = mergeLimits(cur, shared.limits)
  if (!sameLimits(cur, merged)) {
    await update($, limits, () => merged)
    showStatus($, merged)
  }
  if (shared.at > (await read($, limitsAt))) await update($, limitsAt, () => shared.at)
}

async function loadAllLogs($: Engine): Promise<Entry[]> {
  const dir = await dataDir($)
  if (!(await $.fs.exists(dir))) return []
  const now = await $.clock.now()
  const out: Entry[] = []
  for (const f of await $.fs.list(dir)) {
    if (f.kind !== 'file' || !/^log-.*\.json$/.test(f.name) || now - f.mtimeMs > KEEP_MS) continue
    const list = await readJson<Entry[]>($, `${dir}/${f.name}`)
    if (Array.isArray(list)) out.push(...list)
  }
  return out.filter(x => now - x.at < KEEP_MS).sort((a, b) => a.at - b.at)
}

async function syncLog($: Engine) {
  const all = await loadAllLogs($)
  const cur = await read($, log)
  if (all.length !== cur.length || all.at(-1)?.at !== cur.at(-1)?.at) await update($, log, () => all)
}

// ---------- форматирование ----------

const pct = (n: number) => `${Math.round(n)}%`
const tok = (n: number) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`
const DAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']
const pad = (n: number) => String(n).padStart(2, '0')

function untilText(resetsAt: string | undefined, now: number) {
  if (!resetsAt) return 'время сброса неизвестно'
  const at = Date.parse(resetsAt)
  const left = at - now
  if (left <= 0) return 'уже сбросился'
  const d = new Date(at)
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const mins = Math.ceil(left / 60_000)
  const days = Math.floor(mins / 1440)
  const hours = Math.floor((mins % 1440) / 60)
  const m = mins % 60
  const span = days > 0 ? `${days}д ${hours}ч` : hours > 0 ? `${hours}ч ${m}м` : `${m}м`
  const when = left > 20 * HOUR ? `${DAYS[d.getDay()]} ${clock}` : clock
  return `сброс через ${span} (${when})`
}

const bar = (p: number, width: number) => {
  const full = Math.max(0, Math.min(width, Math.round((p / 100) * width)))
  return '█'.repeat(full) + '░'.repeat(width - full)
}
/** Плавный цвет от зелёного (всё свободно) через жёлтый к красному (лимит кончился). */
function gradient(p: number): string {
  const t = Math.min(100, Math.max(0, p)) / 100
  const hue = 130 * (1 - t)
  const sat = 0.7
  const light = 0.5
  const k = (n: number) => (n + hue / 30) % 12
  const a = sat * Math.min(light, 1 - light)
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  const hex = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${hex(f(0))}${hex(f(8))}${hex(f(4))}`
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: '5 часов',
  seven_day: 'Неделя',
  seven_day_opus: 'Нед. Opus',
  seven_day_sonnet: 'Нед. Sonnet',
}
const windowName = (kind: string) => WINDOW_NAMES[kind] ?? kind.replace(/_/g, ' ')

const shortProject = (cwd: string) =>
  /scratch-workspaces/i.test(cwd)
    ? 'без папки'
    : cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd
const shortTool = (t: string) => {
  const m = t.match(/^mcp__(.+?)__/)
  if (!m) return t
  const server = m[1] ?? ''
  return `mcp:${/^[0-9a-f-]{20,}$/i.test(server) ? 'коннектор' : server}`
}
const shortModel = (m: string) =>
  m.replace(/^claude-/, '').replace(/-\d{8}$/, '').replace(/\[.*\]$/, '') || m

// ---------- краб ----------

type Mood = 'chill' | 'busy' | 'sweaty' | 'saving' | 'asleep' | 'weekOut' | 'unknown'

/**
 * Настроение по обоим лимитам. 5-часовой решает, как краб суетится сейчас;
 * недельный — бережётся ли он вообще. Кончился любой — спит.
 */
function moodOf(p5: number | undefined, p7: number | undefined): Mood {
  if (p5 === undefined && p7 === undefined) return 'unknown'
  const h = p5 ?? 0
  const w = p7 ?? 0
  if (w >= 100) return 'weekOut'
  if (h >= 100) return 'asleep'
  if (h >= 80) return 'sweaty'
  if (w >= 80) return 'saving'
  if (h >= 50 || w >= 60) return 'busy'
  return 'chill'
}

const PHRASES: Record<Mood, readonly string[]> = {
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
  unknown: [
    'Цифры придут после первого ответа',
    'Принюхиваюсь к лимитам…',
  ],
}

/** Фраза меняется раз в пару минут, у каждого окна краба своя последовательность. */
function phraseOf(mood: Mood, now: number): string {
  const list = PHRASES[mood]
  const slot = Math.floor(now / 120_000)
  return list[((slot % list.length) + list.length) % list.length] ?? list[0]!

}

// Клод в пикселях: X — тело, E — глаз, A — клешня, L — нога, . — пусто
const CRAB_GRID = [
  '.XXXXXXXXX.',
  '.XEXXXXXEX.',
  'AXXXXXXXXXA',
  '.XXXXXXXXX.',
  '.L.L...L.L.',
]

type CrabMotion = {
  /** Перебежка вбок: размах в пикселях и период. */
  scuttle: number
  scuttleDur: number
  /** Шаг ног и щелчки клешнями. */
  stepDur: number
  snapDur: number
  /** Мелкая дрожь поверх перебежки. */
  tremble: boolean
}

const MOTION: Record<Mood, CrabMotion> = {
  chill: { scuttle: 10, scuttleDur: 4, stepDur: 0.5, snapDur: 3, tremble: false },
  busy: { scuttle: 14, scuttleDur: 2.2, stepDur: 0.3, snapDur: 1.4, tremble: false },
  sweaty: { scuttle: 6, scuttleDur: 1.6, stepDur: 0.2, snapDur: 0.8, tremble: true },
  // Бережётся: ходит медленно и мелко, клешнями щёлкает редко.
  saving: { scuttle: 4, scuttleDur: 6, stepDur: 0.9, snapDur: 6, tremble: false },
  asleep: { scuttle: 0, scuttleDur: 1, stepDur: 0, snapDur: 0, tremble: false },
  weekOut: { scuttle: 0, scuttleDur: 1, stepDur: 0, snapDur: 0, tremble: false },
  unknown: { scuttle: 4, scuttleDur: 5, stepDur: 0.8, snapDur: 4, tremble: false },
}

const loop = 'repeatCount="indefinite"'

/** Чем краб занят между делами. Меняется раз в минуту; пока Claude отвечает — кодит. */
type Activity = 'walk' | 'coding' | 'coffee' | 'dance' | 'wave' | 'reading'

const ACTIVITIES: Record<Mood, readonly Activity[]> = {
  chill: ['walk', 'coffee', 'dance', 'wave', 'reading', 'walk', 'coding'],
  busy: ['walk', 'coding', 'coffee', 'walk', 'reading'],
  sweaty: ['walk', 'coding', 'walk'],
  saving: ['walk', 'reading', 'coffee'],
  asleep: ['walk'],
  weekOut: ['walk'],
  unknown: ['walk', 'wave'],
}

function activityOf(mood: Mood, now: number, isWorking: boolean): Activity {
  if (mood === 'asleep' || mood === 'weekOut') return 'walk'
  if (isWorking) return 'coding'
  const list = ACTIVITIES[mood]
  return list[Math.floor(now / 60_000) % list.length] ?? 'walk'
}

const WORKING_PHRASES = [
  'Кодю вместе с Claude…',
  'Тук-тук по клавишам',
  'Компилирую мысли',
  'Щас-щас, почти готово',
]

const ACTIVITY_PHRASES: Partial<Record<Activity, readonly string[]>> = {
  coffee: ['Кофе-брейк, лимиты подождут', 'Морской капучино — лучший'],
  dance: ['Танцую, пока запас есть!', 'Краб-диско 🕺'],
  wave: ['Привет! 👋', 'Я тут, если что'],
  reading: ['Читаю документацию, пока тихо', 'Изучаю, как расходовать меньше'],
}

/** Фраза: когда Claude работает — про работу, иначе про занятие или настроение. */
type DayPart = 'night' | 'morning' | 'day' | 'evening'

/** Время суток по часам этого компьютера. */
function dayPartOf(now: number): DayPart {
  const h = new Date(now).getHours()
  if (h >= 5 && h < 11) return 'morning'
  if (h >= 11 && h < 17) return 'day'
  if (h >= 17 && h < 22) return 'evening'
  return 'night'
}

const DAY_PHRASES: Record<DayPart, readonly string[]> = {
  morning: [
    'Доброе утро! Лимиты свежие, как бриз',
    'Утренний кофе и первый коммит',
    'Солнце встаёт — клешни просыпаются',
  ],
  day: [
    'Полдень, самое рабочее время',
    'Солнце в зените, код в процессе',
    'Днём крабы особенно продуктивны',
  ],
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
}

function sayingOf(mood: Mood, activity: Activity, now: number, isWorking: boolean): string {
  const slot = Math.floor(now / 120_000)
  const from = (list: readonly string[]) => list[slot % list.length] ?? list[0]!
  if (isWorking && mood !== 'asleep' && mood !== 'weekOut') return from(WORKING_PHRASES)
  // Про лимиты важнее: в тревожных настроениях говорим о них, а не о кофе.
  const isCalm = mood === 'chill' || mood === 'busy'
  const own = ACTIVITY_PHRASES[activity]
  // Спокойный краб по очереди говорит о времени суток, о занятии и о лимитах.
  if (isCalm) {
    if (slot % 3 === 0) return from(DAY_PHRASES[dayPartOf(now)])
    if (slot % 3 === 1 && own) return from(own)
  }
  return phraseOf(mood, now)
}

/** Фон: небо, светило, море и песок — по времени суток. */
function sceneSvg(part: DayPart, x: number, y: number, vw: number, vh: number): string {
  const SKY: Record<DayPart, [string, string]> = {
    morning: ['#f6b38a', '#9cc9e8'],
    day: ['#5aa7e0', '#a9d6f5'],
    evening: ['#3b2b5a', '#e0805a'],
    night: ['#0b1330', '#1f2b52'],
  }
  const [top, bottom] = SKY[part]
  const id = `sky-${part}`
  const ground = y + vh - 8
  const sea = ground - 6
  let sky = ''
  if (part === 'night') {
    const stars = [[-20, -22], [8, -14], [30, -24], [62, -18], [96, -25], [120, -12], [-8, -4], [134, -2], [48, -8]]
    sky =
      stars
        .map(
          ([sx, sy], i) =>
            `<rect x="${sx}" y="${sy}" width="2" height="2" fill="#fff"><animate attributeName="opacity" values="1;0.2;1" dur="${2 + (i % 3)}s" begin="${i * 0.3}s" ${loop}/></rect>`,
        )
        .join('') +
      // Месяц: круг с вырезом цветом неба.
      `<circle cx="118" cy="-16" r="7" fill="#f3f0d0"/><circle cx="121" cy="-18" r="6" fill="${top}"/>`
  } else if (part === 'evening') {
    sky = `<circle cx="112" cy="${sea}" r="11" fill="#ffb366" opacity="0.9"/>`
  } else {
    const sx = part === 'morning' ? -12 : 110
    const sy = part === 'morning' ? -6 : -18
    sky =
      `<circle cx="${sx}" cy="${sy}" r="8" fill="#ffe27a"><animate attributeName="r" values="8;9;8" dur="4s" ${loop}/></circle>` +
      // Облачко медленно плывёт.
      `<g opacity="0.85"><animateTransform attributeName="transform" type="translate" values="0 0;30 0;0 0" dur="40s" ${loop}/>` +
      `<rect x="20" y="-22" width="22" height="5" fill="#fff"/><rect x="25" y="-26" width="12" height="4" fill="#fff"/></g>`
  }
  const water = part === 'night' ? '#16325a' : part === 'evening' ? '#5b4a7a' : '#3f8fcf'
  const wave = part === 'night' ? '#2c4f80' : '#8cc8f0'
  const sand = part === 'night' ? '#4a4030' : part === 'evening' ? '#b98a5e' : '#e8cf96'
  return (
    `<defs><linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient></defs>` +
    `<rect x="${x}" y="${y}" width="${vw}" height="${vh}" rx="6" fill="url(#${id})" shape-rendering="auto"/>` +
    sky +
    `<rect x="${x}" y="${sea}" width="${vw}" height="6" fill="${water}"/>` +
    `<g><animateTransform attributeName="transform" type="translate" values="0 0;6 0;0 0" dur="3s" ${loop}/>` +
    [0, 1, 2, 3, 4, 5].map(i => `<rect x="${x + 6 + i * 28}" y="${sea}" width="10" height="2" fill="${wave}"/>`).join('') +
    `</g><rect x="${x}" y="${ground}" width="${vw}" height="8" fill="${sand}"/>`
  )
}

function crabSvg(mood: Mood, activity: Activity = 'walk', scale = 1, now = Date.now()): string {
  const px = 10
  const w = CRAB_GRID[0]!.length * px
  const h = CRAB_GRID.length * px
  const m = MOTION[mood]
  const isAsleep = mood === 'asleep' || mood === 'weekOut'
  const isStill = activity !== 'walk' && activity !== 'dance'
  const body: string[] = []
  const eyes: string[] = []
  const claws: string[] = []
  const legs: string[] = []
  const cell = (x: number, y: number) =>
    `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${CRAB}"/>`
  const lift = (values: string, dur: number, begin = 0) =>
    `<animateTransform attributeName="transform" type="translate" values="${values}" dur="${dur}s" begin="${begin}s" ${loop}/>`

  CRAB_GRID.forEach((row, y) =>
    [...row].forEach((c, x) => {
      if (c === '.') return
      if (c === 'A') {
        const isLeft = x === 0
        let anim = ''
        if (activity === 'coding') {
          // Стучит по клавишам: клешни быстро и вразнобой.
          anim = lift('0 0;0 -3;0 0', mood === 'sweaty' ? 0.16 : 0.26, isLeft ? 0 : 0.11)
        } else if (activity === 'wave' && !isLeft) {
          anim = lift('0 0;0 -16;0 -9;0 -16;0 -9;0 0;0 0', 1.8)
        } else if (activity === 'coffee' && !isLeft) {
          // Подносит кружку ко рту раз в несколько секунд.
          anim = `<animateTransform attributeName="transform" type="translate" values="0 0;0 0;-6 -12;-6 -12;0 0" keyTimes="0;0.6;0.7;0.85;1" dur="4s" ${loop}/>`
        } else if (activity === 'reading') {
          anim = ''
        } else if (activity === 'dance') {
          anim = lift('0 0;0 -10;0 0', 0.5, isLeft ? 0 : 0.25)
        } else if (m.snapDur) {
          anim = `<animateTransform attributeName="transform" type="translate" values="0 0;0 0;0 -6;0 0;0 -6;0 0" keyTimes="0;0.55;0.65;0.75;0.85;1" dur="${m.snapDur}s" begin="${isLeft ? 0 : m.snapDur / 2}s" ${loop}/>`
        }
        claws.push(`<g>${anim}${cell(x, y)}</g>`)
        return
      }
      if (c === 'L') {
        const isEven = x === 1 || x === 7
        const step = activity === 'dance' ? 0.25 : isStill ? 0 : m.stepDur
        const anim = step ? lift('0 0;0 -3;0 0', step * 2, isEven ? 0 : step) : ''
        legs.push(`<g>${anim}${cell(x, y)}</g>`)
        return
      }
      body.push(cell(x, y))
      if (c === 'E') {
        const ex = x * px + 2
        const ey = y * px
        if (isAsleep) {
          eyes.push(`<rect x="${x * px}" y="${ey + 6}" width="${px}" height="2" fill="#1f1f1f"/>`)
          return
        }
        const ew = mood === 'sweaty' ? px - 2 : px - 4
        // Читает — глаза бегают по строчкам; кодит — смотрят вниз, в экран.
        const look =
          activity === 'reading'
            ? lift('0 0;-2 2;2 2;-2 2;2 2;0 0', 3)
            : activity === 'coding'
              ? lift('0 2;1 2;0 2', 1.2)
              : ''
        eyes.push(
          `<g>${look}<rect x="${mood === 'sweaty' ? ex - 1 : ex}" y="${ey}" width="${ew}" height="${px}" fill="#1f1f1f">` +
            `<animate attributeName="height" values="${px};${px};1;${px}" keyTimes="0;0.9;0.95;1" dur="3.7s" ${loop}/>` +
            `<animate attributeName="y" values="${ey};${ey};${ey + px / 2};${ey}" keyTimes="0;0.9;0.95;1" dur="3.7s" ${loop}/>` +
            `</rect></g>`,
        )
      }
    }),
  )

  // ---------- реквизит ----------
  let front = ''
  let side = ''
  if (activity === 'coding') {
    // Ноутбук спиной к нам: крышка с логотипом и свет экрана на мордочке.
    front =
      `<rect x="20" y="22" width="70" height="26" rx="2" fill="#9aa0a8"/>` +
      `<rect x="20" y="46" width="70" height="4" fill="#6f747b"/>` +
      `<rect x="51" y="31" width="8" height="8" fill="#f4efe6"><animate attributeName="opacity" values="1;0.6;1" dur="2s" ${loop}/></rect>`
    const glow = `<rect x="10" y="8" width="90" height="14" fill="#9fd4ff" opacity="0.08"><animate attributeName="opacity" values="0.04;0.12;0.06;0.1;0.04" dur="1.3s" ${loop}/></rect>`
    const glyphs = ['{', '}', ';', '</>', '()', '=>']
    side =
      glow +
      glyphs
        .map(
          (g, i) =>
            `<text x="${8 + ((i * 19) % 90)}" y="0" font-size="9" font-family="monospace" fill="#8fd18f" opacity="0">${g}` +
            `<animate attributeName="y" values="18;-18" dur="2.4s" begin="${i * 0.4}s" ${loop}/>` +
            `<animate attributeName="opacity" values="0;1;0" dur="2.4s" begin="${i * 0.4}s" ${loop}/></text>`,
        )
        .join('')
  } else if (activity === 'coffee') {
    const steam = [0, 1]
      .map(
        i =>
          `<path d="M${w + 6 + i * 5} 22 q-3 -4 0 -8 q3 -4 0 -8" fill="none" stroke="#bbb" stroke-width="1.5" opacity="0">` +
          `<animate attributeName="opacity" values="0;0.8;0" dur="2s" begin="${i * 0.7}s" ${loop}/>` +
          `<animateTransform attributeName="transform" type="translate" values="0 0;0 -6" dur="2s" begin="${i * 0.7}s" ${loop}/></path>`,
      )
      .join('')
    side =
      `<rect x="${w + 2}" y="28" width="14" height="16" fill="#f2f2f2"/>` +
      `<rect x="${w + 4}" y="30" width="10" height="4" fill="#6b4226"/>` +
      `<rect x="${w + 16}" y="32" width="4" height="8" fill="none" stroke="#f2f2f2" stroke-width="2"/>` +
      steam
  } else if (activity === 'reading') {
    front =
      `<rect x="28" y="22" width="26" height="20" fill="#4a7bd1"/>` +
      `<rect x="56" y="22" width="26" height="20" fill="#4a7bd1"/>` +
      `<rect x="30" y="24" width="22" height="16" fill="#f4efe6"/>` +
      `<rect x="58" y="24" width="22" height="16" fill="#f4efe6"/>` +
      [27, 31, 35]
        .map(y => `<rect x="33" y="${y}" width="16" height="1.5" fill="#999"/><rect x="61" y="${y}" width="16" height="1.5" fill="#999"/>`)
        .join('') +
      // Иногда перелистывает страницу.
      `<rect x="56" y="22" width="26" height="20" fill="#f4efe6" opacity="0">` +
      `<animate attributeName="opacity" values="0;0;0.9;0" keyTimes="0;0.85;0.92;1" dur="5s" ${loop}/></rect>`
  } else if (activity === 'dance') {
    side = ['♪', '♫', '♪']
      .map(
        (n, i) =>
          `<text x="${i === 1 ? w + 4 : -14 + i * 4}" y="0" font-size="13" fill="#c9a0ff" opacity="0">${n}` +
          `<animate attributeName="y" values="20;-16" dur="2s" begin="${i * 0.6}s" ${loop}/>` +
          `<animate attributeName="opacity" values="0;1;0" dur="2s" begin="${i * 0.6}s" ${loop}/></text>`,
      )
      .join('')
  } else if (activity === 'wave') {
    side =
      `<g opacity="0"><animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.6;1" dur="3.6s" ${loop}/>` +
      `<rect x="${w - 2}" y="-22" width="26" height="14" rx="3" fill="#f4efe6"/>` +
      `<text x="${w + 2}" y="-12" font-size="9" font-family="monospace" fill="#333">hi!</text></g>`
  }

  const crab = `${body.join('')}${eyes.join('')}${claws.join('')}${legs.join('')}`
  const tremble = m.tremble
    ? lift('0 0;1 0;-1 0;0 1;0 0', 0.15)
    : ''
  const moving =
    activity === 'dance'
      ? lift('0 0;0 -6;0 0;6 0;0 -6;0 0;-6 0;0 0', 1.6)
      : !isStill && m.scuttle
        ? lift(`0 0;${m.scuttle} 0;0 0;${-m.scuttle} 0;0 0`, m.scuttleDur)
        : ''
  const breathe = isAsleep || isStill ? lift('0 0;0 -1;0 0', isAsleep ? 3 : 2) : ''

  let extra = ''
  if (mood === 'sweaty') {
    extra = [0, 0.5]
      .map(
        (delay, i) =>
          `<circle cx="${i ? -6 : w + 6}" cy="0" r="3" fill="#5BA4E6" opacity="0">` +
          `<animate attributeName="cy" values="2;${h}" dur="1s" begin="${delay}s" ${loop}/>` +
          `<animate attributeName="opacity" values="1;0" dur="1s" begin="${delay}s" ${loop}/></circle>`,
      )
      .join('')
  } else if (isAsleep) {
    extra = ['z', 'z', 'Z']
      .map(
        (ch, i) =>
          `<text x="${w - 4 + i * 6}" y="0" font-size="${10 + i * 3}" font-family="monospace" fill="#999" opacity="0">${ch}` +
          `<animate attributeName="y" values="4;-20" dur="3s" begin="${i}s" ${loop}/>` +
          `<animate attributeName="opacity" values="0;1;0" dur="3s" begin="${i}s" ${loop}/></text>`,
      )
      .join('')
  } else if (mood === 'chill' && activity === 'walk') {
    extra =
      `<circle cx="${w / 2}" cy="0" r="3" fill="none" stroke="#7fb8e6" stroke-width="1.5" opacity="0">` +
      `<animate attributeName="cy" values="0;-20" dur="2.5s" begin="1s" ${loop}/>` +
      `<animate attributeName="opacity" values="0;0.9;0" dur="2.5s" begin="1s" ${loop}/></circle>`
  }

  const pad = 28
  const vw = w + pad * 2
  const vh = h + 36
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} -28 ${vw} ${vh}" width="${Math.round(vw * scale)}" height="${Math.round(vh * scale)}" shape-rendering="crispEdges">` +
    sceneSvg(dayPartOf(now), -pad, -28, vw, vh) +
    `<g>${moving}<g>${tremble}${breathe}${crab}</g>${front}</g>${side}${extra}</svg>`
  )
}

function crabText(mood: Mood): string[] {
  const isAsleep = mood === 'asleep' || mood === 'weekOut'
  const eyes = isAsleep ? '▐▀███▀▌' : '▐▛███▜▌'
  const side = mood === 'sweaty' ? ' 💦' : mood === 'saving' ? ' ⏳' : isAsleep ? ' zZz' : ''
  return [` ${eyes}${side}`, '▝▜█████▛▘', '  ▘▘ ▝▝']
}

// ---------- учёт ----------

type Acc = {
  baseUsd: number
  base5: number
  base7: number
  prompt: string
  model: string
  inTok: number
  outTok: number
  cacheRead: number
  cacheWrite: number
  tools: Record<string, number>
  subagents: number
}

const pick = (list: readonly SessionRateLimit[] | readonly Limit[], kind: string) =>
  list.find(l => l.kind === kind)

async function saveLimits($: Engine, list: readonly SessionRateLimit[]) {
  if (list.length === 0) return
  const incoming: Limit[] = list.map(l => ({ kind: l.kind, percentUsed: l.percentUsed, resetsAt: l.resetsAt }))
  return saveMerged($, incoming, false)
}

async function saveMerged($: Engine, incoming: readonly Limit[], isPoll: boolean) {
  const at = await $.clock.now()
  const shared = await readShared($)
  // Опрос сервера — самый точный источник: его цифры текущего окна главнее.
  const merged = isPoll
    ? mergeLimits(
        mergeLimits(await read($, limits), shared.limits).filter(l => !incoming.some(i => i.kind === l.kind)),
        incoming,
      )
    : mergeLimits(await read($, limits), shared.limits, incoming)
  await update($, limits, () => merged)
  await update($, limitsAt, () => at)
  await $.fs.write(
    `${await dataDir($)}/limits.json`,
    JSON.stringify({
      at,
      polledAt: isPoll ? at : shared.polledAt,
      backoffUntil: isPoll ? 0 : shared.backoffUntil,
      limits: merged,
    } satisfies SharedLimits),
  )
  if (isPoll) await update($, pollNote, () => '')
  showStatus($, merged)
}

// Тот же запрос, которым Claude Code заполняет /usage. Идёт через вход сессии:
// токен подставляет движок, мод его не видит. Эндпоинт недокументированный —
// при сбое остаются цифры из ответов модели.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** Сервер ответил «слишком часто»: все сессии ждут, кнопка тоже. */
async function backOff($: Engine, ms: number) {
  const until = (await $.clock.now()) + ms
  const shared = await readShared($)
  await $.fs.write(`${await dataDir($)}/limits.json`, JSON.stringify({ ...shared, backoffUntil: until }))
  const d = new Date(until)
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  await update($, pollNote, () => `Сервер просит спрашивать реже, жду до ${hhmm}. Цифры пока из ответов модели.`)
}

async function pollLimits($: Engine, isForced = false): Promise<void> {
  try {
    const shared = await readShared($)
    const now = await $.clock.now()
    if ((shared.backoffUntil ?? 0) > now) {
      await syncFromShared($)
      if (isForced) {
        const left = Math.ceil(((shared.backoffUntil ?? 0) - now) / 60_000)
        await update($, pollNote, () => `Сервер просил подождать, ещё ~${left} мин. Цифры пока из ответов модели.`)
      }
      return
    }
    // Опрашивает одна сессия на всех: если кто-то спрашивал недавно, берём его ответ.
    // Кнопка тоже не чаще раза в минуту.
    const minGap = isForced ? 60_000 : POLL_MS - 30_000
    if (now - shared.polledAt < minGap) return syncFromShared($)
    // Отмечаем попытку сразу, чтобы другие сессии не полезли следом.
    await $.fs.write(`${await dataDir($)}/limits.json`, JSON.stringify({ ...shared, polledAt: now }))
    if (await $.env.get('CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC')) {
      await syncFromShared($)
      await update($, pollNote, () =>
        'Сам не опрашиваю: в настройках включён CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC. ' +
        'Цифры обновляются после ответов модели и общие для всех сессий.',
      )
      return
    }
    const auth = await $.session.authorize()
    if (!auth || auth.kind !== 'bearer') {
      await update($, pollNote, () => 'сам не опрашиваю: сессия не через подписку')
      return
    }
    const res = await $.http.fetch(USAGE_URL, {
      auth: auth.handle,
      headers: { 'anthropic-beta': 'oauth-2025-04-20' },
    })
    if (res.status === 429) {
      const header = Object.entries(res.headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]
      const sec = Number(header)
      await backOff($, Number.isFinite(sec) && sec > 0 ? Math.min(sec * 1000, 60 * 60_000) : 15 * 60_000)
      return
    }
    if (!res.ok) {
      await update($, pollNote, () => `опрос не удался: ответ ${res.status}`)
      return
    }
    const body = JSON.parse(res.text) as Record<string, unknown>
    const found: Limit[] = []
    for (const [kind, v] of Object.entries(body)) {
      if (!v || typeof v !== 'object') continue
      const { utilization, resets_at } = v as { utilization?: unknown; resets_at?: unknown }
      if (typeof utilization !== 'number' || !(kind in WINDOW_NAMES)) continue
      found.push({
        kind,
        percentUsed: Math.round(utilization * 10) / 10,
        resetsAt: typeof resets_at === 'string' ? resets_at : undefined,
      })
    }
    if (found.length === 0) {
      await update($, pollNote, () => 'опрос: в ответе нет лимитов')
      return
    }
    await saveMerged($, found, true)
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err)
    await update($, pollNote, () => `опрос не удался: ${why.slice(0, 80)}`)
  }
}

async function appendEntry($: Engine, entry: Entry) {
  const path = `${await dataDir($)}/log-${sessionId}.json`
  const prev = (await readJson<Entry[]>($, path)) ?? []
  const cutoff = entry.at - KEEP_MS
  await $.fs.write(path, JSON.stringify([...prev.filter(e => e.at >= cutoff), entry].slice(-KEEP_MAX)))
  await update($, log, list => [...list.filter(e => e.at >= cutoff), entry])
}

async function fresh($: Engine, lastPrompt: string): Promise<Acc> {
  const u = await $.session.usage()
  return {
    baseUsd: u.cost?.usd ?? 0,
    base5: pick(u.rateLimits, 'five_hour')?.percentUsed ?? 0,
    base7: pick(u.rateLimits, 'seven_day')?.percentUsed ?? 0,
    prompt: lastPrompt,
    model: '',
    inTok: 0,
    outTok: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tools: {},
    subagents: 0,
  }
}

type Row = { label: string; usd: number; p5: number; count: number; tokens: number }

function groupBy(entries: readonly Entry[], by: By): Row[] {
  const rows = new Map<string, Row>()
  const add = (label: string, e: Entry, weight = 1, count = 1) => {
    const r = rows.get(label) ?? { label, usd: 0, p5: 0, count: 0, tokens: 0 }
    r.usd += e.usd * weight
    r.p5 += e.p5 * weight
    r.count += count
    r.tokens += (e.inTok + e.outTok + e.cacheWrite) * weight
    rows.set(label, r)
  }
  for (const e of entries) {
    if (by === 'project') add(e.project, e)
    else if (by === 'model') add(shortModel(e.model), e)
    else if (by === 'tool') {
      const total = Object.values(e.tools).reduce((a, b) => a + b, 0)
      if (total === 0) add('без инструментов (только текст)', e)
      for (const [t, n] of Object.entries(e.tools)) add(shortTool(t), e, n / total, n)
    }
  }
  return [...rows.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens)
}

export const register: Register = on => {
  let acc: Acc | null = null
  let lastPrompt = ''
  let project = ''

  on('session.start', async ($, e, next) => {
    project = shortProject(e.cwd)
    await $.command.register({
      name: 'crab',
      description: 'Краб с лимитами: 5 часов, неделя и на что ушёл расход',
    })

    // Стабилен между перезагрузками мода: момент запуска сессии.
    sessionId = String((await $.session.usage()).startedAt)

    // Журнал прежних версий лежал в $.store — переносим его в файл один раз.
    const legacy = await $.store.get('log')
    if (Array.isArray(legacy) && legacy.length > 0) {
      await $.fs.write(`${await dataDir($)}/log-legacy.json`, JSON.stringify(legacy))
      await $.store.delete('log')
    }
    await syncLog($)
    await syncFromShared($)
    await saveLimits($, (await $.session.usage()).rateLimits)

    const now = await $.clock.now()
    await update($, nowAtom, () => now)
    $.clock.every(SYNC_MS, async () => {
      const t = await $.clock.now()
      await update($, nowAtom, () => t)
      await syncFromShared($)
    })
    $.clock.every(60_000, () => syncLog($))
    // Сами спрашиваем лимиты раз в 5 минут, не дожидаясь ответа модели.
    void pollLimits($)
    $.clock.every(POLL_MS, () => pollLimits($))

    const result = await next(e)
    const saved = await $.store.get('pinned')
    const pin = saved === 'none' ? 'none' : 'full'
    await update($, pinned, () => pin)
    if (e.isInteractive && pin !== 'none') void openView($, 'full')
    return result
  })

  on('command.run', { command: 'crab' }, async $ => {
    await openView($, 'full')
    return { text: 'Краб на посту.' }
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await saveLimits($, e.rateLimits)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    if (!e.isMeta && !e.command) lastPrompt = e.text.replace(/\s+/g, ' ').trim().slice(0, 90)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, working, () => true)
      acc = await fresh($, lastPrompt)
      if (e.text) acc.prompt = e.text.replace(/\s+/g, ' ').trim().slice(0, 90)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (acc) acc.tools[String(e.tool)] = (acc.tools[String(e.tool)] ?? 0) + 1
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) await update($, working, () => false)
    if (!acc) return result
    const u = e.usage
    if (u) {
      acc.inTok += u.input_tokens
      acc.outTok += u.output_tokens
      acc.cacheRead += u.cache_read_input_tokens
      acc.cacheWrite += u.cache_creation_input_tokens
      if (e.agentId === undefined) acc.model = u.model
    }
    if (e.agentId !== undefined) {
      acc.subagents += 1
      return result
    }

    const done = acc
    acc = null
    const usage = await $.session.usage()
    await saveLimits($, usage.rateLimits)
    const entry: Entry = {
      at: await $.clock.now(),
      project,
      model: done.model || 'неизвестно',
      prompt: done.prompt || '(без текста)',
      usd: Math.max(0, (usage.cost?.usd ?? 0) - done.baseUsd),
      p5: Math.max(0, (pick(usage.rateLimits, 'five_hour')?.percentUsed ?? done.base5) - done.base5),
      p7: Math.max(0, (pick(usage.rateLimits, 'seven_day')?.percentUsed ?? done.base7) - done.base7),
      inTok: done.inTok,
      outTok: done.outTok,
      cacheRead: done.cacheRead,
      cacheWrite: done.cacheWrite,
      tools: done.tools,
      subagents: done.subagents,
    }
    if (entry.usd > 0 || entry.inTok + entry.outTok > 0) await appendEntry($, entry)
    return result
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, limits)
    const at = await read($, limitsAt)
    const now = (await read($, nowAtom)) || at
    const entries = await read($, log)
    const win = await read($, windowAtom)
    const by = await read($, byAtom)
    const note = await read($, pollNote)
    const cols = e.props.bodyColumns ?? 40
    const barW = Math.max(8, Math.min(24, cols - 30))

    const l5 = pick(list, 'five_hour')
    const l7 = pick(list, 'seven_day')
    // Если окно уже сбросилось, а свежих цифр ещё нет — показываем 0.
    const live = (l?: Limit) =>
      l && l.resetsAt && Date.parse(l.resetsAt) <= now ? { ...l, percentUsed: 0 } : l
    const v5 = live(l5)
    const v7 = live(l7)
    const mood = moodOf(v5?.percentUsed, v7?.percentUsed)
    const isWorking = await read($, working)
    const activity = activityOf(mood, now, isWorking)
    const saying = sayingOf(mood, activity, now, isWorking)
    const pin = await read($, pinned)

    const limitRow = (name: string, l?: Limit) => (
      <Box flexDirection="column">
        <Text>
          <Text weight="semibold">{name.padEnd(11)}</Text>
          {l ? (
            <Text>
              <Text color={gradient(l.percentUsed)}>{bar(l.percentUsed, barW)}</Text>
              <Text weight="semibold" color={gradient(l.percentUsed)} tabular> {pct(l.percentUsed).padStart(4)}</Text>
            </Text>
          ) : (
            <Text dimColor>нет данных</Text>
          )}
        </Text>
        {l && <Text dimColor>{' '.repeat(11)}{untilText(l.resetsAt, now)}</Text>}
      </Box>
    )

    const crab =
      e.surface === 'terminal' || !('Svg' in ui) ? (
        <Box flexDirection="column">
          {crabText(mood).map(line => (
            <Text color="claude">{line}</Text>
          ))}
        </Box>
      ) : (
        <ui.Svg source={crabSvg(mood, activity, 1, now)} alt={`Краб: ${saying}`} isInteractive />
      )

    // ---- на что ушло ----
    const start =
      (win === '5h' ? l5 : l7)?.resetsAt !== undefined
        ? Date.parse((win === '5h' ? l5 : l7)!.resetsAt!) - WINDOW_MS[win]
        : now - WINDOW_MS[win]
    const inWin = entries.filter(x => x.at >= start)
    const totalUsd = inWin.reduce((a, x) => a + x.usd, 0)
    const totals = inWin.reduce(
      (a, x) => ({
        inTok: a.inTok + x.inTok,
        outTok: a.outTok + x.outTok,
        cacheRead: a.cacheRead + x.cacheRead,
        cacheWrite: a.cacheWrite + x.cacheWrite,
        subagents: a.subagents + x.subagents,
      }),
      { inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, subagents: 0 },
    )
    const nameW = Math.max(10, Math.min(22, cols - 26))
    const share = (v: number) => (totalUsd > 0 ? (v / totalUsd) * 100 : 0)

    const winTab = (value: Window, label: string) => (
      <Button
        key={`window-${value}`}
        variant={win === value ? 'primary' : 'secondary'}
        label={label}
        onPress={() => update($, windowAtom, () => value)}
      />
    )
    const byTab = (value: By, label: string) => (
      <Button
        key={`by-${value}`}
        variant={by === value ? 'primary' : 'secondary'}
        label={label}
        onPress={() => update($, byAtom, () => value)}
      />
    )

    const breakdown =
      inWin.length === 0 ? (
        <Text dimColor>
          {entries.length === 0
            ? 'Пока пусто: учёт начнётся с ответа в любой сессии с этим модом.'
            : 'В этом окне ещё ничего не потрачено.'}
        </Text>
      ) : by === 'top' ? (
        <Box flexDirection="column">
          {[...inWin]
            .sort((a, b) => b.usd - a.usd)
            .slice(0, 8)
            .map(x => (
              <Box flexDirection="column">
                <Text wrap="truncate-end">
                  <Text weight="semibold" color="claude" tabular>{pct(share(x.usd)).padStart(4)} </Text>
                  <Text>{x.project}</Text>
                  <Text dimColor> · {shortModel(x.model)}{x.subagents ? ` · ${x.subagents} сабаг.` : ''}</Text>
                </Text>
                <Text dimColor wrap="truncate-end">        «{x.prompt}»</Text>
              </Box>
            ))}
        </Box>
      ) : (
        <Box flexDirection="column">
          {groupBy(inWin, by)
            .slice(0, 10)
            .map(r => (
              <Text wrap="truncate-end">
                <Text>{(r.label.length > nameW ? r.label.slice(0, nameW - 1) + '…' : r.label).padEnd(nameW)}</Text>
                <Text color="claude"> {bar(share(r.usd), 8)}</Text>
                <Text weight="semibold" tabular> {pct(share(r.usd)).padStart(4)}</Text>
                <Text dimColor tabular> · {by === 'tool' ? `${r.count} выз.` : `${r.count} запр.`}</Text>
              </Text>
            ))}
        </Box>
      )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column" alignItems="flex-start" rowGap={1}>
          {crab}
          <Text italic color="claude">«{saying}»</Text>
          <Box flexDirection="row" columnGap={1} flexWrap="wrap">
            <Button
              key="pin-full"
              plain
              onPress={() => setPinned($, pin === 'full' ? 'none' : 'full')}
            >
              <Text dimColor={pin !== 'full'}>{pin === 'full' ? '📌 открывается при запуске' : '📍 открывать при запуске'}</Text>
            </Button>
          </Box>
        </Box>

        <Box flexDirection="column">
          {limitRow(windowName('five_hour'), v5)}
          {limitRow(windowName('seven_day'), v7)}
          {list
            .filter(l => l.kind !== 'five_hour' && l.kind !== 'seven_day' && l.kind in WINDOW_NAMES)
            .map(l => limitRow(windowName(l.kind), live(l)))}
        </Box>
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" columnGap={1} alignItems="center" flexWrap="wrap">
            <Button key="refresh" label="↻ Обновить" onPress={() => pollLimits($, true)} />
            {at > 0 && (
              <Text dimColor>
                обновлено {Math.max(0, Math.round((now - at) / 60_000))} мин назад
                {note ? '' : ' · само раз в 5 мин'}
              </Text>
            )}
          </Box>
          {note && <Text dimColor>{note}</Text>}
        </Box>

        <Box flexDirection="column" rowGap={1}>
          <Text weight="semibold">На что ушло</Text>
          <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
            <Text dimColor>За:</Text>
            {winTab('5h', '5 часов')}
            {winTab('7d', 'Неделя')}
          </Box>
          <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
            <Text dimColor>По:</Text>
            {byTab('project', 'Проекты')}
            {byTab('model', 'Модели')}
            {byTab('tool', 'Инструменты')}
            {byTab('top', 'Самые тяжёлые')}
          </Box>
        </Box>

        {breakdown}

        {inWin.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor>
              Всего {inWin.length} запр.
              {totals.subagents ? ` · ${totals.subagents} ходов сабагентов` : ''}
            </Text>
            <Text dimColor>
              Токены: ввод {tok(totals.inTok)} · вывод {tok(totals.outTok)} · кэш-запись {tok(totals.cacheWrite)} · кэш-чтение {tok(totals.cacheRead)}
            </Text>
          </Box>
        )}
        <Text dimColor>
          Доля считается по стоимости токенов: дорогая модель и длинный контекст съедают лимит быстрее.
          Никаких денег не списывается. Учитываются только сессии с этим модом.
        </Text>
        <Box flexDirection="row" gap={1}>
          {/* Панель правил открывает мод session-rules по нажатию этой кнопки. */}
          <Button key="open-rules" label="📏 Правила сессии" onPress={() => undefined} />
        </Box>
      </Box>
    )
  })

  // Кнопка «🦀 Лимиты» в панели правил открывает нашу панель.
  on('ui.press', { plugin: 'session-rules', element: 'crab' }, async ($, e, next) => {
    await $.ui.open({ id: PANE, title: '🦀 Лимиты' })
    return next(e)
  })

  // Строка над полем ввода: видна при любой ширине окна. Она общая с другими
  // модами (secret-guard добавляет свою кнопку): берём то, что нарисовали они,
  // и ставим свою часть сверху.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, limits)
    const now = (await read($, nowAtom)) || (await read($, limitsAt))
    const live = (l?: Limit) =>
      l && l.resetsAt && Date.parse(l.resetsAt) <= now ? { ...l, percentUsed: 0 } : l
    const l5 = live(pick(list, 'five_hour'))
    const l7 = live(pick(list, 'seven_day'))
    const cols = e.props.bodyColumns ?? 60
    const isWide = cols >= 70
    const mood = moodOf(l5?.percentUsed, l7?.percentUsed)
    const face =
      mood === 'asleep' || mood === 'weekOut' ? '😴' : mood === 'sweaty' ? '💦' : mood === 'saving' ? '⏳' : '🦀'
    const part = (name: string, l?: Limit) =>
      l ? (
        <Text>
          <Text dimColor>{name} </Text>
          {isWide && <Text color={gradient(l.percentUsed)}>{bar(l.percentUsed, 6)} </Text>}
          <Text weight="semibold" color={gradient(l.percentUsed)}>{pct(l.percentUsed)}</Text>
          {isWide && <Text dimColor> · {untilText(l.resetsAt, now).replace('сброс через ', '↻ ').replace(/ \(.*\)$/, '')}</Text>}
        </Text>
      ) : (
        <Text dimColor>{name} —</Text>
      )

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="row" columnGap={2} rowGap={1} alignItems="center" flexWrap="wrap">
          <Text color="claude">{face}</Text>
          {part('5ч', l5)}
          {part('нед', l7)}
          <Button key="band-crab" label="🦀 Подробнее" onPress={() => openView($, 'full')} />
          <Button key="open-rules" label="📏 Правила" onPress={() => undefined} />
        </Box>
        {below.type === 'engine' ? null : below}
      </Box>
    )
  })
}

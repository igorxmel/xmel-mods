import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const PANE = {
  plugin: 'usage-crab',
  component: 'Pane',
  requestId: 'usage-crab',
  props: {
    title: '🦀 Limits',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-10-30T12:00:00Z')

/** Файлы в памяти: общий файл лимитов и журналы видны всем «сессиям» теста. */
function fakeFs(on: On, files: Record<string, string>) {
  const norm = (e: unknown) => String((e as { path: string }).path).replace(/\\/g, '/')
  mock.env(on, { USERPROFILE: 'C:/u' })
  on('fs.exists', (_, e) => ({ value: norm(e) in files || Object.keys(files).some(f => f.startsWith(norm(e) + '/')) }))
  on('fs.read', (_, e) => ({ value: files[norm(e)] ?? '' }))
  on('fs.write', (_, e) => {
    files[norm(e)] = (e as { text: string }).text
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: Object.keys(files)
      .filter(f => f.startsWith(norm(e) + '/'))
      .map(f => ({ name: f.split('/').pop()!, kind: 'file', size: 1, mtimeMs: NOW, isLink: false })),
  }))
  return files
}

test('панель рисует лимиты, краба и разбивку', async ($, on) => {
  on('state.get', (_, e, next) => {
    const limits = [
      { kind: 'five_hour', percentUsed: 85, resetsAt: '2026-10-30T14:00:00Z' },
      { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-11-03T10:00:00Z' },
    ]
    const log = [
      { at: NOW - 3_600_000, project: 'my-bot', model: 'claude-opus-5-5', prompt: 'почини деплой', usd: 1.5, p5: 4, p7: 1, inTok: 1000, outTok: 2000, cacheRead: 50000, cacheWrite: 3000, tools: { Bash: 3, Edit: 1 }, subagents: 1 },
      { at: NOW - 1_800_000, project: 'my-site', model: 'claude-sonnet-5-5', prompt: 'сделай вёрстку', usd: 0.5, p5: 1, p7: 0, inTok: 500, outTok: 900, cacheRead: 10000, cacheWrite: 1000, tools: {}, subagents: 0 },
    ]
    const values: Record<string, unknown> = {
      limits: { value: { shape: 'limits-1', value: limits }, version: 1 },
      log: { value: { shape: 'log-1', value: log }, version: 1 },
      now: { value: NOW, version: 1 },
      limitsAt: { value: NOW, version: 1 },
    }
    const seeded = values[String((e as { key: string }).key)]
    return seeded ? { value: seeded } : next(e)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /5-hour limit|Claws are smoking|small tasks|Sweating/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /85%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /my-bot/ })).toBeDefined()
    await ui.press({ key: 'by-tool' })
    await ui.press({ key: 'by-top' })
    expect(await ui.find({ type: 'Text', text: /почини деплой/ })).toBeDefined()
    await ui.press({ key: 'by-project' })
    await ui.unmount()
  }
})

test('строка над вводом с кнопками', async ($, on) => {
  // Под модом рисует движок или другой мод: здесь он ничего не добавляет.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  let opened = 0
  on('ui.open', () => (opened++, { value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('state.get', (_, e, next) =>
    String((e as { key: string }).key) === 'limits'
      ? { value: { value: { shape: 'limits-1', value: [{ kind: 'five_hour', percentUsed: 22, resetsAt: '2026-10-30T14:00:00Z' }] }, version: 1 } }
      : next(e),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    for (const bodyColumns of [50, 100]) {
      const ui = await $.ui.mount({
        plugin: 'usage-crab',
        component: 'AbovePrompt',
        requestId: 'above-prompt',
        surface,
        props: { hasSurvey: false, bodyColumns },
      } as never)
      expect(await ui.find({ type: 'Text', text: /22%/ })).toBeDefined()
      expect(await ui.find({ key: 'open-rules' })).toBeDefined()
      await ui.press({ key: 'band-crab' })
      expect(opened).toBeGreaterThan(0)
      await ui.unmount()
    }
  }
})

test('кнопка «Обновить» опрашивает лимиты сама', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  const files = fakeFs(on, {})
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  on('http.fetch', () => ({
    value: {
      status: 200,
      ok: true,
      headers: {},
      text: JSON.stringify({
        five_hour: { utilization: 41, resets_at: '2026-10-30T14:00:00Z' },
        seven_day: { utilization: 63.5, resets_at: '2026-11-03T10:00:00Z' },
        seven_day_opus: { utilization: 12, resets_at: '2026-11-03T10:00:00Z' },
        extra_usage: null,
      }),
    },
  }))
  const ui = await $.ui.mount({
    plugin: 'usage-crab',
    component: 'Pane',
    requestId: 'usage-crab',
    surface: 'desktop',
    props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  await ui.press({ key: 'refresh' })
  expect(await ui.find({ type: 'Text', text: /41%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Opus/ })).toBeDefined()
  expect(JSON.parse(files['C:/u/.claude/usage-crab/limits.json']!).polledAt).toBe(NOW)
  await ui.unmount()
})

test('отставшая сессия подтягивает большие цифры из общего файла', async ($, on) => {
  // Под модом рисует движок или другой мод: здесь он ничего не добавляет.
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  on('clock.now', () => ({ value: NOW }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'crab' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({
    value: {
      startedAt: NOW - 1000,
      context: {},
      // Эта сессия давно молчит: у неё старые 36%.
      rateLimits: [{ kind: 'five_hour', percentUsed: 36, resetsAt: '2026-10-30T14:00:00Z' }],
    },
  }))
  on('store.get', () => ({ value: undefined }))
  // Другая сессия уже записала 61% в том же окне и опрашивала минуту назад.
  fakeFs(on, {
    'C:/u/.claude/usage-crab/limits.json': JSON.stringify({
      at: NOW - 60_000,
      polledAt: NOW - 60_000,
      limits: [{ kind: 'five_hour', percentUsed: 61, resetsAt: '2026-10-30T14:00:00Z' }],
    }),
  })
  await $.session.start({ cwd: 'D:/Code/my-bot', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({
    plugin: 'usage-crab',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface: 'desktop',
    props: { hasSurvey: false, bodyColumns: 100 },
  } as never)
  expect(await ui.find({ type: 'Text', text: /61%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /36%/ })).toBeUndefined()
  await ui.unmount()
})

test('на 429 все ждут, а непонятные окна не показываются', async ($, on) => {
  on('clock.now', () => ({ value: NOW }))
  const files = fakeFs(on, {})
  on('session.authorize', () => ({ value: { handle: 'h', kind: 'bearer' } }))
  let calls = 0
  on('http.fetch', () => {
    calls++
    return calls === 1
      ? { value: { status: 429, ok: false, headers: { 'Retry-After': '600' }, text: '' } }
      : { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ five_hour: { utilization: 11 }, iguana_necktie: { utilization: 0 } }) } }
  })
  const ui = await $.ui.mount({
    plugin: 'usage-crab', component: 'Pane', requestId: 'usage-crab', surface: 'desktop',
    props: { title: 'x', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
  } as never)
  await ui.press({ key: 'refresh' })
  expect(JSON.parse(files['C:/u/.claude/usage-crab/limits.json']!).backoffUntil).toBe(NOW + 600_000)
  expect(await ui.find({ type: 'Text', text: /less often/ })).toBeDefined()
  await ui.press({ key: 'refresh' })
  expect(calls).toBe(1)
  await ui.unmount()
})

test('краб смотрит на оба лимита', async ($, on) => {
  let limits = [
    { kind: 'five_hour', percentUsed: 20, resetsAt: '2026-10-30T14:00:00Z' },
    { kind: 'seven_day', percentUsed: 85, resetsAt: '2026-11-03T10:00:00Z' },
  ]
  on('state.get', (_, e, next) => {
    const key = String((e as { key: string }).key)
    if (key === 'limits') return { value: { value: { shape: 'limits-1', value: limits }, version: 1 } }
    if (key === 'now') return { value: { value: NOW, version: 1 } }
    return next(e)
  })
  const mount = () => $.ui.mount({ ...PANE, surface: 'desktop' })
  // 5ч свободен, неделя почти кончилась — бережётся, а не потеет.
  let ui = await mount()
  expect(await ui.find({ type: 'Text', text: /the week|weekly/i })).toBeDefined()
  await ui.unmount()
  // 5ч на 50%, неделя 76% — просто занят, никаких «лимит близко».
  limits = [
    { kind: 'five_hour', percentUsed: 50, resetsAt: '2026-10-30T14:00:00Z' },
    { kind: 'seven_day', percentUsed: 76, resetsAt: '2026-11-03T10:00:00Z' },
  ]
  ui = await mount()
  expect(await ui.find({ type: 'Text', text: /going strong|steady pace|plenty left|confidently|slowing down|Noon|Sun at its peak|productive|sea breeze|first commit|waking up|sunset|Evening tide|sand|Night|Owls|Getting late|moon/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /almost gone|Sweating|smoking/ })).toBeUndefined()
  await ui.unmount()
})

test('во время ответа краб кодит', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('state.get', (_, e, next) => {
    const key = String((e as { key: string }).key)
    if (key === 'working') return { value: { value: true, version: 1 } }
    if (key === 'limits')
      return { value: { value: { shape: 'limits-1', value: [{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-30T14:00:00Z' }] }, version: 1 } }
    return next(e)
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Coding together|Tap-tap|Compiling|Almost done/ })).toBeDefined()
  const svg = JSON.stringify((await ui.find({ type: 'Svg' }))?.props)
  expect(svg).toContain('9aa0a8')
  expect(svg).toMatch(/sky-(morning|day|evening|night)/)
  expect(await ui.find({ key: 'to-mini' })).toBeUndefined()
  await ui.unmount()
})

test('строка над вводом оставляет часть, которую нарисовал другой мод', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>кнопка другого мода</Text>
  })
  on('state.get', (_, e, next) =>
    String((e as { key: string }).key) === 'limits'
      ? { value: { value: { shape: 'limits-1', value: [{ kind: 'five_hour', percentUsed: 22, resetsAt: '2026-10-30T14:00:00Z' }] }, version: 1 } }
      : next(e),
  )
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'usage-crab',
      component: 'AbovePrompt',
      requestId: 'above-prompt',
      surface,
      props: { hasSurvey: false, bodyColumns: 100 },
    } as never)
    expect(await ui.find({ type: 'Text', text: /22%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /кнопка другого мода/ })).toBeDefined()
    await ui.unmount()
  }
})

const withLimits = (list: unknown[] | (() => unknown[])) => (on: On) =>
  on('state.get', (_, e, next) =>
    String((e as { key: string }).key) === 'limits'
      ? { value: { value: { shape: 'limits-1', value: typeof list === 'function' ? list() : list }, version: 1 } }
      : String((e as { key: string }).key) === 'now'
        ? { value: { value: NOW, version: 1 } }
        : next(e),
  )

test('язык по умолчанию английский, кнопка переключает на русский и обратно и запоминает выбор', async ($, on) => {
  const files = fakeFs(on, {})
  withLimits([{ kind: 'five_hour', percentUsed: 30, resetsAt: '2026-10-30T14:00:00Z' }])(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Where it went/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /resets in 2h 0m/ })).toBeDefined()
  await ui.press({ key: 'lang-toggle' })
  expect(await ui.find({ type: 'Text', text: /На что ушло/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /сброс через 2ч 0м/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Where it went/ })).toBeUndefined()
  expect(files['C:/u/.claude/xmel-mods-lang.txt']).toBe('ru')
  await ui.press({ key: 'lang-toggle' })
  expect(await ui.find({ type: 'Text', text: /Where it went/ })).toBeDefined()
  expect(files['C:/u/.claude/xmel-mods-lang.txt']).toBe('en')
  await ui.unmount()
})

test('язык из общего файла подхватывается при старте сессии', async ($, on) => {
  on('ui.render', () => ({ type: 'engine', ref: 0 }) as never)
  on('clock.now', () => ({ value: NOW }))
  on('ui.status', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'crab' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('clock.every', () => ({ value: { cancel: () => undefined } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.usage', () => ({ value: { startedAt: NOW - 1000, context: {}, rateLimits: [] } }))
  on('store.get', () => ({ value: undefined }))
  fakeFs(on, { 'C:/u/.claude/xmel-mods-lang.txt': 'ru\n' })
  await $.session.start({ cwd: 'D:/Code/my-bot', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'usage-crab',
    component: 'AbovePrompt',
    requestId: 'above-prompt',
    surface: 'desktop',
    props: { hasSurvey: false, bodyColumns: 100 },
  } as never)
  expect(await ui.find({ type: 'Text', text: /нед —/ })).toBeDefined()
  await ui.unmount()
})

test('прогноз: хватит ли лимита до сброса', async ($, on) => {
  // «Сейчас» 12:00, пятичасовое окно 09:00–14:00: прошло 60%.
  const cases: [number, string, RegExp][] = [
    [30, '2026-10-30T14:00:00Z', /On track: 60% of the window gone, ~50% by reset/],
    [53, '2026-10-30T14:00:00Z', /Tight: 60% of the window gone, ~88% by reset/],
    [85, '2026-10-30T14:00:00Z', /Runs out ~1h \d+m before reset \(around \d\d:\d\d\): 60% of the window gone/],
    // Окно началось две минуты назад: считать темп рано.
    [1, '2026-10-30T16:58:00Z', /too early to tell/],
  ]
  let current: unknown[] = []
  withLimits(() => current)(on)
  for (const [used, resetsAt, expected] of cases) {
    current = [{ kind: 'five_hour', percentUsed: used, resetsAt }]
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ ...PANE, surface })
      expect(await ui.find({ type: 'Text', text: expected })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /│/ })).toBeDefined()
      await ui.unmount()
    }
  }
  // Лимит выбран: прогнозировать нечего.
  current = [{ kind: 'five_hour', percentUsed: 100, resetsAt: '2026-10-30T14:00:00Z' }]
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /On track|Tight|Runs out/ })).toBeUndefined()
  await ui.unmount()
})

test('прогноз по неделе: 3 дня 2 часа из 7 прошло, 20% израсходовано — всё в порядке', async ($, on) => {
  withLimits([
    { kind: 'five_hour', percentUsed: 10, resetsAt: '2026-10-30T14:00:00Z' },
    { kind: 'seven_day', percentUsed: 20, resetsAt: '2026-11-03T10:00:00Z' },
  ])(on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /On track: 44% of the window gone, ~45% by reset/ })).toBeDefined()
  await ui.unmount()
})

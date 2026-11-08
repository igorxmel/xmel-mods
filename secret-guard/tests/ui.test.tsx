import { expect, mock, test } from 'claude-code/testing'

const NOW = Date.parse('2026-10-30T12:00:00Z')

const BAND = {
  plugin: 'secret-guard',
  component: 'AbovePrompt',
  requestId: 'above-prompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 },
} as never

const PANE = {
  plugin: 'secret-guard',
  component: 'Pane',
  requestId: 'secret-guard',
  props: {
    title: '🛡️ Secret guard',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as never

test('кнопка паузы в строке над вводом ставит и снимает паузу, чужая часть строки остаётся', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  // Под модом рисует другой мод (например, краб): его часть должна уцелеть.
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>other mod row</Text>
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...(BAND as object), surface } as never)
    expect(await ui.find({ type: 'Text', text: /other mod row/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Guard is on/ })).toBeDefined()
    await ui.press({ key: 'guard-pause' })
    expect(await ui.find({ type: 'Text', text: /Guard paused until/ })).toBeDefined()
    expect(await ui.find({ key: 'guard-resume' })).toBeDefined()
    await ui.press({ key: 'guard-resume' })
    expect(await ui.find({ type: 'Text', text: /Guard is on/ })).toBeDefined()
    await ui.unmount()
  }
})

test('когда опрос или анкета занимают строку, страж уступает', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>анкета</Text>
  })
  const survey = { ...(BAND as { props: object }), props: { ...(BAND as { props: object }).props, hasSurvey: true } }
  const ui = await $.ui.mount({ ...survey, surface: 'desktop' } as never)
  expect(await ui.find({ type: 'Text', text: /анкета/ })).toBeDefined()
  expect(await ui.find({ key: 'guard-pause' })).toBeUndefined()
  await ui.unmount()
})

test('панель: события, пауза на 30 минут, кнопка «забыть значения»', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  // Заданы только значения, которые кнопки не меняют; пауза живёт в настоящем состоянии.
  const seeded: Record<string, unknown> = {
    events: {
      shape: 'events-1',
      value: [
        { at: NOW - 120_000, kind: 'env-secret', where: 'Read', action: 'masked' },
        { at: NOW - 60_000, kind: 'git-files: .env', where: 'Bash', action: 'blocked' },
      ],
    },
    count: 2,
    knownCount: 3,
  }
  on('state.get', (_, e, next) => {
    const key = String((e as { key: string }).key)
    return key in seeded ? { value: { value: seeded[key], version: 1 } } : next(e)
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...(PANE as object), surface } as never)
    expect(await ui.find({ type: 'Text', text: /Guard is on/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /secret from \.env/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /secret files in git/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Remembered values from \.env and output: 3/ })).toBeDefined()
    await ui.press({ key: 'pane-pause-30' })
    expect(await ui.find({ type: 'Text', text: /Guard paused/ })).toBeDefined()
    expect(await ui.find({ key: 'pane-resume' })).toBeDefined()
    await ui.press({ key: 'pane-resume' })
    expect(await ui.find({ key: 'pane-forget' })).toBeDefined()
    await ui.unmount()
  }
})

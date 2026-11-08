import { expect, mock, test } from 'claude-code/testing'

import { findSecrets, maskLabel, maskText } from '../hooks/mask'
import { kindName } from '../hooks/strings'

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

const TEXT = 'export DB_PASSWORD=hunter2hunter2\nPORT=8080'

test('метки для модели на английском по умолчанию и на русском по выбору', async () => {
  const found = findSecrets(TEXT)
  expect(found.map(f => f.kind)).toEqual(['env-secret'])
  expect(maskText(TEXT, found)).toContain('[hidden: secret from .env]')
  expect(maskText(TEXT, found, 'ru')).toContain('[скрыто: секрет из .env]')
  expect(maskText(TEXT, found, 'ru')).toContain('PORT=8080')
  expect(maskLabel('jwt', 'x'.repeat(20), 'en')).toBe('[hidden: JWT, …xxxx]')
})

test('уже скрытое на любом языке повторно не маскируется', async () => {
  for (const lang of ['en', 'ru'] as const) {
    const once = maskText(TEXT, findSecrets(TEXT), lang)
    expect(findSecrets(once)).toHaveLength(0)
  }
  // Смесь двух языков в одном тексте тоже спокойно проходит.
  const mixed = `${maskText(TEXT, findSecrets(TEXT), 'ru')}\n${maskText(TEXT, findSecrets(TEXT), 'en')}`
  expect(findSecrets(mixed)).toHaveLength(0)
})

test('названия видов и остановленных git-команд зависят от языка', async () => {
  expect(kindName('en', 'telegram-token')).toBe('Telegram bot token')
  expect(kindName('ru', 'telegram-token')).toBe('токен Telegram-бота')
  expect(kindName('en', 'git-files: .env, a.pem')).toBe('secret files in git: .env, a.pem')
  expect(kindName('ru', 'git-files: .env')).toBe('файлы с секретами в git: .env')
  expect(kindName('en', 'что-то своё')).toBe('что-то своё')
})

test('кнопка языка в панели переключает язык и запоминает выбор', async ($, on) => {
  mock.clock(on)
  on('ui.status', () => ({ value: undefined }))
  mock.env(on, { USERPROFILE: 'C:/u' })
  const files: Record<string, string> = {}
  on('fs.exists', (_, e) => ({ value: String((e as { path: string }).path).replace(/\\/g, '/') in files }))
  on('fs.read', (_, e) => ({ value: files[String((e as { path: string }).path).replace(/\\/g, '/')] ?? '' }))
  on('fs.write', (_, e) => {
    files[String((e as { path: string }).path).replace(/\\/g, '/')] = (e as { text: string }).text
    return { value: undefined }
  })

  const ui = await $.ui.mount({ ...(PANE as object), surface: 'desktop' } as never)
  expect(await ui.find({ type: 'Text', text: /Guard is on/ })).toBeDefined()
  await ui.press({ key: 'lang-toggle' })
  expect(await ui.find({ type: 'Text', text: /Страж работает/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Guard is on/ })).toBeUndefined()
  expect(files['C:/u/.claude/xmel-mods-lang.txt']).toBe('ru')
  await ui.press({ key: 'lang-toggle' })
  expect(await ui.find({ type: 'Text', text: /Guard is on/ })).toBeDefined()
  expect(files['C:/u/.claude/xmel-mods-lang.txt']).toBe('en')
  await ui.unmount()
})

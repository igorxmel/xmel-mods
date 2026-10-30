import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'session-rules',
  component: 'Pane',
  requestId: 'session-rules',
  props: {
    title: '📏 Правила сессии',
    isFocused: false,
    bodyColumns: 50,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

test('правило в системном промпте и в панели', async ($, on) => {
  on('state.get', (_, e) => {
    const values: Record<string, unknown> = {
      rules: {
        value: { shape: 'rules-1', value: [{ name: 'commits', title: 'Правила коммитов', text: '# Правила коммитов\n- Conventional Commits' }] },
        version: 1,
      },
      enabled: { value: ['commits'], version: 1 },
      projectDefaults: { value: [], version: 1 },
      dir: { value: 'C:/Users/user/.claude/session-rules', version: 1 },
    }
    return { value: values[String((e as { key: string }).key)] ?? { value: undefined, version: 0 } }
  })
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'hi', scope: 'shared' }] }))

  const composed = await $.prompt.compose({ model: 'claude-opus-5-5', promptModel: 'claude-opus-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const section = composed.sections.find(s => s.id === 'session-rules:active')
  expect(section?.text).toContain('Conventional Commits')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Правила коммитов/ })).toBeDefined()
    await ui.unmount()
  }
})

test('правило можно раскрыть, изменить и сохранить', async ($, on) => {
  const files: Record<string, string> = {
    'C:/Users/user/.claude/session-rules/commits.md': '# Правила коммитов\n- Conventional Commits',
  }
  on('env.get', () => ({ value: 'C:/Users/user' }))
  const norm = (e: unknown) => String((e as { path: string }).path).replace(/\\/g, '/')
  on('fs.exists', (_, e) => ({ value: norm(e) in files || /session-rules$/.test(norm(e)) }))
  on('fs.list', () => ({
    value: Object.keys(files).map(f => ({ name: f.split('/').pop()!, kind: 'file', size: 10, mtimeMs: 0, isLink: false })),
  }))
  on('fs.read', (_, e) => ({ value: files[norm(e)] ?? '' }))
  on('fs.write', (_, e) => {
    files[norm(e)] = (e as { text: string }).text
    return { value: undefined }
  })
  on('command.register', () => ({ value: { command: 'rules' } }))
  on('ui.status', () => ({ value: undefined }))
  mock.clock(on)
  on('store.get', () => ({ value: undefined }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: 'D:/Code/my-bot', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'view-commits' })
  expect(await ui.find({ type: 'Markdown' })).toBeDefined()
  await ui.press({ key: 'edit-btn-commits' })
  await ui.input({ key: 'edit-commits', text: '# Правила коммитов\n- Conventional Commits\n- Без Co-Authored-By' })
  expect(files['C:/Users/user/.claude/session-rules/commits.md']).toContain('Без Co-Authored-By')
  expect(await ui.find({ type: 'Text', text: /Сохранил commits\.md/ })).toBeDefined()

  await ui.input({ key: 'create-rule', text: 'Стиль кода' })
  expect(Object.keys(files).some(f => f.endsWith('/стиль-кода.md'))).toBe(true)
  await ui.unmount()
})

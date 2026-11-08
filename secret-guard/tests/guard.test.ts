import { expect, mock, test } from 'claude-code/testing'

import { findSecrets, gitSteps, isSensitiveFile, maskText } from '../hooks/mask'

const ENV = [
  'BOT_TOKEN=1234567890:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq',
  'DATABASE_URL=postgres://app:S3cretPass@db.local:5432/app',
  'OPENAI_API_KEY="sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD"',
  'GITHUB=ghp_abcdefghijklmnopqrstuvwxyz0123456789',
  'PORT=8080',
  'DEBUG=true',
  'API_KEY=your_api_key_here',
].join('\n')

test('находит и скрывает секреты из .env', async () => {
  const found = findSecrets(ENV)
  const masked = maskText(ENV, found)
  expect(masked).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsawq')
  expect(masked).not.toContain('S3cretPass')
  expect(masked).not.toContain('abcdefghijklmnopqrstuvwxyz0123456789ABCD')
  expect(masked).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789')
  expect(masked).toContain('PORT=8080')
  expect(masked).toContain('DEBUG=true')
  expect(masked).toContain('your_api_key_here')
  expect(masked).toContain('[hidden: Telegram bot token, …sawq]')
})

test('не трогает обычный вывод', async () => {
  const text = [
    'Passed: 15 tests, Failed: 0',
    'PWD=/home/user/project',
    'TOKENIZERS_PARALLELISM=false',
    'token_count: 12345',
    'commit 3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39',
    'https://github.com/user/repo',
  ].join('\n')
  expect(findSecrets(text)).toHaveLength(0)
})

test('повторная маскировка ничего не ломает', async () => {
  const once = maskText(ENV, findSecrets(ENV))
  expect(findSecrets(once)).toHaveLength(0)
})

test('известное значение скрывается и без имени переменной', async () => {
  const found = findSecrets('$ echo $BOT_TOKEN\nsupersecretvalue123', ['supersecretvalue123'])
  expect(found.map(f => f.kind)).toEqual(['known-secret'])
})

test('чувствительные файлы', async () => {
  for (const f of ['.env', 'bot/.env.production', 'server.key', 'certs/cert.pem', 'id_rsa', 'credentials.json']) {
    expect(isSensitiveFile(f)).toBe(true)
  }
  for (const f of ['.env.example', '.env.sample', 'id_rsa.pub', 'src/env.ts', 'keyboard.py', 'README.md']) {
    expect(isSensitiveFile(f)).toBe(false)
  }
})

test('разбор git-команд с cd и -C', async () => {
  const steps = gitSteps('cd bot && git add . && git -C ../web commit -am "fix"', 'D:/Code/my-bot')
  expect(steps).toEqual([
    { dir: 'D:/Code/my-bot/bot', verb: 'add', args: ['.'] },
    { dir: 'D:/Code/my-bot/bot/../web', verb: 'commit', args: ['-am', 'fix'] },
  ])
})

test('не даёт добавить .env в git', async ($, on) => {
  on('session.cwd', () => ({ value: 'D:/Code/my-bot' }))
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '' } }))
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  mock.clock(on)

  const denied = await $.tool.call({ tool: 'Bash', command: 'git add .env && git commit -m x' })
  expect('deny' in denied || ('isError' in denied && denied.isError)).toBe(true)

  const fine = await $.tool.call({ tool: 'Bash', command: 'git add src/main.py' })
  expect('deny' in fine && fine.deny).toBeFalsy()
})

test('git add . останавливается, если рядом лежит неигнорируемый .env', async ($, on) => {
  on('session.cwd', () => ({ value: 'D:/Code/my-bot' }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: string[] }).argv
    return {
      value: {
        exitCode: 0,
        stdout: argv.includes('--others') ? 'src/new.py\n.env\n' : '',
        stderr: '',
      },
    }
  })
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  mock.clock(on)

  const denied = await $.tool.call({ tool: 'Bash', command: 'git add -A' })
  expect('deny' in denied || ('isError' in denied && denied.isError)).toBe(true)
})

test('вывод инструмента маскируется до модели', async ($, on) => {
  const session = mock.session(on)
  mock.clock(on)
  await $.session.append({
    door: 'tool-result',
    origin: { kind: 'tool', tool: 'Read' },
    message: {
      type: 'user',
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 't1', content: ENV }],
    },
  } as never)
  const rows = session.appended()
  const stored = JSON.stringify(rows[rows.length - 1]?.message.content)
  expect(stored).not.toContain('S3cretPass')
  expect(stored).toContain('PORT=8080')
})

test('секрет в сообщении пользователя скрывается, а в чате остаётся строка', async ($, on) => {
  const session = mock.session(on)
  mock.clock(on)
  let reached = ''
  on('prompt.submit', (_, e) => {
    reached = e.text
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'положи в .env: BOT_TOKEN=fsdfsdf_sdfsdh983893y258978939rh0wy893h5@32428yhuhj' })
  expect(reached).not.toContain('fsdfsdf_sdfsdh983893y258978939rh0wy893h5')
  expect(reached).toContain('[hidden: secret from .env')
  expect(reached).toContain('положи в .env')
  const notes = session.appended().filter(r => r.message.type === 'system')
  expect(JSON.stringify(notes)).toContain('secret-guard')
})

test('обычное сообщение проходит как есть', async ($, on) => {
  mock.clock(on)
  let reached = ''
  on('prompt.submit', (_, e) => {
    reached = e.text
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'поставь PORT=8080 и почини деплой' })
  expect(reached).toBe('поставь PORT=8080 и почини деплой')
})

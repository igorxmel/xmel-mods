import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { GuardEvent } from '../types'
import { findSecrets, gitSteps, isSensitiveFile, maskText } from './mask'
import type { Found } from './mask'

const events = atom({ plugin: 'secret-guard', key: 'events' } as const, [], { shape: 'events-1' })
const count = atom({ plugin: 'secret-guard', key: 'count' } as const, 0)
const pausedUntil = atom({ plugin: 'secret-guard', key: 'pausedUntil' } as const, 0)
/** Часы для отображения: по ним кнопка паузы сама возвращается в «работает». */
const nowAtom = atom({ plugin: 'secret-guard', key: 'now' } as const, 0)
/** Сколько значений запомнено; сами значения в состояние не попадают. */
const knownCount = atom({ plugin: 'secret-guard', key: 'knownCount' } as const, 0)

const PANE = 'secret-guard'

// Сами значения секретов живут только в памяти модуля: не в $.state (его
// читают другие плагины) и не в $.store (он пишется на диск).
const known = new Set<string>()

type Block = { type: string; [field: string]: unknown }

function maskBlocks(blocks: readonly Block[]): { blocks: Block[]; found: Found[] } {
  const found: Found[] = []
  const maskString = (text: string) => {
    const hits = findSecrets(text, known)
    if (hits.length === 0) return text
    found.push(...hits)
    return maskText(text, hits)
  }
  const out = blocks.map(block => {
    if (block.type === 'text' && typeof block.text === 'string') {
      return { ...block, text: maskString(block.text) }
    }
    if (block.type === 'tool_result') {
      const content = block.content
      if (typeof content === 'string') return { ...block, content: maskString(content) }
      if (Array.isArray(content)) {
        return {
          ...block,
          content: content.map((inner: Block) =>
            inner.type === 'text' && typeof inner.text === 'string'
              ? { ...inner, text: maskString(inner.text) }
              : inner,
          ),
        }
      }
    }
    return block
  })
  return { blocks: out, found }
}

async function isPaused($: Engine) {
  return (await read($, pausedUntil)) > (await $.clock.now())
}

async function syncKnown($: Engine) {
  await update($, knownCount, () => known.size)
}

async function record($: Engine, kind: string, where: string, action: GuardEvent['action']) {
  const at = await $.clock.now()
  await update($, events, list => [...list, { at, kind, where, action }].slice(-50))
  const n = await update($, count, c => c + 1)
  await syncKnown($)
  $.ui.status(`🛡️ Страж: скрыто/остановлено ${n}`)
}

/** Пауза и возврат: их зовут и команда, и кнопки, поэтому живут здесь. */
async function setPause($: Engine, minutes: number): Promise<number> {
  const now = await $.clock.now()
  const until = now + minutes * 60_000
  await update($, nowAtom, () => now)
  await update($, pausedUntil, () => until)
  $.ui.status(`🛡️ Страж на паузе до ${fmtTime(until)}`)
  return until
}

async function resumeGuard($: Engine) {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  await update($, pausedUntil, () => 0)
  $.ui.status('🛡️ Страж включён')
}

async function forgetKnown($: Engine) {
  known.clear()
  await syncKnown($)
}

async function git($: Engine, dir: string, args: string[]): Promise<string[]> {
  try {
    const r = await $.process.run(['git', ...args], { cwd: dir, timeoutMs: 5000 })
    if (r.exitCode !== 0) return []
    return r.stdout.split(/\r?\n/).filter(Boolean)
  } catch {
    return []
  }
}

/** Что из чувствительных файлов попадёт в git этой командой; пусто — всё чисто. */
async function riskyFiles($: Engine, command: string): Promise<string[]> {
  const cwd = await $.session.cwd()
  const bad = new Set<string>()
  for (const step of gitSteps(command, cwd)) {
    if (step.verb === 'add') {
      const paths = step.args.filter(a => !a.startsWith('-'))
      for (const p of paths) if (isSensitiveFile(p)) bad.add(p)
      const isBroad =
        step.args.some(a => ['-A', '--all', '-u', '--update', '.', '*', ':/'].includes(a)) ||
        paths.some(p => p.endsWith('/') || p.endsWith('\\') || !/\.[\w-]+$/.test(p))
      if (isBroad) {
        const untracked = await git($, step.dir, ['ls-files', '--others', '--exclude-standard'])
        const changed = await git($, step.dir, ['diff', '--name-only'])
        for (const f of [...untracked, ...changed]) if (isSensitiveFile(f)) bad.add(f)
      }
    } else {
      const staged = await git($, step.dir, ['diff', '--cached', '--name-only'])
      const isAll = step.args.some(a => a === '--all' || /^-[a-zA-Z]*a[a-zA-Z]*$/.test(a))
      const changed = isAll ? await git($, step.dir, ['diff', '--name-only']) : []
      for (const f of [...staged, ...changed]) if (isSensitiveFile(f)) bad.add(f)
    }
  }
  return [...bad]
}

const GIT_WRITE = /\bgit\b[^|;&\n]*\b(?:add|commit)\b/

const fmtTime = (at: number) => {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'secrets',
      description: 'Страж секретов: что скрыто, пауза и возобновление',
      argumentHint: '[pause [минут] | resume]',
    })
    // Значения из .env текущей папки запоминаем, чтобы скрывать их везде,
    // даже без имени переменной рядом (например, вывод echo $TOKEN).
    try {
      for (const entry of await $.fs.list(e.cwd)) {
        if (entry.kind !== 'file' || !isSensitiveFile(entry.name) || entry.size > 200_000) continue
        const text = await $.fs.read(`${e.cwd}/${entry.name}`)
        for (const f of findSecrets(text)) known.add(f.value)
      }
    } catch {
      // нет доступа к папке — работаем только по шаблонам
    }
    await syncKnown($)
    const now = await $.clock.now()
    await update($, nowAtom, () => now)
    $.clock.every(30_000, async () => {
      const t = await $.clock.now()
      await update($, nowAtom, () => t)
    })
    const n = await read($, count)
    const until = await read($, pausedUntil)
    $.ui.status(
      until > now
        ? `🛡️ Страж на паузе до ${fmtTime(until)}`
        : n > 0
          ? `🛡️ Страж: скрыто/остановлено ${n}`
          : '🛡️ Страж включён',
    )
    return next(e)
  })

  // Всё, что инструменты возвращают модели (и что сабагенты получают), проходит здесь.
  on('session.append', async ($, e, next) => {
    if (e.door !== 'tool-result' && e.door !== 'tool-message' && e.door !== 'attachment') return next(e)
    if (await isPaused($)) return next(e)
    const { blocks, found } = maskBlocks(e.message.content)
    if (found.length === 0) return next(e)
    for (const f of found) known.add(f.value)
    const tool = e.origin.kind === 'tool' ? e.origin.tool : e.door
    const kinds = [...new Set(found.map(f => f.kind))]
    for (const kind of kinds) await record($, kind, tool, 'masked')
    $.ui.toast(`🛡️ Скрыл от модели: ${kinds.join(', ')} (${tool})`)
    return next({ ...e, message: { ...e.message, content: blocks } })
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    // Проверка сломалась — лучше спрятать вывод целиком, чем показать секрет.
    if (e.door !== 'tool-result') return next(e)
    return next({
      ...e,
      message: {
        ...e.message,
        content: e.message.content.map(b =>
          b.type === 'tool_result'
            ? { ...b, content: '[secret-guard: не смог проверить этот вывод на секреты и скрыл его]' }
            : b,
        ),
      },
    })
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!GIT_WRITE.test(e.command) || (await isPaused($))) return next(e)
    const bad = await riskyFiles($, e.command)
    if (bad.length === 0) return next(e)
    await record($, `файлы с секретами в git: ${bad.join(', ')}`, 'Bash', 'blocked')
    $.ui.toast(`🛡️ Не дал закоммитить: ${bad.join(', ')}`)
    return {
      deny:
        `secret-guard: эта команда отправит в git файлы с секретами: ${bad.join(', ')}. ` +
        'Не добавляй их. Добавь их в .gitignore; если файл уже в индексе — `git rm --cached <файл>`. ' +
        'Если пользователь осознанно хочет закоммитить, он сам нажмёт «Пауза» у стража или выполнит /secrets pause.',
    }
  }).catch(($, e, next) =>
    next.called || !GIT_WRITE.test(e.command)
      ? next(e)
      : { deny: 'secret-guard не смог проверить эту git-команду на секреты. Проверь файлы вручную или попроси пользователя выполнить /secrets pause.' },
  )

  // Секрет, вставленный прямо в сообщение, заменяем меткой до того, как его
  // прочтёт модель, и оставляем в чате заметную строку об этом.
  // Слэш-команды движок переписать не даёт — их не трогаем.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || (await isPaused($))) return next(e)
    const found = findSecrets(e.text, known)
    if (found.length === 0) return next(e)
    for (const f of found) known.add(f.value)
    const kinds = [...new Set(found.map(f => f.kind))]
    for (const kind of kinds) await record($, kind, 'твоё сообщение', 'masked')
    const result = await next({ ...e, text: maskText(e.text, found) })
    const note =
      `🛡️ secret-guard: в твоём сообщении скрыл от модели ${kinds.join(', ')}. ` +
      'Если секрет нужно передать Claude, выполни /secrets pause и отправь ещё раз.'
    void $.session.append({ message: { type: 'system', content: [{ type: 'text', text: note }] } })
    $.ui.toast(`🛡️ Скрыл в сообщении: ${kinds.join(', ')}`)
    return result
  })

  on('command.run', { command: 'secrets' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()
    if (verb === 'open') {
      await $.ui.open({ id: PANE, title: '🛡️ Страж секретов' })
      return { text: 'Панель стража открыта.' }
    }
    if (verb === 'pause') {
      const minutes = Math.min(120, Math.max(1, Number(arg) || 10))
      await setPause($, minutes)
      return { text: `Страж на паузе ${minutes} мин: секреты не скрываются, git не проверяется.` }
    }
    if (verb === 'resume') {
      await resumeGuard($)
      return { text: 'Страж снова работает.' }
    }
    const list = await read($, events)
    const paused = await read($, pausedUntil)
    const head =
      paused > now ? `Страж на паузе до ${fmtTime(paused)}.` : 'Страж работает.'
    const lines = list
      .slice(-15)
      .reverse()
      .map(ev => `${fmtTime(ev.at)}  ${ev.action === 'blocked' ? '⛔' : '🙈'} ${ev.kind} · ${ev.where}`)
    return {
      text: [
        head,
        `Запомнено значений из .env и вывода: ${known.size}.`,
        lines.length ? 'Последнее:\n' + lines.join('\n') : 'Пока ничего не скрыто и не остановлено.',
        '',
        '/secrets open — панель, /secrets pause [мин] — пауза (по умолчанию 10 мин), /secrets resume — включить.',
      ].join('\n'),
    }
  })

  // Строка над полем ввода: состояние стража и кнопки. Другие моды тоже рисуют
  // в этой строке, поэтому сначала берём их часть и добавляем свою под ней.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = (await read($, nowAtom)) || 0
    const until = await read($, pausedUntil)
    const n = await read($, count)
    const isPaused = until > now

    return (
      <Box flexDirection="column">
        {below.type === 'engine' ? null : below}
        <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
          {isPaused ? (
            <Text color="warning">⏸ Страж на паузе до {fmtTime(until)}</Text>
          ) : (
            <Text>
              <Text color="success">🛡️ Страж работает</Text>
              {n > 0 && <Text dimColor> · скрыто {n}</Text>}
            </Text>
          )}
          {isPaused ? (
            <Button key="guard-resume" variant="primary" label="▶ Включить" onPress={() => resumeGuard($)} />
          ) : (
            <Button key="guard-pause" label="⏸ Пауза 10 мин" onPress={() => setPause($, 10)} />
          )}
          <Button key="guard-open" label="Подробнее" onPress={() => $.ui.open({ id: PANE, title: '🛡️ Страж секретов' })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const now = (await read($, nowAtom)) || 0
    const until = await read($, pausedUntil)
    const list = await read($, events)
    const n = await read($, count)
    const k = await read($, knownCount)
    const isPaused = until > now

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          <Text weight="semibold" color={isPaused ? 'warning' : 'success'}>
            {isPaused ? '⏸ Страж на паузе' : '🛡️ Страж работает'}
          </Text>
          <Text dimColor>
            {isPaused
              ? `До ${fmtTime(until)}: секреты не скрываются, git не проверяется.`
              : 'Прячет секреты от модели и не даёт закоммитить .env и ключи.'}
          </Text>
        </Box>

        <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
          {isPaused ? (
            <Button key="pane-resume" variant="primary" label="▶ Включить сейчас" onPress={() => resumeGuard($)} />
          ) : (
            <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
              <Text dimColor>Пауза:</Text>
              <Button key="pane-pause-10" label="10 мин" onPress={() => setPause($, 10)} />
              <Button key="pane-pause-30" label="30 мин" onPress={() => setPause($, 30)} />
              <Button key="pane-pause-60" label="1 час" onPress={() => setPause($, 60)} />
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Text>
            Скрыто или остановлено за сессию: <Text weight="semibold">{n}</Text>
          </Text>
          <Text dimColor>Запомнено значений из .env и вывода: {k}</Text>
        </Box>
        {k > 0 && (
          <Box flexDirection="row">
            <Button key="pane-forget" label="Забыть запомненные значения" onPress={() => forgetKnown($)} />
          </Box>
        )}

        <Box flexDirection="column">
          <Text weight="semibold">Последнее</Text>
          {list.length === 0 ? (
            <Text dimColor>Пока ничего не скрыто и не остановлено.</Text>
          ) : (
            [...list]
              .slice(-10)
              .reverse()
              .map(ev => (
                <Text wrap="truncate-end">
                  <Text dimColor>{fmtTime(ev.at)} </Text>
                  <Text color={ev.action === 'blocked' ? 'error' : undefined}>
                    {ev.action === 'blocked' ? '⛔ ' : '🙈 '}
                    {ev.kind}
                  </Text>
                  <Text dimColor> · {ev.where}</Text>
                </Text>
              ))
          )}
        </Box>

        <Text dimColor>Значения секретов нигде не показываются и не записываются на диск.</Text>
      </Box>
    )
  })
}

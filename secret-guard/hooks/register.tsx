import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { GuardEvent } from '../types'
import { findSecrets, gitSteps, isSensitiveFile, maskText } from './mask'
import type { Found } from './mask'
import { GIT_KIND, STRINGS, WHERE_MESSAGE, kindName, loadLang, otherLang, parseLang, saveLang, whereName } from './strings'
import type { Lang } from './strings'

const events = atom({ plugin: 'secret-guard', key: 'events' } as const, [], { shape: 'events-1' })
const count = atom({ plugin: 'secret-guard', key: 'count' } as const, 0)
const pausedUntil = atom({ plugin: 'secret-guard', key: 'pausedUntil' } as const, 0)
/** Часы для отображения: по ним кнопка паузы сама возвращается в «работает». */
const nowAtom = atom({ plugin: 'secret-guard', key: 'now' } as const, 0)
/** Сколько значений запомнено; сами значения в состояние не попадают. */
const knownCount = atom({ plugin: 'secret-guard', key: 'knownCount' } as const, 0)

/** Язык интерфейса; общий для модов xmel-mods, подхватывается из файла. */
const langAtom = atom({ plugin: 'secret-guard', key: 'lang' } as const, 'en')

const PANE = 'secret-guard'

/**
 * Язык для кода вне отрисовки (статус, тосты, метки для модели). Отрисовка
 * читает атом, чтобы перерисоваться при смене языка, и кладёт значение сюда.
 */
let L: Lang = 'en'
const S = () => STRINGS[L]
const kindsText = (kinds: readonly string[]) => kinds.map(k => kindName(L, k)).join(', ')

async function applyLang($: Engine, lang: Lang, isSave: boolean) {
  L = lang
  await update($, langAtom, () => lang)
  if (isSave) await saveLang($, lang)
  await showStatus($)
}

/** Подхватывает язык, выбранный в другом моде или другой сессии. */
async function syncLang($: Engine) {
  const lang = await loadLang($)
  if (lang !== (await read($, langAtom))) await applyLang($, lang, false)
  else L = lang
}

/** Без аргумента переключает язык на другой, с аргументом ставит указанный. */
async function toggleLang($: Engine, lang?: Lang) {
  await applyLang($, lang ?? otherLang(await read($, langAtom)), true)
}

/** Строка состояния: пауза, счётчик или «включён». */
async function showStatus($: Engine) {
  const now = await $.clock.now()
  const until = await read($, pausedUntil)
  const n = await read($, count)
  $.ui.status(
    until > now ? S().statusPaused(fmtTime(until)) : n > 0 ? S().statusCount(n) : S().statusOn,
  )
}

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
    return maskText(text, hits, L)
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
  $.ui.status(S().statusCount(n))
}

/** Пауза и возврат: их зовут и команда, и кнопки, поэтому живут здесь. */
async function setPause($: Engine, minutes: number): Promise<number> {
  const now = await $.clock.now()
  const until = now + minutes * 60_000
  await update($, nowAtom, () => now)
  await update($, pausedUntil, () => until)
  $.ui.status(S().statusPaused(fmtTime(until)))
  return until
}

async function resumeGuard($: Engine) {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
  await update($, pausedUntil, () => 0)
  $.ui.status(S().statusResumed)
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
    await syncLang($)
    await $.command.register({
      name: 'secrets',
      description: S().cmdDescription,
      argumentHint: S().cmdArgumentHint,
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
      await syncLang($)
    })
    await showStatus($)
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
    $.ui.toast(S().toastHidden(kindsText(kinds), tool))
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
            ? { ...b, content: S().catchHidden }
            : b,
        ),
      },
    })
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    if (!GIT_WRITE.test(e.command) || (await isPaused($))) return next(e)
    const bad = await riskyFiles($, e.command)
    if (bad.length === 0) return next(e)
    await record($, `${GIT_KIND} ${bad.join(', ')}`, 'Bash', 'blocked')
    $.ui.toast(S().toastBlocked(bad.join(', ')))
    return { deny: S().denyGit(bad.join(', ')) }
  }).catch(($, e, next) =>
    next.called || !GIT_WRITE.test(e.command)
      ? next(e)
      : { deny: S().denyGitFailed },
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
    for (const kind of kinds) await record($, kind, WHERE_MESSAGE, 'masked')
    const result = await next({ ...e, text: maskText(e.text, found, L) })
    const note = S().chatNote(kindsText(kinds))
    void $.session.append({ message: { type: 'system', content: [{ type: 'text', text: note }] } })
    $.ui.toast(S().toastMessage(kindsText(kinds)))
    return result
  })

  on('command.run', { command: 'secrets' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
    const now = await $.clock.now()
    if (verb === 'lang') {
      await toggleLang($, parseLang(arg))
      return { text: S().langSet(S().langName) }
    }
    if (verb === 'open') {
      await $.ui.open({ id: PANE, title: S().paneTitle })
      return { text: S().panelOpened }
    }
    if (verb === 'pause') {
      const minutes = Math.min(120, Math.max(1, Number(arg) || 10))
      await setPause($, minutes)
      return { text: S().pausedFor(minutes) }
    }
    if (verb === 'resume') {
      await resumeGuard($)
      return { text: S().resumed }
    }
    const list = await read($, events)
    const paused = await read($, pausedUntil)
    const head = paused > now ? S().headPaused(fmtTime(paused)) : S().headWorking
    const lines = list
      .slice(-15)
      .reverse()
      .map(
        ev =>
          `${fmtTime(ev.at)}  ${ev.action === 'blocked' ? '⛔' : '🙈'} ${kindName(L, ev.kind)} · ${whereName(L, ev.where)}`,
      )
    return {
      text: [
        head,
        S().remembered(known.size),
        lines.length ? S().recent + lines.join('\n') : S().nothing,
        '',
        S().cmdFooter,
      ].join('\n'),
    }
  })

  // Строка над полем ввода: состояние стража и кнопки. Другие моды тоже рисуют
  // в этой строке, поэтому сначала берём их часть и добавляем свою под ней.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey) return below
    const { Box, Text, Button } = $.ui.resolve(e)
    const lang = await read($, langAtom)
    L = lang
    const s = STRINGS[lang]
    const now = (await read($, nowAtom)) || 0
    const until = await read($, pausedUntil)
    const n = await read($, count)
    const isPaused = until > now

    return (
      <Box flexDirection="column" rowGap={1}>
        {below.type === 'engine' ? null : below}
        <Box flexDirection="row" columnGap={2} rowGap={1} flexWrap="wrap" alignItems="center">
          {isPaused ? (
            <Text color="warning">{s.bandPaused(fmtTime(until))}</Text>
          ) : (
            <Text>
              <Text color="success">{s.bandWorking}</Text>
              {n > 0 && <Text dimColor>{s.bandHidden(n)}</Text>}
            </Text>
          )}
          {isPaused ? (
            <Button key="guard-resume" variant="primary" label={s.bandResume} onPress={() => resumeGuard($)} />
          ) : (
            <Button key="guard-pause" label={s.bandPause} onPress={() => setPause($, 10)} />
          )}
          <Button key="guard-open" label={s.bandDetails} onPress={() => $.ui.open({ id: PANE, title: s.paneTitle })} />
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const lang = await read($, langAtom)
    L = lang
    const s = STRINGS[lang]
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
            {isPaused ? s.panePaused : s.paneWorking}
          </Text>
          <Text dimColor>{isPaused ? s.panePausedHint(fmtTime(until)) : s.paneWorkingHint}</Text>
        </Box>

        <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
          {isPaused ? (
            <Button key="pane-resume" variant="primary" label={s.resumeNow} onPress={() => resumeGuard($)} />
          ) : (
            <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
              <Text dimColor>{s.pause}</Text>
              <Button key="pane-pause-10" label={s.min10} onPress={() => setPause($, 10)} />
              <Button key="pane-pause-30" label={s.min30} onPress={() => setPause($, 30)} />
              <Button key="pane-pause-60" label={s.hour1} onPress={() => setPause($, 60)} />
            </Box>
          )}
        </Box>

        <Box flexDirection="column">
          <Text>
            {s.hiddenThisSession} <Text weight="semibold">{n}</Text>
          </Text>
          <Text dimColor>{s.rememberedLine(k)}</Text>
        </Box>
        {k > 0 && (
          <Box flexDirection="row">
            <Button key="pane-forget" label={s.forget} onPress={() => forgetKnown($)} />
          </Box>
        )}

        <Box flexDirection="column">
          <Text weight="semibold">{s.recentTitle}</Text>
          {list.length === 0 ? (
            <Text dimColor>{s.nothing}</Text>
          ) : (
            [...list]
              .slice(-10)
              .reverse()
              .map(ev => (
                <Text wrap="truncate-end">
                  <Text dimColor>{fmtTime(ev.at)} </Text>
                  <Text color={ev.action === 'blocked' ? 'error' : undefined}>
                    {ev.action === 'blocked' ? '⛔ ' : '🙈 '}
                    {kindName(lang, ev.kind)}
                  </Text>
                  <Text dimColor> · {whereName(lang, ev.where)}</Text>
                </Text>
              ))
          )}
        </Box>

        <Box flexDirection="row" columnGap={2} flexWrap="wrap" alignItems="center">
          <Text dimColor>{s.neverShown}</Text>
          <Button key="lang-toggle" plain onPress={() => toggleLang($)}>
            <Text>
              <Text dimColor>🌐 </Text>
              <Text weight={lang === 'en' ? 'semibold' : undefined} dimColor={lang !== 'en'}>EN</Text>
              <Text dimColor> · </Text>
              <Text weight={lang === 'ru' ? 'semibold' : undefined} dimColor={lang !== 'ru'}>RU</Text>
            </Text>
          </Button>
        </Box>
      </Box>
    )
  })
}

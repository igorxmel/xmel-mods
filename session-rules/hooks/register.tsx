import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Rule } from '../types'
import { STRINGS, loadLang, otherLang, parseLang, saveLang } from './strings'
import type { Lang } from './strings'

const PANE = 'session-rules'
const SECTION = 'session-rules:active'

const rules = atom({ plugin: 'session-rules', key: 'rules' } as const, [], {
  shape: 'rules-1',
})
const enabled = atom({ plugin: 'session-rules', key: 'enabled' } as const, [])
const projectDefaults = atom(
  { plugin: 'session-rules', key: 'projectDefaults' } as const,
  [],
)
const cwdAtom = atom({ plugin: 'session-rules', key: 'cwd' } as const, '')
const dirAtom = atom({ plugin: 'session-rules', key: 'dir' } as const, '')
/** Какое правило раскрыто в панели и какое сейчас редактируется ('' — никакое). */
const openRule = atom({ plugin: 'session-rules', key: 'openRule' } as const, '')
const editRule = atom({ plugin: 'session-rules', key: 'editRule' } as const, '')
const note = atom({ plugin: 'session-rules', key: 'note' } as const, '')
/** Язык интерфейса; общий для модов xmel-mods, подхватывается из файла. */
const langAtom = atom({ plugin: 'session-rules', key: 'lang' } as const, 'en')

/**
 * Язык для кода вне отрисовки (статус, ответы команд). Отрисовка читает атом,
 * чтобы перерисоваться при смене языка, и кладёт значение сюда.
 */
let L: Lang = 'en'
const S = () => STRINGS[L]

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

const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/^-+|-+$/g, '')

const defaultsKey = (cwd: string) => `defaults:${cwd.toLowerCase()}`

async function rulesDir($: Engine): Promise<string> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  return `${home.replace(/\\/g, '/')}/.claude/session-rules`
}

function parseRule(name: string, text: string): Rule {
  const heading = text.match(/^\s*#\s+(.+)$/m)?.[1]
  const firstLine = text.split(/\r?\n/).find(l => l.trim() !== '')
  return { name, title: (heading ?? firstLine ?? name).trim().slice(0, 80), text: text.trim() }
}

async function loadRules($: Engine): Promise<Rule[]> {
  const dir = await rulesDir($)
  await update($, dirAtom, () => dir)
  if (!(await $.fs.exists(dir))) return []
  const entries = await $.fs.list(dir)
  const out: Rule[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !/\.md$/i.test(entry.name)) continue
    const text = await $.fs.read(`${dir}/${entry.name}`)
    out.push(parseRule(entry.name.replace(/\.md$/i, ''), text))
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function refresh($: Engine) {
  const list = await loadRules($)
  await update($, rules, () => list)
  // Выключаем правила, файлы которых пропали.
  await update($, enabled, cur => cur.filter(n => list.some(r => r.name === n)))
  await showStatus($)
  return list
}

async function showStatus($: Engine) {
  const onNames = await read($, enabled)
  $.ui.status(onNames.length ? S().statusOn(onNames.join(', ')) : S().statusOff)
}

async function setRule($: Engine, name: string, isOn: boolean) {
  await update($, enabled, cur =>
    isOn ? [...new Set([...cur, name])] : cur.filter(n => n !== name),
  )
  await showStatus($)
}

async function toggleDefault($: Engine, name: string) {
  const cwd = await read($, cwdAtom)
  const next = await update($, projectDefaults, list =>
    list.includes(name) ? list.filter(n => n !== name) : [...list, name],
  )
  await $.store.set(defaultsKey(cwd), next)
  return next.includes(name)
}

function findRule(list: readonly Rule[], query: string) {
  const q = slug(query)
  return list.find(r => r.name === q) ?? list.find(r => r.name.startsWith(q))
}

async function askToSave($: Engine, topic: string, dir: string) {
  const name = slug(topic)
  await $.prompt.submit({ text: S().askToSave(topic, dir, name) })
}

async function openFolder($: Engine) {
  const dir = await read($, dirAtom)
  const win = dir.replace(/\//g, '\\')
  if (!(await $.fs.exists(`${dir}/README.txt`))) await $.fs.write(`${dir}/README.txt`, S().readme)
  // explorer.exe и при успехе отвечает кодом 1, поэтому смотрим только на исключения.
  const tries: string[][] = [
    ['explorer.exe', win],
    ['cmd.exe', '/c', 'start', '""', win],
    ['powershell.exe', '-NoProfile', '-Command', `Start-Process -FilePath '${win.replace(/'/g, "''")}'`],
  ]
  const errors: string[] = []
  for (const argv of tries) {
    try {
      await $.process.run(argv, { timeoutMs: 5000 })
      await update($, note, () => S().folderOpened(win))
      return
    } catch (err) {
      errors.push(`${argv[0]}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 120))
    }
  }
  await update($, note, () => S().folderFailed(errors.join('; '), win))
}

async function saveRule($: Engine, name: string, text: string) {
  const dir = await read($, dirAtom)
  const body = text.replace(/\r\n/g, '\n').trimEnd() + '\n'
  await $.fs.write(`${dir}/${name}.md`, body)
  await refresh($)
  await update($, editRule, () => '')
  await update($, openRule, () => name)
  await update($, note, () => S().saved(name))
}

async function createRule($: Engine, title: string) {
  const name = slug(title)
  if (!name) return
  const dir = await read($, dirAtom)
  if (!(await $.fs.exists(`${dir}/${name}.md`))) {
    await $.fs.write(`${dir}/${name}.md`, `# ${title.trim()}\n\n- \n`)
    await refresh($)
  }
  await update($, openRule, () => name)
  await update($, editRule, () => name)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await syncLang($)
    await $.command.register({
      name: 'rules',
      description: S().cmdDescription,
      argumentHint: S().cmdArgumentHint,
    })
    await update($, cwdAtom, () => e.cwd)
    const list = await refresh($)

    const saved = await $.store.get(defaultsKey(e.cwd))
    const defaults = Array.isArray(saved) ? saved.filter((n): n is string => typeof n === 'string') : []
    await update($, projectDefaults, () => defaults)
    // При перезагрузке мода включённое в сессии сохраняется; автоправила добавляем сверху.
    await update($, enabled, cur => [
      ...new Set([...cur, ...defaults.filter(n => list.some(r => r.name === n))]),
    ])
    await showStatus($)
    // Подхватываем новые и изменённые файлы правил без /rules reload.
    $.clock.every(5000, async () => {
      await syncLang($)
      const fresh = await loadRules($)
      const cur = await read($, rules)
      if (JSON.stringify(fresh) !== JSON.stringify(cur)) await refresh($)
    })

    return next(e)
  })

  on('command.run', { command: 'rules' }, async ($, e) => {
    const [verb = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    const arg = rest.join(' ')
    const list = verb === 'reload' ? await refresh($) : await read($, rules)
    const dir = await read($, dirAtom)

    if (verb === '') {
      await $.ui.open({ id: PANE, title: S().paneTitle })
      return { text: S().panelOpened(dir) }
    }
    if (verb === 'help') return { text: S().help }
    if (verb === 'lang') {
      await toggleLang($, parseLang(arg))
      return { text: S().langSet(S().langName) }
    }
    if (verb === 'reload') return { text: S().found(list.length) }
    if (verb === 'list') {
      const onNames = await read($, enabled)
      if (list.length === 0) {
        return { text: S().noneYet(dir) }
      }
      return {
        text: list
          .map(r => `${onNames.includes(r.name) ? '●' : '○'} ${r.name} — ${r.title}`)
          .join('\n'),
      }
    }
    if (verb === 'save') {
      const name = slug(arg)
      if (!name) return { text: S().needName }
      await askToSave($, arg, dir)
      return { text: S().saveAsked(`${dir}/${name}.md`) }
    }
    if (verb === 'on' || verb === 'off' || verb === 'auto') {
      const rule = findRule(list, arg)
      if (!rule) return { text: S().notFound(arg) }
      if (verb === 'auto') {
        const isAuto = await toggleDefault($, rule.name)
        if (isAuto) await setRule($, rule.name, true)
        return { text: isAuto ? S().autoOn(rule.name) : S().autoOff(rule.name) }
      }
      await setRule($, rule.name, verb === 'on')
      return {
        text: verb === 'on' ? S().turnedOn(rule.name) : S().turnedOff(rule.name),
        context: [verb === 'on' ? S().contextOn(rule.name) : S().contextOff(rule.name)],
      }
    }
    return { text: S().help }
  })

  // Кнопки «📏 Правила» у краба (в панели и над полем ввода) открывают нашу панель.
  on('ui.press', { plugin: 'usage-crab', element: 'open-rules' }, async ($, e, next) => {
    await $.ui.open({ id: PANE, title: S().paneTitle })
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const onNames = await read($, enabled)
    if (onNames.length === 0) return composed
    const list = await read($, rules)
    const active = list.filter(r => onNames.includes(r.name))
    if (active.length === 0) return composed
    const text = [
      S().composeTitle,
      S().composeIntro,
      ...active.map(r => S().composeSet(r.name, r.text)),
    ].join('\n')
    return {
      sections: [
        ...composed.sections.filter(s => s.id !== SECTION),
        { id: SECTION, text, scope: 'session' as const },
      ],
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const lang = await read($, langAtom)
    L = lang
    const s = STRINGS[lang]
    const list = await read($, rules)
    const onNames = await read($, enabled)
    const defaults = await read($, projectDefaults)
    const dir = await read($, dirAtom)
    const opened = await read($, openRule)
    const editing = await read($, editRule)
    const message = await read($, note)
    const canEdit = e.surface !== 'mobile' && 'Input' in ui

    const ruleBody = (rule: Rule) => {
      if (editing === rule.name && canEdit) {
        return (
          <Box flexDirection="column" rowGap={1}>
            <ui.Input
              key={`edit-${rule.name}`}
              label={`${rule.name}.md`}
              value={rule.text}
              rows={14}
              submitLabel={s.save}
              autoFocus
              onSubmit={value => saveRule($, rule.name, value)}
            />
            <Text dimColor>{s.editHint}</Text>
            <Box flexDirection="row" columnGap={1}>
              <Button key={`cancel-${rule.name}`} label={s.cancel} onPress={() => update($, editRule, () => '')} />
            </Box>
          </Box>
        )
      }
      return (
        <Box flexDirection="column" rowGap={1}>
          {'Markdown' in ui ? <ui.Markdown text={rule.text} /> : <Text>{rule.text}</Text>}
          {canEdit && (
            <Box flexDirection="row" columnGap={1}>
              <Button key={`edit-btn-${rule.name}`} label={s.edit} onPress={() => update($, editRule, () => rule.name)} />
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" rowGap={1}>
        {list.length === 0 ? (
          <Box flexDirection="column">
            <Text>{s.none}</Text>
            <Text dimColor>{s.noneHint}</Text>
          </Box>
        ) : (
          list.map(rule => {
            const isOn = onNames.includes(rule.name)
            const isAuto = defaults.includes(rule.name)
            const isOpen = opened === rule.name
            return (
              <Box flexDirection="column" rowGap={1}>
                <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap" alignItems="center">
                  <Button
                    key={`toggle-${rule.name}`}
                    variant={isOn ? 'primary' : 'secondary'}
                    onPress={() => setRule($, rule.name, !isOn)}
                  >
                    {isOn ? '● ' : '○ '}
                    {rule.name}
                  </Button>
                  <Button
                    key={`auto-${rule.name}`}
                    plain
                    onPress={async () => { if (await toggleDefault($, rule.name)) await setRule($, rule.name, true) }}
                  >
                    <Text dimColor={!isAuto}>{isAuto ? s.auto : s.notAuto}</Text>
                  </Button>
                  <Button
                    key={`view-${rule.name}`}
                    plain
                    onPress={() => update($, openRule, cur => (cur === rule.name ? '' : rule.name))}
                  >
                    <Text dimColor>{isOpen ? s.hide : s.show}</Text>
                  </Button>
                </Box>
                {isOpen ? ruleBody(rule) : <Text dimColor wrap="truncate-end">{rule.title}</Text>}
              </Box>
            )
          })
        )}
        {canEdit && (
          <Box flexDirection="column" rowGap={1}>
            <ui.Input
              key="create-rule"
              label={s.createManual}
              placeholder={s.createManualPlaceholder}
              submitLabel={s.create}
              onSubmit={value => createRule($, value)}
            />
            <ui.Input
              key="new-rule"
              label={s.createFromSession}
              placeholder={s.createFromSessionPlaceholder}
              submitLabel={s.record}
              onSubmit={value => {
                if (slug(value)) void read($, dirAtom).then(d => askToSave($, value, d))
              }}
            />
          </Box>
        )}
        <Box flexDirection="row" columnGap={1} rowGap={1} flexWrap="wrap">
          <Button key="open-folder" label={s.openFolder} onPress={() => openFolder($)} />
          <Button key="reload" label={s.reload} onPress={() => refresh($)} />
          {/* Панель лимитов открывает мод usage-crab по нажатию этой кнопки. */}
          <Button key="crab" label={s.crabButton} onPress={() => undefined} />
          <Button key="lang-toggle" plain onPress={() => toggleLang($)}>
            <Text>
              <Text dimColor>🌐 </Text>
              <Text weight={lang === 'en' ? 'semibold' : undefined} dimColor={lang !== 'en'}>EN</Text>
              <Text dimColor> · </Text>
              <Text weight={lang === 'ru' ? 'semibold' : undefined} dimColor={lang !== 'ru'}>RU</Text>
            </Text>
          </Button>
        </Box>
        {message ? <Text dimColor>{message}</Text> : <Text dimColor>{s.files(dir)}</Text>}
        <Text dimColor>{s.legend}</Text>
      </Box>
    )
  })
}

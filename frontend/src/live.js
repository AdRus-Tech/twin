// «Живая смена» — демонстрация того, как двойник работает на линии в реальном времени.
// Поток данных имитируется: события — из демонстрационного журнала простоев и из ML-мониторинга
// на синтетической телеметрии. На каждое событие модель линии считает прогноз без мер
// и с рекомендацией; руководитель решает, решение уходит в расчёт оставшейся смены.
import { computed, reactive } from 'vue'
import { api } from './api'
import { expectedFailure, loadMl, logIncident, scenario, wall } from './scenario'

const clone = (x) => JSON.parse(JSON.stringify(x))
const TICK_MS = 100

export const live = reactive({
  status: 'idle', // idle | running | paused | decision | finished
  t: 0,
  speed: 4, // минут смены в секунду
  autopilot: false,
  plan: 120,
  base: null, // выпуск той же смены без происшествий
  output: null, // прогноз выпуска на конец смены с учётом принятых решений
  log: [], // лента событий: { t, kind, text }
  pending: null, // событие, по которому ждём решения
  decisions: [],
  summary: null,
  error: null,
  marks: [], // метки событий сценария на шкале смены
  saved: 0,
  money: 0,
  savingsError: null,
  applying: false,
})

let script = []
let committed = [] // остановки, которые уже есть в расчёте смены
let scheduled = [] // будущие аварии, если по предупреждению решили не действовать
let timer = null
let last = 0
let autoTimer = null
let session = 0

// Оставляем места для автоматических событий, которые ещё придут в смене.
export const canAddEvent = computed(() => ['running', 'paused'].includes(live.status)
  && live.decisions.length + script.filter((s) => !s.done).length < (scenario.limits?.extra_stoppages ?? 8))

const horizon = () => scenario.preset.horizon_min
const stationName = (id) => scenario.preset.stations.find((s) => s.id === id)?.name ?? id
const params = (stoppage = null, extra = committed) => {
  const p = clone(scenario.preset)
  delete p.label
  p.stoppage = stoppage
  p.extra_stoppages = clone(extra)
  return p
}
const idleOf = (run) => run.stations.reduce((m, s) => m + s.blocked_min + s.starved_min, 0)
const tenge = (cars, idleMin) => cars * scenario.econ.margin + (idleMin / 60) * scenario.econ.idleCost

function say(kind, text, t = live.t) {
  live.log.unshift({ t: Math.round(t), clock: wall(t), kind, text })
}

/** Сценарий смены: внезапный сбой из демонстрационного журнала + предупреждения ML демонстрационной смены. */
function buildScript() {
  const items = [withRec({
    t: 100, kind: 'fail', station: 'welding', equipment: 'ABB-01', reason: 'ошибка датчика',
    none: { duration: 25, text: 'ремонт 25 мин — как в журнале простоев (01.10)' },
    rec: { duration: 10 },
    note: 'Внезапный сбой: предвестника в телеметрии не было, ML его не предупреждал.',
  })]
  for (const e of scenario.ml?.equipment ?? []) {
    const a = e.alarms[0]
    if (!e.predictable || !a) continue
    const failAt = e.failures.find((f) => f > a.t) ?? expectedFailure(e, a)
    items.push(withRec({
      t: a.t, kind: 'ml', eqId: e.id, station: e.station, equipment: e.name, reason: e.failure,
      risk: a.risk, why: a.why, failAt,
      none: { start: failAt, duration: e.repair_min, text: `работать до отказа: авария ~${wall(failAt)}, аварийный ремонт ${e.repair_min} мин` },
      rec: { duration: e.planned_min },
    }))
  }
  return items.sort((x, y) => x.t - y.t)
}

// Текст рекомендации зависит от срока ремонта, который руководитель может подвинуть.
const REC_TEXT = {
  fail: (d) => `запасной датчик со склада у линии — ${d} мин`,
  ml: (d) => `плановая замена сейчас — ${d} мин, до аварии`,
  manual: (d) => `резервная бригада и запчасть у линии — ремонт ~${d} мин`,
}
function withRec(item) {
  item.rec.text = REC_TEXT[item.kind](item.rec.duration)
  return item
}

/** Остановка по варианту решения: часть внутри смены и перенос на следующую. */
function stopOf(item, option) {
  const start = Math.min(Math.round(option.start ?? item.t), horizon() - 1)
  const inShift = Math.max(0, Math.min(option.duration, horizon() - start))
  return { stop: { station: item.station, start_min: start, duration_min: inShift }, carry: option.duration - inShift }
}

// Потери следующей смены от ремонта, перешедшего через пересменку (та же модель, остановка с 0-й минуты).
function stopsFor(variant) {
  const stops = []
  const carry = []
  for (const d of live.decisions) {
    const opt = d.p[variant === 'actual' ? d.choice : variant]
    stops.push(opt.stop)
    if (opt.carry) carry.push({ station: d.item.station, start_min: 0, duration_min: opt.carry })
  }
  return { stops, carry }
}

async function carryOutcome(stops) {
  if (!stops.length) return { cars: 0, idle: 0 }
  const run = await api.run(params(null, stops))
  return { cars: live.base - run.output_units, idle: idleOf(run) - live.baseIdle }
}

async function carryLoss(station, minutes) {
  if (!minutes) return { cars: 0, idle: 0 }
  const prior = stopsFor('actual').carry
  const [before, after] = await Promise.all([
    carryOutcome(prior),
    carryOutcome([...prior, { station, start_min: 0, duration_min: minutes }]),
  ])
  return { cars: after.cars - before.cars, idle: after.idle - before.idle }
}

async function outcome(variant, run = null) {
  const stops = stopsFor(variant)
  const [current, carry] = await Promise.all([
    run ?? api.run(params(null, stops.stops)), carryOutcome(stops.carry),
  ])
  return { run: current, carry }
}

/** Эффект решений по всей смене: перекрывающиеся остановки учитываются один раз. */
async function refreshSavings(run, includeRec = false) {
  const seq = session
  try {
    const [none, actual, rec] = await Promise.all([
      outcome('none'), outcome('actual', run), includeRec ? outcome('rec') : null,
    ])
    if (seq !== session) return null
    live.saved = actual.run.output_units - actual.carry.cars - (none.run.output_units - none.carry.cars)
    const idle = idleOf(none.run) + none.carry.idle - idleOf(actual.run) - actual.carry.idle
    live.money = tenge(live.saved, idle)
    live.savingsError = null
    return { none, actual, rec }
  } catch (e) {
    if (seq === session) {
      live.saved = null
      live.money = null
      live.savingsError = `Эффект решений не удалось пересчитать: ${e.message}`
    }
    return null
  }
}

async function showRun(run) {
  scenario.result = { a: run, b: run, comparison: null }
  live.output = run.output_units
}

/** Экран перед стартом: линия без происшествий на 08:00. */
export async function prepareLive() {
  scenario.live = true
  // Вернулись из аналитики в идущую смену — продолжаем с того же места.
  if (live.status !== 'idle') {
    scenario.minute = live.t
    return
  }
  scenario.minute = 0
  live.t = 0
  try {
    const base = await api.run(params(null, []))
    live.base = base.output_units
    live.baseIdle = idleOf(base)
    if (live.status === 'idle') await showRun(base)
  } catch (e) {
    live.error = e.message
  }
}

export async function startLive() {
  session++
  stopTimer()
  clearTimeout(autoTimer)
  live.error = null
  try {
    if (!scenario.ml) await loadMl()
    script = buildScript()
    live.marks = script.map((s) => ({ t: s.t, kind: s.kind }))
    committed = []
    scheduled = []
    Object.assign(live, { status: 'running', t: 0, log: [], pending: null, decisions: [], summary: null,
      saved: 0, money: 0, savingsError: null, applying: false })
    scenario.live = true
    scenario.mlResolved = {}
    scenario.event = null
    scenario.view = 'a'
    scenario.playing = false
    scenario.minute = 0
    const base = await api.run(params(null, []))
    live.base = base.output_units
    live.baseIdle = idleOf(base)
    await showRun(base)
    say('info', `Смена началась. План — ${live.plan} машин (демонстрационные данные), модель линии без происшествий даёт ${live.base}.`, 0)
    startTimer()
  } catch (e) {
    live.error = e.message
    live.status = 'idle'
  }
}

export function pauseLive() {
  if (live.status === 'running') live.status = 'paused'
}
export function resumeLive() {
  if (live.status === 'paused') {
    live.status = 'running'
    startTimer()
  }
}

export function stopLive() {
  session++
  stopTimer()
  clearTimeout(autoTimer)
  scenario.live = false
  scenario.mlResolved = {}
  if (live.status !== 'idle') scenario.result = null
  live.status = 'idle'
  live.pending = null
  live.applying = false
}

function startTimer() {
  stopTimer()
  last = performance.now()
  timer = setInterval(tick, TICK_MS)
}
function stopTimer() {
  clearInterval(timer)
  timer = null
}

async function tick() {
  if (live.status !== 'running') return stopTimer()
  const now = performance.now()
  const next = Math.min(horizon(), live.t + ((now - last) / 1000) * live.speed)
  last = now
  // Плановая авария (по предупреждению решили не действовать) — без паузы.
  const due = scheduled.find((s) => s.t <= next)
  if (due) {
    scheduled = scheduled.filter((s) => s !== due)
    setTime(due.t)
    say('fail', due.text, due.t)
    logIncident(due.incident)
  }
  const item = script.find((s) => s.t > live.t - 1e-9 && s.t <= next && !s.done)
  if (item) {
    setTime(item.t)
    item.done = true
    stopTimer()
    if (!await raise(item)) item.done = false
    return
  }
  setTime(next)
  if (next >= horizon()) await finish()
}

function setTime(t) {
  live.t = t
  scenario.minute = t
}

/** Событие на линии: прогноз без мер и с рекомендацией, ждём решения. */
async function raise(item) {
  const seq = session
  live.error = null
  live.status = 'decision'
  const name = stationName(item.station)
  if (item.kind === 'fail') say('fail', `${name} · ${item.equipment}: ${item.reason} — участок встал.`)
  else if (item.kind === 'manual') say('fail', `${name}${item.equipment !== '—' ? ` · ${item.equipment}` : ''}: ${item.reason} — сообщил руководитель смены.`)
  else say('alarm', `ML: ${item.equipment} — риск «${item.reason}» ${Math.round(item.risk * 100)}% в ближайшие 2 ч.`)
  try {
    const none = stopOf(item, item.none)
    const rec = stopOf(item, item.rec)
    const res = await api.compare(params(none.stop), params(rec.stop))
    const [ca, cb] = await Promise.all([carryLoss(item.station, none.carry), carryLoss(item.station, rec.carry)])
    if (seq !== session) return false
    const before = live.output
    const cars = res.b.output_units - res.a.output_units + (ca.cars - cb.cars)
    const idle = idleOf(res.a) - idleOf(res.b) + (ca.idle - cb.idle)
    live.pending = {
      item, name, none, rec, runA: res.a, runB: res.b,
      outA: res.a.output_units, outB: res.b.output_units,
      before, lossA: before - res.a.output_units, lossB: before - res.b.output_units,
      carryA: none.carry ? { min: none.carry, cars: ca.cars, idle: ca.idle } : null,
      carryB: rec.carry ? { min: rec.carry, cars: cb.cars, idle: cb.idle } : null,
      cars, idle: Math.round(idle), money: tenge(cars, idle),
      recMin: Math.min(5, item.none.duration), recMax: item.none.duration, ai: null,
      recalculating: false, recError: null,
    }
    // На сцене и в прогнозе — что будет без мер.
    scenario.result = { a: res.a, b: res.b, comparison: null }
    scenario.view = 'a'
    if (live.autopilot) autoTimer = setTimeout(() => decide('rec'), 2500)
    return true
  } catch (e) {
    if (seq !== session) return false
    live.error = e.message
    live.status = 'paused'
    return false
  }
}

export async function decide(choice) {
  clearTimeout(autoTimer)
  const p = live.pending
  if (!p || !['rec', 'none'].includes(choice)) return
  if (choice === 'rec' && (p.recalculating || p.recError || p.item.rec.duration !== p.rec.stop.duration_min + p.rec.carry)) return
  const seq = session
  live.applying = true
  live.pending = null
  const { item, name } = p
  const opt = choice === 'rec' ? p.rec : p.none
  committed.push(opt.stop)
  const run = choice === 'rec' ? p.runB : p.runA
  live.decisions.push({ item, choice, name, saved: choice === 'rec' ? p.cars : 0, money: choice === 'rec' ? p.money : 0, p })
  if (item.kind === 'ml') scenario.mlResolved = { ...scenario.mlResolved, [item.eqId]: item.t }
  const impact = (r, carry) => ({ lossCars: live.base - r.output_units + (carry?.cars ?? 0), idleMin: Math.round(idleOf(r)), output: r.output_units })
  if (choice === 'rec') {
    const gains = [p.cars > 0 && `сбережено ${p.cars} маш.`, p.idle > 0 && `простой соседей −${p.idle} мин`].filter(Boolean)
    say('decision', `Решение: ${item.rec.text}${gains.length ? ` → ${gains.join(', ')}` : ''}.`)
    await logIncident({
      station: item.station, name, start: opt.stop.start_min, duration: item.rec.duration, equipment: item.equipment,
      reason: item.kind === 'ml' ? `${item.reason}: плановая замена по ML` : item.reason, source: item.kind === 'ml' ? 'ml' : 'manual',
      impact: impact(run, p.carryB), status: 'work',
    })
  } else if (item.kind === 'ml') {
    say('decision', `Решение: работать до отказа. Модель ждёт аварию ~${wall(item.failAt)}.`)
    scheduled.push({
      t: Math.min(item.failAt, horizon()),
      text: `${name} · ${item.equipment}: ${item.reason} — авария, ремонт ${item.none.duration} мин.`,
      incident: {
        station: item.station, name, start: Math.min(item.failAt, horizon() - 1), duration: item.none.duration, equipment: item.equipment,
        reason: `${item.reason} (авария)`, source: 'ml', impact: impact(run, p.carryA),
      },
    })
  } else {
    say('decision', `Решение: ремонт своими силами, ${item.none.duration} мин.`)
    await logIncident({
      station: item.station, name, start: opt.stop.start_min, duration: item.none.duration, equipment: item.equipment,
      reason: item.reason, source: 'manual', impact: impact(run, p.carryA), status: 'work',
    })
  }
  if (seq !== session) return
  await showRun(run)
  await refreshSavings(run)
  if (seq !== session) return
  live.applying = false
  live.status = 'running'
  startTimer()
}

async function finish() {
  const seq = session
  stopTimer()
  live.status = 'finished'
  scenario.minute = horizon()
  const totals = await refreshSavings(scenario.result.a, true)
  if (seq !== session) return
  const noneOut = totals?.none.run.output_units ?? null
  const recOut = totals?.rec.run.output_units ?? null
  const noneCarry = totals?.none.carry.cars ?? null
  const carry = totals?.actual.carry.cars ?? null
  const missed = totals ? recOut - totals.rec.carry.cars - (live.output - carry) : null
  const { saved, money } = live
  live.summary = { fact: live.output, plan: live.plan, base: live.base, noneOut, noneCarry, recOut, missed, carry, saved, money,
    comparisonAvailable: !!totals, events: live.decisions.length }
  say('ok', `Смена закончилась: ${live.output} машин при плане ${live.plan}.${saved > 0 ? ` Решения сберегли ${saved} маш.` : ''}`, horizon())
}

/** Руководитель двигает срок ремонта в рекомендации — пересчитываем только её. */
let recSeq = 0
export function previewRecDuration(minutes) {
  const p = live.pending
  if (!p) return
  clearTimeout(autoTimer)
  recSeq++
  p.item.rec.duration = Math.max(p.recMin, Math.min(p.recMax, Math.round(minutes)))
  withRec(p.item)
  p.recalculating = true
  p.recError = null
}

export async function setRecDuration(minutes) {
  const p = live.pending
  if (!p) return
  const { item } = p
  previewRecDuration(minutes)
  const seq = recSeq
  const rec = stopOf(item, item.rec)
  try {
    const [run, carry] = await Promise.all([api.run(params(rec.stop)), carryLoss(item.station, rec.carry)])
    if (seq !== recSeq || live.pending !== p) return
    const ca = p.carryA ? { cars: p.carryA.cars, idle: p.carryA.idle ?? 0 } : { cars: 0, idle: 0 }
    const cars = run.output_units - p.outA + (ca.cars - carry.cars)
    const idle = idleOf(p.runA) - idleOf(run) + (ca.idle - carry.idle)
    Object.assign(p, {
      rec, runB: run, outB: run.output_units, lossB: p.before - run.output_units,
      carryB: rec.carry ? { min: rec.carry, cars: carry.cars, idle: carry.idle } : null,
      cars, idle: Math.round(idle), money: tenge(cars, idle),
    })
    if (live.autopilot) autoTimer = setTimeout(() => decide('rec'), 2500)
  } catch (e) {
    if (seq === recSeq && live.pending === p) p.recError = e.message
  } finally {
    if (seq === recSeq && live.pending === p) p.recalculating = false
  }
}

/** ИИ по текущему событию: объяснение и своя мера; модель проверяет каждую. */
export async function askAi() {
  const p = live.pending
  if (!p) return
  clearTimeout(autoTimer)
  p.ai = { busy: true }
  try {
    const res = await api.aiPropose(params(p.none.stop))
    if (live.pending !== p) return
    const props = res.ai?.result?.proposals ?? []
    p.ai = { busy: false, ans: res.ai, best: props.find((c) => c.best) ?? null, proposals: props }
  } catch (e) {
    p.ai = { busy: false, error: e.message }
  }
}

/** Событие, которое руководитель ввёл сам, — в текущую минуту идущей смены. */
export async function injectEvent({ station, duration, reason, equipment, message = '', parsedBy = '' }) {
  if (!['running', 'paused'].includes(live.status)) throw new Error('Смена не идёт')
  if (!canAddEvent.value) throw new Error('Лимит событий смены достигнут. Оставшиеся места зарезервированы для автоматических событий.')
  stopTimer()
  const d = Math.max(1, Math.round(duration))
  if (message) say('info', `Сообщение с линии: «${message}»`)
  const item = withRec({
    t: Math.min(Math.round(live.t), horizon() - 1), kind: 'manual', station, equipment: equipment || '—', reason: reason || 'остановка',
    none: { duration: d, text: `ремонт ${d} мин — ${message ? 'из сообщения' : 'оценка руководителя'}` },
    rec: { duration: Math.max(Math.min(10, d), Math.round(d / 2)) },
    note: message ? `«${message}» — ${parsedBy === 'ai' ? 'разобрал ИИ' : 'разобрано по ключевым словам'}.` : 'Событие введено руководителем смены.',
    message,
  })
  item.done = true
  setTime(item.t)
  if (!await raise(item)) throw new Error(live.error ?? 'Не удалось рассчитать событие')
}

/**
 * Сообщение рабочего свободным текстом: разбор (ИИ или правила) → событие в текущую минуту смены.
 * Если участок или длительность не понятны — возвращаем разобранное, чтобы руководитель уточнил в форме.
 */
export async function sendLineMessage(text) {
  if (!['running', 'paused'].includes(live.status)) throw new Error('Смена не идёт')
  const wasRunning = live.status === 'running'
  pauseLive()
  try {
    const parsed = await api.parseReport(text)
    if (parsed.missing.length) {
      if (wasRunning) resumeLive()
      return { needsForm: true, parsed }
    }
    await injectEvent({
      station: parsed.station, duration: parsed.duration_min, reason: parsed.reason, equipment: parsed.equipment,
      message: text.trim(), parsedBy: parsed.source,
    })
    return { needsForm: false, parsed }
  } catch (e) {
    if (wasRunning && live.status === 'paused') resumeLive()
    throw e
  }
}

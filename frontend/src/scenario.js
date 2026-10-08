import { computed, reactive, watch } from 'vue'
import { api } from './api'

const STORE = 'twin.'
function load(key, fallback) {
  try {
    const raw = localStorage.getItem(STORE + key)
    if (!raw) return fallback
    const value = JSON.parse(raw)
    if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback
    return { ...fallback, ...value }
  } catch {
    return fallback
  }
}
function save(key, value) {
  try {
    localStorage.setItem(STORE + key, JSON.stringify(value))
    return true
  } catch {
    // хранилище недоступно (приватный режим) — журнал живёт до перезагрузки
    return false
  }
}

// Сценарий A — параметры пользователя (по умолчанию синтетический пример).
// Сценарий B — копия A с изменёнными полями: вручную или по предложению ИИ.
export const scenario = reactive({
  preset: null,
  limits: null,
  a: null,
  b: null,
  bOrigin: 'user', // 'user' | 'ai'
  result: null, // { a, b, comparison }
  running: false,
  error: null,
  fieldErrors: {},
  view: 'a',
  minute: 0,
  playing: false,
  speed: 20, // минут модели в секунду
  ai: { busy: null, propose: null, explain: null, error: null, ms: {}, proposeRun: null },
  // Та же смена без остановки — точка отсчёта для потерь к месячному плану.
  baseline: null,
  // Месячная цель и сменность берутся из демонстрационных данных; рабочие дни — допущение.
  month: { target: null, shiftsPerDay: null, workdays: 22 },
  // Начало смены по часам (минуты от полуночи) — допущение для ввода событий.
  shiftStart: 8 * 60,
  // Событие, введённое руководителем смены.
  event: null,
  // Журнал инцидентов смены: в базе на сервере; без сервера — в этом браузере.
  incidents: load('incidents', []).map((i) => ({ ...i, _saving: false,
    _legacy: i._legacy ?? (i.client_id === undefined && i._local === undefined) })),
  incidentsStore: 'server', // 'server' | 'local'
  incidentsError: null,
  incidentsSyncing: false,
  // Прогноз отказов оборудования (ML) на демонстрационной смене.
  ml: null,
  mlError: null,
  // Живая смена: интерфейс показывает одну текущую смену, без сравнения вариантов.
  live: false,
  // Оборудование, по предупреждению которого уже принято решение (id → минута).
  mlResolved: {},
  // Экономика — только допущения пользователя, значения-примеры помечены в интерфейсе.
  econ: load('econ', { margin: 500000, idleCost: 150000, perMonth: 4 }),
})

// Журнал и допущения экономики переживают перезагрузку страницы (в этом браузере).
function persistIncidents() {
  const saved = save('incidents', scenario.incidents.map((i) => ({ ...i, _saving: false })))
  if (!saved && scenario.incidents.some((i) => i._local)) {
    scenario.incidentsError = 'Браузер не разрешил сохранить журнал. Локальные записи исчезнут при закрытии страницы.'
  }
}
watch(() => scenario.incidents, persistIncidents, { deep: true })

export async function loadMl() {
  try {
    scenario.ml = await api.mlShift()
    scenario.mlError = null
  } catch (e) {
    scenario.mlError = e.message
  }
}

let loadingIncidents = null
export function loadIncidents() {
  if (loadingIncidents) return loadingIncidents
  loadingIncidents = refreshIncidents().finally(() => { loadingIncidents = null })
  return loadingIncidents
}

async function uploadIncident(inc) {
  inc._saving = true
  try {
    const { _local, _saving, _legacy, n, id, at, updated, ...draft } = inc
    let saved = await api.createIncident(draft)
    // Первый POST мог сохраниться на сервере, хотя его ответ потерялся.
    if (saved.status !== inc.status) saved = await api.updateIncident(saved.n, { status: inc.status })
    Object.assign(inc, saved, { _local: false })
  } finally {
    inc._saving = false
    persistIncidents()
  }
}

async function refreshIncidents() {
  scenario.incidentsSyncing = true
  scenario.incidentsError = null
  try {
    const remote = await api.incidents()
    // Старый формат локального журнала не имел признака неотправленной записи.
    // Сохраняем записи, которым нет соответствия на сервере, при обновлении приложения.
    for (const inc of scenario.incidents.filter((i) => i._legacy)) {
      if (!remote.some((r) => r.id === inc.id && r.at === inc.at)) {
        inc.client_id = crypto.randomUUID()
        inc.id = `LOCAL-${inc.client_id.slice(0, 8)}`
        inc._local = true
      }
      inc._legacy = false
    }
    const pending = scenario.incidents.filter((i) => i._local)
    const ids = new Set(pending.map((i) => i.client_id))
    scenario.incidents = [...pending, ...remote.filter((i) => !ids.has(i.client_id))]
    for (const inc of scenario.incidents.filter((i) => i._local && !i._saving)) {
      try {
        await uploadIncident(inc)
      } catch (e) {
        scenario.incidentsError = `Запись сохранена в браузере, отправка на сервер не удалась: ${e.message}`
      }
    }
    scenario.incidentsStore = scenario.incidents.some((i) => i._local) ? 'local' : 'server'
  } catch (e) {
    scenario.incidentsStore = 'local'
    scenario.incidentsError = `Сервер недоступен: ${e.message}. Показана сохранённая копия журнала.`
  } finally {
    persistIncidents()
    scenario.incidentsSyncing = false
  }
}
watch(() => scenario.econ, (v) => save('econ', v), { deep: true })

const clone = (x) => JSON.parse(JSON.stringify(x))

export async function loadPreset() {
  if (scenario.preset) return
  const data = await api.preset()
  scenario.preset = data.params
  scenario.limits = data.limits
  resetToPreset()
}

export function resetToPreset() {
  const p = clone(scenario.preset)
  delete p.label
  scenario.a = p
  scenario.b = clone(p)
  scenario.b.stoppage.duration_min = 20
  scenario.bOrigin = 'user'
  scenario.result = null
  scenario.event = null
  scenario.ai.propose = null
  scenario.ai.explain = null
  scenario.minute = 0
}

/** Поля, которыми B отличается от A, — для подписи «что изменено». */
function diffParams(a, b) {
  if (!a || !b) return []
  const out = []
  const sa = a.stoppage || {}
  const sb = b.stoppage || {}
  if (sa.duration_min !== sb.duration_min) out.push({ label: 'Ремонт, мин', short: `ремонт ${sb.duration_min} мин`, a: sa.duration_min, b: sb.duration_min })
  a.buffers.forEach((buf, i) => {
    const other = b.buffers[i]
    const where = `перед участком «${a.stations[i + 1].name}»`
    if (buf.capacity !== other.capacity) out.push({ label: `Мест в накопителе ${where}`, short: `накопитель: ${other.capacity} мест`, a: buf.capacity, b: other.capacity })
    if (buf.initial !== other.initial) out.push({ label: `Машин в накопителе ${where} в начале`, short: `запас: ${other.initial} машин`, a: buf.initial, b: other.initial })
  })
  return out
}

// Различия в полях ввода и в том, что реально посчитано (для подписей результата).
export const differences = computed(() => diffParams(scenario.a, scenario.b))
export const resultDifferences = computed(() => diffParams(scenario.result?.a.params, scenario.result?.b.params))

// В интерфейсе A и B — это прогноз без мер и прогноз с рекомендованной мерой.
// Буквы остаются только в коде и в API.
export const VARIANT = { a: 'без мер', b: 'с рекомендацией' }

/** Рекомендованная мера (чем B отличается от A) — как действие для руководителя смены. */
export const measure = computed(() => {
  const d = resultDifferences.value
  if (!d.length) return 'мер нет'
  const ev = scenario.event
  return d.map((x) => {
    if (x.label !== 'Ремонт, мин') return x.short
    if (ev?.source === 'ml' && x.b === ev.bDuration) return `плановая замена сейчас, ${x.b} мин, — до аварии`
    return `ускорить ремонт до ${x.b} мин (вместо ${x.a})`
  }).join(', ')
})

// Автопересчёт: расчёт занимает доли секунды, поэтому после правки полей
// результат обновляется сам — без «старых» чисел рядом с новыми параметрами.
let lastRunKey = null
let timer = null
const paramsKey = () => JSON.stringify([scenario.a, scenario.b?.stoppage?.duration_min, scenario.b?.buffers])
watch(paramsKey, (key) => {
  if (!scenario.result || key === lastRunKey) return
  clearTimeout(timer)
  timer = setTimeout(() => {
    if (paramsKey() !== lastRunKey && !scenario.running) runBoth()
  }, 450)
})

/** Общие параметры A копируются в B; различия B сохраняются. */
export function syncSharedToB() {
  const keepDuration = scenario.b.stoppage?.duration_min ?? 0
  const keepBuffers = scenario.b.buffers
  const next = clone(scenario.a)
  if (next.stoppage) next.stoppage.duration_min = keepDuration
  if (scenario.bOrigin === 'ai') next.buffers = clone(keepBuffers)
  scenario.b = next
}

export async function runBoth() {
  scenario.running = true
  scenario.error = null
  scenario.fieldErrors = {}
  scenario.ai.explain = null
  try {
    syncSharedToB()
    lastRunKey = paramsKey()
    scenario.result = await api.compare(scenario.a, scenario.b)
    scenario.minute = Math.min(scenario.minute, scenario.a.horizon_min)
    await refreshBaseline()
  } catch (e) {
    scenario.error = e.message
    scenario.fieldErrors = e.fields || {}
  } finally {
    scenario.running = false
  }
}

let baselineKey = null
/** Смена с теми же тактами и накопителями, но без остановки. */
async function refreshBaseline() {
  const base = { ...JSON.parse(JSON.stringify(scenario.a)), stoppage: null }
  const key = JSON.stringify(base)
  if (key === baselineKey && scenario.baseline) return
  try {
    scenario.baseline = await api.run(base)
    baselineKey = key
  } catch {
    scenario.baseline = null
  }
}

/**
 * Событие с линии, введённое руководителем: участок, время по часам, оценка ремонта.
 * Становится вариантом A; вариант B — тот же случай при ремонте вдвое быстрее.
 */
export async function applyEvent({ station, clockMin, duration, reason, equipment, bDuration, source = 'manual' }) {
  const start = clockMin - scenario.shiftStart
  const horizon = scenario.a.horizon_min
  if (start < 0 || start >= horizon) {
    throw new Error(`Время вне смены: смена идёт с ${wall(0)} до ${wall(horizon)}`)
  }
  const name = scenario.a.stations.find((s) => s.id === station)?.name ?? station
  await showEvent({ station, name, start, duration, bDuration, source, reason: reason?.trim() || '', equipment: equipment || '', at: new Date().toISOString() })
  if (!scenario.result || scenario.error) return
  // Инцидент в журнал: приоритет — по последствиям в модели.
  await recordIncident(scenario.event, source)
}

/** Записать текущее событие в журнал с последствиями по модели. */
async function recordIncident(evt, source) {
  const impact = eventImpact()
  await logIncident({
    station: evt.station, name: evt.name, start: evt.start, duration: evt.duration,
    reason: evt.reason, equipment: evt.equipment, source, impact,
  })
}

/** Запись в журнал инцидентов: на сервере, без сервера — в этом браузере. Приоритет — по потерям в модели. */
export async function logIncident({ station, name, start, duration, reason, equipment, source = 'manual', impact, status }) {
  const draft = {
    station, name, start, clock: wall(start), duration,
    reason: reason || '', equipment: equipment || '', source,
    impact, priority: impact.lossCars >= 4 ? 'high' : impact.lossCars >= 1 ? 'medium' : 'low',
  }
  const n = scenario.incidents.reduce((m, i) => Math.max(m, i.n), 0) + 1
  const now = new Date().toISOString()
  const client_id = crypto.randomUUID()
  scenario.incidents.unshift({ n, id: `LOCAL-${client_id.slice(0, 8)}`, client_id,
    status: status ?? 'new', ...draft, at: now, updated: now, _local: true, _saving: false })
  const inc = scenario.incidents[0]
  persistIncidents()
  try {
    await uploadIncident(inc)
    scenario.incidentsError = null
    scenario.incidentsStore = scenario.incidents.some((i) => i._local) ? 'local' : 'server'
  } catch (e) {
    scenario.incidentsStore = 'local'
    scenario.incidentsError = `Запись сохранена в браузере, отправка на сервер не удалась: ${e.message}`
    persistIncidents()
  }
  return inc
}

/** Событие становится вариантом A, вариант B — тот же случай при ремонте вдвое быстрее. */
async function showEvent(evt) {
  scenario.a.stoppage = { station: evt.station, start_min: evt.start, duration_min: evt.duration }
  scenario.b = clone(scenario.a)
  scenario.b.stoppage.duration_min = evt.bDuration ?? Math.max(Math.min(10, evt.duration), Math.round(evt.duration / 2))
  scenario.bOrigin = 'user'
  scenario.view = 'a'
  scenario.playing = false
  scenario.ai.propose = null
  scenario.ai.explain = null
  scenario.event = { station: evt.station, name: evt.name, start: evt.start, duration: evt.duration, bDuration: evt.bDuration, source: evt.source ?? 'manual', reason: evt.reason, equipment: evt.equipment, at: evt.at }
  scenario.minute = evt.start
  await runBoth()
  scenario.minute = evt.start
}

/** Последствия текущего варианта A: потерянные машины и простой соседних участков. */
function eventImpact() {
  const a = scenario.result.a
  const base = scenario.baseline?.output_units ?? null
  const st = a.params.stoppage?.station
  const idle = a.stations.filter((s) => s.id !== st).reduce((m, s) => m + s.blocked_min + s.starved_min, 0)
  return { lossCars: base === null ? null : base - a.output_units, idleMin: Math.round(idle), output: a.output_units }
}

export async function setIncidentStatus(id, status) {
  const inc = scenario.incidents.find((i) => i.id === id)
  if (!inc || inc._saving || scenario.incidentsSyncing) return
  scenario.incidentsError = null
  if (!inc._local) {
    inc._saving = true
    try {
      Object.assign(inc, await api.updateIncident(inc.n, { status }))
    } catch (e) {
      scenario.incidentsError = `Статус не сохранён: ${e.message}. Попробуйте снова после восстановления связи.`
    } finally {
      inc._saving = false
      persistIncidents()
    }
    return
  }
  Object.assign(inc, { status, updated: new Date().toISOString() })
  persistIncidents()
}

export async function removeIncident(id) {
  const inc = scenario.incidents.find((i) => i.id === id)
  if (!inc || inc._saving || scenario.incidentsSyncing) return
  scenario.incidentsError = null
  if (!inc._local) {
    inc._saving = true
    try {
      await api.deleteIncident(inc.n)
    } catch (e) {
      scenario.incidentsError = `Инцидент не удалён: ${e.message}`
      return
    } finally {
      inc._saving = false
    }
  }
  scenario.incidents = scenario.incidents.filter((i) => i.id !== id)
  persistIncidents()
}

/** Открыть расчёт по инциденту: подставить его как вариант A. */
export const openIncident = (inc) => showEvent(inc)

export async function askPropose() {
  scenario.ai.busy = 'propose'
  scenario.ai.error = null
  scenario.ai.propose = null
  scenario.ai.proposeRun = null
  const t0 = performance.now()
  try {
    const res = await api.aiPropose(scenario.a)
    scenario.ai.ms.propose = performance.now() - t0
    scenario.ai.propose = res.ai
    scenario.ai.proposeRun = { a: res.a.output_units, b: res.b?.output_units ?? null }
    if (res.b_params) {
      scenario.b = res.b_params
      lastRunKey = paramsKey()
      scenario.bOrigin = 'ai'
      scenario.result = { a: res.a, b: res.b, comparison: res.comparison }
      scenario.ai.explain = null
      await refreshBaseline()
    }
  } catch (e) {
    scenario.ai.error = e.message
  } finally {
    scenario.ai.busy = null
  }
}

export async function askExplain() {
  scenario.ai.busy = 'explain'
  scenario.ai.error = null
  scenario.ai.explain = null
  const t0 = performance.now()
  try {
    const res = await api.aiExplain(scenario.a, scenario.b)
    scenario.ai.ms.explain = performance.now() - t0
    scenario.ai.explain = res.ai
    scenario.result = { a: res.a, b: res.b, comparison: res.comparison }
  } catch (e) {
    scenario.ai.error = e.message
  } finally {
    scenario.ai.busy = null
  }
}

export const currentRun = computed(() => scenario.result?.[scenario.view] ?? null)

export const currentFrame = computed(() => {
  const run = currentRun.value
  if (!run) return null
  return run.frames[Math.min(Math.round(scenario.minute), run.frames.length - 1)]
})

/** Минуты от начала смены → время по часам (начало смены — допущение). */
export function wall(min) {
  const t = Math.round(scenario.shiftStart + min) % (24 * 60)
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`
}

/**
 * Прогноз последствий на текущей минуте проигрывания: что происходит сейчас
 * и какие простои модель ожидает дальше (по эпизодам расчёта, не по истории).
 */
export const forecast = computed(() => {
  const run = currentRun.value
  if (!run) return null
  const t = scenario.minute
  const now = run.events.filter((e) => e.start_min <= t && t < e.end_min)
  const next = run.events.filter((e) => e.start_min > t)
  const byStation = {}
  for (const e of next) if (!(e.station in byStation)) byStation[e.station] = { state: e.state, in: e.start_min - t }
  return { t, now, next: next.slice(0, 3), more: Math.max(0, next.length - 3), byStation, output: run.output_units }
})

/** Связь смены с месячной целью: нужный темп, потери от остановки, темп месяца. */
export const monthly = computed(() => {
  const r = scenario.result
  const m = scenario.month
  if (!r || !m.target || !m.shiftsPerDay || !(m.workdays > 0)) return null
  const shifts = m.shiftsPerDay * m.workdays
  const base = scenario.baseline?.output_units ?? null
  const a = r.a.output_units
  const b = r.b.output_units
  return {
    target: m.target,
    shifts,
    need: Math.ceil(m.target / shifts),
    base,
    a,
    b,
    lossA: base === null ? null : base - a,
    lossB: base === null ? null : base - b,
    pace: { base: base === null ? null : base * shifts, a: a * shifts, b: b * shifts },
  }
})

/** Узкое место линии — самый медленный участок: он задаёт потолок выпуска. */
export const bottleneck = computed(() => {
  const p = scenario.result?.a.params ?? scenario.a
  if (!p) return null
  const st = p.stations.reduce((x, y) => (y.cycle_s > x.cycle_s ? y : x))
  return { id: st.id, name: st.name, cycle: st.cycle_s, cap: Math.floor((p.horizon_min * 60) / st.cycle_s) }
})

/**
 * Эффект в деньгах по допущениям пользователя: машины × маржа + простой соседей × ставка.
 * B против A — за одно событие; в месяц — при заданном числе таких событий.
 */
export const economy = computed(() => {
  const r = scenario.result
  const e = scenario.econ
  if (!r || !(e.margin >= 0) || !(e.idleCost >= 0) || !(e.perMonth >= 0)) return null
  const st = r.a.params.stoppage?.station
  const idle = (run) => run.stations.filter((s) => s.id !== st).reduce((m, s) => m + s.blocked_min + s.starved_min, 0)
  const base = scenario.baseline?.output_units ?? null
  const cost = (run) => (base === null ? null : (base - run.output_units) * e.margin + (idle(run) / 60) * e.idleCost)
  const costA = cost(r.a)
  const costB = cost(r.b)
  const gain = (r.b.output_units - r.a.output_units) * e.margin + ((idle(r.a) - idle(r.b)) / 60) * e.idleCost
  return {
    costA, costB, gain,
    cars: r.b.output_units - r.a.output_units,
    idleSaved: idle(r.a) - idle(r.b),
    month: gain * e.perMonth,
    year: gain * e.perMonth * 12,
  }
})

/** Состояние оборудования (ML) на текущей минуте смены: риск и активные предупреждения. */
export const mlNow = computed(() => {
  const ml = scenario.ml
  if (!ml) return null
  const t = scenario.minute
  const i = Math.min(ml.equipment[0].points.length - 1, Math.max(0, Math.floor(t / ml.step_min)))
  const items = ml.equipment.map((e) => {
    const alarm = [...e.alarms].reverse().find((a) => a.t <= t) ?? null
    const failed = e.failures.find((f) => f <= t && t < f + e.repair_min) ?? null
    // По предупреждению уже принято решение (живая смена) — повторно не тревожим.
    const resolved = e.id in scenario.mlResolved && alarm && alarm.t <= scenario.mlResolved[e.id]
    return { ...e, risk: e.points[i]?.risk ?? null, alarm: alarm && !failed && !resolved ? alarm : null, failedAt: failed }
  })
  return { t, items, alerts: items.filter((e) => e.alarm) }
})

/** Ожидаемое время отказа по предупреждению: момент тревоги + медианное упреждение на проверке. */
export function expectedFailure(e, alarm) {
  const lead = e.metrics?.lead_median_min ?? 60
  return Math.min((scenario.ml?.shift_min ?? 480) - 1, alarm.t + lead)
}

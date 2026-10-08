// Живая смена на подменённом сервере: модель линии заменена простой формулой
// (каждая минута остановки стоит участку фиксированную долю машины), время — поддельные таймеры.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const COST = { welding: 0, painting: 0.1, assembly: 0.25 } // машин за минуту остановки
const run = (p) => {
  const stops = [p.stoppage, ...(p.extra_stoppages ?? [])].filter(Boolean)
  const loss = Math.round(stops.reduce((m, s) => m + s.duration_min * COST[s.station], 0))
  const idle = stops.reduce((m, s) => m + s.duration_min, 0) / 2
  return {
    output_units: 122 - loss,
    stations: p.stations.map((s) => ({ id: s.id, name: s.name, blocked_min: idle / 3, starved_min: 0, down_min: 0 })),
    params: p,
  }
}

vi.mock('./api', () => ({
  api: {
    run: vi.fn(async (p) => run(p)),
    compare: vi.fn(async (a, b) => ({ a: run(a), b: run(b), comparison: null })),
    parseReport: vi.fn(),
    createIncident: vi.fn(async (d) => ({ ...d, id: 'INC-T', status: d.status ?? 'new' })),
    mlShift: vi.fn(),
    aiPropose: vi.fn(),
  },
}))

const { api } = await import('./api')
const { scenario } = await import('./scenario')
const { canAddEvent, decide, injectEvent, live, previewRecDuration, sendLineMessage, setRecDuration, startLive, stopLive } = await import('./live')

const PRESET = {
  horizon_min: 480,
  stations: [{ id: 'welding', name: 'Сварка' }, { id: 'painting', name: 'Окраска' }, { id: 'assembly', name: 'Сборка' }],
  buffers: [],
}
const ML = {
  equipment: [{
    id: 'conv', name: 'Конвейер-03', station: 'assembly', failure: 'обрыв цепи', predictable: true,
    alarms: [{ t: 265, risk: 0.68, why: [] }], failures: [330], repair_min: 55, planned_min: 20,
  }],
}

// Проиграть смену до ближайшего решения (или до конца).
async function playUntilDecision(maxMs = 60_000) {
  for (let ms = 0; ms < maxMs && live.status === 'running'; ms += 500) await vi.advanceTimersByTimeAsync(500)
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance'] })
  scenario.preset = structuredClone(PRESET)
  scenario.limits = { extra_stoppages: 8 }
  scenario.econ = { margin: 500000, idleCost: 150000, perMonth: 4 }
  scenario.ml = structuredClone(ML)
  scenario.incidents = []
  scenario.incidentsStore = 'server'
  live.speed = 10
  live.autopilot = false
  api.run.mockImplementation(async (p) => run(p))
  api.compare.mockImplementation(async (a, b) => ({ a: run(a), b: run(b), comparison: null }))
  await startLive()
})
afterEach(() => {
  stopLive()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('живая смена', () => {
  it('старт: смена идёт, база — линия без происшествий', () => {
    expect(live.status).toBe('running')
    expect(live.base).toBe(122)
    expect(live.output).toBe(122)
    expect(live.marks.map((m) => m.t)).toEqual([100, 265])
    expect(live.log[0].text).toMatch(/Смена началась/)
  })

  it('сбой ABB-01 в 09:40: смена ждёт решения, есть прогноз без мер и с рекомендацией', async () => {
    await playUntilDecision()
    expect(live.status).toBe('decision')
    expect(Math.round(live.t)).toBe(100)
    const p = live.pending
    expect(p.item).toMatchObject({ kind: 'fail', equipment: 'ABB-01', station: 'welding' })
    expect(p.none.stop).toEqual({ station: 'welding', start_min: 100, duration_min: 25 })
    expect(p.rec.stop.duration_min).toBe(10)
    expect(p.cars).toBe(p.outB - p.outA)
  })

  it('решение уходит в расчёт смены и в журнал инцидентов', async () => {
    await playUntilDecision()
    await decide('rec')
    expect(live.status).toBe('running')
    expect(live.decisions).toHaveLength(1)
    expect(api.createIncident).toHaveBeenCalledTimes(1)
    expect(scenario.incidents[0]).toMatchObject({ equipment: 'ABB-01', duration: 10, status: 'work' })
    // Следующий расчёт смены уже содержит принятую остановку.
    await playUntilDecision()
    const last = api.compare.mock.calls.at(-1)[0]
    expect(last.extra_stoppages).toEqual([{ station: 'welding', start_min: 100, duration_min: 10 }])
  })

  it('предупреждение ML: замена заранее дешевле аварии', async () => {
    await playUntilDecision()
    await decide('rec')
    await playUntilDecision()
    const p = live.pending
    expect(p.item).toMatchObject({ kind: 'ml', equipment: 'Конвейер-03', failAt: 330 })
    expect(p.none.stop).toEqual({ station: 'assembly', start_min: 330, duration_min: 55 })
    expect(p.rec.stop).toEqual({ station: 'assembly', start_min: 265, duration_min: 20 })
    expect(p.outB).toBeGreaterThan(p.outA)
  })

  it('«работать до отказа»: авария случается в срок без паузы смены', async () => {
    await playUntilDecision()
    await decide('rec')
    await playUntilDecision()
    await decide('none')
    expect(api.createIncident).toHaveBeenCalledTimes(1) // авария ещё не случилась
    await playUntilDecision()
    expect(live.status).toBe('finished')
    expect(live.log.some((e) => /Конвейер-03: обрыв цепи — авария/.test(e.text))).toBe(true)
    expect(api.createIncident).toHaveBeenCalledTimes(2)
  })

  it('итог смены: сбережённые машины = разница решений', async () => {
    await playUntilDecision()
    await decide('rec')
    await playUntilDecision()
    await decide('rec')
    await playUntilDecision()
    const s = live.summary
    expect(live.status).toBe('finished')
    // Без мер: 25 мин сварки (0) + 55 мин сборки (≈14) → 108; с мерами: 20 мин сборки (5) → 117.
    expect(s).toMatchObject({ fact: 117, noneOut: 108, saved: 9, events: 2, missed: 0 })
  })

  it('автопилот сам принимает рекомендации', async () => {
    live.autopilot = true
    await playUntilDecision()
    await vi.advanceTimersByTimeAsync(3000)
    expect(live.decisions).toHaveLength(1)
    expect(live.decisions[0].choice).toBe('rec')
  })

  it('событие руководителя: ремонт после 16:00 переходит на следующую смену', async () => {
    await playUntilDecision()
    await decide('rec')
    live.t = 470
    await injectEvent({ station: 'assembly', duration: 40, reason: 'обрыв цепи', equipment: 'Конвейер-03' })
    const p = live.pending
    expect(p.item.kind).toBe('manual')
    expect(p.none.stop).toEqual({ station: 'assembly', start_min: 470, duration_min: 10 })
    expect(p.carryA.min).toBe(30)
    expect(p.carryA.cars).toBeGreaterThan(0)
    expect(p.rec.stop.duration_min).toBe(10) // ремонт 20 мин: в смене 10, перенос 10
    expect(p.carryB.min).toBe(10)
  })

  it('ползунок срока ремонта пересчитывает только рекомендацию', async () => {
    await injectEvent({ station: 'assembly', duration: 40, reason: 'обрыв цепи', equipment: '' })
    const outA = live.pending.outA
    await setRecDuration(8)
    expect(live.pending.outA).toBe(outA)
    expect(live.pending.rec.stop.duration_min).toBe(8)
    expect(live.pending.outB).toBe(122 - 2)
    expect(live.pending.item.rec.text).toMatch(/~8 мин/)
  })

  it('не принимает новый срок, пока расчёт не завершён', async () => {
    await injectEvent({ station: 'assembly', duration: 40 })
    const p = live.pending
    let resolve
    api.run.mockImplementationOnce((params) => new Promise((done) => { resolve = () => done(run(params)) }))
    const recalculation = setRecDuration(10)
    await decide('rec')
    expect(live.pending).toBe(p)
    expect(live.decisions).toHaveLength(0)
    resolve()
    await recalculation
    await decide('rec')
    expect(live.decisions[0].p.rec.stop.duration_min).toBe(10)
    expect(scenario.incidents[0].duration).toBe(10)
  })

  it('движение ползунка сразу отменяет автопилот и блокирует принятие', async () => {
    live.autopilot = true
    await injectEvent({ station: 'assembly', duration: 40 })
    previewRecDuration(12)
    await vi.advanceTimersByTimeAsync(3000)
    await decide('rec')
    expect(live.decisions).toHaveLength(0)
    expect(live.pending.recalculating).toBe(true)
  })

  it('ошибка нового расчёта не позволяет принять прежние цифры', async () => {
    await injectEvent({ station: 'assembly', duration: 40 })
    api.run.mockRejectedValueOnce(new Error('нет связи'))
    await setRecDuration(10)
    await decide('rec')
    expect(live.pending.recError).toBe('нет связи')
    expect(live.decisions).toHaveLength(0)
    await setRecDuration(10)
    await decide('rec')
    expect(live.decisions[0].p.rec.stop.duration_min).toBe(10)
  })

  it('устаревшая ошибка не заменяет последний успешный расчёт', async () => {
    await injectEvent({ station: 'assembly', duration: 40 })
    let reject
    api.run.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    const old = setRecDuration(12)
    await setRecDuration(10)
    reject(new Error('устаревший запрос'))
    await old
    expect(live.pending.recError).toBeNull()
    expect(live.pending.recalculating).toBe(false)
    expect(live.pending.rec.stop.duration_min).toBe(10)
  })

  it('резервирует места для автоматических событий и заканчивает смену в лимите API', async () => {
    for (let i = 0; i < 6; i++) {
      await injectEvent({ station: 'painting', duration: 1 })
      await decide('rec')
    }
    expect(canAddEvent.value).toBe(false)
    await expect(injectEvent({ station: 'painting', duration: 1 })).rejects.toThrow('Лимит событий')
    await playUntilDecision()
    await decide('rec')
    await playUntilDecision()
    await decide('rec')
    await playUntilDecision()
    expect(live.summary.events).toBe(8)
    expect(live.summary.comparisonAvailable).toBe(true)
    for (const [p] of api.run.mock.calls) expect(p.extra_stoppages.length).toBeLessThanOrEqual(8)
  })

  it('при ошибке итогового расчёта показывает недоступный эффект', async () => {
    await playUntilDecision()
    await decide('rec')
    await playUntilDecision()
    await decide('rec')
    api.run.mockRejectedValueOnce(new Error('нет связи'))
    await playUntilDecision()
    expect(live.summary).toMatchObject({ saved: null, money: null, noneOut: null, comparisonAvailable: false })
    expect(live.savingsError).toMatch(/нет связи/)
  })
})

// Независимая заглушка с нелинейным эффектом: одновременные остановки участка
// образуют один интервал простоя, а не сумму длительностей.
function overlappingRun(p) {
  const stops = [p.stoppage, ...(p.extra_stoppages ?? [])].filter(Boolean)
  let loss = 0
  let idle = 0
  for (const station of p.stations) {
    const intervals = stops.filter((s) => s.station === station.id)
      .map((s) => [s.start_min, s.start_min + s.duration_min]).sort((a, b) => a[0] - b[0])
    let end = 0
    let minutes = 0
    for (const [start, finish] of intervals) {
      minutes += Math.max(0, finish - Math.max(start, end))
      end = Math.max(end, finish)
    }
    loss += minutes * COST[station.id]
    idle += minutes / 2
  }
  return { ...run({ ...p, stoppage: null, extra_stoppages: [] }), output_units: 122 - Math.round(loss),
    stations: p.stations.map((s) => ({ ...s, blocked_min: idle / 3, starved_min: 0 })) }
}

describe('эффект перекрывающихся остановок', () => {
  beforeEach(() => {
    api.run.mockImplementation(async (p) => overlappingRun(p))
    api.compare.mockImplementation(async (a, b) => ({ a: overlappingRun(a), b: overlappingRun(b) }))
  })

  it('считает эффект всей смены при пересечении двух событий', async () => {
    await injectEvent({ station: 'painting', duration: 40 })
    await decide('rec')
    live.t = 20
    await injectEvent({ station: 'painting', duration: 40 })
    await decide('rec')
    expect(live.decisions.reduce((n, d) => n + d.saved, 0)).toBe(4)
    expect(live.saved).toBe(2) // без мер — 116, принятые решения — 118
    expect(live.money).toBe(1_025_000) // 2 машины и 10 минут простоя
    await playUntilDecision()
    await decide('rec')
    await playUntilDecision()
    await decide('none')
    await playUntilDecision()
    expect(live.summary.saved).toBe(live.summary.fact - live.summary.noneOut)
  })

  it('учитывает перекрытие ремонта, перенесённого на следующую смену', async () => {
    live.t = 470
    for (let i = 0; i < 2; i++) {
      await injectEvent({ station: 'assembly', duration: 40 })
      await decide('rec')
    }
    await playUntilDecision()
    expect(live.summary).toMatchObject({ saved: 5, carry: 3, noneCarry: 8 })
    expect(live.summary.saved).toBe(live.summary.fact - live.summary.carry
      - (live.summary.noneOut - live.summary.noneCarry))
  })
})

describe('сообщение с линии', () => {
  it('понятное сообщение сразу становится событием смены', async () => {
    api.parseReport.mockResolvedValue({ station: 'assembly', equipment: '', reason: 'обрыв цепи', duration_min: 40, source: 'ai', missing: [] })
    const res = await sendLineMessage('на сборке порвалась цепь, минут на 40')
    expect(res.needsForm).toBe(false)
    expect(live.status).toBe('decision')
    expect(live.pending.item).toMatchObject({ kind: 'manual', station: 'assembly', message: 'на сборке порвалась цепь, минут на 40' })
    expect(live.pending.item.note).toMatch(/разобрал ИИ/)
    expect(live.log.some((e) => e.text.startsWith('Сообщение с линии'))).toBe(true)
  })

  it('неполное сообщение возвращается в форму, смена продолжается', async () => {
    api.parseReport.mockResolvedValue({ station: null, equipment: '', reason: 'остановка', duration_min: null, source: 'rules', missing: ['station', 'duration_min'] })
    const res = await sendLineMessage('что-то сломалось')
    expect(res.needsForm).toBe(true)
    expect(res.parsed.missing).toEqual(['station', 'duration_min'])
    expect(live.status).toBe('running')
    expect(live.pending).toBeNull()
  })

  it('ошибка сервера не останавливает смену', async () => {
    api.parseReport.mockRejectedValue(new Error('нет связи'))
    await expect(sendLineMessage('ABB-01 встал')).rejects.toThrow('нет связи')
    expect(live.status).toBe('running')
  })
})

import { describe, expect, it } from 'vitest'
import { forecastMonth } from './plan'
import caseInputs from './__fixtures__/plan_month.json'

// Небольшие входные данные: одна линия 100 машин за смену, один тип сбоя.
const inputs = (over = {}) => ({
  target: 2000,
  shifts_per_day: 2,
  base_shift: 100,
  horizon_min: 480,
  events_per_shift: 1,
  events: [{ loss_none: 10, loss_rec: 4 }],
  models: [{ model: 'A', units: 1200 }, { model: 'B', units: 400 }],
  ...over,
})

describe('прогноз месяца', () => {
  it('воспроизводим: одинаковый ответ при каждом расчёте', () => {
    expect(forecastMonth(inputs(), 10, 300)).toEqual(forecastMonth(inputs(), 10, 300))
  })

  it('без сбоев выпуск равен мощности линии, разброса нет', () => {
    const f = forecastMonth(inputs({ events_per_shift: 0 }), 10, 200)
    expect(f.capacity).toBe(2000)
    for (const k of ['none', 'rec']) {
      expect(f[k]).toMatchObject({ mean: 2000, p10: 2000, p90: 2000, hit: 1 })
    }
    expect(f.gain).toBe(0)
    expect(f.extraShifts).toBe(0)
  })

  it('мера не хуже, чем без мер; интервал содержит среднее', () => {
    const f = forecastMonth(inputs(), 10, 500)
    expect(f.rec.mean).toBeGreaterThan(f.none.mean)
    expect(f.gain).toBe(f.rec.mean - f.none.mean)
    for (const k of ['none', 'rec']) {
      expect(f[k].p10).toBeLessThanOrEqual(f[k].mean)
      expect(f[k].mean).toBeLessThanOrEqual(f[k].p90)
      expect(f[k].mean).toBeLessThanOrEqual(f.capacity)
    }
  })

  it('средние потери близки к ожиданию: частота × потери', () => {
    const f = forecastMonth(inputs(), 10, 2000)
    // 20 смен × (100 − 1 сбой × 10) = 1800 без мер; × (100 − 4) = 1920 с мерой
    expect(Math.abs(f.none.mean - 1800)).toBeLessThan(8)
    expect(Math.abs(f.rec.mean - 1920)).toBeLessThan(8)
  })

  it('дополнительных смен хватает, чтобы закрыть разрыв', () => {
    const f = forecastMonth(inputs(), 10, 500)
    expect(f.gapRec).toBe(Math.max(0, 2000 - f.rec.mean))
    expect((f.shifts + f.extraShifts) * (100 - 4)).toBeGreaterThanOrEqual(2000)
    expect((f.shifts + f.extraShifts - 1) * (100 - 4)).toBeLessThan(2000)
  })

  it('больше рабочих дней — больше машин', () => {
    expect(forecastMonth(inputs(), 22, 300).rec.mean).toBeGreaterThan(forecastMonth(inputs(), 20, 300).rec.mean)
  })

  it('план по моделям: дни моделей и свободные дни составляют месяц', () => {
    const f = forecastMonth(inputs(), 10, 300)
    const b = f.byModel
    expect(b.total).toBe(1600)
    expect(b.unassigned).toBe(400)
    const days = b.models.reduce((a, m) => a + m.days, 0)
    expect(days + b.freeDays).toBeCloseTo(10, 6)
    expect(b.models[0].days / b.models[1].days).toBeCloseTo(3, 6) // 1200 : 400
    expect(b.freeUnits).toBe(f.rec.mean - 1600)
    expect(b.hitRec).toBeGreaterThanOrEqual(b.hitNone)
  })

  it('без плана по моделям блок пустой и не ломает расчёт', () => {
    const f = forecastMonth(inputs({ models: undefined }), 10, 100)
    expect(f.byModel.models).toEqual([])
    expect(f.byModel.unassigned).toBe(2000)
  })
})

describe('прогноз месяца на демонстрационных данных', () => {
  // Входные данные — ответ /api/plan/month/; бэкенд-тест сверяет этот файл с сервером.
  const f = forecastMonth(caseInputs, 22)

  it('цифры, которые показывает экран и презентация', () => {
    expect(f.shifts).toBe(44)
    expect(f.capacity).toBe(5368)
    expect(f.none.mean).toBe(5166)
    expect(f.rec.mean).toBe(5313)
    expect(f.gain).toBe(147)
    expect(f.extraShifts).toBe(2)
    expect(f.cycleNeeded).toBe(228)
  })

  it('даже без сбоев 5 500 не закрываются: узкое место — сборка', () => {
    expect(f.capacity).toBeLessThan(caseInputs.target)
    expect(caseInputs.bottleneck).toMatchObject({ id: 'assembly', cycle_s: 235 })
    expect(f.rec.hit).toBe(0)
  })

  it('план по моделям 4 800 закрывается, 700 машин не распределены', () => {
    expect(f.byModel.total).toBe(4800)
    expect(f.byModel.unassigned).toBe(700)
    expect(f.byModel.hitRec).toBe(1)
    expect(f.byModel.models.map((m) => m.model)).toEqual(['Chevrolet Onix', 'Chevrolet Cobalt', 'JAC J7'])
  })
})

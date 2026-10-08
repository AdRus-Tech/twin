// Прогноз месячного плана методом Монте-Карло.
// Каждая смена: число сбоев ~ Пуассон(частота из демонстрационного журнала), сбой — один из
// четырёх записей журнала, потери машин — из таблицы модели линии (без мер / с мерой).
// Генератор с фиксированным зерном: один и тот же ответ при каждом открытии.

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function poisson(rnd, lambda) {
  const l = Math.exp(-lambda)
  let k = 0
  let p = 1
  do {
    k += 1
    p *= rnd()
  } while (p > l)
  return k - 1
}

const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))]

/**
 * @param m   ответ /api/plan/month/
 * @param workdays рабочих дней в месяце (допущение пользователя)
 * @param months   число проигранных месяцев
 */
export function forecastMonth(m, workdays = 22, months = 3000) {
  const shifts = m.shifts_per_day * workdays
  const rnd = mulberry32(20261008)
  const totals = { none: [], rec: [] }
  for (let i = 0; i < months; i++) {
    let none = 0
    let rec = 0
    for (let s = 0; s < shifts; s++) {
      let lossNone = 0
      let lossRec = 0
      const k = poisson(rnd, m.events_per_shift)
      for (let j = 0; j < k; j++) {
        const e = m.events[Math.floor(rnd() * m.events.length)]
        lossNone += e.loss_none
        lossRec += e.loss_rec
      }
      none += Math.max(0, m.base_shift - lossNone)
      rec += Math.max(0, m.base_shift - lossRec)
    }
    totals.none.push(Math.round(none))
    totals.rec.push(Math.round(rec))
  }
  const stats = (xs) => {
    const s = [...xs].sort((a, b) => a - b)
    return {
      mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
      p10: quantile(s, 0.1),
      p90: quantile(s, 0.9),
      hit: s.filter((x) => x >= m.target).length / s.length,
    }
  }
  const none = stats(totals.none)
  const rec = stats(totals.rec)
  // Сколько в среднем теряет смена на сбоях и что нужно, чтобы закрыть план.
  const avg = (k) => m.events.reduce((a, e) => a + e[k], 0) / m.events.length
  const lossPerShiftRec = m.events_per_shift * avg('loss_rec')
  const perShiftRec = m.base_shift - lossPerShiftRec
  const gapRec = Math.max(0, m.target - rec.mean)
  const needPerShift = m.target / shifts + lossPerShiftRec
  // План по моделям: сколько рабочих дней займёт каждая модель при прогнозном темпе с решениями
  // (такт одинаковый для всех моделей) и сколько останется на объём, не распределённый по моделям.
  const models = m.models ?? []
  const modelsTotal = models.reduce((a, x) => a + x.units, 0)
  const perDayRec = rec.mean / workdays
  const share = (xs) => xs.filter((x) => x >= modelsTotal).length / xs.length
  const byModel = {
    models: models.map((x) => ({ ...x, days: x.units / perDayRec })),
    total: modelsTotal,
    unassigned: Math.max(0, m.target - modelsTotal),
    freeDays: Math.max(0, workdays - modelsTotal / perDayRec),
    freeUnits: Math.max(0, rec.mean - modelsTotal),
    hitNone: share(totals.none),
    hitRec: share(totals.rec),
  }
  return {
    workdays,
    byModel,
    shifts,
    target: m.target,
    capacity: m.base_shift * shifts, // без единого сбоя
    none,
    rec,
    gain: rec.mean - none.mean,
    gapRec,
    extraShifts: gapRec > 0 ? Math.ceil(gapRec / perShiftRec) : 0,
    cycleNeeded: Math.floor((m.horizon_min * 60) / needPerShift),
    needPerShift: Math.ceil(m.target / shifts),
  }
}

export function fmt(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return Number(value).toLocaleString('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function signed(value, digits = 0) {
  if (value === null || value === undefined) return '—'
  const s = fmt(Math.abs(value), digits)
  return value > 0 ? `+${s}` : value < 0 ? `−${s}` : s
}

export function fmtDate(iso) {
  const [y, m, d] = iso.split('-')
  return `${d}.${m}.${y}`
}

/** Минуты модели → «чч:мм от начала». */
export function clock(min) {
  if (min === null || min === undefined) return '—'
  const h = Math.floor(min / 60)
  const m = Math.floor(min % 60)
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Русское окончание: plural(5, 'машину', 'машины', 'машин') → «машин». */
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100
  const b = a % 10
  if (a > 10 && a < 20) return many
  if (b === 1) return one
  if (b >= 2 && b <= 4) return few
  return many
}

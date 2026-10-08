import { describe, expect, it } from 'vitest'
import { clock, fmt, fmtDate, plural, signed } from './format'
import { wall } from './scenario'

const NB = ' ' // разделитель тысяч в ru-RU

describe('форматирование', () => {
  it('склонение «машина»', () => {
    const f = (n) => `${n} ${plural(n, 'машину', 'машины', 'машин')}`
    expect([1, 2, 5, 11, 12, 21, 22, 25, 111, 112].map(f)).toEqual([
      '1 машину', '2 машины', '5 машин', '11 машин', '12 машин', '21 машину', '22 машины', '25 машин', '111 машин', '112 машин',
    ])
    expect(plural(-3, 'а', 'б', 'в')).toBe('б')
  })

  it('числа по-русски, пустое значение — прочерк', () => {
    expect(fmt(5500)).toBe(`5${NB}500`)
    expect(fmt(5.17, 2)).toBe('5,17')
    expect(fmt(null)).toBe('—')
    expect(fmt(NaN)).toBe('—')
  })

  it('знак изменения', () => {
    expect(signed(5)).toBe('+5')
    expect(signed(-5)).toBe('−5')
    expect(signed(0)).toBe('0')
  })

  it('даты и время смены', () => {
    expect(fmtDate('2026-10-02')).toBe('02.10.2026')
    expect(clock(125)).toBe('02:05')
    expect(wall(0)).toBe('08:00')
    expect(wall(100)).toBe('09:40')
    expect(wall(480)).toBe('16:00')
  })
})

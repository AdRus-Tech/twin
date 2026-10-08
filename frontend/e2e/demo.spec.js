import { expect, test } from '@playwright/test'

// Ошибки страницы и консоли — падение теста.
function watchErrors(page) {
  const errors = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => m.type() === 'error' && errors.push(`console: ${m.text()}`))
  return errors
}

test('главный экран: заставка, цели, план месяца по моделям', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/')
  // Заставка уходит сама (на медленном программном WebGL может мелькнуть быстрее проверки).
  await expect(page.locator('.splash')).toBeHidden({ timeout: 60_000 })
  await expect(page.getByRole('button', { name: /Начать смену/ })).toBeVisible({ timeout: 60_000 })
  await expect(page.locator('.scene-tools')).toContainText('Выпуск')
  const month = page.locator('.side .month')
  await expect(month).toContainText('План месяца')
  await expect(month).toContainText('5 166')
  await expect(month).toContainText('5 313')
  await expect(month.locator('.models')).toContainText('Chevrolet Onix')
  await expect(month.locator('.models')).toContainText('700')
  expect(errors).toEqual([])
})

test('сообщение с линии: текст рабочего → карточка решения; неполное → форма', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/#nosplash&still')
  await page.getByRole('button', { name: /Начать смену/ }).click({ timeout: 60_000 })
  const ta = page.locator('.side .msg textarea')
  await ta.fill('на сборке порвалась цепь, минут на 40')
  await ta.press('Enter')
  const card = page.locator('.side div.decision')
  await expect(card).toContainText('Сборка')
  await expect(card).toContainText(/цеп/i) // причину формулирует ИИ или правила
  await expect(card).toContainText('ремонт 40 мин')
  await card.getByRole('button', { name: 'Принять рекомендацию' }).click()
  await expect(card).toBeHidden()

  await ta.fill('что-то сломалось')
  await ta.press('Enter')
  await expect(page.locator('#ev-station')).toBeVisible()
  await expect(page.locator('.from-msg')).toContainText('не удалось понять: участок и длительность')
  expect(errors).toEqual([])
})

test('режим презентации проходит все шаги до конца', async ({ page }) => {
  const errors = watchErrors(page)
  await page.goto('/#nosplash&still')
  await page.getByRole('button', { name: /Презентация/ }).click({ timeout: 60_000 })
  const card = page.locator('.tcard')
  await expect(card).toBeVisible()
  const total = Number((await card.locator('.n').innerText()).split('/')[1])
  expect(total).toBeGreaterThan(10)
  const titles = []
  for (let n = 1; n <= total; n++) {
    await expect(card.locator('.n')).toHaveText(`${n} / ${total}`)
    await expect(card.locator('.wait')).toHaveCount(0, { timeout: 120_000 })
    await expect(card.locator('.err')).toHaveCount(0)
    titles.push(await card.locator('h2').innerText())
    await page.keyboard.press('ArrowRight')
  }
  await expect(card).toBeHidden()
  expect(titles.join(' | ')).toMatch(/Итоги смены.*План месяца.*План по моделям/i)
  // Тур довёл смену до конца: итог и сбережённые машины.
  await expect(page.locator('.side .summary')).toContainText('сберегли')
  expect(errors).toEqual([])
})

test('API: прогноз месяца и разбор сообщения', async ({ request }) => {
  const m = await (await request.get('/api/plan/month/')).json()
  expect(m.target).toBe(5500)
  expect(m.models.map((x) => x.units)).toEqual([2500, 1800, 500])
  const r = await request.post('/api/ai/parse-report/', { data: { text: 'Камера-02, замена фильтра, полчаса' } })
  const p = await r.json()
  expect(p).toMatchObject({ station: 'painting', equipment: 'Камера-02', duration_min: 30, missing: [] })
  expect((await request.post('/api/ai/parse-report/', { data: {} })).status()).toBe(400)
})

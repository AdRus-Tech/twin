import { expect, test } from '@playwright/test'

async function startPaused(page) {
  await page.goto('/#nosplash&still')
  await page.getByRole('button', { name: /Начать смену/ }).click()
  await expect(page.locator('.live-dock .state-text')).toContainText('смена идёт')
  await page.locator('.live-dock .play').click()
  await expect(page.locator('.live-dock .state-text')).toContainText('пауза')
}

async function report(page) {
  const text = page.locator('.side .msg textarea')
  await text.fill('на сборке порвалась цепь, минут на 40')
  await text.press('Enter')
  await expect(page.locator('.side div.decision')).toBeVisible()
}

test('сбережённые машины совпадают с моделью всей смены при перекрытии событий', async ({ page, request }) => {
  const comparisons = []
  page.on('request', (req) => {
    if (req.url().endsWith('/api/scenario/compare/')) comparisons.push(req.postDataJSON())
  })
  await startPaused(page)
  for (let i = 0; i < 2; i++) {
    await report(page)
    await page.locator('.side div.decision').getByRole('button', { name: 'Принять рекомендацию' }).click()
    await expect(page.locator('.live-dock .state-text')).toContainText('смена идёт')
    await page.locator('.live-dock .play').click()
  }
  expect(comparisons).toHaveLength(2)
  const params = { ...comparisons[0].a, stoppage: null }
  const [none, actual] = await Promise.all(['a', 'b'].map(async (variant) => {
    const response = await request.post('/api/scenario/run/', {
      data: { params: { ...params, extra_stoppages: comparisons.map((p) => p[variant].stoppage) } },
    })
    expect(response.ok()).toBe(true)
    return response.json()
  }))
  const saved = actual.output_units - none.output_units
  await expect(page.locator('.live-dock .kpi').nth(3).locator('b')).toHaveText(`${saved >= 0 ? '+' : ''}${saved}`)
})

test('кнопка принятия заблокирована до окончания пересчёта ползунка', async ({ page }) => {
  await startPaused(page)
  await report(page)
  let release
  const wait = new Promise((resolve) => { release = resolve })
  await page.route('**/api/scenario/run/', async (route) => {
    await wait
    await route.continue()
  })
  const card = page.locator('.side div.decision')
  const slider = card.getByRole('slider')
  await slider.fill('10')
  await slider.dispatchEvent('input')
  const accept = card.getByRole('button', { name: 'Принять рекомендацию' })
  await expect(accept).toBeDisabled()
  await slider.dispatchEvent('change')
  await expect(card).toContainText('Пересчитываем рекомендацию')
  release()
  await expect(accept).toBeEnabled()
  const savedRequest = page.waitForRequest((req) => req.url().endsWith('/api/incidents/') && req.method() === 'POST')
  await accept.click()
  expect((await savedRequest).postDataJSON().duration).toBe(10)
})

test('потерянный ответ сохранения переживает перезагрузку без дубля инцидента', async ({ page, request }) => {
  await startPaused(page)
  let clientId
  await page.route('**/api/incidents/', async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    clientId = route.request().postDataJSON().client_id
    const response = await route.fetch()
    expect(response.ok()).toBe(true)
    await route.abort('failed') // сервер сохранил запись, ответ не дошёл до браузера
  })
  await report(page)
  await page.locator('.side div.decision').getByRole('button', { name: 'Принять рекомендацию' }).click()
  await expect(page.locator('.live-dock .state-text')).toContainText('смена идёт')
  await page.getByRole('button', { name: /^Инциденты/ }).click()
  await expect(page.locator('.inc')).toContainText('только в браузере')
  await page.unroute('**/api/incidents/')
  await page.reload()
  await page.getByRole('button', { name: /^Инциденты/ }).click()
  const response = await request.get('/api/incidents/')
  const records = (await response.json()).filter((i) => i.client_id === clientId)
  expect(records).toHaveLength(1)
  await expect(page.locator('.inc')).toContainText(records[0].id)
  await expect(page.locator('.inc')).not.toContainText('только в браузере')
})

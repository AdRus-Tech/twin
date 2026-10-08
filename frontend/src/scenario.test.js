import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const api = vi.hoisted(() => ({ incidents: vi.fn(), createIncident: vi.fn(), updateIncident: vi.fn(), deleteIncident: vi.fn() }))
vi.mock('./api', () => ({ api }))

let store
let state
const SERVER = { n: 1, id: 'INC-001', client_id: null, status: 'new', impact: { lossCars: 1 } }
const EVENT = { station: 'painting', name: 'Окраска', start: 10, duration: 20, impact: { lossCars: 2 } }

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  store = new Map()
  vi.stubGlobal('localStorage', { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) })
  api.incidents.mockResolvedValue([structuredClone(SERVER)])
  api.createIncident.mockImplementation(async (draft) => ({ ...draft, n: 2, id: 'INC-002' }))
  state = await import('./scenario')
  await state.loadIncidents()
})
afterEach(() => vi.unstubAllGlobals())

describe('журнал при потере связи', () => {
  it('не меняет статус на экране, если сервер не подтвердил сохранение', async () => {
    api.updateIncident.mockRejectedValue(new Error('нет связи'))
    await state.setIncidentStatus('INC-001', 'work')
    expect(state.scenario.incidents[0].status).toBe('new')
    expect(state.scenario.incidentsError).toMatch(/Статус не сохранён/)
  })

  it('сохраняет локальную запись и отправляет её после перезагрузки', async () => {
    api.createIncident.mockRejectedValueOnce(new Error('нет связи'))
    const local = await state.logIncident(EVENT)
    const clientId = local.client_id
    expect(local._local).toBe(true)
    expect(JSON.parse(store.get('twin.incidents')).some((i) => i.client_id === clientId)).toBe(true)
    vi.resetModules()
    state = await import('./scenario')
    await state.loadIncidents()
    expect(state.scenario.incidents.map((i) => i.id)).toEqual(['INC-002', 'INC-001'])
    expect(state.scenario.incidentsStore).toBe('server')
    expect(api.createIncident.mock.calls[1][0].client_id).toBe(clientId)
    expect(state.scenario.incidents[0]._local).toBe(false)
  })

  it('повторная отправка после потерянного ответа использует тот же идентификатор', async () => {
    let saved
    api.createIncident.mockImplementation(async (draft) => {
      if (!saved) {
        saved = { ...draft, n: 2, id: 'INC-002' }
        throw new Error('ответ потерян')
      }
      expect(draft.client_id).toBe(saved.client_id)
      return saved
    })
    await state.logIncident(EVENT)
    api.incidents.mockImplementation(async () => [saved, structuredClone(SERVER)])
    await state.loadIncidents()
    expect(state.scenario.incidents.filter((i) => i.id === 'INC-002')).toHaveLength(1)
  })

  it('сохраняет неотправленную запись из старого формата журнала', async () => {
    store.set('twin.incidents', JSON.stringify([{ ...EVENT, n: 2, id: 'INC-002', status: 'work', at: 'local-time' }]))
    vi.resetModules()
    state = await import('./scenario')
    await state.loadIncidents()
    expect(state.scenario.incidents).toHaveLength(2)
    expect(api.createIncident).toHaveBeenCalledTimes(1)
    expect(state.scenario.incidents[0]).toMatchObject({ status: 'work', _local: false })
  })

  it('не отправляет заново старую копию записи, которая уже есть на сервере', async () => {
    const legacy = { ...SERVER }
    delete legacy.client_id
    store.set('twin.incidents', JSON.stringify([legacy]))
    vi.resetModules()
    state = await import('./scenario')
    await state.loadIncidents()
    expect(api.createIncident).not.toHaveBeenCalled()
    expect(state.scenario.incidents).toHaveLength(1)
  })

  it('оставляет неотправленные записи видимыми при повторной ошибке сервера', async () => {
    api.createIncident.mockRejectedValue(new Error('нет связи'))
    const local = await state.logIncident(EVENT)
    await state.setIncidentStatus(local.id, 'work')
    await state.loadIncidents()
    expect(state.scenario.incidents[0]).toMatchObject({ client_id: local.client_id, status: 'work', _local: true })
    expect(JSON.parse(store.get('twin.incidents'))[0].status).toBe('work')
    expect(state.scenario.incidentsError).toMatch(/отправка на сервер не удалась/)
  })

  it('при неудачном удалении сохраняет запись и показывает ошибку', async () => {
    api.deleteIncident.mockRejectedValue(new Error('нет связи'))
    await state.removeIncident('INC-001')
    expect(state.scenario.incidents).toHaveLength(1)
    expect(state.scenario.incidentsError).toMatch(/не удалён/)
  })

  it('предупреждает, если браузер не сохраняет локальные записи', async () => {
    api.createIncident.mockRejectedValue(new Error('нет связи'))
    localStorage.setItem = () => { throw new Error('хранилище недоступно') }
    await state.logIncident(EVENT)
    expect(state.scenario.incidentsError).toMatch(/Браузер не разрешил сохранить/)
  })
})

async function request(path, body, method) {
  const res = await fetch(`/api/${path}`, {
    method: method ?? (body ? 'POST' : 'GET'),
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (res.status === 204) return null
  let data = null
  try {
    data = await res.json()
  } catch {
    // тело не JSON — обработаем ниже как ошибку сервера
  }
  if (!res.ok) {
    const err = new Error(data?.error || `Сервер вернул HTTP ${res.status}`)
    err.fields = data?.fields
    throw err
  }
  return data
}

export const api = {
  overview: (date) => request(`overview/${date ? `?date=${encodeURIComponent(date)}` : ''}`),
  preset: () => request('scenario/preset/'),
  run: (params) => request('scenario/run/', { params }),
  compare: (a, b) => request('scenario/compare/', { a, b }),
  aiStatus: () => request('ai/status/'),
  aiPropose: (params) => request('ai/propose/', { params }),
  aiExplain: (a, b) => request('ai/explain/', { a, b }),
  mlShift: () => request('ml/shift/'),
  parseReport: (text) => request('ai/parse-report/', { text }),
  planMonth: () => request('plan/month/'),
  incidents: () => request('incidents/'),
  createIncident: (data) => request('incidents/', data),
  updateIncident: (n, data) => request(`incidents/${n}/`, data, 'PATCH'),
  deleteIncident: (n) => request(`incidents/${n}/`, null, 'DELETE'),
}

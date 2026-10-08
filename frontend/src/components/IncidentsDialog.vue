<script setup>
// Журнал инцидентов смены: события, введённые руководителем, со статусом
// и приоритетом по последствиям в модели. Ниже — простои из тестовых данных.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Prov from './Prov.vue'
import { loadIncidents, removeIncident, scenario, setIncidentStatus } from '../scenario'
import { fmtDate, plural } from '../format'

const props = defineProps({ downtimes: { type: Array, default: () => [] } })
const emit = defineEmits(['close', 'open', 'new'])

const filter = ref('open')
const list = computed(() => scenario.incidents.filter((i) => filter.value === 'all' || i.status !== 'closed'))
const openCount = computed(() => scenario.incidents.filter((i) => i.status !== 'closed').length)

const PRIORITY = { high: 'высокий', medium: 'средний', low: 'низкий' }
const STATUS = { new: 'новый', work: 'в работе', closed: 'закрыт' }

function impactText(i) {
  const parts = []
  if (i.impact?.lossCars) parts.push(`−${i.impact.lossCars} ${plural(i.impact.lossCars, 'машина', 'машины', 'машин')} за смену`)
  if (i.impact?.idleMin) parts.push(`соседи стоят ${i.impact.idleMin} мин`)
  return parts.join(', ') || 'на соседей не влияет'
}

const onKey = (e) => e.key === 'Escape' && emit('close')
onMounted(() => {
  window.addEventListener('keydown', onKey)
  loadIncidents()
})
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="inc-title" @click.self="emit('close')">
    <div class="card glow box rise">
      <button class="close" aria-label="Закрыть" @click="emit('close')">×</button>
      <div class="top">
        <h2 id="inc-title">Инциденты смены</h2>
        <div class="seg" role="group" aria-label="Фильтр">
          <button :aria-pressed="filter === 'open'" @click="filter = 'open'">Открытые · {{ openCount }}</button>
          <button :aria-pressed="filter === 'all'" @click="filter = 'all'">Все · {{ scenario.incidents.length }}</button>
        </div>
        <button class="btn primary" @click="emit('new')">＋ Событие</button>
      </div>
      <p class="lead">Приоритет ставит модель линии: сколько машин теряет смена и сколько стоят соседние участки. {{ scenario.incidentsStore === 'server' ? 'Журнал хранится в базе данных на сервере.' : 'Показана копия журнала в браузере. Локальные записи отправятся при восстановлении связи.' }}</p>
      <p v-if="scenario.incidentsError" class="error" role="alert">{{ scenario.incidentsError }}</p>
      <button class="btn" :disabled="scenario.incidentsSyncing" @click="loadIncidents">{{ scenario.incidentsSyncing ? 'Обновляем журнал…' : 'Обновить и отправить локальные записи' }}</button>

      <div class="table-wrap">
        <table v-if="list.length" class="grid inc">
          <thead><tr><th>№</th><th>Время</th><th>Участок</th><th>Причина</th><th>Последствия <Prov kind="simulation" /></th><th>Приоритет</th><th>Статус</th><th></th></tr></thead>
          <tbody>
            <tr v-for="i in list" :key="i.id" :class="i.status">
              <td class="mono">{{ i.id }}<small v-if="i._local">{{ i._saving ? 'отправляется…' : 'только в браузере' }}</small></td>
              <td class="num">{{ i.clock }}</td>
              <td><b>{{ i.name }}</b><small v-if="i.equipment" class="eq">{{ i.equipment }}</small><small>ремонт ~{{ i.duration }} мин</small></td>
              <td>{{ i.reason || '—' }}<small v-if="i.source === 'ml'" class="ml">прогноз ML</small></td>
              <td>{{ impactText(i) }}</td>
              <td><span class="prio" :class="i.priority">{{ PRIORITY[i.priority] }}</span></td>
              <td><span class="status" :class="i.status">{{ STATUS[i.status] }}</span></td>
              <td class="actions"><fieldset :disabled="scenario.incidentsSyncing || i._saving">
                <button v-if="i.status === 'new'" class="btn sm" @click="setIncidentStatus(i.id, 'work')">В работу</button>
                <button v-if="i.status !== 'closed'" class="btn sm" @click="setIncidentStatus(i.id, 'closed')">Закрыть</button>
                <button v-else class="btn sm" @click="setIncidentStatus(i.id, 'work')">Открыть снова</button>

                <button class="btn sm ghost" title="Удалить из журнала" @click="removeIncident(i.id)">×</button>
                </fieldset>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="empty muted">{{ filter === 'open' ? 'Открытых инцидентов нет.' : 'Журнал пуст.' }} Нажмите «＋ Событие», когда участок встанет.</p>
      </div>

      <h3 class="sub">Простои из демонстрационных данных <Prov kind="source" /></h3>
      <div class="table-wrap">
        <table class="grid">
          <thead><tr><th>Дата</th><th>Участок</th><th>Оборудование</th><th>Причина</th><th>Мин</th></tr></thead>
          <tbody>
            <tr v-for="(d, k) in props.downtimes" :key="k">
              <td class="num">{{ fmtDate(d.date) }}</td><td>{{ d.section }}</td><td class="mono">{{ d.equipment }}</td><td>{{ d.reason }}</td><td class="num">{{ d.minutes }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(4,6,10,.72); }
.box { width: min(1060px, 94vw); max-height: 88vh; overflow: auto; padding: 24px; display: grid; gap: 12px; position: relative; }
.close { position: absolute; top: 12px; right: 14px; font-size: 26px; background: none; border: 0; cursor: pointer; color: var(--ink-2); }
.top { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; padding-right: 30px; }
h2 { font-size: 20px; letter-spacing: 0; text-transform: none; color: var(--ink); margin-right: auto; }
.lead { font-size: 13px; color: var(--ink-2); }
.table-wrap { overflow-x: auto; }
.inc td { vertical-align: top; text-align: left; font-size: 12.5px; }
.inc td small { display: block; color: var(--ink-3); font-size: 11px; }
.inc td small.eq { color: var(--ink-2); font-family: var(--mono); }
.inc tr.closed { opacity: .55; }
.inc td small.ml { color: var(--ai); font-weight: 700; }
.prio, .status { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; white-space: nowrap; }
.prio.high { color: var(--down); background: var(--down-bg); }
.prio.medium { color: var(--blocked); background: var(--blocked-bg); }
.prio.low { color: var(--ink-3); }
.status.new { color: var(--starved); }
.status.work { color: var(--blocked); }
.status.closed { color: var(--ok); }
.actions { white-space: nowrap; display: flex; gap: 4px; }
.actions fieldset { border: 0; padding: 0; margin: 0; display: flex; gap: 4px; }
.error { color: var(--down); font-size: 13px; }
.btn.sm { padding: 3px 8px; font-size: 11.5px; }
.btn.ghost { border-color: transparent; color: var(--ink-3); }
.empty { padding: 14px 0; }
.sub { font-size: 12px; color: var(--ink-3); text-transform: uppercase; letter-spacing: .12em; margin-top: 6px; display: flex; gap: 8px; align-items: center; }
</style>

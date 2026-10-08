<script setup>
import { computed } from 'vue'
import Prov from './Prov.vue'
import { fmt, fmtDate } from '../format'

const props = defineProps({ overview: Object, selected: String, history: { type: Array, default: () => [] } })
const emit = defineEmits(['select', 'date'])

const node = computed(() => props.overview?.chain.find((n) => n.id === props.selected) ?? null)
const allFlags = computed(() =>
  (props.overview?.chain ?? []).flatMap((n) => (n.flags ?? []).map((f) => ({ ...f, node: n }))),
)
const SEV = { critical: '!', warning: '△', info: 'i' }

// Оборудование — всё, что упомянуто в журнале простоев за все даты.
const equipment = computed(() => {
  const map = new Map()
  for (const ov of props.history) {
    for (const n of ov.chain) {
      for (const d of n.downtimes ?? []) {
        const e = map.get(d.equipment) ?? { name: d.equipment, section: d.section, node: n.id, records: [], total: 0 }
        e.records.push({ date: ov.date, reason: d.reason, minutes: d.minutes, planned: /плановое|(^|\s)ТО(\s|$)/i.test(d.reason) })
        e.total += d.minutes
        map.set(d.equipment, e)
      }
    }
  }
  return [...map.values()].sort((a, b) => b.total - a.total)
})
const dayLimit = computed(() => props.overview?.targets.critical_downtime_limit_min_per_day.value ?? 60)
</script>

<template>
  <div v-if="overview" class="data-panel">
    <div class="panel-section head">
      <div class="row">
        <h2>Дата</h2>
        <div class="seg" role="group" aria-label="Дата">
          <button v-for="d in overview.dates" :key="d" :aria-pressed="d === overview.date" @click="emit('date', d)">{{ fmtDate(d) }}</button>
        </div>
      </div>
    </div>

    <template v-if="node">
      <div class="panel-section">
        <div class="row">
          <h3>{{ node.name }}</h3>
          <span class="muted">{{ fmtDate(overview.date) }}</span>
        </div>
        <p v-if="!node.has_data" class="notice"><span class="state nodata">нет данных</span> {{ node.no_data_reason }}</p>

        <dl v-if="node.line" class="kv">
          <dt>План</dt><dd class="num">{{ node.line.plan.value }}</dd><dd><Prov kind="source" /></dd>
          <dt>Факт</dt><dd class="num">{{ node.line.fact.value }}</dd><dd><Prov kind="source" /></dd>
          <dt>Выполнение плана</dt><dd class="num">{{ fmt(node.line.plan_completion_pct.value, 1) }}%</dd><dd><Prov kind="derived" /></dd>
          <dt>Время работы</dt><dd class="num">{{ fmt(node.line.hours.value, 1) }} ч</dd><dd><Prov kind="source" /></dd>
          <dt>Загрузка (как в источнике)</dt><dd class="num">{{ node.line.load_pct.value }}%</dd><dd><Prov kind="source" /></dd>
        </dl>
        <dl v-if="node.quality" class="kv">
          <dt>Выпущено / брак</dt><dd class="num">{{ node.quality.released.value }} / {{ node.quality.defects.value }}</dd><dd><Prov kind="source" /></dd>
          <dt>Брак, расчёт</dt>
          <dd class="num" :class="{ bad: node.quality.defect_pct.value > overview.targets.defect_limit_pct.value }">{{ fmt(node.quality.defect_pct.value, 2) }}%</dd>
          <dd><Prov kind="derived" /></dd>
          <dt>Брак, указано в источнике</dt><dd class="num">{{ fmt(node.quality.stated_defect_pct.value, 1) }}%</dd><dd><Prov kind="source" /></dd>
          <dt>Порог брака</dt><dd class="num">≤ {{ overview.targets.defect_limit_pct.value }}%</dd><dd><Prov kind="source" /></dd>
        </dl>
      </div>

      <div v-if="node.flags?.length" class="panel-section">
        <h2>Отклонения</h2>
        <div>
          <div v-for="(f, i) in node.flags" :key="i" class="flag"><span class="sev" :class="f.severity">{{ SEV[f.severity] }}</span>{{ f.text }}</div>
        </div>
      </div>

      <div v-if="node.has_data" class="panel-section">
        <h2>Журнал простоев за дату</h2>
        <p v-if="!node.downtimes.length" class="muted">Записей нет.</p>
        <table v-else class="grid">
          <thead><tr><th>Оборудование</th><th>Причина</th><th>Мин</th></tr></thead>
          <tbody>
            <tr v-for="d in node.downtimes" :key="d.equipment"><td class="mono">{{ d.equipment }}</td><td style="text-align:left">{{ d.reason }}</td><td class="num">{{ d.minutes }}</td></tr>
          </tbody>
        </table>
      </div>
    </template>

    <template v-else>
      <div class="panel-section">
        <h2>Что пошло не так · {{ fmtDate(overview.date) }}</h2>
        <div>
          <button v-for="(f, i) in allFlags" :key="i" class="flag as-btn" @click="emit('select', f.node.id)">
            <span class="sev" :class="f.severity">{{ SEV[f.severity] }}</span>
            <span><b>{{ f.node.name }}.</b> {{ f.text }}</span>
          </button>
          <p v-if="!allFlags.length" class="muted">Отклонений от порогов нет.</p>
        </div>
      </div>

      <div v-if="equipment.length" class="panel-section">
        <h2>Оборудование · простои за все даты</h2>
        <div class="eq-list">
          <button v-for="e in equipment" :key="e.name" class="eq" @click="emit('select', e.node)">
            <div class="eq-top">
              <span class="mono eq-name">{{ e.name }}</span>
              <span class="muted">{{ e.section }}</span>
              <span class="eq-total"><b class="num">{{ e.total }}</b> мин <Prov kind="derived" /></span>
            </div>
            <div v-for="r in e.records" :key="r.date + r.reason" class="eq-rec">
              <span class="num">{{ fmtDate(r.date).slice(0, 5) }}</span>
              <span class="kind" :class="r.planned ? 'planned' : 'fail'">{{ r.planned ? 'плановое' : 'отказ' }}</span>
              <span class="reason">{{ r.reason }}</span>
              <span class="meter" :title="`${r.minutes} из ${dayLimit} мин/сутки`"><i :style="{ width: Math.min(100, (r.minutes / dayLimit) * 100) + '%' }" :class="{ near: r.minutes >= dayLimit * 0.9 }"></i></span>
              <span class="num">{{ r.minutes }}</span>
            </div>
          </button>
        </div>
        <p class="muted small">Полоса — доля от лимита {{ dayLimit }} мин/сутки.</p>
      </div>

      <div class="panel-section">
        <h2>План на месяц не сходится</h2>
        <dl class="kv">
          <template v-for="m in overview.plan_check.models" :key="m.model">
            <dt>{{ m.model }}</dt><dd class="num">{{ fmt(m.units) }}</dd><dd><Prov kind="source" /></dd>
          </template>
          <dt>Сумма по моделям</dt><dd class="num">{{ fmt(overview.plan_check.models_total.value) }}</dd><dd><Prov kind="derived" /></dd>
          <dt>Общий план, не менее</dt><dd class="num">{{ fmt(overview.plan_check.required_min.value) }}</dd><dd><Prov kind="source" /></dd>
          <dt>Не распределено</dt><dd class="num bad">{{ fmt(overview.plan_check.gap.value) }}</dd><dd><Prov kind="derived" /></dd>
        </dl>
        <p class="notice">{{ overview.plan_check.note }}</p>
      </div>

      <div class="panel-section">
        <h2>Общая эффективность (OEE)</h2>
        <p><span class="state nodata">не рассчитан</span> цель ≥ {{ overview.oee.target_pct.value }}% <Prov kind="source" /></p>
        <p class="muted small">Для OEE нужны: {{ overview.oee.missing.join('; ') }}.</p>
      </div>

    </template>
  </div>
</template>

<style scoped>
.row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.bad { color: var(--down); }
.small { font-size: 12px; }
.as-btn { width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--line); cursor: pointer; padding: 7px 0; }
.as-btn:first-child { border-top: 0; }
.as-btn:hover b { text-decoration: underline; }
.eq-list { display: grid; gap: 8px; }
.eq { display: grid; gap: 4px; text-align: left; width: 100%; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line); background: var(--surface); cursor: pointer; color: inherit; }
.eq:hover { border-color: var(--line-strong); background: var(--surface-2); }
.eq-top { display: flex; align-items: baseline; gap: 8px; }
.eq-name { font-size: 13px; color: var(--ink); font-weight: 600; }
.eq-total { margin-left: auto; font-size: 12px; color: var(--ink-2); display: flex; gap: 6px; align-items: center; }
.eq-rec { display: grid; grid-template-columns: 38px auto 1fr 54px 24px; gap: 6px; align-items: center; font-size: 12px; color: var(--ink-2); }
.eq-rec .num:last-child { text-align: right; }
.kind { font-size: 10px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; border: 1px solid currentColor; }
.kind.fail { color: var(--down); }
.kind.planned { color: var(--ink-3); }
.reason { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.meter { height: 5px; border-radius: 3px; background: rgba(255,255,255,.07); overflow: hidden; }
.meter i { display: block; height: 100%; background: var(--ink-3); }
.meter i.near { background: var(--blocked); }
.notes { margin: 0; padding-left: 18px; font-size: 12px; color: var(--ink-2); display: grid; gap: 4px; }
</style>

<script setup>
// Мониторинг оборудования: риск отказа по модели ML на демонстрационной смене.
// Телеметрия синтетическая — так и подписано; предупреждение можно сразу
// превратить в расчёт последствий моделью линии.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Prov from './Prov.vue'
import { applyEvent, expectedFailure, mlNow, scenario, wall } from '../scenario'
import { fmt, plural } from '../format'

const emit = defineEmits(['close', 'done'])
const ml = computed(() => scenario.ml)
const now = computed(() => mlNow.value)
const busy = ref(null)
const error = ref(null)

const W = 520
const H = 96
const PAD = { l: 30, r: 8, t: 8, b: 16 }
const sx = (t) => PAD.l + (t / (ml.value?.shift_min ?? 480)) * (W - PAD.l - PAD.r)
const sy = (p) => H - PAD.b - p * (H - PAD.t - PAD.b)

function riskPath(e) {
  let d = ''
  let pen = false
  for (const p of e.points) {
    if (p.risk === null) {
      pen = false
      continue
    }
    d += `${pen ? 'L' : 'M'}${sx(p.t).toFixed(1)},${sy(p.risk).toFixed(1)}`
    pen = true
  }
  return d
}

// Главный датчик (первый канал) в долях от нормы — для мини-графика под риском.
function sensorPath(e, key) {
  const c = e.channels.find((x) => x.key === key)
  const vals = e.points.map((p) => (p.running ? p.sensors[key] / c.norm : null))
  const lo = Math.min(...vals.filter((v) => v !== null))
  const hi = Math.max(...vals.filter((v) => v !== null))
  const y = (v) => H - PAD.b - ((v - lo) / Math.max(hi - lo, 1e-6)) * (H - PAD.t - PAD.b)
  let d = ''
  let pen = false
  e.points.forEach((p, i) => {
    if (vals[i] === null) {
      pen = false
      return
    }
    d += `${pen ? 'L' : 'M'}${sx(p.t).toFixed(1)},${y(vals[i]).toFixed(1)}`
    pen = true
  })
  return d
}
const mainSensor = (e) => (e.id === 'conveyor03' ? 'vibration' : e.channels[0].key)

const STATION = { welding: 'Сварка', painting: 'Окраска', assembly: 'Сборка' }
const pct = (p) => (p === null || p === undefined ? '—' : `${fmt(p * 100, 0)}%`)

async function consequences(e) {
  error.value = null
  busy.value = e.id
  try {
    const at = expectedFailure(e, e.alarm)
    await applyEvent({
      station: e.station, clockMin: scenario.shiftStart + at, duration: e.repair_min, bDuration: e.planned_min,
      reason: `${e.failure} (прогноз ML)`, equipment: e.name, source: 'ml',
    })
    if (scenario.error) throw new Error(scenario.error)
    emit('done')
  } catch (err) {
    error.value = err.message
  } finally {
    busy.value = null
  }
}

function jump(t) {
  scenario.playing = false
  scenario.minute = t
}

const onKey = (ev) => ev.key === 'Escape' && emit('close')
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey))
</script>

<template>
  <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="ml-title" @click.self="emit('close')">
    <div class="card glow box rise">
      <button class="close" aria-label="Закрыть" @click="emit('close')">×</button>
      <div class="top">
        <h2 id="ml-title">Мониторинг оборудования <span class="tag-ml">ML</span></h2>
        <label class="time">Время смены <b class="num">{{ wall(scenario.minute) }}</b>
          <input id="ml-minute" v-model.number="scenario.minute" type="range" min="0" :max="(ml?.shift_min ?? 480) - 1" step="5" aria-label="Минута смены" :disabled="scenario.live" @input="scenario.playing = false" />
        </label>
      </div>
      <p class="lead">Модель смотрит на последний час телеметрии и оценивает риск отказа в ближайшие {{ ml?.horizon_min ?? 120 }} минут.</p>
      <p v-if="scenario.mlError" class="error" role="alert">Мониторинг недоступен: {{ scenario.mlError }}</p>

      <div v-if="now" class="grid-eq">
        <article v-for="e in now.items" :key="e.id" class="eq card" :class="{ alert: e.alarm, off: !e.predictable }">
          <header>
            <div>
              <h3>{{ e.name }} <small>{{ STATION[e.station] }} · {{ e.failure }}</small></h3>
            </div>
            <span v-if="e.failedAt !== null" class="state down">отказ · ремонт</span>
            <span v-else-if="e.alarm" class="state blocked">предупреждение с {{ wall(e.alarm.t) }}</span>
            <span v-else-if="e.predictable" class="state working">норма</span>
            <span v-else class="state nodata">не прогнозируется</span>
          </header>

          <div class="risk-row">
            <div v-if="e.predictable" class="risk-num"><span class="big" :class="{ hot: e.risk >= e.threshold }">{{ pct(e.risk) }}</span><small>риск отказа<br>за 2 часа</small></div>
            <div v-else class="risk-num"><span class="big dim">{{ pct(e.background) }}</span><small>фоновая вероятность<br>за 2 часа</small></div>
            <svg :viewBox="`0 0 ${W} ${H}`" class="chart" role="img" :aria-label="`Риск отказа ${e.name} по смене`">
              <line :x1="PAD.l" :x2="W - PAD.r" :y1="sy(e.threshold)" :y2="sy(e.threshold)" class="thr" />
              <text :x="PAD.l - 4" :y="sy(e.threshold) + 3" text-anchor="end" class="ax">порог</text>
              <path :d="sensorPath(e, mainSensor(e))" class="sensor" />
              <path v-if="e.predictable" :d="riskPath(e)" class="risk" />
              <line v-for="a in e.alarms" :key="'a' + a.t" :x1="sx(a.t)" :x2="sx(a.t)" :y1="PAD.t" :y2="H - PAD.b" class="alarm" :class="{ future: a.t > scenario.minute }" />
              <rect v-for="f in e.failures.filter((x) => x <= scenario.minute)" :key="'f' + f" :x="sx(f)" :y="PAD.t" :width="Math.max(2, sx(f + e.repair_min) - sx(f))" :height="H - PAD.t - PAD.b" class="fail" />
              <line :x1="sx(scenario.minute)" :x2="sx(scenario.minute)" :y1="PAD.t - 4" :y2="H - PAD.b" class="cursor" />
              <text v-for="h in [0, 2, 4, 6, 8]" :key="h" :x="sx(h * 60)" :y="H - 3" text-anchor="middle" class="ax">{{ wall(h * 60) }}</text>
            </svg>
          </div>
          <p class="legend"><i class="lr"></i>риск <i class="ls"></i>{{ e.channels.find((c) => c.key === mainSensor(e)).name }} <i class="lt"></i>порог</p>

          <div v-if="e.alarm" class="why">
            <b>Почему:</b>
            <ul><li v-for="w in e.alarm.why" :key="w.text">{{ w.text }}</li></ul>
            <p>Ожидаемый отказ около <b>{{ wall(expectedFailure(e, e.alarm)) }}</b> (медиана упреждения на проверке — {{ e.metrics.lead_median_min }} мин).</p>
            <p v-if="scenario.live" class="hint">Решение по предупреждению — в карточке смены справа.</p>
            <button v-else class="btn primary" :disabled="busy === e.id" @click="consequences(e)">{{ busy === e.id ? 'Считаем…' : `Посчитать последствия: авария ${e.repair_min} мин или замена заранее ${e.planned_min} мин` }}</button>
          </div>
          <p v-else-if="!scenario.live && e.predictable && e.alarms.some((a) => a.t > scenario.minute)" class="hint">
            Дальше по смене будет предупреждение — <button class="link" @click="jump(e.alarms.find((a) => a.t > scenario.minute).t)">перейти к {{ wall(e.alarms.find((a) => a.t > scenario.minute).t) }}</button>
          </p>
          <p v-else-if="!e.predictable" class="hint">Отказ внезапный, предвестника в телеметрии нет — прогноз не выдаём. Такой простой сокращает запас датчиков у линии и быстрая реакция наладчика.</p>

          <p class="metrics"><Prov kind="ml" />
            <template v-if="e.predictable">Проверка на истории, которую модель не видела: предупреждено {{ e.metrics.warned }} из {{ e.metrics.failures }} {{ plural(e.metrics.failures, 'отказа', 'отказов', 'отказов') }}, за {{ e.metrics.lead_median_min }} мин (медиана), ложных {{ fmt(e.metrics.false_per_100h, 2) }} на 100 ч. Простое правило: {{ e.baseline.warned }} из {{ e.baseline.failures }}, ложных {{ fmt(e.baseline.false_per_100h, 2) }}.</template>
            <template v-else>Проверка: ROC-AUC {{ fmt(e.metrics.roc_auc, 2) }} — на уровне угадывания, поэтому прогноз не показываем.</template>
          </p>
        </article>
      </div>
      <p v-if="error" class="error" role="alert">{{ error }}</p>
      <p class="muted small">Метод: {{ ml?.method }}. Подробности обучения и проверки — docs/ML_REPORT.md.</p>
    </div>
  </div>
</template>

<style scoped>
.overlay { position: absolute; inset: 0; z-index: 20; display: grid; place-items: center; background: rgba(4,6,10,.72); }
.box { width: min(1180px, 95vw); max-height: 90vh; overflow: auto; padding: 22px 24px; display: grid; gap: 12px; position: relative; }
.close { position: absolute; top: 12px; right: 14px; font-size: 26px; background: none; border: 0; cursor: pointer; color: var(--ink-2); }
.top { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; padding-right: 30px; }
h2 { font-size: 20px; letter-spacing: 0; text-transform: none; color: var(--ink); margin-right: auto; display: flex; align-items: center; gap: 8px; }
.tag-ml { font-size: 11px; font-weight: 800; letter-spacing: .1em; padding: 2px 8px; border-radius: 999px; color: #12081f; background: linear-gradient(135deg, #b894ff, #4cc4ff); }
.time { display: flex; align-items: center; gap: 10px; font-size: 13px; color: var(--ink-2); }
.time b { color: var(--ink); font-size: 16px; min-width: 46px; }
.time input { width: 220px; accent-color: var(--accent); }
.lead { font-size: 13px; color: var(--ink-2); max-width: 900px; }
.grid-eq { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.eq { display: grid; gap: 8px; padding: 14px; align-content: start; min-width: 0; }
.eq.alert { border-color: rgba(255,178,36,.6); box-shadow: 0 0 26px rgba(255,178,36,.18); }
.eq header { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; }
.eq h3 { font-size: 16px; }
.eq h3 small { display: block; font-size: 12px; color: var(--ink-3); font-weight: 400; margin-top: 2px; }
.risk-row { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: center; }
.risk-num { display: grid; justify-items: start; }
.risk-num .big { font-size: 40px; }
.risk-num .big.hot { color: var(--blocked); }
.risk-num .big.dim { color: var(--ink-3); }
.risk-num small { font-size: 11px; color: var(--ink-3); line-height: 1.2; }
.chart { width: 100%; height: auto; }
.thr { stroke: var(--blocked); stroke-dasharray: 4 3; }
.risk { fill: none; stroke: var(--ai); stroke-width: 2; }
.sensor { fill: none; stroke: var(--ink-3); stroke-width: 1; opacity: .7; }
.alarm { stroke: var(--blocked); stroke-width: 2; }
.alarm.future { opacity: .25; stroke-dasharray: 2 3; }
.fail { fill: var(--down-bg); stroke: var(--down); }
.cursor { stroke: var(--ink); }
.ax { font-size: 9px; fill: var(--ink-3); }
.legend { display: flex; align-items: center; gap: 6px; font-size: 11px; color: var(--ink-3); }
.legend i { display: inline-block; width: 14px; height: 0; margin-left: 6px; }
.legend .lr { border-top: 2px solid var(--ai); }
.legend .ls { border-top: 1px solid var(--ink-3); }
.legend .lt { border-top: 2px dashed var(--blocked); }
.why { display: grid; gap: 6px; font-size: 12.5px; color: var(--ink-2); padding: 10px; border-radius: 10px; background: rgba(255,178,36,.07); border: 1px solid rgba(255,178,36,.3); }
.why ul { margin: 0; padding-left: 18px; }
.why .btn { white-space: normal; text-align: left; }
.hint { font-size: 12.5px; color: var(--ink-2); }
.link { background: none; border: 0; color: var(--accent); cursor: pointer; padding: 0; font: inherit; text-decoration: underline; }
.metrics { font-size: 11.5px; color: var(--ink-3); border-top: 1px solid var(--line); padding-top: 8px; }
.error { color: var(--down); font-size: 13px; }
.small { font-size: 11px; }
@media (max-width: 1100px) { .grid-eq { grid-template-columns: 1fr; } }
</style>

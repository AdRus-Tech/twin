<script setup>
// Прогноз последствий на текущей минуте проигрывания: что происходит сейчас
// и что модель ожидает дальше. Это расчёт модели при заданной остановке,
// а не предсказание отказов по истории.
import { computed } from 'vue'
import Prov from './Prov.vue'
import { VARIANT, bottleneck, forecast, mlNow, scenario, wall } from '../scenario'
import { fmt, plural } from '../format'

const WHAT = {
  down: 'остановлен',
  blocked: 'встанет — некуда отдать',
  starved: 'встанет — нет кузовов',
}
const NOW = {
  down: 'остановлен',
  blocked: 'стоит — некуда отдать',
  starved: 'стоит — нет кузовов',
}

const mins = (m) => `${fmt(Math.max(1, m), 0)} ${plural(Math.round(Math.max(1, m)), 'минуту', 'минуты', 'минут')}`
const f = computed(() => forecast.value)
const emit = defineEmits(['open-ml'])
const mlAlerts = computed(() => mlNow.value?.alerts ?? [])
const urgent = computed(() => f.value?.next.find((e) => e.state !== 'down' && e.start_min - f.value.t <= 30) ?? null)
</script>

<template>
  <section v-if="f" class="forecast glass" :class="{ alert: urgent }" aria-live="polite">
    <header>
      <h2>Прогноз · {{ wall(f.t) }} <span v-if="!scenario.live" class="muted">{{ VARIANT[scenario.view] }}</span></h2>
      <Prov kind="simulation" />
    </header>

    <ul>
      <li v-for="(e, i) in f.now" :key="'n' + i" class="now">
        <span class="when">сейчас</span>
        <span class="state" :class="e.state">{{ e.station_name }}</span>
        <span>{{ NOW[e.state] }}, ещё {{ mins(e.end_min - f.t) }}</span>
      </li>
      <li v-for="(e, i) in f.next" :key="'x' + i" :class="{ soon: e.state !== 'down' && e.start_min - f.t <= 30 }">
        <span class="when">через {{ mins(e.start_min - f.t) }}</span>
        <span class="state" :class="e.state">{{ e.station_name }}</span>
        <span>{{ WHAT[e.state] }} · в {{ wall(e.start_min) }}, на {{ mins(e.duration_min) }}</span>
      </li>
      <li v-if="!f.now.length && !f.next.length" class="ok">До конца смены простоев не ожидается.</li>
    </ul>
    <button v-for="e in mlAlerts" :key="e.id" class="ml-alert" @click="emit('open-ml')">
      <span class="tag-ml">ML</span>
      <span><b>{{ e.name }}</b>: риск «{{ e.failure }}» {{ Math.round((e.risk ?? e.alarm.risk) * 100) }}% за 2 ч · с {{ wall(e.alarm.t) }} →</span>
    </button>
    <p v-if="f.more" class="muted small">и ещё {{ f.more }} {{ plural(f.more, 'событие', 'события', 'событий') }} до конца смены</p>
    <p class="total">Итог смены по расчёту: <b class="num">{{ f.output }}</b> {{ plural(f.output, 'машина', 'машины', 'машин') }}
      <template v-if="bottleneck"><br><span class="bn">Узкое место линии — {{ bottleneck.name }}: {{ bottleneck.cycle }} с на машину</span></template>
    </p>
  </section>
</template>

<style scoped>
.forecast { display: grid; gap: 8px; padding: 12px 14px; border-radius: 16px; width: 360px; max-width: 100%; }
.forecast.alert { border-color: rgba(255, 178, 36, .55); box-shadow: 0 0 30px rgba(255, 178, 36, .18); }
header { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
h2 { color: var(--ink); }
h2 .muted { color: var(--ink-3); font-weight: 500; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 7px; }
li { display: grid; grid-template-columns: auto 1fr; gap: 2px 8px; align-items: center; font-size: 12.5px; color: var(--ink-2); }
li > span:last-child { grid-column: 1 / -1; padding-left: 2px; }
.when { font-weight: 700; color: var(--ink); font-size: 13px; white-space: nowrap; }
.soon .when { color: var(--blocked); }
.now .when { color: var(--down); }
.state { justify-self: start; }
.ok { display: block; color: var(--ok); }
.total { font-size: 12.5px; color: var(--ink-2); border-top: 1px solid var(--line); padding-top: 8px; }
.total b { color: var(--ink); font-size: 15px; }
.small { font-size: 11px; }
.bn { font-size: 11.5px; color: var(--blocked); }
.ml-alert { display: flex; gap: 8px; align-items: center; text-align: left; font-size: 12.5px; color: var(--ink-2); padding: 7px 9px; border-radius: 10px; cursor: pointer; background: rgba(184,148,255,.1); border: 1px solid rgba(184,148,255,.45); }
.ml-alert:hover { background: rgba(184,148,255,.18); }
.ml-alert b { color: var(--ink); }
.tag-ml { flex: none; font-size: 9.5px; font-weight: 800; letter-spacing: .08em; padding: 1px 6px; border-radius: 999px; color: #12081f; background: linear-gradient(135deg, #b894ff, #4cc4ff); }
</style>

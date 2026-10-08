<script setup>
// Прогноз месячного плана 5500: Монте-Карло по сменам месяца, сбои — из демонстрационного журнала,
// потери — из модели линии. Без мер против «с решениями двойника» и что нужно для плана.
import { computed, onMounted, ref } from 'vue'
import Prov from './Prov.vue'
import { api } from '../api'
import { forecastMonth } from '../plan'
import { scenario } from '../scenario'
import { fmt, plural } from '../format'

const inputs = ref(null)
const error = ref(null)
onMounted(async () => {
  try {
    inputs.value = await api.planMonth()
  } catch (e) {
    error.value = e.message
  }
})

const f = computed(() => (inputs.value ? forecastMonth(inputs.value, scenario.month.workdays || 22) : null))
const scale = computed(() => (f.value ? Math.max(f.value.target, f.value.capacity) * 1.03 : 1))
const lo = computed(() => (f.value ? Math.min(f.value.none.p10, f.value.target) - 80 : 0))
const x = (v) => `${Math.max(0, Math.min(100, ((v - lo.value) / (scale.value - lo.value)) * 100))}%`
const tg = (v) => `${fmt(v / 1e6, 1)} млн ₸`
</script>

<template>
  <div v-if="f" class="month">
    <div class="top">
      <h2>План месяца · {{ fmt(f.target) }} <Prov kind="source" /></h2>
      <span class="hit" :class="f.rec.hit > 0.5 ? 'ok' : 'bad'">{{ f.rec.hit >= 0.995 ? 'закрывается' : f.rec.hit > 0.05 ? `шанс ${Math.round(f.rec.hit * 100)}%` : 'ниже плана' }}</span>
    </div>

    <div class="scale">
      <div v-for="row in [{ k: 'none', label: 'Без мер', s: f.none }, { k: 'rec', label: 'С решениями двойника', s: f.rec }]" :key="row.k" class="row">
        <span class="lbl">{{ row.label }}</span>
        <div class="track">
          <i class="range" :class="row.k" :style="{ left: x(row.s.p10), width: `calc(${x(row.s.p90)} - ${x(row.s.p10)})` }"></i>
          <i class="dot" :class="row.k" :style="{ left: x(row.s.mean) }"></i>
          <em class="goal" :style="{ left: x(f.target) }" aria-hidden="true"></em>
          <em class="cap" :style="{ left: x(f.capacity) }" aria-hidden="true"></em>
        </div>
        <b class="num">{{ fmt(row.s.mean) }}</b>
      </div>
      <div class="legend"><span><em class="goal"></em>план {{ fmt(f.target) }}</span><span><em class="cap"></em>без единого сбоя {{ fmt(f.capacity) }}</span><span>полоса — 80% месяцев</span></div>
    </div>

    <p class="lead">Решения двойника дают <b class="pos">+{{ fmt(f.gain) }} {{ plural(f.gain, 'машину', 'машины', 'машин') }} в месяц</b> ≈ <b class="pos">{{ tg(f.gain * scenario.econ.margin) }}</b> <Prov kind="simulation" /></p>
    <p v-if="f.gapRec > 0" class="lead">
      Даже без сбоев линия даёт {{ inputs.base_shift }} × {{ f.shifts }} = {{ fmt(f.capacity) }}: узкое место — {{ inputs.bottleneck.name.toLowerCase() }}, {{ inputs.bottleneck.cycle_s }} с на машину.
      Чтобы закрыть {{ fmt(f.target) }}: <b>+{{ f.extraShifts }} {{ plural(f.extraShifts, 'смена', 'смены', 'смен') }}</b> (субботы) или такт {{ inputs.bottleneck.name.toLowerCase() === 'сборка' ? 'сборки' : 'узкого места' }} <b>≤ {{ f.cycleNeeded }} с</b>.
    </p>
    <div v-if="f.byModel.models.length" class="models">
      <div class="mh">По моделям <Prov kind="source" /> <span>дни месяца при темпе с решениями</span></div>
      <div class="mbar" role="img" :aria-label="`План по моделям ${fmt(f.byModel.total)} из ${fmt(f.target)}`">
        <i v-for="(m, i) in f.byModel.models" :key="m.model" :class="`m${i}`" :style="{ width: `${(m.days / f.workdays) * 100}%` }"></i>
        <i class="free" :style="{ width: `${(f.byModel.freeDays / f.workdays) * 100}%` }"></i>
      </div>
      <ul class="mlist">
        <li v-for="(m, i) in f.byModel.models" :key="m.model"><em :class="`m${i}`"></em>{{ m.model }} <b>{{ fmt(m.units) }}</b> <span>{{ fmt(m.days, 1) }} дн.</span></li>
        <li><em class="free"></em>свободно <b>≈{{ fmt(f.byModel.freeUnits) }}</b> <span>{{ fmt(f.byModel.freeDays, 1) }} дн.</span></li>
      </ul>
      <p class="lead">
        Заказы по моделям ({{ fmt(f.byModel.total) }}) закрываются в <b class="pos">{{ Math.round(f.byModel.hitRec * 100) }}%</b> месяцев с решениями
        (без мер — {{ Math.round(f.byModel.hitNone * 100) }}%).
        <template v-if="f.byModel.unassigned > 0">Ещё {{ fmt(f.byModel.unassigned) }} {{ plural(f.byModel.unassigned, 'машина', 'машины', 'машин') }} плана не распределены по моделям — линия успевает ≈{{ fmt(Math.min(f.byModel.freeUnits, f.byModel.unassigned)) }} из них; модели для этого объёма нужно назначить.</template>
      </p>
    </div>
    <p class="note">
      {{ f.shifts }} {{ plural(f.shifts, 'смена', 'смены', 'смен') }}: {{ inputs.shifts_per_day }} в день <Prov kind="source" /> ×
      <label class="days"><input v-model.number="scenario.month.workdays" type="number" min="1" max="31" aria-label="Рабочих дней в месяце" /> дн.</label> <Prov kind="assumption" />.
      Сбои — {{ inputs.events_source }} (≈{{ fmt(inputs.events_per_shift, 1) }} за смену), потери каждого — по модели линии; проиграно 3000 месяцев.
    </p>
  </div>
  <p v-else-if="error" class="note">Прогноз месяца недоступен: {{ error }}</p>
</template>

<style scoped>
.month { display: grid; gap: 10px; }
.top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hit { white-space: nowrap; flex: none; font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; border: 1px solid currentColor; }
.hit.ok { color: var(--ok); }
.hit.bad { color: var(--blocked); }
.scale { display: grid; gap: 8px; }
.row { display: grid; grid-template-columns: 112px 1fr 48px; gap: 8px; align-items: center; font-size: 12px; }
.lbl { color: var(--ink-2); }
.row b { text-align: right; color: var(--ink); }
.track { position: relative; height: 14px; border-radius: 7px; background: rgba(255,255,255,.05); }
.range { position: absolute; top: 3px; bottom: 3px; border-radius: 4px; opacity: .5; }
.range.none { background: var(--down); }
.range.rec { background: var(--ok); }
.dot { position: absolute; top: 1px; width: 12px; height: 12px; margin-left: -6px; border-radius: 50%; border: 2px solid #0b0f15; }
.dot.none { background: var(--down); }
.dot.rec { background: var(--ok); }
.goal, .cap { position: absolute; top: -3px; bottom: -3px; width: 0; border-left: 2px solid var(--accent); }
.cap { border-left: 2px dashed var(--ink-3); }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 10.5px; color: var(--ink-3); }
.legend em { position: relative; display: inline-block; height: 10px; margin-right: 4px; vertical-align: -1px; }
.lead { font-size: 13px; color: var(--ink-2); line-height: 1.4; }
.lead b { color: var(--ink); }
.pos { color: var(--ok) !important; }
.models { display: grid; gap: 6px; padding-top: 4px; border-top: 1px solid var(--line); }
.mh { font-size: 11px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-2); }
.mh span { font-weight: 400; letter-spacing: 0; text-transform: none; color: var(--ink-3); margin-left: 4px; }
.mbar { display: flex; height: 12px; border-radius: 6px; overflow: hidden; background: rgba(255,255,255,.05); }
.mbar i { display: block; height: 100%; }
.mbar i + i { border-left: 2px solid #0b0f15; }
.m0 { background: #4cc4ff; }
.m1 { background: #a78bfa; }
.m2 { background: #f59e0b; }
.free { background: repeating-linear-gradient(135deg, rgba(255,255,255,.18) 0 4px, rgba(255,255,255,.06) 4px 8px); }
.mlist { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 11.5px; color: var(--ink-2); }
.mlist b { color: var(--ink); font-weight: 600; }
.mlist span { color: var(--ink-3); }
.mlist em { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; }
.note { font-size: 11px; color: var(--ink-3); line-height: 1.4; }
.days input { width: 38px; padding: 1px 4px; font-size: 11px; background: rgba(255,255,255,.06); border: 1px solid var(--line); border-radius: 4px; color: var(--ink); }
</style>

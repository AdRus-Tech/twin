<script setup>
// Нижняя панель «Живой смены»: шкала 08:00–16:00, управление временем и показатели смены.
import { computed } from 'vue'
import Prov from './Prov.vue'
import { live, pauseLive, resumeLive, startLive } from '../live'
import { currentFrame, scenario, wall } from '../scenario'
import { fmt } from '../format'

const H = computed(() => scenario.preset?.horizon_min ?? 480)
const x = (t) => `${(t / H.value) * 100}%`
const hours = computed(() => Array.from({ length: H.value / 60 + 1 }, (_, i) => i * 60))
// Пока ждём решения, на шкале — только уже случившееся (прогноз без мер — в карточке решения).
const downs = computed(() => (scenario.result?.a.events ?? [])
  .filter((e) => e.state === 'down' && (live.status !== 'decision' || e.start_min <= live.t)))
const made = computed(() => currentFrame.value?.output ?? 0)
const planNow = computed(() => Math.round((live.plan * live.t) / H.value))
const behind = computed(() => made.value - planNow.value)
const running = computed(() => live.status === 'running')

function toggle() {
  if (live.status === 'idle' || live.status === 'finished') startLive()
  else if (running.value) pauseLive()
  else resumeLive()
}
</script>

<template>
  <div class="live-dock">
    <div class="controls">
      <button class="btn primary play" :disabled="live.status === 'decision'" :aria-label="running ? 'Пауза' : 'Пуск'" @click="toggle">{{ running ? '❚❚' : '▶' }}</button>
      <span class="clock big">{{ wall(live.t) }}</span>
      <span class="state-text">
        <template v-if="live.status === 'idle'">смена не начата</template>
        <template v-else-if="live.status === 'decision'"><b class="warn">{{ live.applying ? 'сохраняем решение и считаем эффект' : 'ждём решения руководителя' }}</b></template>
        <template v-else-if="live.status === 'paused'">пауза</template>
        <template v-else-if="live.status === 'finished'">смена закончена</template>
        <template v-else>смена идёт <span class="dot" aria-hidden="true"></span></template>
      </span>
      <label class="field speed">
        <select v-model.number="live.speed" aria-label="Скорость смены">
          <option :value="2">2 мин/с</option>
          <option :value="4">4 мин/с</option>
          <option :value="10">10 мин/с</option>
          <option :value="20">20 мин/с</option>
        </select>
      </label>
      <label class="auto"><input v-model="live.autopilot" type="checkbox" /> автопилот</label>
    </div>

    <div class="track" aria-hidden="true">
      <div class="fill" :style="{ width: x(live.t) }"></div>
      <i v-for="(d, i) in downs" :key="'d' + i" class="down" :style="{ left: x(d.start_min), width: x(d.duration_min) }"></i>
      <i v-for="(m, i) in live.marks" :key="'m' + i" class="mark" :class="m.kind" :style="{ left: x(m.t) }"></i>
      <span v-for="h in hours" :key="h" class="hour" :style="{ left: x(h) }">{{ wall(h) }}</span>
    </div>

    <div class="kpis">
      <div class="kpi">
        <small>Выпущено <Prov kind="simulation" /></small>
        <b class="big">{{ made }}</b>
        <span class="sub">машин с начала смены</span>
      </div>
      <div class="kpi">
        <small>План к {{ wall(live.t) }}</small>
        <b class="big muted">{{ planNow }}</b>
        <span class="sub" :class="behind < 0 ? 'neg' : 'pos'">{{ behind < 0 ? `отстаём на ${-behind}` : behind > 0 ? `опережаем на ${behind}` : 'идём по плану' }}</span>
      </div>
      <div class="kpi">
        <small>Прогноз на 16:00 <Prov kind="simulation" /></small>
        <b class="big" :class="(live.output ?? 0) >= live.plan ? 'pos' : 'neg'">{{ live.output ?? '—' }}</b>
        <span class="sub">при плане {{ live.plan }} · без происшествий {{ live.base ?? '—' }}</span>
      </div>
      <div class="kpi">
        <small>Решения сберегли</small>
        <b class="big" :class="live.saved >= 0 ? 'pos' : 'neg'">{{ live.saved === null ? '—' : `${live.saved >= 0 ? '+' : ''}${fmt(live.saved)}` }}</b>
        <span class="sub">машин · событий: {{ live.decisions.length }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.live-dock { display: grid; gap: 14px; padding: 14px 18px; height: 100%; align-content: start; }
.controls { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
.play { width: 44px; height: 44px; border-radius: 50%; padding: 0; font-size: 16px; }
.clock { font-size: 40px; }
.state-text { font-size: 13px; color: var(--ink-2); display: flex; align-items: center; gap: 6px; }
.warn { color: var(--blocked); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--down); box-shadow: 0 0 10px var(--down); animation: pulse-dot 1.4s infinite; }
.speed { margin-left: auto; }
.speed select { padding: 6px 8px; }
.auto { display: flex; gap: 6px; align-items: center; font-size: 12.5px; color: var(--ink-2); cursor: pointer; }
.auto input { accent-color: var(--accent); }

.track { position: relative; height: 14px; margin: 0 4px 16px; border-radius: 7px; background: rgba(255,255,255,.06); border: 1px solid var(--line); }
.fill { position: absolute; inset: 0 auto 0 0; border-radius: 7px; background: linear-gradient(90deg, rgba(220,255,79,.25), rgba(220,255,79,.55)); }
.down { position: absolute; top: 2px; bottom: 2px; min-width: 3px; border-radius: 3px; background: var(--down); box-shadow: 0 0 10px rgba(255,77,97,.6); }
.mark { position: absolute; top: -5px; width: 2px; height: 22px; background: var(--down); transform: translateX(-1px); }
.mark.ml { background: var(--ai); }
.hour { position: absolute; top: 17px; transform: translateX(-50%); font-size: 10.5px; color: var(--ink-3); }

.kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.kpi { display: grid; gap: 2px; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line); background: rgba(255,255,255,.03); }
.kpi small { font-size: 11px; color: var(--ink-3); display: flex; align-items: center; gap: 6px; }
.kpi .big { font-size: 36px; }
.kpi .sub { font-size: 12px; color: var(--ink-2); }
.pos { color: var(--ok); }
.neg { color: var(--down); }
</style>

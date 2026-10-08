<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Prov from './Prov.vue'
import { VARIANT, currentFrame, scenario } from '../scenario'
import { clock } from '../format'

// Размер графика берём из DOM, чтобы SVG не растягивался с искажением текста.
const box = ref(null)
const W = ref(420)
const H = ref(120)
const PAD = { l: 26, r: 8, t: 8, b: 18 }
let ro = null
onMounted(() => {
  ro = new ResizeObserver(([entry]) => {
    W.value = Math.max(200, entry.contentRect.width)
    H.value = Math.max(80, entry.contentRect.height)
  })
  watch(box, (el) => { ro.disconnect(); if (el) ro.observe(el) }, { immediate: true })
})

const horizon = computed(() => scenario.result?.a.params.horizon_min ?? scenario.a?.horizon_min ?? 480)
const sx = (m) => PAD.l + (m / horizon.value) * (W.value - PAD.l - PAD.r)

// Линия по среднему уровню очереди за каждую минуту модели.
function path(frames, idx, cap, closed = false) {
  const sy = (v) => H.value - PAD.b - (v / cap) * (H.value - PAD.t - PAD.b)
  let d = ''
  frames.forEach((f, i) => {
    d += `${i ? 'L' : 'M'}${sx(f.t).toFixed(1)},${sy(f.avg[idx]).toFixed(1)}`
  })
  if (closed) d += `V${sy(0)}H${sx(0)}Z`
  return d
}

const charts = computed(() => {
  const r = scenario.result
  if (!r) return []
  return r.a.buffers.map((b, i) => {
    const cap = Math.max(b.capacity, r.b.buffers[i].capacity)
    const stopA = r.a.params.stoppage
    const stopB = r.b.params.stoppage
    return {
      name: b.name,
      cap,
      capY: H.value - PAD.b - (b.capacity / cap) * (H.value - PAD.t - PAD.b),
      a: path(r.a.frames, i, cap),
      aArea: path(r.a.frames, i, cap, true),
      b: path(r.b.frames, i, cap),
      stopA: stopA && stopA.duration_min ? [sx(stopA.start_min), sx(stopA.start_min + stopA.duration_min)] : null,
      stopB: stopB && stopB.duration_min ? [sx(stopB.start_min), sx(stopB.start_min + stopB.duration_min)] : null,
    }
  })
})

const ticks = computed(() => {
  const step = horizon.value > 600 ? 120 : 60
  const out = []
  for (let m = 0; m <= horizon.value; m += step) out.push(m)
  return out
})

const events = computed(() => {
  const run = scenario.result?.[scenario.view]
  return run ? run.events : []
})

let raf = 0
let last = 0
function tick(ts) {
  if (!scenario.playing) return
  const dt = last ? (ts - last) / 1000 : 0
  last = ts
  scenario.minute = Math.min(horizon.value, scenario.minute + dt * scenario.speed)
  if (scenario.minute >= horizon.value) {
    scenario.playing = false
    return
  }
  raf = requestAnimationFrame(tick)
}
function toggle() {
  if (scenario.playing) {
    scenario.playing = false
    return
  }
  if (scenario.minute >= horizon.value) scenario.minute = 0
  scenario.playing = true
  last = 0
  raf = requestAnimationFrame(tick)
}
function jump(m) {
  scenario.playing = false
  scenario.minute = m
}
watch(() => scenario.playing, (p) => { if (!p) cancelAnimationFrame(raf) })
onBeforeUnmount(() => {
  ro?.disconnect()
  scenario.playing = false
  cancelAnimationFrame(raf)
})

const STATE_TEXT = { down: 'остановлен', blocked: 'ждёт: некуда отдать', starved: 'ждёт: нет кузовов' }
</script>

<template>
  <div class="timeline">
    <div v-if="!scenario.result" class="empty muted">Задайте остановку — здесь появится проигрывание смены и очереди во времени.</div>
    <template v-else>
      <div class="controls">
        <div class="seg" role="group" aria-label="Сценарий на схеме">
          <button :aria-pressed="scenario.view === 'a'" title="Показать смену без мер" @click="scenario.view = 'a'">Без мер</button>
          <button :aria-pressed="scenario.view === 'b'" title="Показать смену с рекомендацией" @click="scenario.view = 'b'">С рекомендацией</button>
        </div>
        <button class="btn primary play" :aria-label="scenario.playing ? 'Пауза' : 'Проиграть'" @click="toggle">{{ scenario.playing ? '❚❚' : '▶' }}</button>
        <input v-model.number="scenario.minute" class="scrub" type="range" min="0" :max="horizon" step="1" aria-label="Минута модели" @input="scenario.playing = false" />
        <span class="clock num">{{ clock(scenario.minute) }} <span class="muted">/ {{ clock(horizon) }}</span></span>
        <label class="field speed">
          <select v-model.number="scenario.speed" aria-label="Скорость проигрывания">
            <option :value="5">5 мин/с</option>
            <option :value="20">20 мин/с</option>
            <option :value="60">60 мин/с</option>
          </select>
        </label>
        <span class="out">Готово машин: <b class="num">{{ currentFrame?.output ?? 0 }}</b> <Prov kind="simulation" /></span>
      </div>
      <p class="demo-note">▶ проиграйте смену и посмотрите, как остановка расходится по линии. Это расчёт модели, а не запись реальной смены.</p>

      <div class="charts">
        <figure v-for="(c, ci) in charts" :key="c.name">
          <figcaption><span><b>Накопитель {{ c.name }}</b> <span class="muted">машин в очереди</span></span> <span class="legend"><i class="la"></i>без мер <i class="lb"></i>с мерой</span></figcaption>
          <div :ref="ci === 0 ? (el) => (box = el) : undefined" class="plot">
          <svg :viewBox="`0 0 ${W} ${H}`" :width="W" :height="H" role="img" :aria-label="`Очередь ${c.name}, A и B`">
            <rect v-if="c.stopA" :x="c.stopA[0]" :y="PAD.t" :width="c.stopA[1] - c.stopA[0]" :height="H - PAD.t - PAD.b" class="stop" />
            <rect v-if="c.stopB" :x="c.stopB[0]" :y="PAD.t" :width="c.stopB[1] - c.stopB[0]" :height="H - PAD.t - PAD.b" class="stop b" />
            <line :x1="PAD.l" :x2="W - PAD.r" :y1="c.capY" :y2="c.capY" class="cap" />
            <text :x="PAD.l - 4" :y="c.capY + 4" text-anchor="end" class="ax">{{ c.cap }}</text>
            <text :x="PAD.l - 4" :y="H - PAD.b" text-anchor="end" class="ax">0</text>
            <line :x1="PAD.l" :x2="W - PAD.r" :y1="H - PAD.b" :y2="H - PAD.b" class="base" />
            <text v-for="t in ticks" :key="t" :x="sx(t)" :y="H - 4" text-anchor="middle" class="ax">{{ t / 60 }}ч</text>
            <path :d="c.aArea" class="area" />
            <path :d="c.b" class="lb" />
            <line :x1="sx(scenario.minute)" :x2="sx(scenario.minute)" :y1="PAD.t" :y2="H - PAD.b" class="cursor" />
          </svg>
          </div>
        </figure>
        <div class="events">
          <h2>Что происходит · {{ VARIANT[scenario.view] }}</h2>
          <ul>
            <li v-for="(e, i) in events" :key="i">
              <button class="ev" @click="jump(e.start_min)">
                <span class="num">{{ clock(e.start_min) }}</span>
                <span class="state" :class="e.state">{{ STATE_TEXT[e.state] }}</span>
                {{ e.station_name }} · {{ e.duration_min.toLocaleString('ru-RU') }} мин
              </button>
            </li>
          </ul>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.timeline { height: 100%; display: grid; grid-template-rows: auto auto 1fr; gap: 6px; padding: 10px 14px; min-height: 0; }
.empty { align-self: center; justify-self: center; }
.controls { display: flex; align-items: center; gap: 10px; }
.play { width: 36px; padding: 6px 0; }
.scrub { flex: 1; accent-color: var(--ink); }
.clock { font-size: 15px; min-width: 104px; }
.speed { width: 96px; }
.out { white-space: nowrap; }
.demo-note { font-size: 11px; color: var(--ink-3); }
.charts { display: grid; grid-template-columns: 1fr 1fr minmax(220px, .8fr); gap: 14px; min-height: 0; }
figure { margin: 0; display: grid; grid-template-rows: auto 1fr; min-height: 0; }
figcaption { font-size: 12px; color: var(--ink-2); display: flex; justify-content: space-between; gap: 8px; }
.plot { min-height: 0; position: relative; }
.plot svg { position: absolute; inset: 0; display: block; }
path.area { fill: var(--line-strong); opacity: .55; }
.legend { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; flex: none; }
.legend i { display: inline-block; width: 16px; height: 8px; background: var(--line-strong); margin-left: 6px; }
.legend i.lb { background: none; height: 0; border-top: 2px solid var(--ai); }
path.la { fill: none; stroke: var(--ink-2); stroke-width: 1.2; }
path.lb { fill: none; stroke: var(--ai); stroke-width: 1.4; stroke-linejoin: round; }
.stop { fill: var(--down-bg); }
.stop.b { fill: none; stroke: var(--down); stroke-dasharray: 3 3; vector-effect: non-scaling-stroke; }
.cap { stroke: var(--blocked); stroke-dasharray: 4 3; vector-effect: non-scaling-stroke; }
.base { stroke: var(--line-strong); vector-effect: non-scaling-stroke; }
.cursor { stroke: var(--ink); stroke-width: 1; vector-effect: non-scaling-stroke; }
.ax { font-size: 10px; fill: var(--ink-3); }
.events { min-height: 0; overflow: auto; }
.events ul { list-style: none; margin: 4px 0 0; padding: 0; display: grid; gap: 2px; }
.ev { display: flex; gap: 6px; align-items: center; background: none; border: 0; padding: 2px 0; cursor: pointer; font-size: 12px; text-align: left; }
.ev:hover { text-decoration: underline; }
.small { font-size: 11px; text-transform: none; letter-spacing: 0; }
</style>

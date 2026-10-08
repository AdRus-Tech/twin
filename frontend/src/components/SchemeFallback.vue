<script setup>
import { computed } from 'vue'

const props = defineProps({
  mode: String, dataNodes: Array, frame: Object, stations: Array, buffers: Array, selected: String,
})
const emit = defineEmits(['select'])

const ORDER = [
  ['parts_store', 'Склад компл.'], ['welding', 'Сварка'], ['painting', 'Окраска'],
  ['assembly', 'Сборка'], ['quality', 'Контроль кач.'], ['fg_store', 'Склад ГП'],
]
const STATE_TEXT = { working: 'работа', down: 'остановка', blocked: 'блокировка', starved: 'нет потока' }
const W = 120
const GAP = 46
const x = (i) => 20 + i * (W + GAP)

const nodes = computed(() => ORDER.map(([id, short], i) => {
  const data = props.dataNodes?.find((n) => n.id === id)
  let state = null
  let caption = data?.caption || ''
  let nodata = data ? !data.hasData : false
  if (props.mode === 'scenario' && props.stations) {
    const idx = props.stations.findIndex((s) => s.id === id)
    nodata = idx < 0
    state = idx >= 0 ? props.frame?.states[idx] : null
    caption = idx < 0 ? 'вне модели' : STATE_TEXT[state] || ''
  }
  return { id, short, i, state, caption, nodata, severity: props.mode === 'data' ? data?.severity : null }
}))

const buffers = computed(() => {
  if (props.mode !== 'scenario' || !props.frame || !props.buffers) return []
  return props.buffers.map((b, i) => ({
    level: props.frame.buffers[i], capacity: b.capacity, cx: x(i + 1) + W + GAP / 2,
  }))
})
</script>

<template>
  <svg class="scheme" viewBox="0 0 1000 200" role="img" aria-label="Плоская схема цепочки участков">
    <defs>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="6" stroke="currentColor" stroke-width="2" />
      </pattern>
      <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
        <path d="M0,0 L8,4 L0,8 z" fill="#75787d" />
      </marker>
    </defs>
    <line v-for="n in nodes.slice(0, -1)" :key="'l' + n.id"
      :x1="x(n.i) + W" :y1="70" :x2="x(n.i + 1) - 2" :y2="70" stroke="#75787d" stroke-width="2" marker-end="url(#arrow)" />
    <g v-for="n in nodes" :key="n.id" class="node" :class="[n.state, { nodata: n.nodata, sel: n.id === selected, crit: n.severity === 'critical' }]"
      tabindex="0" role="button" :aria-label="n.short" @click="emit('select', n.id)" @keydown.enter="emit('select', n.id)">
      <rect :x="x(n.i)" y="40" :width="W" height="60" rx="3" />
      <rect v-if="n.state === 'down'" :x="x(n.i)" y="40" :width="W" height="60" rx="3" fill="url(#hatch)" class="hatch" />
      <text :x="x(n.i) + W / 2" y="66" text-anchor="middle" class="name">{{ n.short }}</text>
      <text :x="x(n.i) + W / 2" y="86" text-anchor="middle" class="cap">{{ n.nodata && mode === 'data' ? 'нет данных' : n.caption }}</text>
    </g>
    <g v-for="(b, i) in buffers" :key="'b' + i">
      <rect :x="b.cx - 9" y="110" width="18" height="60" class="gauge" />
      <rect :x="b.cx - 9" :y="170 - 60 * b.level / b.capacity" width="18" :height="60 * b.level / b.capacity" class="fill"
        :class="{ full: b.level >= b.capacity, empty: b.level === 0 }" />
      <text :x="b.cx" y="188" text-anchor="middle" class="cap">{{ b.level }}/{{ b.capacity }}</text>
    </g>
  </svg>
</template>

<style scoped>
.scheme { width: 100%; height: 100%; display: block; padding: 20px 12px 40px; }
.node { cursor: pointer; color: var(--down); }
.node rect { fill: var(--surface-2); stroke: var(--line-strong); stroke-width: 1.5; }
.node .hatch { fill: url(#hatch); stroke: none; opacity: .25; }
.node.sel rect { stroke: var(--ink); stroke-width: 3; }
.node.nodata rect { stroke-dasharray: 5 4; fill: var(--surface); }
.node.crit rect { stroke: var(--down); stroke-width: 2.5; }
.node.down rect { stroke: var(--down); stroke-width: 2.5; }
.node.blocked rect { stroke: var(--blocked); stroke-width: 2.5; }
.node.starved rect { stroke: var(--starved); stroke-width: 2.5; stroke-dasharray: 8 3; }
.name { font-size: 15px; font-weight: 600; fill: var(--ink); }
.cap { font-size: 12px; fill: var(--ink-2); }
.gauge { fill: none; stroke: var(--line-strong); }
.fill { fill: var(--ink-2); }
.fill.full { fill: var(--blocked); }
.fill.empty { fill: var(--starved); }
</style>

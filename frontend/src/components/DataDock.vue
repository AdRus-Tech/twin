<script setup>
import { computed } from 'vue'
import Prov from './Prov.vue'
import { fmt, fmtDate } from '../format'

// Карточки участков по выбранной дате + сравнение двух дат.
const props = defineProps({ history: Array, date: String, selected: String })
const emit = defineEmits(['select'])

const IDS = ['welding', 'painting', 'assembly']
const limit = computed(() => props.history?.[0]?.targets.defect_limit_pct.value ?? 2)
const scaleMax = 6 // шкала брака 0–6%, порог отмечен риской

const cards = computed(() => {
  if (!props.history?.length) return []
  return IDS.map((id) => {
    const days = props.history.map((ov) => {
      const n = ov.chain.find((x) => x.id === id)
      return { date: ov.date, name: n.name, line: n.line, q: n.quality, down: n.downtime_total_min?.value ?? 0 }
    })
    const cur = days.find((d) => d.date === props.date) ?? days.at(-1)
    return { id, name: cur.name, cur, days, over: cur.q.defect_pct.value > limit.value }
  })
})
</script>

<template>
  <div class="dock-data">
    <header>
      <h2>Брак по участкам · {{ date ? fmtDate(date) : '' }} · норма до 2%</h2>
      <span class="muted small"><Prov kind="source" /> значения источника · <Prov kind="derived" /> расчёт по ним</span>
    </header>
    <div class="cards">
      <button v-for="c in cards" :key="c.id" class="card" :class="{ over: c.over, sel: selected === c.id }" @click="emit('select', c.id)">
        <div class="top">
          <span class="name">{{ c.name }}</span>
          <span v-if="c.over" class="state down">выше нормы</span>
        </div>
        <div class="main">
          <span class="big val">{{ fmt(c.cur.q.defect_pct.value, 2) }}<small>%</small></span>
          <span class="muted small">брак {{ c.cur.q.defects.value }}/{{ c.cur.q.released.value }}</span>
        </div>
        <div class="bar" :aria-label="`Брак ${fmt(c.cur.q.defect_pct.value, 2)}% при пороге ${limit}%`">
          <i class="fill" :style="{ width: Math.min(100, (c.cur.q.defect_pct.value / scaleMax) * 100) + '%' }"></i>
          <i class="tick" :style="{ left: (limit / scaleMax) * 100 + '%' }"><span>{{ limit }}%</span></i>
        </div>
        <div class="foot">
          <span>план <b>{{ fmt(c.cur.line.plan_completion_pct.value, 1) }}%</b></span>
          <span>{{ c.cur.line.fact.value }}/{{ c.cur.line.plan.value }}</span>
          <span>простои <b>{{ c.cur.down || '—' }}</b>{{ c.cur.down ? ' мин' : '' }}</span>
        </div>
        <div class="trend">
          <span v-for="d in c.days" :key="d.date" :class="{ cur: d.date === c.cur.date, over: d.q.defect_pct.value > limit }">
            {{ fmtDate(d.date).slice(0, 5) }} · {{ fmt(d.q.defect_pct.value, 2) }}%
          </span>
        </div>
      </button>
    </div>
  </div>
</template>

<style scoped>
.dock-data { height: 100%; display: grid; grid-template-rows: auto 1fr; gap: 10px; padding: 14px 16px; }
header { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
.small { font-size: 11px; }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; min-height: 0; }
.card {
  text-align: left; cursor: pointer; display: grid; grid-template-rows: auto auto auto auto 1fr; gap: 8px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 14px; padding: 12px 14px;
  transition: border-color .2s, background .2s, transform .2s;
}
.card:hover { border-color: var(--line-strong); background: var(--surface-2); transform: translateY(-2px); }
.card.sel { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
.card.over { background: linear-gradient(160deg, rgba(255,77,97,.09), transparent 60%), var(--surface); }
.top { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.name { font-size: 15px; font-weight: 600; }
.main { display: flex; align-items: baseline; gap: 10px; }
.val { font-size: 46px; }
.val small { font-size: .45em; color: var(--ink-2); }
.card.over .val { color: var(--down); }
.bar { position: relative; height: 6px; border-radius: 3px; background: rgba(255,255,255,.07); margin: 2px 0 10px; }
.fill { position: absolute; inset: 0 auto 0 0; border-radius: 3px; background: linear-gradient(90deg, var(--ok), var(--ok)); }
.card.over .fill { background: linear-gradient(90deg, var(--blocked), var(--down)); box-shadow: 0 0 12px rgba(255,77,97,.5); }
.tick { position: absolute; top: -3px; bottom: -3px; width: 2px; background: var(--ink); }
.tick span { position: absolute; top: 12px; left: -8px; font-size: 10px; font-style: normal; color: var(--ink-3); }
.foot { display: flex; justify-content: space-between; font-size: 12px; color: var(--ink-3); }
.foot b { color: var(--ink); font-weight: 600; }
.trend { display: flex; gap: 6px; align-self: end; }
.trend span { font-size: 11px; color: var(--ink-3); border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; }
.trend span.cur { color: var(--ink); border-color: var(--line-strong); }
.trend span.over { color: var(--down); }
</style>

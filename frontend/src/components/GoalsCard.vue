<script setup>
// Цели линии и их статус на выбранную дату. Статус ставится только там,
// где данных хватает; иначе честно «нет данных».
import { computed } from 'vue'
import { fmt } from '../format'

const props = defineProps({ overview: Object })
const emit = defineEmits(['select'])

const goals = computed(() => {
  const ov = props.overview
  if (!ov) return []
  const t = ov.targets
  const out = []

  out.push({
    key: 'oee', title: `OEE ≥ ${t.oee_target_pct.value}%`, status: 'nodata', value: 'не рассчитан',
    note: 'нет планового времени и идеального цикла',
  })

  const limit = t.defect_limit_pct.value
  const over = ov.chain.filter((n) => n.quality && n.quality.defect_pct.value > limit)
    .sort((a, b) => b.quality.defect_pct.value - a.quality.defect_pct.value)
  out.push({
    key: 'defect', title: `Брак ≤ ${limit}%`, status: over.length ? 'bad' : 'ok',
    value: over.length ? `нарушен на ${over.length} из 3` : 'в норме',
    note: over.map((n) => `${n.name} ${fmt(n.quality.defect_pct.value, 2)}%`).join(', ') || 'по всем участкам',
    node: over[0]?.id,
  })

  const lim = t.critical_downtime_limit_min_per_day.value
  const day = ov.chain.flatMap((n) => (n.downtimes ?? []).map((d) => ({ ...d, node: n.id })))
  const worst = day.reduce((a, d) => (!a || d.minutes > a.minutes ? d : a), null)
  const overLim = ov.downtime_check.equipment_over_limit
  out.push({
    key: 'down', title: `Простой ≤ ${lim} мин/сут`,
    status: overLim.length ? 'bad' : worst ? 'ok' : 'nodata',
    value: overLim.length ? `превышен: ${overLim.join(', ')}` : worst ? `макс. ${worst.minutes} мин` : 'записей нет',
    note: worst ? `${worst.equipment} · критичность оборудования не указана` : 'журнал за дату пуст',
    node: worst?.node,
  })

  const pc = ov.plan_check
  out.push({
    key: 'month', title: `Выпуск ≥ ${fmt(pc.required_min.value)}/мес`, status: pc.consistent ? 'ok' : 'warn',
    value: pc.consistent ? 'план сходится' : `план по моделям ${fmt(pc.models_total.value)}`,
    note: pc.consistent ? 'сумма по моделям покрывает цель' : `не распределено ${fmt(pc.gap.value)} машин`,
  })
  return out
})

const MARK = { ok: '✓', bad: '!', warn: '△', nodata: '–' }
</script>

<template>
  <section v-if="goals.length" class="goals glass" aria-label="Цели линии">
    <h2>Цели завода · {{ overview.date.split('-').reverse().join('.') }}</h2>
    <ul>
      <li v-for="g in goals" :key="g.key">
        <button class="goal" :class="g.status" :disabled="!g.node" :title="g.note" @click="g.node && emit('select', g.node)">
          <span class="mark" aria-hidden="true">{{ MARK[g.status] }}</span>
          <span class="txt"><b>{{ g.title }}</b><span>{{ g.value }}</span><small>{{ g.note }}</small></span>
        </button>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.goals { padding: 10px 12px; border-radius: 16px; display: grid; gap: 8px; width: 280px; }
ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.goal {
  width: 100%; display: flex; gap: 10px; align-items: flex-start; text-align: left; padding: 6px 8px; border-radius: 10px;
  background: none; border: 1px solid transparent; color: inherit; cursor: default;
}
.goal:not(:disabled) { cursor: pointer; }
.goal:not(:disabled):hover { border-color: var(--line-strong); background: rgba(255,255,255,.04); }
.mark {
  flex: none; width: 20px; height: 20px; border-radius: 6px; display: grid; place-items: center;
  font-size: 11px; font-weight: 800; margin-top: 1px;
}
.ok .mark { background: rgba(62,232,169,.15); color: var(--ok); border: 1px solid var(--ok); }
.bad .mark { background: var(--down); color: #1a0306; box-shadow: 0 0 12px rgba(255,77,97,.45); }
.warn .mark { background: var(--blocked); color: #1a1003; }
.nodata .mark { border: 1px dashed var(--ink-3); color: var(--ink-3); }
.txt { display: grid; line-height: 1.25; min-width: 0; }
.txt b { font-size: 13px; font-weight: 600; color: var(--ink); }
.txt span { font-size: 12.5px; color: var(--ink-2); }
.bad .txt span { color: var(--down); font-weight: 600; }
.warn .txt span { color: var(--blocked); font-weight: 600; }
.ok .txt span { color: var(--ok); }
.txt small { font-size: 11px; color: var(--ink-3); }
</style>

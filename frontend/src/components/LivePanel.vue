<script setup>
// Правая панель «Смены онлайн»: запуск, карточка решения по событию (с ИИ), итоги и лента.
import { computed, ref } from 'vue'
import Prov from './Prov.vue'
import MonthPlan from './MonthPlan.vue'
import { askAi, canAddEvent, decide, live, previewRecDuration, sendLineMessage, setRecDuration, startLive } from '../live'
import { scenario, wall } from '../scenario'
import { fmt, plural } from '../format'

const emit = defineEmits(['explore', 'incidents', 'need-form'])

// Сообщение с линии свободным текстом: ИИ (или ключевые слова) → событие в смену.
const msg = ref('')
const msgBusy = ref(false)
const msgError = ref(null)
const EXAMPLES = ['на сборке порвалась цепь, минут на 40', 'ABB-04 ошибка датчика, полчаса', 'окраска стоит, засор форсунки, минут 25']
async function send() {
  const text = msg.value.trim()
  if (!text || msgBusy.value || !canAddEvent.value) return
  msgBusy.value = true
  msgError.value = null
  try {
    const r = await sendLineMessage(text)
    if (r.needsForm) emit('need-form', { ...r.parsed, message: text })
    msg.value = ''
  } catch (e) {
    msgError.value = e.message
  } finally {
    msgBusy.value = false
  }
}

const p = computed(() => live.pending)
const s = computed(() => live.summary)
const cars = (n) => `${fmt(Math.abs(n))} ${plural(Math.abs(n), 'машина', 'машины', 'машин')}`
const loss = (n) => (n > 0 ? `−${cars(n)}` : 'без потерь')
const tg = (v) => {
  const a = Math.abs(v)
  return a >= 1e6 ? `${fmt(a / 1e6, 1)} млн ₸` : `${fmt(Math.round(a / 1000))} тыс. ₸`
}
// Подсказка к сумме в тенге: что посчитала модель линии, а что задано условно.
const TG_TITLE = 'Машины и минуты простоя — из модели линии. Тенге = машины × маржа + часы простоя × ставка; маржа и ставка задаются ниже, в «Ценах для расчёта»'
const FIELD = { 'stoppage.duration_min': 'срок ремонта', 'buffers.0.capacity': 'мест в накопителе перед окраской', 'buffers.1.capacity': 'мест в накопителе перед сборкой', 'buffers.0.initial': 'запас перед окраской', 'buffers.1.initial': 'запас перед сборкой' }
const aiSource = (a) => (a.source === 'live' ? a.model : a.source === 'saved' ? `${a.model}, сохранён` : 'шаблон')
const KIND = { info: 'смена', fail: 'отказ', alarm: 'ML', decision: 'решение', ok: 'итог' }
</script>

<template>
  <div class="live-panel">
    <section class="panel-section">
      <div class="head">
        <span class="icon-badge live-badge"><span class="rec-dot" aria-hidden="true"></span></span>
        <div>
          <h3>Смена онлайн</h3>
          <p class="lead">Двойник следит за линией: видит событие, считает последствия по цепочке и предлагает меру. Решение — за руководителем.</p>
        </div>
      </div>

      <template v-if="live.status === 'idle'">
        <ol class="steps">
          <li><b>08:00</b> смена стартует, план {{ live.plan }} машин — из демонстрационных данных;</li>
          <li><b>события</b> приходят по ходу смены: сбой оборудования, предупреждение ML; свой сбой — <b>сообщением с линии</b> обычным текстом («на сборке порвалась цепь, минут на 40») или кнопкой «＋ Событие»;</li>
          <li><b>на каждое</b> — прогноз без мер, рекомендация и совет ИИ; решение за руководителем;</li>
          <li><b>16:00</b> — итоги: сколько машин сберегли решения.</li>
          <li><b>месяц</b> — ниже карточка «План месяца»: дойдём ли до 5 500 без мер и с решениями двойника.</li>
        </ol>
        <button class="btn primary wide" @click="startLive">▶ Начать смену</button>
        <label class="auto"><input v-model="live.autopilot" type="checkbox" /> Автопилот: принимать рекомендации самому</label>
      </template>
      <p v-if="live.error" class="error" role="alert">{{ live.error }}</p>
      <p v-if="live.savingsError" class="error" role="alert">{{ live.savingsError }}</p>
      <p v-if="live.applying" class="lead">Сохраняем решение и пересчитываем эффект по всей смене…</p>
    </section>

    <!-- Решение по событию -->
    <section v-if="p" class="panel-section">
      <div class="decision card glow" :class="p.item.kind === 'ml' ? 'ai-glow' : 'bad-glow'">
        <span class="when">{{ wall(p.item.t) }} · {{ p.item.kind === 'ml' ? 'предупреждение ML' : p.item.kind === 'manual' ? (p.item.message ? 'сообщение с линии' : 'событие от руководителя') : 'отказ на линии' }}</span>
        <h3>{{ p.name }}<template v-if="p.item.equipment !== '—'"> · {{ p.item.equipment }}</template>: {{ p.item.reason }}</h3>
        <p v-if="p.item.kind === 'ml'" class="lead">Риск {{ Math.round(p.item.risk * 100) }}% в ближайшие 2 часа<template v-if="p.item.why?.length">: {{ p.item.why.map((w) => w.text).join('; ') }}</template>.</p>
        <p v-else class="lead">{{ p.item.note }}</p>

        <div class="opts">
          <div class="opt">
            <span class="tag">Без мер</span>
            <span class="what">{{ p.item.none.text }}</span>
            <b class="out">{{ p.outA }}<small>машин за смену</small></b>
            <span class="eff" :class="{ bad: p.lossA > 0 }">{{ loss(p.lossA) }} к текущему прогнозу</span>
            <span v-if="p.carryA" class="eff bad">и {{ loss(p.carryA.cars) }} следующей смене: {{ p.carryA.min }} мин ремонта после 16:00</span>
          </div>
          <div class="opt rec">
            <span class="tag good">Рекомендация</span>
            <span class="what">{{ p.item.rec.text }}</span>
            <b class="out">{{ p.recalculating || p.recError ? '—' : p.outB }}<small>машин за смену</small></b>
            <span v-if="!p.recalculating && !p.recError" class="eff" :class="{ bad: p.lossB > 0 }">{{ loss(p.lossB) }} к текущему прогнозу</span>
            <label class="dur">
              <span>срок ремонта: <b>{{ p.item.rec.duration }} мин</b></span>
              <input type="range" :min="p.recMin" :max="p.recMax" step="1" :value="p.item.rec.duration" aria-label="Срок ремонта по рекомендации"
                     @input="previewRecDuration(Number($event.target.value))" @change="setRecDuration(Number($event.target.value))" />
            </label>
          </div>
        </div>
        <p v-if="p.recalculating" class="lead">Пересчитываем рекомендацию…</p>
        <p v-else-if="p.recError" class="error" role="alert">Пересчёт не удался: {{ p.recError }}. <button class="link" @click="setRecDuration(p.item.rec.duration)">Повторить</button></p>
        <p v-else class="gain">
          <template v-if="p.cars > 0">Рекомендация сберегает <b>{{ cars(p.cars) }}</b><template v-if="p.idle > 0"> и {{ p.idle }} мин простоя соседей</template> <Prov kind="simulation" /> ≈ <b>{{ tg(p.money) }}</b> <Prov kind="assumption" :title="TG_TITLE" /></template>
          <template v-else-if="p.idle > 0">Машин не теряем — накопитель держит. Рекомендация убирает <b>{{ p.idle }} мин</b> простоя соседей <Prov kind="simulation" /> ≈ <b>{{ tg(p.money) }}</b> <Prov kind="assumption" :title="TG_TITLE" /></template>
          <template v-else>Разницы почти нет. <Prov kind="simulation" /></template>
        </p>
        <!-- Совет ИИ по этому событию -->
        <div class="ai-box">
          <button v-if="!p.ai" class="btn ai" @click="askAi"><span class="orb" aria-hidden="true"></span> Спросить ИИ: что ещё можно сделать?</button>
          <p v-else-if="p.ai.busy" class="ai-wait"><span class="orb thinking" aria-hidden="true"></span> ИИ читает расчёт…</p>
          <p v-else-if="p.ai.error || p.ai.ans?.status !== 'ok'" class="ai-err">ИИ не ответил: {{ p.ai.error || p.ai.ans?.error }}. <button class="link" @click="askAi">Повторить</button></p>
          <template v-else>
            <p class="ai-text"><Prov :kind="p.ai.ans.source === 'live' ? 'ai' : p.ai.ans.source" :title="aiSource(p.ai.ans)" /> {{ p.ai.ans.result.summary }}</p>
            <div v-if="p.ai.best" class="ai-best">
              <span>Лучшая мера ИИ, проверена моделью линии: <b>{{ FIELD[p.ai.best.field] ?? p.ai.best.field }} = {{ p.ai.best.value }}</b>
                <template v-if="p.ai.best.delta_output != null"> → {{ p.ai.best.delta_output > 0 ? '+' : '' }}{{ p.ai.best.delta_output }} маш. к варианту без мер</template></span>
              <button v-if="p.ai.best.field === 'stoppage.duration_min' && p.ai.best.value < p.item.rec.duration" class="btn ai small" @click="setRecDuration(p.ai.best.value)">Взять срок {{ p.ai.best.value }} мин</button>
              <small v-else-if="p.ai.best.field === 'stoppage.duration_min'" class="muted">Рекомендация уже не хуже: ремонт {{ p.item.rec.duration }} мин.</small>
              <small v-else class="muted">Мера на следующие смены — в этой смене накопитель уже не перестроить.</small>
            </div>
          </template>
        </div>

        <div class="actions">
          <button class="btn" @click="decide('none')">Без мер</button>
          <button class="btn primary" :disabled="p.recalculating || !!p.recError" @click="decide('rec')">Принять рекомендацию</button>
        </div>
        <small v-if="live.autopilot" class="muted">Автопилот примет рекомендацию через пару секунд.</small>
      </div>
    </section>

    <!-- Итоги -->
    <section v-if="s" class="panel-section">
      <div class="card glow good-glow summary">
        <span class="when">16:00 · итоги смены</span>
        <div class="kpis">
          <div><b class="big">{{ s.fact }}</b><small>машин за смену</small></div>
          <div><b class="big muted">{{ s.plan }}</b><small>план (демонстрационные данные)</small></div>
          <div v-if="!s.comparisonAvailable"><b class="big muted">—</b><small>эффект не рассчитан</small></div>
          <div v-else-if="s.saved > 0 || !s.missed"><b class="big" :class="s.saved >= 0 ? 'pos' : 'neg'">{{ s.saved >= 0 ? '+' : '' }}{{ s.saved }}</b><small>эффект решений</small></div>
          <div v-else><b class="big neg">−{{ s.missed }}</b><small>упущено без мер</small></div>
        </div>
        <p v-if="s.saved > 0" class="lead">Без мер по тем же событиям было бы <b>{{ s.noneOut }}</b> машин<template v-if="s.noneCarry"> и ещё −{{ s.noneCarry }} в следующей смене</template>. Решения сберегли <b>{{ cars(s.saved) }}</b> ≈ <b>{{ tg(s.money) }}</b><template v-if="s.carry || s.noneCarry"> с учётом следующей смены</template> при марже {{ fmt(scenario.econ.margin / 1000) }} тыс. ₸ <Prov kind="assumption" :title="TG_TITLE" /></p>
        <p v-if="s.missed > 0" class="lead">С рекомендациями по всем событиям было бы <b>{{ s.recOut }}</b> машин — упущено <b>{{ cars(s.missed) }}</b> с учётом следующей смены.</p>
        <p v-if="s.fact < s.plan" class="lead">До плана не хватило {{ cars(s.plan - s.fact) }}: {{ s.events }} {{ plural(s.events, 'событие', 'события', 'событий') }} за смену. Все записаны в журнал инцидентов.</p>
        <div class="actions">
          <button class="btn" @click="emit('incidents')">Журнал инцидентов</button>
          <button class="btn" @click="emit('explore')">Разобрать «Что если…»</button>
          <button class="btn primary" @click="startLive">↻ Ещё раз</button>
        </div>
      </div>
    </section>

    <section v-if="['running', 'paused'].includes(live.status)" class="panel-section msg">
      <h2>Сообщение с линии</h2>
      <form class="msg-form" @submit.prevent="send">
        <textarea v-model="msg" rows="2" maxlength="300" placeholder="Как написал бы рабочий: «на сборке порвалась цепь, минут на 40»" @keydown.enter.exact.prevent="send"></textarea>
        <button class="btn primary" :disabled="msgBusy || !msg.trim() || !canAddEvent">{{ msgBusy ? 'Разбираю…' : 'Отправить' }}</button>
      </form>
      <div class="examples">
        <button v-for="e in EXAMPLES" :key="e" type="button" class="chip" @click="msg = e">{{ e }}</button>
      </div>
      <p v-if="msgError" class="error">{{ msgError }}</p>
      <p v-if="!canAddEvent" class="lead">Лимит событий смены достигнут. Оставшиеся места зарезервированы для автоматических событий.</p>
    </section>

    <section v-if="['idle', 'finished'].includes(live.status)" class="panel-section">
      <MonthPlan />
    </section>

    <section class="panel-section">
      <details class="pro">
        <summary>Цены для расчёта в тенге <Prov kind="assumption" /></summary>
        <div class="prices">
          <label class="field">Маржа на машину, ₸<input v-model.number="scenario.econ.margin" type="number" min="0" step="10000" /></label>
          <label class="field">Час простоя участка, ₸<input v-model.number="scenario.econ.idleCost" type="number" min="0" step="10000" /></label>
        </div>
      </details>
    </section>

    <section v-if="live.log.length" class="panel-section">
      <h2>Лента смены</h2>
      <ul class="feed">
        <li v-for="(e, i) in live.log" :key="live.log.length - i" :class="e.kind">
          <span class="t num">{{ e.clock }}</span>
          <span class="k">{{ KIND[e.kind] }}</span>
          <span class="x">{{ e.text }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.head { display: flex; gap: 12px; align-items: flex-start; }
.head h3 { display: flex; align-items: center; gap: 8px; }
.lead { font-size: 13px; color: var(--ink-2); line-height: 1.4; }
.live-badge { background: linear-gradient(135deg, rgba(255,77,97,.35), rgba(255,178,36,.2)); }
.rec-dot { width: 12px; height: 12px; border-radius: 50%; background: var(--down); box-shadow: 0 0 12px var(--down); animation: pulse-dot 1.4s infinite; }
.steps { margin: 0; padding-left: 18px; display: grid; gap: 4px; font-size: 13px; color: var(--ink-2); }
.steps b { color: var(--ink); }
.wide { width: 100%; padding: 12px; font-size: 16px; }
.auto { display: flex; gap: 8px; align-items: center; font-size: 12.5px; color: var(--ink-2); cursor: pointer; }
.auto input { accent-color: var(--accent); }
.error { color: var(--down); font-size: 13px; }

.decision, .summary { display: grid; gap: 10px; padding: 14px; }
.when { font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--ink-3); }
.decision h3, .summary h3 { font-size: 17px; }
.opts { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.opt { display: grid; gap: 4px; align-content: start; padding: 10px; border-radius: 12px; border: 1px solid var(--line); background: rgba(255,255,255,.03); }
.opt.rec { border-color: rgba(62,232,169,.45); background: rgba(62,232,169,.06); }
.tag { font-size: 10.5px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.tag.good { color: var(--ok); }
.what { font-size: 12px; color: var(--ink-2); line-height: 1.3; }
.out { display: grid; font-size: 30px; font-weight: 300; font-stretch: 75%; color: var(--ink); line-height: 1; margin-top: 4px; }
.out small { font-size: 11px; color: var(--ink-3); font-weight: 400; font-stretch: normal; margin-top: 2px; }
.eff { font-size: 11.5px; color: var(--ok); }
.eff.bad { color: var(--down); }
.gain { font-size: 13px; color: var(--ink-2); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.gain b { color: var(--ok); }
.actions { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.actions .primary { padding: 9px 14px; }

.dur { display: grid; gap: 2px; margin-top: 4px; font-size: 11.5px; color: var(--ink-2); }
.dur b { color: var(--ink); }
.dur input { width: 100%; accent-color: var(--ok); }
.ai-box { display: grid; gap: 8px; padding: 10px; border-radius: 12px; background: var(--ai-bg); border: 1px solid rgba(184,148,255,.35); }
.ai-box .btn.ai { display: flex; align-items: center; gap: 8px; justify-content: center; }
.ai-box .small { padding: 6px 10px; font-size: 12.5px; justify-self: start; }
.orb { width: 16px; height: 16px; border-radius: 50%; flex: none; display: inline-block; background: conic-gradient(from 0deg, #b894ff, #4cc4ff, #3ee8a9, #dcff4f, #b894ff); }
.orb.thinking { animation: orb 1.2s linear infinite; }
.ai-wait { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--ai); }
.ai-err { font-size: 12.5px; color: var(--down); }
.ai-text { font-size: 13px; color: var(--ink); line-height: 1.4; }
.ai-best { display: grid; gap: 6px; font-size: 12.5px; color: var(--ink-2); }
.ai-best b { color: var(--ai); }
.link { background: none; border: 0; color: var(--ai); text-decoration: underline; cursor: pointer; padding: 0; }
.prices { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.prices input { width: 100%; }
.msg-form { display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: stretch; }
.msg-form textarea { resize: none; font: inherit; font-size: 13px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--line-strong); background: rgba(255,255,255,.04); color: var(--ink); }
.msg-form .btn { padding: 0 14px; }
.examples { display: flex; flex-wrap: wrap; gap: 6px; }
.examples .chip { cursor: pointer; font-size: 11.5px; }
.examples .chip:hover { border-color: var(--line-strong); color: var(--ink); }
.kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.kpis div { display: grid; }
.kpis .big { font-size: 40px; }
.kpis .pos { color: var(--ok); }
.kpis .neg { color: var(--down); }
.kpis small { font-size: 11px; color: var(--ink-3); }
.summary .lead b { color: var(--ink); }

.feed { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.feed li { display: grid; grid-template-columns: 40px auto 1fr; gap: 2px 8px; align-items: baseline; font-size: 12.5px; color: var(--ink-2); line-height: 1.35; }
.feed .t { color: var(--ink); font-size: 12px; }
.feed .k { font-size: 9.5px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--line-strong); color: var(--ink-3); }
.feed .fail .k { color: var(--down); border-color: rgba(255,77,97,.5); }
.feed .alarm .k { color: var(--ai); border-color: rgba(184,148,255,.5); }
.feed .decision .k { color: var(--ok); border-color: rgba(62,232,169,.5); }
.feed .ok .k { color: var(--accent); border-color: rgba(220,255,79,.5); }
</style>

<script setup>
import { computed } from 'vue'
import Prov from './Prov.vue'
import { bottleneck, differences, economy, monthly, resetToPreset, runBoth, scenario, wall } from '../scenario'
import { fmt, plural, signed } from '../format'

const emit = defineEmits(['ask-ai', 'new-event'])

const a = computed(() => scenario.a)
const cmp = computed(() => scenario.result?.comparison)
const runs = computed(() => scenario.result)
const err = (key) => scenario.fieldErrors?.[key]

function onBDuration(e) {
  scenario.b.stoppage.duration_min = Number(e.target.value)
  scenario.bOrigin = 'user'
}

const stopName = computed(() => a.value?.stations.find((s) => s.id === a.value.stoppage.station)?.name ?? '')

// Строки сравнения простым языком: только то, что реально изменилось или важно.
const rows = computed(() => {
  if (!runs.value) return []
  const out = [{
    label: 'Машин на выходе линии за смену', a: cmp.value.a.output_units, b: cmp.value.b.output_units, unit: '', better: 'more', main: true,
  }]
  runs.value.a.stations.forEach((s, i) => {
    const sb = runs.value.b.stations[i]
    if (s.blocked_min || sb.blocked_min) out.push({ label: `${s.name} стоит — некуда отдать`, a: s.blocked_min, b: sb.blocked_min, unit: ' мин', better: 'less', state: 'blocked' })
    if (s.starved_min || sb.starved_min) out.push({ label: `${s.name} стоит — нет кузовов`, a: s.starved_min, b: sb.starved_min, unit: ' мин', better: 'less', state: 'starved' })
  })
  return out
})

const verdict = computed(() => {
  if (!cmp.value) return ''
  const d = cmp.value.delta
  const idle = -(d.blocked_min + d.starved_min)
  const cars = (n) => `${n} ${plural(n, 'машину', 'машины', 'машин')}`
  if (d.output_units > 0) return `С рекомендацией линия делает на ${cars(d.output_units)} больше, а соседние участки простаивают на ${fmt(idle, 0)} мин меньше.`
  if (d.output_units < 0) return `С этой мерой линия делает на ${cars(-d.output_units)} меньше — она не помогает.`
  return idle > 0 ? `Выпуск тот же, но соседние участки простаивают на ${fmt(idle, 0)} мин меньше.` : 'Мера почти ничего не меняет.'
})

const bar = (v, r) => `${Math.max(4, (v / Math.max(r.a, r.b, 1)) * 100)}%`

// Введённое событие показываем, пока вариант A совпадает с ним.
const event = computed(() => {
  const e = scenario.event
  const st = a.value?.stoppage
  return e && st && e.station === st.station && e.start === st.start_min && e.duration === st.duration_min ? e : null
})

const m = computed(() => monthly.value)
const cars = (n) => `${fmt(n)} ${plural(n, 'машина', 'машины', 'машин')}`
const loss = (n) => (n > 0 ? `−${cars(n)}` : n < 0 ? `+${cars(-n)}` : 'без потерь')
// Полоски темпа месяца: шкала до цели с запасом.
const paceBar = (v) => `${Math.max(3, Math.min(100, (v / (m.value.target * 1.08)) * 100))}%`
const targetX = computed(() => (m.value ? `${(1 / 1.08) * 100}%` : '0%'))

const eco = computed(() => economy.value)
const bn = computed(() => bottleneck.value)
// Тенге: крупные суммы — в млн, остальные — целыми.
const tg = (v) => {
  if (v === null || v === undefined) return '—'
  const a = Math.abs(v)
  const s = a >= 1e6 ? `${fmt(a / 1e6, a >= 1e8 ? 0 : 1)} млн ₸` : `${fmt(Math.round(a))} ₸`
  return v < 0 ? `−${s}` : s
}
</script>

<template>
  <div v-if="a" class="scenario-panel">
    <section class="panel-section">
      <div class="head">
        <span class="icon-badge bad"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17v.5"/></svg></span>
        <div>
          <h3>Что случилось на линии</h3>
          <p class="lead">Участок встал — модель покажет прогноз смены без мер и эффект рекомендации.</p>
        </div>
      </div>

      <div v-if="event" class="event-banner">
        <span class="state down">{{ event.source === 'ml' ? 'прогноз ML' : 'событие' }}</span>
        <span><b>{{ event.name }}</b><template v-if="event.equipment"> ({{ event.equipment }})</template> встал в {{ wall(event.start) }}, ремонт ~{{ event.duration }} мин<template v-if="event.reason"> · {{ event.reason }}</template></span>
      </div>
      <button v-else class="btn wide-sm" @click="emit('new-event')">＋ Ввести событие с линии</button>

      <div class="row2">
        <label class="field">Какой участок встал
          <select v-model="a.stoppage.station">
            <option v-for="s in a.stations" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
        <label class="field">Во сколько от начала смены, мин
          <input v-model.number="a.stoppage.start_min" type="number" min="0" :max="a.horizon_min - 1" />
        </label>
      </div>

      <p class="explain">Смена проигрывается дважды: без мер и с рекомендацией. Разница — эффект меры. Пересчёт идёт сам.</p>
      <div class="variants">
        <div class="var card">
          <span class="tag">Прогноз без мер</span>
          <label class="big-input"><input v-model.number="a.stoppage.duration_min" type="number" min="0" max="960" /><span>мин ремонта</span></label>
          <small v-if="event?.source === 'ml'">аварийный ремонт, если не реагировать на предупреждение ML</small>
          <small v-else-if="event">как указал руководитель смены{{ event.reason ? ` (${event.reason.toLowerCase()})` : '' }}</small>
          <small v-else>40 мин — как в журнале простоев (замена фильтра на окраске, 01.10)</small>
        </div>
        <div class="var card glow good-glow">
          <span class="tag good">Рекомендация</span>
          <label class="big-input"><input :value="scenario.b.stoppage.duration_min" type="number" min="0" max="960" @input="onBDuration" /><span>мин ремонта</span></label>
          <input class="slider" type="range" min="0" :max="Math.max(a.stoppage.duration_min, 1)" :value="scenario.b.stoppage.duration_min" aria-label="Целевой срок ремонта по рекомендации" @input="onBDuration" />
          <small v-if="scenario.bOrigin === 'ai'" class="ai-note">✦ мера от ИИ, проверена моделью</small>
          <small v-else-if="event?.source === 'ml' && scenario.b.stoppage.duration_min === event.bDuration" class="ai-note">замена заранее по предупреждению ML — вместо аварийного ремонта</small>
          <small v-else>ускорить ремонт: резервная бригада, запчасть у линии. Ползунок — целевой срок</small>
        </div>
      </div>
      <div v-if="differences.length > 1" class="diff">
        <span v-for="d in differences" :key="d.label">{{ d.label }}: {{ d.a }} → <b>{{ d.b }}</b></span>
      </div>

      <button class="btn primary wide" :disabled="scenario.running" @click="runBoth">
        {{ scenario.running ? 'Считаем…' : '↻ Пересчитать' }}
      </button>
      <p v-if="scenario.error" class="error" role="alert">{{ scenario.error }}
        <span v-for="(m, k) in scenario.fieldErrors" :key="k" class="mono"> {{ k }}: {{ m }};</span>
      </p>
    </section>

    <section v-if="cmp" class="panel-section">
      <div class="head">
        <span class="icon-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg></span>
        <div>
          <h3>Что получилось <Prov kind="simulation" /></h3>
          <p class="lead">{{ verdict }}</p>
        </div>
      </div>
      <div v-if="bn" class="bottleneck">
        <span class="bn-tag">узкое место</span>
        <span><b>{{ bn.name }}</b> — самый медленный участок: {{ bn.cycle }} с на машину, не больше {{ bn.cap }} машин за смену. Быстрее него линия не пойдёт; при остановке узким местом на время ремонта становится остановленный участок.</span>
      </div>
      <div class="rows">
        <div v-for="r in rows" :key="r.label" class="cmp-row" :class="{ main: r.main }">
          <div class="label">
            <span v-if="r.state" class="dot" :class="r.state"></span>{{ r.label }}
            <span class="chip" :class="(r.better === 'more' ? r.b > r.a : r.b < r.a) ? 'good' : r.b === r.a ? '' : 'bad'">
              {{ signed(Math.round((r.b - r.a) * 10) / 10, r.main ? 0 : 0) }}{{ r.unit }}
            </span>
          </div>
          <div class="bars">
            <span class="k">без мер</span><div class="track"><i class="a" :style="{ width: bar(r.a, r) }"></i></div><b>{{ fmt(r.a, 0) }}{{ r.unit }}</b>
            <span class="k">с мерой</span><div class="track"><i class="b" :style="{ width: bar(r.b, r) }"></i></div><b>{{ fmt(r.b, 0) }}{{ r.unit }}</b>
          </div>
        </div>
      </div>
      <p class="muted small">«Выход линии» — машины после сборки; брак и контроль качества модель не учитывает.</p>
    </section>

    <section v-if="m" class="panel-section month">
      <div class="head">
        <span class="icon-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg></span>
        <div>
          <h3>Месячный план {{ fmt(m.target) }} <Prov kind="source" /></h3>
          <p class="lead" v-if="m.lossA !== null">Одна такая остановка: {{ loss(m.lossA) }} к плану месяца<template v-if="m.lossB !== m.lossA">, с рекомендацией — {{ loss(m.lossB) }}</template>.</p>
        </div>
      </div>
      <dl class="kv">
        <dt>Нужно в среднем за смену</dt><dd class="num big-n">{{ m.need }}</dd><dd><Prov kind="derived" /></dd>
        <dt>Без остановки модель даёт</dt><dd class="num">{{ m.base ?? '—' }}</dd><dd><Prov kind="simulation" /></dd>
      </dl>
      <p class="muted small">{{ fmt(m.target) }} ÷ ({{ scenario.month.shiftsPerDay }} смены × <label class="inline-num"><input v-model.number="scenario.month.workdays" type="number" min="1" max="31" aria-label="Рабочих дней в месяце" /></label> {{ plural(scenario.month.workdays || 0, 'рабочий день', 'рабочих дня', 'рабочих дней') }} <Prov kind="assumption" />) = {{ m.need }} машин за смену.</p>
      <div class="pace" :style="{ '--target': targetX }">
        <span class="pace-cap">Темп месяца, если каждая смена такая</span>
        <template v-for="row in [
          { k: 'base', label: 'Без остановки', v: m.pace.base },
          { k: 'a', label: 'Без мер', v: m.pace.a },
          { k: 'b', label: 'С рекомендацией', v: m.pace.b },
        ]" :key="row.k">
          <template v-if="row.v !== null">
            <span class="k">{{ row.label }}</span>
            <div class="track"><i :class="row.k" :style="{ width: paceBar(row.v) }"></i><em class="goal" aria-hidden="true"></em></div>
            <b :class="row.v >= m.target ? 'ok' : 'bad'">{{ fmt(row.v) }}</b>
          </template>
        </template>
      </div>
      <p class="muted small">Такты модели условные (секунд на машину — в настройках ниже), поэтому темп месяца показывает порядок величины, а не прогноз выпуска завода. Потери от остановки устойчивее: они считаются как разница с той же сменой без остановки.</p>
    </section>

    <section v-if="eco" class="panel-section econ">
      <div class="head">
        <span class="icon-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 4h12M6 9h12M12 9v11M6 14h9"/></svg></span>
        <div>
          <h3>Эффект в деньгах <Prov kind="assumption" /></h3>
          <p class="lead" v-if="eco.gain > 0">Рекомендация сберегает <b class="pos">{{ tg(eco.gain) }}</b> на одной такой остановке.</p>
          <p class="lead" v-else-if="eco.gain < 0">Мера обходится дороже на <b class="neg">{{ tg(-eco.gain) }}</b> за одну остановку.</p>
          <p class="lead" v-else>Эффекта в деньгах нет.</p>
        </div>
      </div>
      <div class="econ-in">
        <label class="field">Маржа на 1 машину, ₸
          <input id="econ-margin" v-model.number="scenario.econ.margin" type="number" min="0" step="50000" />
        </label>
        <label class="field">Час простоя участка, ₸
          <input id="econ-idle" v-model.number="scenario.econ.idleCost" type="number" min="0" step="10000" />
        </label>
        <label class="field">Таких остановок в месяц
          <input id="econ-per-month" v-model.number="scenario.econ.perMonth" type="number" min="0" max="200" />
        </label>
      </div>
      <dl class="kv">
        <dt>{{ signed(eco.cars) }} {{ plural(eco.cars, 'машина', 'машины', 'машин') }} × маржа</dt><dd class="num">{{ tg(eco.cars * scenario.econ.margin) }}</dd><dd><Prov kind="derived" /></dd>
        <dt>{{ signed(-Math.round(eco.idleSaved)) }} мин простоя соседей × ставка</dt><dd class="num">{{ tg((eco.idleSaved / 60) * scenario.econ.idleCost) }}</dd><dd><Prov kind="derived" /></dd>
        <dt>В месяц ({{ scenario.econ.perMonth }} {{ plural(scenario.econ.perMonth || 0, 'остановка', 'остановки', 'остановок') }})</dt><dd class="num big-n" :class="eco.month >= 0 ? 'pos' : 'neg'">{{ tg(eco.month) }}</dd><dd><Prov kind="derived" /></dd>
        <dt>В год</dt><dd class="num" :class="eco.year >= 0 ? 'pos' : 'neg'">{{ tg(eco.year) }}</dd><dd><Prov kind="derived" /></dd>
        <dt>Одна остановка без мер стоит</dt><dd class="num">{{ tg(eco.costA) }}</dd><dd><Prov kind="derived" /></dd>
      </dl>
      <p class="muted small">Маржа, стоимость часа простоя и частота остановок — примеры, а не подтверждённые производственные данные: подставьте свои значения. Стоимость остановки — потерянные машины к той же смене без остановки плюс простой соседних участков; сам ремонт не учитывается.</p>
    </section>

    <section class="panel-section">
      <button class="cta" @click="emit('ask-ai')">
        <span class="orb" aria-hidden="true"></span>
        <span><b>Спросить ИИ</b><small>объяснит результат и предложит свою меру</small></span>
        <span class="go">→</span>
      </button>
    </section>

    <section class="panel-section">
      <details class="pro">
        <summary>Настройки модели — для специалистов <Prov kind="assumption" /></summary>
        <div class="pro-body">
          <p class="notice">Числа условные (синтетический пример): скорость участков не выведена из плана 120, время начала и полнота остановки — допущения.</p>
          <table class="grid params">
            <thead><tr><th>Участок</th><th>Секунд на машину</th></tr></thead>
            <tbody>
              <tr v-for="(s, i) in a.stations" :key="s.id">
                <td>{{ s.name }}</td>
                <td><input v-model.number="s.cycle_s" type="number" min="30" max="3600" :aria-invalid="!!err(`stations[${i}].cycle_s`)" /></td>
              </tr>
            </tbody>
          </table>
          <table class="grid params">
            <thead><tr><th>Накопитель между участками</th><th>Мест</th><th>В начале</th></tr></thead>
            <tbody>
              <tr v-for="(b, i) in a.buffers" :key="i">
                <td>{{ a.stations[i].name }} → {{ a.stations[i + 1].name }}</td>
                <td><input v-model.number="b.capacity" type="number" min="1" max="200" /></td>
                <td><input v-model.number="b.initial" type="number" min="0" :max="b.capacity" /></td>
              </tr>
            </tbody>
          </table>
          <label class="field">Длина смены, мин <input v-model.number="a.horizon_min" type="number" min="30" max="960" /></label>
          <button class="btn" @click="resetToPreset">Сбросить к примеру</button>
        </div>
      </details>
    </section>
  </div>
</template>

<style scoped>
.head { display: flex; gap: 12px; align-items: flex-start; }
.head h3 { display: flex; align-items: center; gap: 8px; }
.row2 { display: grid; grid-template-columns: 1.2fr 1fr; gap: 10px; }
.explain { font-size: 12.5px; color: var(--ink-2); background: rgba(220,255,79,.06); border-left: 2px solid var(--accent); padding: 8px 10px; display: grid; gap: 2px; line-height: 1.35; border-radius: 0 8px 8px 0; }
.explain b { color: var(--ink); }
.explain .bb { color: var(--accent); }
.variants { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.var { display: grid; gap: 6px; padding: 12px; }
.tag { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-2); }
.tag.good { color: var(--ok); }
.big-input { display: flex; align-items: baseline; gap: 6px; }
.big-input input { width: 74px; font-size: 34px; font-weight: 300; font-stretch: 75%; background: none; border: 0; border-bottom: 1px solid var(--line-strong); color: var(--ink); padding: 0; }
.big-input span { font-size: 12px; color: var(--ink-3); }
.var small { font-size: 11px; color: var(--ink-3); line-height: 1.3; }
.ai-note { color: var(--ai) !important; }
.slider { width: 100%; accent-color: var(--ok); }
.diff { display: grid; gap: 2px; font-size: 12px; color: var(--ink-2); }
.wide { width: 100%; padding: 11px; font-size: 15px; }
.error { color: var(--down); font-size: 13px; }
.rows { display: grid; gap: 12px; }
.cmp-row { display: grid; gap: 6px; }
.cmp-row .label { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--ink-2); }
.cmp-row.main .label { color: var(--ink); font-weight: 600; font-size: 14px; }
.cmp-row .chip { margin-left: auto; font-weight: 700; }
.dot { width: 8px; height: 8px; border-radius: 2px; }
.dot.blocked { background: var(--blocked); }
.dot.starved { background: var(--starved); border-radius: 50%; }
.bars { display: grid; grid-template-columns: 56px 1fr 64px; gap: 4px 8px; align-items: center; font-size: 12px; }
.bars .k { color: var(--ink-3); font-weight: 600; font-size: 11px; white-space: nowrap; }
.bars b { text-align: right; font-weight: 600; }
.track { height: 8px; border-radius: 4px; background: rgba(255,255,255,.06); overflow: hidden; }
.track i { display: block; height: 100%; border-radius: 4px; transition: width .6s cubic-bezier(.2,.8,.2,1); }
.track i.a { background: linear-gradient(90deg, #6b7685, #a3aebb); }
.track i.b { background: linear-gradient(90deg, #3ee8a9, #dcff4f); }
.cmp-row.main .track { height: 12px; }
.small { font-size: 11px; }
.cta {
  display: flex; align-items: center; gap: 12px; width: 100%; padding: 12px 14px; border-radius: 16px; cursor: pointer; text-align: left;
  border: 1px solid rgba(184,148,255,.5); color: var(--ink);
  background: linear-gradient(135deg, rgba(184,148,255,.22), rgba(76,196,255,.12));
  transition: transform .2s, box-shadow .2s;
}
.cta:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(110,90,255,.35); }
.cta > span:nth-child(2) { display: grid; flex: 1; }
.cta b { font-size: 15px; }
.cta small { font-size: 12px; color: var(--ink-2); }
.cta .go { font-size: 20px; color: var(--ai); }
.orb { width: 32px; height: 32px; border-radius: 50%; flex: none; background: conic-gradient(from 0deg, #b894ff, #4cc4ff, #dcff4f, #b894ff); animation: orb 6s linear infinite; }
.pro-body { display: grid; gap: 10px; margin-top: 10px; }
.bottleneck { display: flex; gap: 10px; align-items: flex-start; font-size: 12.5px; color: var(--ink-2); padding: 8px 10px; border-radius: 10px; background: rgba(255,178,36,.07); border: 1px solid rgba(255,178,36,.3); }
.bottleneck b { color: var(--ink); }
.bn-tag { flex: none; font-size: 10px; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; color: var(--blocked); border: 1px solid currentColor; border-radius: 999px; padding: 2px 7px; margin-top: 1px; }
.econ-in { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.econ-in input { width: 100%; }
.econ .kv dt { font-size: 12.5px; }
.pos { color: var(--ok); }
.neg { color: var(--down); }
.event-banner { display: flex; gap: 10px; align-items: center; font-size: 13px; color: var(--ink-2); padding: 8px 10px; border-radius: 10px; background: var(--down-bg); border: 1px solid rgba(255,77,97,.35); }
.event-banner b { color: var(--ink); }
.wide-sm { width: 100%; }
.big-n { font-size: 20px; font-weight: 600; }
.inline-num input { width: 44px; border: 1px solid var(--line-strong); border-radius: 6px; padding: 1px 4px; text-align: right; background: rgba(0,0,0,.3); color: var(--ink); font: inherit; }
.pace { display: grid; grid-template-columns: auto 1fr 52px; gap: 6px 8px; align-items: center; font-size: 12px; }
.pace-cap { grid-column: 1 / -1; color: var(--ink-3); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
.pace .k { color: var(--ink-2); white-space: nowrap; }
.pace b { text-align: right; font-weight: 600; }
.pace b.ok { color: var(--ok); }
.pace b.bad { color: var(--down); }
.pace .track { position: relative; overflow: visible; }
.pace .track i.base { background: linear-gradient(90deg, #6b7685, #a3aebb); opacity: .6; }
.pace .goal { position: absolute; top: -3px; bottom: -3px; left: var(--target); width: 2px; background: var(--ink); }
.params input { width: 64px; border: 1px solid var(--line-strong); border-radius: 6px; padding: 3px 5px; text-align: right; background: rgba(0,0,0,.3); color: var(--ink); }
.params input[aria-invalid="true"] { border-color: var(--down); }
</style>

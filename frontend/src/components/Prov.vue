<script setup>
// Метка происхождения значения. Форма рамки отличается, а не только цвет.
const props = defineProps({ kind: { type: String, required: true }, title: { type: String, default: '' } })
const LABELS = {
  source: ['из данных', 'Значение из предоставленных тестовых данных'],
  derived: ['посчитано', 'Посчитано по значениям источника'],
  assumption: ['условие', 'Задано пользователем или синтетическим примером'],
  simulation: ['модель линии', 'Расчёт пошаговой модели линии «сварка → окраска → сборка» при заданных тактах и накопителях. Это не ИИ и не ML'],
  ml: ['ML', 'Оценка ML-модели прогноза отказов, обученной на синтетической телеметрии'],
  ai: ['ИИ', 'Текст сформирован языковой моделью; числа взяты из расчёта'],
  demo: ['демо', 'Шаблонный ответ сервера; языковая модель не вызывалась'],
  saved: ['ИИ · сохр.', 'Ранее полученный ответ модели на те же факты; повтор без сети'],
}
</script>

<template>
  <span class="prov" :class="props.kind" :title="props.title || LABELS[props.kind]?.[1]">{{ LABELS[props.kind]?.[0] ?? props.kind }}</span>
</template>

<style scoped>
.prov {
  display: inline-block;
  font: 600 10px/1 var(--mono);
  letter-spacing: .04em;
  text-transform: uppercase;
  padding: 3px 5px 2px;
  border-radius: 2px;
  border: 1px solid var(--ink-3);
  color: var(--ink-2);
  vertical-align: 1px;
  white-space: nowrap;
}
.derived { border-style: dotted; }
.assumption { border-style: dashed; color: var(--blocked); border-color: var(--blocked); }
.simulation { background: var(--ink-2); color: #fff; border-color: var(--ink-2); }
.ai { background: var(--ai); color: #fff; border-color: var(--ai); }
.demo { border: 1px dashed var(--ai); color: var(--ai); }
.saved { border: 1px solid var(--ai); color: var(--ai); }
.ml { border: 1px solid var(--starved); color: var(--starved); }
</style>

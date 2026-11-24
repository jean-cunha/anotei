// Datas são guardadas como texto no horário de Brasília, sem fuso: "2026-11-25T14:00".
// Assim o prazo digitado no balcão nunca "anda" 3 horas quando o servidor roda em UTC.

const FUSO = 'America/Sao_Paulo';

const formatador = new Intl.DateTimeFormat('en-CA', {
  timeZone: FUSO,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hourCycle: 'h23',
});

/** Agora, no horário de Brasília, no formato "AAAA-MM-DDTHH:mm:ss". */
function agora(deslocamentoMs = 0) {
  const p = Object.fromEntries(
    formatador.formatToParts(new Date(Date.now() + deslocamentoMs)).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}

const HORA = 3600 * 1000;

/** Aceita "AAAA-MM-DDTHH:mm" ou com segundos; devolve sempre com segundos, ou null se inválido. */
function normalizarDataHora(valor) {
  if (typeof valor !== 'string') return null;
  const m = valor.trim().match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  const [, a, mes, d, h, min, s = '00'] = m;
  const teste = new Date(Date.UTC(+a, +mes - 1, +d, +h, +min, +s));
  if (teste.getUTCMonth() !== +mes - 1 || teste.getUTCDate() !== +d || +h > 23 || +min > 59) return null;
  return `${a}-${mes}-${d}T${h}:${min}:${s}`;
}

const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

/** "2026-11-25T14:00:00" -> "qua 25/11 às 14:00" */
function formatarPrazo(texto) {
  const [data, hora] = texto.split('T');
  const [a, m, d] = data.split('-').map(Number);
  const dia = DIAS[new Date(Date.UTC(a, m - 1, d)).getUTCDay()];
  return `${dia} ${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')} às ${hora.slice(0, 5)}`;
}

/** "2026-11-25T14:00:00" -> "25/11/2026 14:00" */
function formatarDataHora(texto) {
  const [data, hora] = texto.split('T');
  const [a, m, d] = data.split('-');
  return `${d}/${m}/${a} ${hora.slice(0, 5)}`;
}

module.exports = { FUSO, HORA, agora, normalizarDataHora, formatarPrazo, formatarDataHora };

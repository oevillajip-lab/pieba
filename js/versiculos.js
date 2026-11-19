// Sugerencias de versículos para el panel (Configuración → Página de Inicio).
// Texto: Reina-Valera 1909 (dominio público) vía https://bible-api.com (gratis, sin clave).
// Las referencias usan los códigos de libro en inglés que pide la API; la respuesta llega en español.

export const TEMAS = {
  "Esperanza": [
    "JER 29:11",
    "ROM 15:13",
    "LAM 3:22-23",
    "ISA 40:31",
    "PSA 42:11",
    "ROM 8:28",
    "PRO 23:18",
    "PSA 33:22",
    "PSA 71:5",
    "HEB 10:23",
    "PSA 62:5",
    "ISA 43:19"
  ],
  "Fortaleza": [
    "ISA 41:10",
    "PHP 4:13",
    "JOS 1:9",
    "PSA 46:10",
    "2CO 12:9",
    "PSA 27:14",
    "ISA 12:2",
    "DEU 31:6",
    "ISA 40:29",
    "EPH 6:10",
    "PSA 18:2",
    "PSA 28:7"
  ],
  "Paz": [
    "JHN 14:27",
    "PHP 4:7",
    "ISA 26:3",
    "MAT 11:28",
    "PSA 4:8",
    "NUM 6:24-26",
    "COL 3:15",
    "JHN 16:33",
    "2TH 3:16",
    "PSA 29:11",
    "ROM 5:1",
    "PSA 55:22"
  ],
  "Amor": [
    "JHN 3:16",
    "1JN 4:19",
    "ROM 5:8",
    "1CO 13:4",
    "JHN 15:12",
    "ROM 8:31",
    "ZEP 3:17",
    "1CO 16:14",
    "PSA 36:7",
    "1JN 3:1",
    "1JN 4:10",
    "1JN 4:16"
  ],
  "Fe": [
    "HEB 11:1",
    "PRO 3:5-6",
    "MRK 9:23",
    "ROM 10:17",
    "2CO 5:7",
    "HEB 11:6",
    "EPH 2:8",
    "MRK 11:24",
    "JHN 11:25",
    "ROM 1:17",
    "JAS 1:6",
    "1JN 5:4"
  ],
  "Gratitud": [
    "PSA 100:4",
    "1TH 5:18",
    "PSA 118:24",
    "PSA 107:1",
    "COL 3:17",
    "PSA 103:2",
    "PSA 150:6",
    "PSA 34:8",
    "EPH 5:20",
    "PSA 9:10",
    "PSA 136:1",
    "PSA 95:2"
  ],
  "Guía": [
    "PSA 119:105",
    "PRO 16:3",
    "JAS 1:5",
    "PSA 32:8",
    "ISA 30:21",
    "MAT 6:33",
    "PSA 37:5",
    "PRO 16:9",
    "PSA 25:4-5",
    "ISA 58:11",
    "PSA 37:23",
    "PRO 4:23"
  ],
  "Familia": [
    "PRO 17:17",
    "1JN 4:11",
    "HEB 10:24",
    "COL 3:14",
    "PRO 22:6",
    "ROM 12:10",
    "GAL 6:2",
    "1PE 4:8",
    "EPH 4:32",
    "PSA 34:3",
    "EPH 4:3",
    "PRO 27:17"
  ]
};

const HEBREAS = 'ALEPH|BETH|GIMEL|DALETH|HE|VAU|ZAIN|CHETH|TETH|JOD|CAPH|LAMED|MEM|NUN|SAMECH|AIN|PE|TZADDI|COPH|RESH|SIN|SCHIN|TAU';
const L = 'A-Za-zÁÉÍÓÚáéíóúÑñÜü';

// Ortografía de 1909 → actual, y detalles de formato para mostrarlo en la portada
export function limpiarVersiculo(t) {
  t = String(t || '').replace(/\s+/g, ' ').trim();
  for (const [a, b] of [['á', 'a'], ['é', 'e'], ['ó', 'o'], ['ú', 'u']]) {
    t = t.replace(new RegExp(`(^|[^${L}])${a}(?=$|[^${L}])`, 'g'), `$1${b}`);
  }
  t = t.replace(/(^|[^${L}])fuí(?=$|[^${L}])/g, '$1fui');
  t = t.replace(new RegExp(`^(?:${HEBREAS})\\.\\s+`), '');
  if (t.startsWith('(') && t.endsWith(')')) t = t.slice(1, -1).trim();
  t = t.replace(/^([¡¿]?)([A-ZÁÉÍÓÚÑ]{2,})(?=[^A-ZÁÉÍÓÚÑ]|$)/, (_, p, w) => p + w[0] + w.slice(1).toLowerCase());
  t = t.replace(/[:;,]$/, '.');
  if (!/[.!?»”"]$/.test(t)) t += '.';
  return t;
}

const ultimos = [];
export async function sugerirVersiculo(tema) {
  const lista = tema && TEMAS[tema] ? TEMAS[tema] : Object.values(TEMAS).flat();
  const opciones = lista.filter(r => !ultimos.includes(r));
  const ref = (opciones.length ? opciones : lista)[Math.floor(Math.random() * (opciones.length || lista.length))];
  ultimos.push(ref); if (ultimos.length > 6) ultimos.shift();

  const res = await fetch(`https://bible-api.com/${encodeURIComponent(ref).replace(/%20/g, '+')}?translation=rv1909`);
  if (!res.ok) throw new Error(res.status === 429 ? 'Demasiadas consultas seguidas. Esperá unos segundos.' : 'No se pudo obtener el versículo.');
  const d = await res.json();
  if (!d.text) throw new Error('No se pudo obtener el versículo.');
  return { texto: limpiarVersiculo(d.text), referencia: d.reference, tema: tema || null };
}

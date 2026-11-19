#!/usr/bin/env node
/**
 * Migración única de datos: Firestore → Supabase
 *
 * Uso:
 *   cd scripts/migracion && npm install
 *
 *   # 1) Solo exportar Firestore a un archivo JSON (no toca Supabase)
 *   node migrar-firestore.mjs --firebase ./clave-firebase.json --exportar firestore.json
 *
 *   # 2) Importar a Supabase (desde Firestore directo o desde el JSON exportado)
 *   SUPABASE_SECRET_KEY=sb_secret_xxx node migrar-firestore.mjs --firebase ./clave-firebase.json
 *   SUPABASE_SECRET_KEY=sb_secret_xxx node migrar-firestore.mjs --desde firestore.json
 *
 * Opciones:
 *   --reemplazar   borra el contenido actual de las tablas en Supabase antes de importar
 *   --probar       muestra lo que se importaría sin escribir nada
 *
 * Las URLs de imágenes (Cloudinary) se copian tal cual: no hace falta mover fotos.
 */
import { readFile, writeFile } from 'node:fs/promises';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://ywftajhexpnofsoupfht.supabase.co';
const COLECCIONES = ['avisos', 'eventos', 'galeria', 'blog', 'miembros'];

/* ─── Argumentos ─── */
const args = process.argv.slice(2);
const arg = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
const flag = (n) => args.includes(n);
const rutaFirebase = arg('--firebase');
const rutaExportar = arg('--exportar');
const rutaDesde = arg('--desde');
const REEMPLAZAR = flag('--reemplazar');
const PROBAR = flag('--probar');

if (!rutaFirebase && !rutaDesde) {
  console.error('Indicá --firebase <clave.json> o --desde <export.json>. Ver instrucciones al inicio del archivo.');
  process.exit(1);
}

/* ─── Conversión de valores de Firestore ─── */
// Fecha: Timestamp de firebase-admin, {_seconds}, {seconds}, string o número
function aISO(v) {
  if (v == null || v === '') return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  if (typeof v === 'object' && ('_seconds' in v || 'seconds' in v)) {
    const s = v._seconds ?? v.seconds, ns = v._nanoseconds ?? v.nanoseconds ?? 0;
    return new Date(s * 1000 + Math.floor(ns / 1e6)).toISOString();
  }
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
}
const texto = (v) => (v == null || v === '' ? null : String(v));
const entero = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };
const AHORA = new Date().toISOString();

const TRANSFORMAR = {
  avisos: (d) => ({
    titulo: texto(d.titulo) || '(Sin título)',
    texto: texto(d.texto ?? d.contenido),
    tipo: ['normal', 'info', 'urgente'].includes(String(d.tipo).toLowerCase()) ? String(d.tipo).toLowerCase() : 'normal',
    fecha: aISO(d.fecha) || AHORA,
    imagen: texto(d.imagen),
  }),
  eventos: (d) => ({
    titulo: texto(d.titulo) || '(Sin título)',
    texto: texto(d.texto ?? d.descripcion),
    fecha: aISO(d.fecha ?? d.fechaInicio) || AHORA,
    imagen: texto(d.imagen),
  }),
  galeria: (d) => {
    const fotos = (Array.isArray(d.fotos) ? d.fotos : []).map((f) => (typeof f === 'string' ? f : f?.url)).filter(Boolean);
    return {
      nombre: texto(d.nombre ?? d.titulo) || '(Sin nombre)',
      fecha: aISO(d.fecha) || AHORA,
      portada: texto(d.portada) || fotos[0] || null,
      fotos,
    };
  },
  blog: (d) => ({
    titulo: texto(d.titulo) || '(Sin título)',
    categoria: texto(d.categoria) || 'Reflexión',
    autor: texto(d.autor) || 'PIEBA',
    extracto: texto(d.extracto ?? d.contenido),
    imagen: texto(d.imagen),
    fecha: aISO(d.fecha) || AHORA,
  }),
  miembros: (d) => ({
    nombre: texto(d.nombre) || '(Sin nombre)',
    anio: entero(d.anio),
    rol: texto(d.rol),
    orden: entero(d.orden) ?? 99,
    frase: texto(d.frase),
    referencia: texto(d.referencia),
    foto: texto(d.foto),
    es_pastor: !!d.isPastor,
  }),
};

/* ─── 1. Leer datos ─── */
async function leerFirestore() {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  const cuenta = JSON.parse(await readFile(rutaFirebase, 'utf8'));
  initializeApp({ credential: cert(cuenta) });
  const db = getFirestore();

  const datos = {};
  for (const col of COLECCIONES) {
    const snap = await db.collection(col).get();
    datos[col] = snap.docs.map((doc) => ({ _id: doc.id, ...doc.data() }));
    console.log(`  Firestore · ${col}: ${datos[col].length} documentos`);
  }
  return datos;
}

const datos = rutaDesde ? JSON.parse(await readFile(rutaDesde, 'utf8')) : await leerFirestore();

if (rutaExportar) {
  await writeFile(rutaExportar, JSON.stringify(datos, null, 2));
  console.log(`\n✓ Exportado a ${rutaExportar}`);
  if (!process.env.SUPABASE_SECRET_KEY) process.exit(0);
}

/* ─── 2. Transformar ─── */
const webconfigDoc = (datos.avisos || []).find((d) => d._id === 'webconfig');
const filas = {};
for (const col of COLECCIONES) {
  filas[col] = (datos[col] || [])
    .filter((d) => !(col === 'avisos' && d._id === 'webconfig'))
    .map(TRANSFORMAR[col]);
}
const webConfig = webconfigDoc
  ? Object.fromEntries(['inicio', 'nosotros', 'comunidad', 'contacto', 'ofrendas'].map((k) => [k, webconfigDoc[k] || {}]))
  : null;

console.log('\nA importar:');
for (const col of COLECCIONES) console.log(`  ${col.padEnd(9)} ${filas[col].length}`);
console.log(`  web_config ${webConfig ? 'sí' : 'no encontrada'}`);

if (PROBAR) {
  console.log('\n--probar: no se escribió nada. Ejemplo de filas:');
  for (const col of COLECCIONES) if (filas[col][0]) console.log(col, JSON.stringify(filas[col][0]).slice(0, 300));
  process.exit(0);
}

/* ─── 3. Escribir en Supabase ─── */
const KEY = process.env.SUPABASE_SECRET_KEY;
if (!KEY) {
  console.error('\nFalta SUPABASE_SECRET_KEY (clave secreta / service_role del proyecto).');
  process.exit(1);
}
const { createClient } = await import('@supabase/supabase-js');
const supabase = createClient(SUPABASE_URL, KEY, { auth: { persistSession: false } });

for (const col of COLECCIONES) {
  const { count, error } = await supabase.from(col).select('id', { count: 'exact', head: true });
  if (error) throw new Error(`${col}: ${error.message || error.code || JSON.stringify(error)}`);
  if (count > 0 && !REEMPLAZAR) {
    console.error(`\n✗ La tabla "${col}" ya tiene ${count} filas. Usá --reemplazar para borrarlas e importar de nuevo.`);
    process.exit(1);
  }
}

for (const col of COLECCIONES) {
  if (REEMPLAZAR) {
    const { error } = await supabase.from(col).delete().not('id', 'is', null);
    if (error) throw new Error(`Borrando ${col}: ${error.message}`);
  }
  if (filas[col].length) {
    const { error } = await supabase.from(col).insert(filas[col]);
    if (error) throw new Error(`Insertando ${col}: ${error.message}`);
  }
  console.log(`✓ ${col}: ${filas[col].length}`);
}

if (webConfig) {
  const { error } = await supabase.from('web_config').update(webConfig).eq('id', 1);
  if (error) throw new Error(`web_config: ${error.message}`);
  console.log('✓ web_config');
}

console.log('\nMigración terminada.');

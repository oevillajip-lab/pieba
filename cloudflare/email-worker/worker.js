// ═══════════════════════════════════════════════════════════════════
//  PIEBA Mail · Recepción de correo (Cloudflare Email Worker)
// ═══════════════════════════════════════════════════════════════════
//  Cloudflare entrega acá cada correo que llega al dominio. Este programa
//  lo lee y lo guarda en Supabase (función "buzon"), que además manda el
//  aviso al teléfono en el mismo instante.
//
//  Variables (Cloudflare → Workers → este worker → Settings → Variables):
//    BUZON_URL       https://<proyecto>.supabase.co/functions/v1/buzon
//    SUPABASE_APIKEY la clave PÚBLICA (publishable) del proyecto
//    BUZON_SECRETO   (secreto) el mismo texto que en Supabase
// ═══════════════════════════════════════════════════════════════════
import PostalMime from 'postal-mime';

async function llamar(env, cuerpo) {
  const r = await fetch(env.BUZON_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_APIKEY,
      'x-buzon-secreto': env.BUZON_SECRETO,
    },
    body: JSON.stringify(cuerpo),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`buzon ${r.status}: ${t.slice(0, 200)}`);
  return JSON.parse(t);
}

const direcciones = (lista) =>
  (lista || []).map((d) => (d.name ? `${d.name} <${d.address}>` : d.address)).filter(Boolean).join(', ');

export default {
  async email(message, env) {
    // 1. ¿Existe el buzón? Si no, se rechaza (el remitente recibe el aviso).
    const { buzones } = await llamar(env, { accion: 'entrante_destino', destinatarios: [message.to] });
    if (!buzones || !buzones.length) {
      message.setReject('Esta dirección no existe.');
      return;
    }

    // 2. Leer el correo completo.
    const crudo = await new Response(message.raw).arrayBuffer();
    const correo = await PostalMime.parse(crudo);

    for (const buzon of buzones) {
      // 3. Adjuntos: se suben directo a Storage con enlaces firmados.
      const adjuntos = [];
      const lista = correo.attachments || [];
      if (lista.length) {
        const { subidas } = await llamar(env, {
          accion: 'entrante_subir', buzon, nombres: lista.map((a, i) => a.filename || `adjunto_${i + 1}`),
        });
        for (let i = 0; i < lista.length; i++) {
          const a = lista[i];
          const s = subidas[i];
          const contenido = a.content instanceof ArrayBuffer ? a.content : new TextEncoder().encode(String(a.content || ''));
          const r = await fetch(s.url, {
            method: 'PUT',
            headers: { 'Content-Type': a.mimeType || 'application/octet-stream', 'x-upsert': 'true' },
            body: contenido,
          });
          if (!r.ok) continue;
          adjuntos.push({
            nombre: a.filename || `adjunto_${i + 1}`, tipo: a.mimeType || 'application/octet-stream',
            tamano: contenido.byteLength, cid: a.contentId || null, ruta: s.ruta,
          });
        }
      }

      // 4. Guardar el correo (y avisar al teléfono).
      await llamar(env, {
        accion: 'entrante',
        buzon,
        message_id: correo.messageId || '',
        in_reply_to: correo.inReplyTo || '',
        referencias: correo.references || '',
        de: correo.from?.address || message.from,
        de_nombre: correo.from?.name || '',
        para: direcciones(correo.to),
        cc: direcciones(correo.cc),
        responder_a: direcciones(correo.replyTo),
        asunto: correo.subject || '',
        html: correo.html || '',
        texto: correo.text || '',
        fecha: correo.date || '',
        tamano: message.rawSize,
        adjuntos,
      });
    }
  },
};

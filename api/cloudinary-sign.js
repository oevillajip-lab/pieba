import crypto from 'crypto';
import admin from 'firebase-admin';

// Inicializar Firebase Admin solo una vez
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    )
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Verificar token de Firebase
  const authHeader = req.headers.authorization || '';
  const token = authHeader.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  try {
    await admin.auth().verifyIdToken(token);
  } catch (e) {
    return res.status(403).json({ error: 'Token inválido' });
  }

  // Firmar para Cloudinary
  try {
    const body = req.body || {};
    const folder = body.folder || 'pieba/galeria';
    const timestamp = Math.floor(Date.now() / 1000);
    const paramsToSign = { folder, source: 'uw', timestamp };
    const sortedParams = Object.keys(paramsToSign)
      .sort()
      .map((key) => `${key}=${paramsToSign[key]}`)
      .join('&');
    const signature = crypto
      .createHash('sha1')
      .update(sortedParams + process.env.CLOUDINARY_API_SECRET)
      .digest('hex');

    return res.status(200).json({
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
      folder,
      timestamp,
      signature,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to generate signature' });
  }
}

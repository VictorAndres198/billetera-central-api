const express = require('express');
const { Pool } = require('pg'); // Driver de PostgreSQL
const fetch = require('node-fetch'); // Para llamar a los webhooks
const app = express();
const PORT = process.env.PORT || 3001;

// --- Middlewares ---
app.use(express.json()); // 1. Para que Express entienda JSON

// 2. Conexión a la BD de Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL, // De las variables de entorno de Render
  ssl: {
    rejectUnauthorized: false // Requerido por Render para conexiones externas
  }
});

// 3. Middleware de Autenticación (Seguridad)
// Esta función revisará el X-API-Token en cada solicitud
const checkApiKey = async (req, res, next) => {
  const token = req.get('X-API-Token');
  
  if (!token) {
    return res.status(401).json({ success: false, message: "Error: X-API-Token faltante." });
  }

  try {
    // Busca el token en la tabla de participantes
    const query = "SELECT * FROM participants WHERE token = $1";
    const result = await pool.query(query, [token]);
    
    if (result.rows.length === 0) {
      return res.status(403).json({ success: false, message: "Error: Token inválido." });
    }
    
    // Si es válido, adjuntamos la info del participante (app) al request
    req.participant = result.rows[0]; 
    next(); // Pasa al siguiente endpoint
  } catch (err) {
    console.error("Error en middleware checkApiKey:", err);
    res.status(500).json({ success: false, message: "Error interno del servidor" });
  }
};

// --- Rutas Públicas (Test) ---
app.get('/', (req, res) => {
  res.json({ status: "ok", message: "API Intermediaria Khipu v1.0 en línea." });
});

// --- Rutas Protegidas (Requieren API Key) ---
const api = express.Router();
api.use(checkApiKey); // Aplica el middleware de seguridad a TODAS las rutas /api/v1

// Endpoint 1: Registrar un Wallet (POST /api/v1/register-wallet)
api.post('/v1/register-wallet', async (req, res) => {
  // El 'participant_id' viene del token (gracias al middleware checkApiKey)
  const participantId = req.participant.id;
  const { userIdentifier, internalWalletId, userName } = req.body;

  if (!userIdentifier || !internalWalletId || !userName) {
    return res.status(400).json({ success: false, message: "Faltan campos: userIdentifier, internalWalletId, userName" });
  }

  try {
    const query = `
      INSERT INTO wallets (user_identifier, internal_wallet_id, user_name, participant_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_identifier, participant_id) DO NOTHING
      RETURNING wallet_uuid, user_identifier, user_name, created_at;
    `;
    const result = await pool.query(query, [userIdentifier, internalWalletId, userName, participantId]);
    
    if (result.rows.length === 0) {
      // Esto pasa si el 'ON CONFLICT' se activó
      return res.status(200).json({ success: true, message: "Este usuario ya estaba registrado." });
    }
    
    res.status(201).json({ success: true, data: result.rows[0] });
  } catch (err) {
    console.error("Error en /register-wallet:", err);
    res.status(500).json({ success: false, message: "Error al registrar wallet", error: err.message });
  }
});

// Endpoint 2: GET /api/v1/wallets (Para pruebas)
// Devuelve todos los usuarios registrados
api.get('/v1/wallets', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM wallets");
    res.json({ success: true, data: result.rows });
  } catch (err) {
    console.error("Error en /wallets:", err);
    res.status(500).json({ success: false, message: "Error en el servidor" });
  }
});

// Endpoint 3: GET /api/v1/wallets/:identifier (Buscar destinatario)
// Busca todas las billeteras asociadas a un teléfono/DNI
api.get('/v1/wallets/:identifier', async (req, res) => {
  try {
    const { identifier } = req.params;
    
    // Unimos (JOIN) wallets y participants para obtener el app_name
    const query = `
      SELECT w.wallet_uuid, w.user_name, p.app_name
      FROM wallets w
      JOIN participants p ON w.participant_id = p.id
      WHERE w.user_identifier = $1;
    `;
    const result = await pool.query(query, [identifier]);

    if (result.rows.length > 0) {
      res.json({
        found: true,
        identifier: identifier,
        wallets_disponibles: result.rows
      });
    } else {
      res.status(404).json({ found: false, message: "Usuario no encontrado en el hub central." });
    }
  } catch (err) {
    console.error("Error en /wallets/:identifier:", err);
    res.status(500).json({ success: false, message: "Error en el servidor" });
  }
});


// Endpoint 4: POST /api/v1/transfer (¡El importante!)
api.post('/v1/transfer', async (req, res) => {
  // 'req.participant' nos dice QUIÉN está enviando (ej. Khipu)
  const fromParticipant = req.participant;
  
  const { fromIdentifier, toIdentifier, toAppName, monto, descripcion } = req.body;
  
  if (!fromIdentifier || !toIdentifier || !toAppName || !monto || monto <= 0) {
    return res.status(400).json({ success: false, message: "Faltan campos: fromIdentifier, toIdentifier, toAppName, monto (debe ser > 0)" });
  }

  const client = await pool.connect(); // Inicia una conexión
  
  try {
    // 1. Obtener el Participante (App) destino
    const toParticipantResult = await client.query("SELECT * FROM participants WHERE app_name = $1", [toAppName]);
    if (toParticipantResult.rows.length === 0) {
      throw new Error(`La aplicación destino '${toAppName}' no está registrada.`);
    }
    const toParticipant = toParticipantResult.rows[0];

    // 2. Obtener el Wallet (Usuario) destino
    const toWalletResult = await client.query("SELECT * FROM wallets WHERE user_identifier = $1 AND participant_id = $2", [toIdentifier, toParticipant.id]);
    if (toWalletResult.rows.length === 0) {
      throw new Error(`El usuario '${toIdentifier}' no está registrado en '${toAppName}'.`);
    }
    const toWallet = toWalletResult.rows[0];

    // 3. Crear el Log de Transacción (PENDING)
    const logQuery = `
      INSERT INTO transactions_log (from_participant_id, to_participant_id, from_user_identifier, to_user_identifier, monto, status)
      VALUES ($1, $2, $3, $4, $5, 'PENDING')
      RETURNING tx_uuid;
    `;
    const logResult = await client.query(logQuery, [fromParticipant.id, toParticipant.id, fromIdentifier, toIdentifier, monto]);
    const centralTxUUID = logResult.rows[0].tx_uuid;

    // 4. Preparar JSON para el Webhook de la app destino
    const jsonParaDestino = {
      fromAppName: fromParticipant.app_name,
      internalWalletId: toWallet.internal_wallet_id, // El ID que la app destino entiende
      monto: monto,
      descripcion: descripcion || "Transferencia",
      centralTransactionId: centralTxUUID // ID de auditoría
    };


    // -----------------------------------------------------------
    // ✅ ¡ESTA ES LA LÓGICA DE SIMULACIÓN QUE NECESITAS!
    // -----------------------------------------------------------
    let respuestaDeDestino;
    
    // Si la URL del webhook es la de placeholder, SIMULAMOS el éxito
    if (toParticipant.webhook_url.includes('placeholder.com')) {
      
      console.log(`[INFO] SIMULANDO llamada a webhook (placeholder): ${toParticipant.webhook_url}`);
      respuestaDeDestino = { success: true, localTransactionId: "tx_simulada_123" };
    
    } else {
      // Si es un webhook real, intenta llamarlo
      console.log(`[INFO] Llamando a Webhook REAL: ${toParticipant.webhook_url}`);
      try {
        const response = await fetch(toParticipant.webhook_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Token': toParticipant.token // El API Central se autentica con el TOKEN del destino
          },
          body: JSON.stringify(jsonParaDestino),
          timeout: 10000 // 10 segundos de timeout
        });

        if (!response.ok) {
          throw new Error(`El webhook de ${toAppName} respondió con error: ${response.status}`);
        }
        respuestaDeDestino = await response.json(); // { success: true, localTransactionId: "..." }

      } catch (e) {
        // Si el webhook falla (timeout, 500, o ENOTFOUND como viste)
        console.error("[ERROR] La llamada al webhook falló:", e.message);
        // Marcar la transacción como FAILED
        await client.query("UPDATE transactions_log SET status = 'FAILED' WHERE tx_uuid = $1", [centralTxUUID]);
        // Lanza el error para que sea capturado por el catch principal
        throw new Error(`Error contactando a ${toAppName}: ${e.message}`);
      }
    }
    // -----------------------------------------------------------
    // FIN DE LA LÓGICA DE SIMULACIÓN/LLAMADA
    // -----------------------------------------------------------


    // 6. Si el otro backend dijo OK (real o simulado), marcamos la transacción como COMPLETED
    if (respuestaDeDestino.success) {
      await client.query(
        "UPDATE transactions_log SET status = 'COMPLETED', destination_tx_id = $1 WHERE tx_uuid = $2",
        [respuestaDeDestino.localTransactionId, centralTxUUID]
      );
      
      res.json({
        success: true,
        status: "COMPLETED",
        centralTransactionId: centralTxUUID,
        message: "Transferencia completada"
      });
    } else {
      // Si el otro backend respondió { success: false }
      await client.query("UPDATE transactions_log SET status = 'FAILED' WHERE tx_uuid = $1", [centralTxUUID]);
      res.status(400).json({ success: false, message: "La aplicación destino rechazó la transferencia." });
    }

  } catch (err) {
    // Captura errores de SQL, de lógica, o el "throw" del fetch fallido
    console.error("[ERROR] en /v1/transfer:", err.message);
    res.status(400).json({ success: false, message: err.message });
  } finally {
    client.release(); // Libera la conexión
  }
});


// --- Iniciar Servidor ---
app.use('/api', api); // Monta todas las rutas protegidas bajo /api
app.listen(PORT, () => {
  console.log(`Servidor API Intermediario escuchando en el puerto ${PORT}`);
});
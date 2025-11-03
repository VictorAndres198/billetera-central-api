// index.js
const express = require('express');
const { Pool } = require('pg'); // 👈 1. Importa el cliente de Postgres
const app = express();
const PORT = process.env.PORT || 3001;

// 2. Configura la conexión usando la variable de entorno de Render
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Si Render requiere SSL para conexiones (a veces lo hace en planes gratis):
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Endpoint "Hola Mundo" (que ya tenías)
app.get('/', (req, res) => {
  res.json({ 
    status: "ok", 
    message: "¡Hola Mundo! El Intermediario Khipu está en línea." 
  });
});

// 3. NUEVO ENDPOINT para probar la BD
app.get('/test-db', async (req, res) => {
  try {
    // Saca una conexión del "pool"
    const client = await pool.connect(); 

    // Ejecuta una consulta de prueba (ej. 'SELECT NOW()' devuelve la hora actual)
    const result = await client.query('SELECT NOW()');

    // Devuelve el resultado
    res.json({ 
      status: "success", 
      db_time: result.rows[0].now 
    });

    // Libera la conexión
    client.release();
  } catch (err) {
    // Si falla, muestra el error
    res.status(500).json({ 
      status: "error", 
      message: "No se pudo conectar a la base de datos.",
      error: err.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
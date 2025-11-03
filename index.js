// index.js
const express = require('express');
const app = express();

// Render te dará un puerto en una variable de entorno. 
// Si estamos en local, usamos el 3001.
const PORT = process.env.PORT || 3001;

// Este es tu primer "endpoint"
// Cuando alguien visite la URL raíz (GET /), le responderemos con un JSON
app.get('/', (req, res) => {
  res.json({ 
    status: "ok", 
    message: "¡Hola Mundo! El Intermediario Khipu está en línea." 
  });
});

// (Aquí pondrás tus endpoints reales, como POST /transferir)

// Inicia el servidor
app.listen(PORT, () => {
  console.log(`Servidor escuchando en el puerto ${PORT}`);
});
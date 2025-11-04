# API Intermediaria - Khipu (Contrato de Interoperabilidad)

Esta es la API centralizada para el proyecto de interoperabilidad de billeteras digitales. Actúa como un **Directorio de Billeteras** y un **Enrutador de Transacciones** (Hub-and-Spoke) para todas las aplicaciones.

**URL Base (Producción):** `https://billetera-central-api.onrender.com`

---

## 1. Modelo de Funcionamiento (Hub-and-Spoke)

Este API **NO** guarda saldos de usuarios. Actúa como un "Directorio Telefónico" y un "Cartero".

1.  **Directorio (Páginas Amarillas):** Mantiene un registro de qué usuarios (identificados por teléfono/DNI) existen en qué aplicaciones (`Khipu`, `BilleteraGrupoB`, etc.).
2.  **Cartero (Enrutador):** Cuando Khipu quiere enviar dinero a GrupoB, Khipu llama a esta API. La API busca la "dirección" (webhook) de GrupoB y le reenvía la orden de pago.

**El Saldo de cada usuario (Khipu, GrupoB) vive en la PROPIA base de datos de esa app (Firebase, SQL, etc.).**

---

## 2. Autenticación (¡Para Todos los Grupos!)

Todas las solicitudes a esta API deben incluir una **API Key** (Token) secreta en el *header* HTTP para identificar qué aplicación está haciendo la llamada.

* **Header Requerido:** `X-API-Token`
* **Valor:** `TOKENDECADAGRUPO` (Cada grupo tendrá su propia llave secreta).

Si la llave falta o es inválida, la API devolverá un error `401 Unauthorized`.

---

## 3. Esquema de Base de Datos (PostgreSQL)

Esta API usa dos tablas principales en su propia base de datos (`billetera-central-db`) para funcionar.

### Tabla: `participants`
Registra las "Apps" (grupos) que participan en el sistema.

| Columna | Tipo | Descripción |
| :--- | :--- | :--- |
| `id` (PK) | `uuid` | ID único para la app (ej. "Khipu"). |
| `app_name` | `varchar` | Nombre único (ej. "Khipu", "BilleteraGrupoB"). |
| `webhook_url`| `varchar` | **URL del Backend de la app** para RECIBIR dinero. |
| `token` | `varchar` | **La API Key secreta** de esta app. |

### Tabla: `wallets`
Es el "Directorio" que mapea usuarios a sus billeteras en diferentes apps.

| Columna | Tipo | Descripción |
| :--- | :--- | :--- |
| `wallet_uuid` (PK)| `uuid` | ID único para *esta entrada* del directorio. |
| `user_identifier` | `varchar` | **ID Universal:** El teléfono o DNI (ej. "+51..."). |
| `internal_wallet_id`| `varchar` | **ID Interno:** El ID de ese usuario en la BD de *su app* (ej. UID de Firebase). |
| `user_name` | `varchar` | Nombre del usuario (para mostrar en búsquedas). |
| `participant_id` (FK)| `uuid` | Enlaza con la app (`participants.id`). |
| `created_at` | `timestamp`| Fecha de registro. |

*Nota: La clave única está en `(user_identifier, participant_id)`.*

### Código `dbdiagram.io` (Para visualizar)
```dbdiagram
// --- El Directorio (Páginas Amarillas) ---
Table participants {
  id uuid [pk, default: `gen_random_uuid()`]
  app_name varchar(50) [not null, unique]
  webhook_url varchar(255) [not null]
  token varchar(100) [not null, unique]
}

Table wallets {
  wallet_uuid uuid [pk, default: `gen_random_uuid()`]
  user_identifier varchar(50) [not null] // ID Universal (ej: "+51999...")
  internal_wallet_id varchar(100) [not null] // ID de la BD de la app (ej. Firebase UID)
  user_name varchar(100) [not null]
  participant_id uuid [not null]
  created_at timestamptz [default: `now()`]
  
  // Un teléfono/DNI solo puede tener UNA cuenta POR app
  indexes {
    (user_identifier, participant_id) [unique]
  }
}

// --- El Historial de Transacciones (Auditoría) ---
Table transactions_log {
  tx_uuid uuid [pk, default: `gen_random_uuid()`]
  from_participant_id uuid [not null]
  to_participant_id uuid [not null]
  from_user_identifier varchar(50) [not null]
  to_user_identifier varchar(50) [not null]
  monto decimal(12, 2) [not null]
  status varchar(20) [default: '"PENDING"'] // PENDING, COMPLETED, FAILED
  created_at timestamptz [default: `now()`]
  destination_tx_id varchar(100)
}

// Definir Relaciones
Ref: "participants"."id" < "wallets"."participant_id"
Ref: "participants"."id" < "transactions_log"."from_participant_id"
Ref: "participants"."id" < "transactions_log"."to_participant_id"
```
---
## 4. Contrato de API (Endpoints para Todos)

Estos son los endpoints que todas las aplicaciones deben consumir.

### A. Registrar un Usuario (¡El "Doble Registro"!)

* **Cuándo:** Inmediatamente después de que un usuario se registre en tu propia app.

* **Propósito:** Le dice a la API Central que tu nuevo usuario (con su teléfono/DNI) ahora existe en tu app.

* **Método:**  `POST /api/v1/register-wallet`

* **Headers:**` X-API-Token: [Tu_Token_Secreto_de_Grupo]`

* **Body (JSON que envías):**
```
{
  "userIdentifier": "+51987654321",
  "internalWalletId": "uuid-de-tu-base-de-datos-del-usuario-registrado",
  "userName": "Nombre del Usuario"
}
```
* **Respuesta Exitosa (201, JSON):**
```
{
  "success": true,
  "data": {
    "wallet_uuid": "...",
    "user_identifier": "+51987654321",
    "user_name": "Nombre del Usuario",
    "created_at": "..."
  }
}
```
### B. Buscar un Destinatario 

* **Cuándo:** Cuando un usuario quiere enviar dinero a un número.

* **Propósito:** Pregunta al API Central: "¿Qué billeteras existen para este número?"

* **Método:** `GET /api/v1/wallets/:identifier`

* **Ejemplo:** `GET /api/v1/wallets/+51111222333`

* **Headers:** `X-API-Token: [Tu_Token_Secreto_de_Grupo]`

* **Respuesta (JSON que recibes):**
```
{
  "found": true,
  "identifier": "+51111222333",
  "wallets_disponibles": [
    { 
      "wallet_uuid": "uuid-de-khipu-para-ese-numero",
      "appName": "Khipu", 
      "userName": "Juan (Khipu)" 
    },
    { 
      "wallet_uuid": "uuid-de-grupob-para-ese-numero",
      "appName": "BilleteraGrupoB", 
      "userName": "Juan (Grupo B)" 
    }
  ]
}
```
### C. Ejecutar la Transferencia (El "Envío")

* **Cuándo:** Cuando el usuario selecciona una app destino (ej. "BilleteraGrupoB") y un monto.

* **Propósito:** Le da la orden al API Central para que actúe como "cartero" y mueva el dinero.

* **Método:** `POST /api/v1/transfer`

* **Headers:** `X-API-Token: [Tu_Token_Secreto_de_Grupo]`

* **Body (JSON que envías):**
```
{
  "fromIdentifier": "+51999888777",
  "toIdentifier": "+51111222333",
  "toAppName": "BilleteraGrupoB",
  "monto": 10.50,
  "descripcion": "Pago de la cena"
}
```
* **Respuesta (JSON que recibes):**
```
{
  "success": true,
  "status": "COMPLETED",
  "centralTransactionId": "tx-uuid-...",
  "message": "Transferencia completada"
}
```
### D. Recibir Dinero (El Webhook que todos deben construir)

* **Propósito:** El "buzón" de cada app para aceptar un depósito.

* **Método:** `POST (URL que cada grupo proporcionará, ej: https://api-grupoc.onrender.com/deposit)`

* **Headers (que el API Central les enviará): X-API-Token:** `[Su_Token_Secreto_de_Grupo]`

* **Body (JSON que ellos reciben):**
```
{
  "fromAppName": "Khipu",
  "internalWalletId": "sql_id_de_su_usuario_xyz",
  "monto": 10.50,
  "descripcion": "Pago de la cena",
  "centralTransactionId": "tx-uuid-..."
}
```
* **Respuesta (JSON que ellos deben devolver):**
```
{
  "success": true,
  "localTransactionId": "su-id-de-transaccion-interna-123"
}
```

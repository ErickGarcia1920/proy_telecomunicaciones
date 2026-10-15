# Internet prepago de última milla

Portal de venta de acceso a Internet por tiempo, con autenticación **RADIUS** contra el portal cautivo de **pfSense**, contabilidad de consumo, monitoreo en tiempo real y soporte **Dual Stack (IPv4 + IPv6)**. Proyecto final de Telecomunicaciones, Universidad Mariano Gálvez de Guatemala.

No usa dependencias externas: solo Node.js 20 o superior.

## Qué hace

1. El usuario se conecta al Wi-Fi y pfSense lo manda al portal cautivo.
2. En la tienda **elige un paquete, deja sus datos y paga** (pasarela simulada).
3. El portal **emite un usuario y una contraseña**, guarda solo el hash y se las muestra una sola vez.
4. El usuario toca **“Conectarme ahora”**: el navegador envía las credenciales a pfSense.
5. pfSense consulta a nuestro **servidor RADIUS**, que responde con el tiempo disponible, la velocidad del paquete y el intervalo de reportes.
6. pfSense reporta tiempo y tráfico por **contabilidad RADIUS**. El portal descuenta el saldo y lo muestra en el panel de estado.

```
 Cliente Wi-Fi ──► pfSense (portal cautivo) ──UDP 1812/1813──► Portal (Node.js)
      │                                                          ├─ Web (tienda + /estado)
      └──────────── HTTP (tienda) ──► HAProxy ──► Portal ───────├─ RADIUS (auth + acct)
                                                                 ├─ /metrics ─► Telegraf ─► InfluxDB ─► Grafana
                                                                 └─ data/store.json
```

## Inicio rápido

```bash
# Desarrollo, sin RADIUS:
RADIUS_ENABLED=false npm start        # abre http://localhost:3000

# Con RADIUS (el secreto debe tener al menos 16 caracteres):
RADIUS_SECRET='un-secreto-largo-y-unico' \
PORTAL_LOGIN_URL='https://10.10.20.1:8003/index.php?zone=prepago' \
npm start

npm test                              # pruebas automáticas
```

El panel de monitoreo está en `/estado`. Para desplegar en el servidor, usen `ops/portal.service` y `.env.example`. La configuración de pfSense está en [`docs/pfsense.md`](docs/pfsense.md).

## Configuración

Todo se controla por variables de entorno. Las más importantes:

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `PORT`, `HOST` | Puerto y dirección. `::` atiende IPv4 e IPv6 | `3000`, `::` |
| `TRUST_PROXY` | Leer `X-Forwarded-For` (detrás de HAProxy) | `false` |
| `PORTAL_LOGIN_URL` | URL de inicio de sesión del portal cautivo de pfSense | vacío |
| `RADIUS_ENABLED` | Activar el servidor RADIUS | `true` |
| `RADIUS_SECRET` | Secreto compartido con pfSense (**obligatorio**, mínimo 16 caracteres) | — |
| `RADIUS_CLIENTS` | IP o CIDR de pfSense autorizadas | cualquiera |
| `RADIUS_SINGLE_DEVICE` | Una sola sesión activa por usuario | `true` |
| `METRICS_TOKEN` | Si se define, `/metrics` exige `Authorization: Bearer <token>` | vacío |
| `DATA_FILE` | Archivo de datos | `data/store.json` |

La lista completa está en `src/config.js`. Los paquetes se editan en `src/plans.js`.

## API

| Método | Ruta | Descripción |
|---|---|---|
| `GET` | `/api/plans` | Paquetes disponibles |
| `POST` | `/api/register` | Crea la orden con nombre, correo, paquete y aceptación de condiciones |
| `POST` | `/api/payments/mock` | Pago simulado. Acepta cabecera `Idempotency-Key` |
| `GET` | `/api/sessions/:id` | Estado de la orden y saldo de la cuenta |
| `GET` | `/api/stats` | Resumen y serie temporal para el panel |
| `GET` | `/metrics` | Formato Prometheus, para Telegraf |
| `GET` | `/healthz` | Estado para los *health checks* del balanceador |

**Tarjetas de prueba:** `4242 4242 4242 4242` aprueba, `4000 0000 0000 0002` rechaza y `4000 0000 0000 9995` simula fondos insuficientes. Cualquier otro número se rechaza, así nadie escribe una tarjeta real por error.

## Seguridad

- Las contraseñas se guardan con **scrypt** y salt; la comparación es de tiempo constante.
- El número de tarjeta **nunca se guarda ni se registra**: solo los últimos 4 dígitos.
- Las credenciales se muestran **una sola vez**; la contraseña en claro se borra al entregarla.
- RADIUS verifica la **firma de la contabilidad** y el *Message-Authenticator*, y **descarta en silencio** lo que no puede verificar. Solo responde a las IP de `RADIUS_CLIENTS`.
- Pagos **idempotentes**, máximo de 5 intentos por orden y órdenes que vencen a los 30 minutos.
- Límite de peticiones por IP, cuerpo máximo de 16 KB, cabeceras de seguridad y una política CSP estricta.
- Las páginas no cargan nada externo: antes de autenticarse el usuario no tiene Internet.

## Monitoreo

`/metrics` expone, entre otras, `portal_uptime_seconds`, `portal_http_latency_ms`, `portal_users_online`, `portal_traffic_bytes_total` y `portal_radius_requests_total`. Con `ops/telegraf.conf` van a InfluxDB, y de ahí pueden armar los paneles de Grafana de uptime, latencia y ancho de banda. `/estado` muestra lo mismo sin depender de Grafana.

## Alta disponibilidad

`ops/haproxy.cfg` configura un par **activo/respaldo** con *health checks* sobre `/healthz`. Los dos servidores comparten la carpeta `data/`, y el respaldo recarga los datos al tomar el control. En pfSense se registra el segundo servidor como RADIUS secundario. **Es activo/respaldo, no activo/activo**: dos servidores escribiendo a la vez corromperían el estado.

## Estructura

```
server.js            arranque, apagado ordenado
src/app.js           rutas HTTP y archivos estáticos
src/radius.js        servidor RADIUS (RFC 2865, 2866, 3579)
src/store.js         persistencia atómica
src/payments.js      pasarela simulada
src/metrics.js       métricas y serie temporal
public/              tienda (index) y panel (estado)
test/                32 pruebas, incluida la capa RADIUS
ops/                 servicio systemd, HAProxy, Telegraf
docs/pfsense.md      configuración de pfSense paso a paso
```

## Alcance y límites

- **El pago es simulado**, como exige la guía del proyecto. No hay pasarela real.
- **RADIUS se probó con paquetes armados según el RFC, no contra un pfSense real.** Los valores de `docs/pfsense.md` deben verificarse en su versión.
- La tienda corre por **HTTP** en la LAN del laboratorio. En una operación real necesita TLS, porque ahí se capturan datos y tarjeta.
- Los datos viven en un archivo JSON: sirve para este volumen, pero no para varios escritores.
- No incluye envío de correos ni panel de administración.
- **Legal:** operar en la banda de 2.4 GHz debe validarse con la SIT antes de cualquier uso comercial.

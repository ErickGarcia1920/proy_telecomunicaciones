# Internet prepago de última milla

Prototipo académico del portal de registro y pago simulado. El servidor Node.js sirve la interfaz y expone una API local; **no procesa pagos reales, no concede acceso a Internet y todavía no configura ni modifica pfSense**.

## Requisitos

- Node.js 20 o posterior.

## Ejecución

Desde esta carpeta:

```powershell
npm start
```

Abre `http://127.0.0.1:3000`. Para permitir pruebas desde otra máquina de la red del laboratorio, inicia el servidor enlazado a la interfaz de red local:

```powershell
$env:HOST = "0.0.0.0"
npm start
```

No expongas este prototipo a Internet. Los registros se guardan solo en memoria y se pierden al reiniciar el proceso. Los nombres, precios y estados son datos de demostración.

## Pruebas

```powershell
npm test
```

## Flujo implementado

1. El usuario completa nombre, correo, paquete y aceptación de condiciones.
2. `POST /api/register` valida la solicitud y crea una sesión en estado `registered`.
3. El botón de simulación llama a `POST /api/payments/mock`; la API cambia el estado a `payment_simulated`.
4. `GET /api/sessions/:id` permite consultar el estado de la sesión.

El estado `payment_simulated` es solo un registro de la demo: **no equivale a una autenticación en el portal cautivo ni libera reglas de firewall**.

## Integración posterior con pfSense

La integración se debe implementar después de confirmar la versión de pfSense, el diseño de interfaces/VLAN y el método de autenticación elegido. Una opción habitual a evaluar es autenticar el portal cautivo de pfSense contra RADIUS: el backend podría crear o habilitar credenciales después de validar el pago, y el usuario autenticarse en el portal de pfSense. No se debe asumir que una API de terceros o una edición directa de la configuración de pfSense estará disponible o será compatible.

Antes de habilitar tráfico de usuarios, también se deberá probar el control previo a la autenticación para IPv4 **e IPv6**, el aislamiento de la red de gestión y el comportamiento de DNS. No configures credenciales de administración de pfSense en el navegador ni en el código cliente.

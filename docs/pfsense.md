# Configuración de pfSense para el portal

> Los nombres de menús pueden variar un poco según la versión de pfSense. Esta guía describe
> el diseño y los valores que deben coincidir. Verifiquen cada paso en su versión.

## 1. Red

| VLAN | Uso | IPv4 | IPv6 |
|---|---|---|---|
| 10 | Gestión | 10.10.10.0/24 | fd4a:7c21:9e05:10::/64 |
| 20 | Usuarios (portal cautivo) | 10.10.20.0/24 | fd4a:7c21:9e05:20::/64 |
| 30 | Servicios (portal web, RADIUS, monitoreo) | 10.10.30.0/24 | fd4a:7c21:9e05:30::/64 |

- Creen las VLAN sobre la interfaz LAN y asignen IP IPv4 e IPv6 a cada una.
- En la VLAN 20 activen DHCP y DHCPv6 (o anuncios de router), con el DNS Resolver como servidor.
- Los prefijos IPv6 son direcciones locales únicas de laboratorio; cámbienlos si tienen un prefijo delegado real.

## 2. Servidor del portal (VLAN 30)

1. Copien este proyecto a `/opt/portal` y creen un usuario `portal` sin shell.
2. Copien `.env.example` a `/etc/portal.env` y completen los valores. El **`RADIUS_SECRET`** debe ser idéntico al de pfSense.
3. Instalen `ops/portal.service` en `/etc/systemd/system/` y ejecuten `systemctl enable --now portal`.
4. Comprueben con `curl http://10.10.30.11:3000/healthz`.

## 3. Reglas de firewall

| Interfaz | Origen → Destino | Puerto | Acción |
|---|---|---|---|
| VLAN 20 | Usuarios → pfSense | DNS 53 TCP/UDP | Permitir |
| VLAN 20 | Usuarios → portal web (10.10.30.10) | HTTP 80 | Permitir (también como IP permitida del portal cautivo) |
| VLAN 20 | Usuarios → VLAN 10 | cualquiera | Bloquear |
| VLAN 30 | pfSense → portal | UDP 1812 y 1813 | Permitir (es tráfico generado por pfSense) |
| VLAN 10 | Administración → pfSense | HTTPS 443 | Permitir solo desde esta VLAN |
| VLAN 30 | pfSense → servidor AIOps | syslog UDP 514 | Se configura en *Status → System Logs → Settings → Remote Logging*; lo genera pfSense, y el servidor AIOps debe aceptar UDP 514 |
| Todas | lo demás | | Denegar y registrar |

## 4. Portal cautivo

En **Services → Captive Portal** creen una zona (por ejemplo `prepago`) sobre la interfaz de la VLAN 20 y configuren:

- **Autenticación:** RADIUS.
  - Servidor primario: `10.10.30.11`, puerto `1812`, secreto compartido.
  - Servidor secundario: `10.10.30.12` (el respaldo), mismos datos.
- **Contabilidad (accounting):** activada, puerto `1813`, con actualizaciones periódicas (interim).
- **Usar el atributo Session-Timeout de RADIUS:** activado. Así el tiempo del paquete se corta solo.
- **Límite de velocidad por usuario:** activado. El portal envía los atributos WISPr `Max-Down` y `Max-Up` según el paquete.
- **Direcciones permitidas sin autenticar:** `10.10.30.10`, para que el usuario llegue a la tienda antes de pagar.
- **HTTPS en el inicio de sesión:** activado con un certificado, porque por ahí viajan usuario y contraseña.

## 5. Página de acceso personalizada

En la zona, suban un HTML propio con dos cosas: un enlace a la tienda y el formulario de pfSense. Los campos deben llamarse exactamente así:

```html
<a href="http://10.10.30.10/?redirurl=$PORTAL_REDIRURL$">Comprar Internet</a>

<form method="post" action="$PORTAL_ACTION$">
  <input name="auth_user" placeholder="Usuario" autocomplete="username">
  <input name="auth_pass" type="password" placeholder="Contraseña" autocomplete="current-password">
  <input name="redirurl" type="hidden" value="$PORTAL_REDIRURL$">
  <button name="accept" value="Continue">Conectar</button>
</form>
```

Si la URL original contiene caracteres especiales, puede ser necesario codificarla con `encodeURIComponent`.

## 6. Cómo comprobar que funciona

1. **Prueba de autenticación:** compren un paquete en el portal y usen *Diagnostics → Authentication* de pfSense con ese usuario y contraseña, contra el servidor RADIUS.
2. **Prueba real:** conecten un celular al Wi-Fi, abran una página HTTP y compren un paquete. Al tocar “Conectarme ahora” deben quedar navegando.
3. **Contabilidad:** en `/estado` deben aparecer 1 usuario conectado y el consumo subiendo.
4. **Corte por tiempo:** compren el paquete de 1 hora y bajen `RADIUS_MAX_SESSION_SECONDS` a un valor corto para ver cómo pfSense desconecta la sesión.

## 7. Problemas comunes

| Síntoma | Causa probable |
|---|---|
| pfSense dice “tiempo de espera agotado” | El portal no responde: secreto distinto, `RADIUS_CLIENTS` sin la IP de pfSense, o puerto UDP bloqueado. Por diseño el servidor **descarta en silencio** lo que no puede verificar. |
| “Usuario o contraseña incorrectos” con datos correctos | Ya se mostraron las credenciales y se copiaron mal. Prueben con el botón “Copiar”. |
| “Ya hay una sesión activa en otro dispositivo” | Sesión colgada. Se libera sola tras 3 minutos sin reportes de contabilidad. |
| El usuario no navega tras entrar | Falta una regla para la VLAN 20 en el portal, o el DNS no resuelve. |

# Backlog — CMU Platform

Items sin fecha comprometida. Cuando se decida ejecutar, se abre commit y se mueve a historial.

---

## AVP — UI de aceptación en PWA y WhatsApp

**Estado:** backend completo (`e0b4a58`, 21-abr-2026). UI pendiente.

**Endpoints ya vivos:**
- `GET  /api/aviso-privacidad?phone=...`
- `POST /api/aviso-privacidad/accept`
- `POST /api/aviso-privacidad/revoke`

**Alcance propuesto (cuando se ejecute):**

1. Componentes React `<AvpModal />` + `<AvpStatusBadge />` en `cmu-decision/client/src/`.
2. Integración bloqueante al wizard del prospecto — el paso 0 consulta `GET /api/aviso-privacidad?phone=X` y bloquea hasta que el estado sea `VIGENTE`.
3. Handlers nuevos en `server/agent/orchestrator.ts` para estado `avp_pending` y palabras `ACEPTO`, `ACEPTO PROMOS`, `SOLO LO ESENCIAL`.
4. Templates nuevos en `server/agent/templates.ts`: `AVP_INTRO`, `AVP_OTP_REQUEST`, `AVP_ACCEPTED`, `AVP_REJECTED`.
5. Endpoint público `GET /api/aviso-privacidad/pdf/v2` que sirva la plantilla renderizada (para que el link en WhatsApp funcione).
6. Backfill: script opcional que marca a operadores existentes como `needsAcceptance=true` para forzar re-aceptación al próximo contacto.

**Decisiones de producto que quedaron abiertas:**
- Quién acepta (operador directo vía WhatsApp+OTP, promotora como intermediaria, o híbrido).
- Publicación pública del PDF (endpoint, archivo estático, o sitio institucional).
- Modal bloqueante vs. permisivo con warning.
- Retroactividad para operadores ya activos.
- Badge permanente en UI de promotora vs. solo modal inicial.

**Tiempo estimado:** ~3 horas de trabajo una vez decididos los puntos de arriba.

---

## CMU-ACC — Acuse de Aceptación de Unidad

**Estado:** texto aprobado en Paquete Complementario v2 (21-abr-2026). Backend y UI pendientes.

**Alcance propuesto:**

1. `CMU-ACC.docx` en `server/templates/` con placeholders alineados a `contract-engine.ts`.
2. `generateACC()` en `contract-engine.ts`.
3. Endpoint `POST /api/originations/:id/acuse-unidad` — dispara ACC cuando operador acepta oferta por WhatsApp.
4. Estado nuevo en orquestador: `ofrecida_unidad` entre `validacion` y `firma_tsr`.
5. Campo `accId`, `tanqueDictamen` en `originations` (migración).
6. Cron de 7 días: libera unidad al inventario y notifica si no se firmó el CMU-TSR en plazo.
7. UI en PWA: flujo de oferta de unidad con dictamen del tanque (Apto / No apto / Sin tanque).

**Bloqueado por:** validación legal del Paquete Complementario v2 por abogado mercantil.

---

## Aviso de privacidad — publicación pública

Publicar el Aviso v2 en:
1. Sitio web institucional (`conductores.lat` si existe).
2. Endpoint público de la plataforma.

Requisito LFPDPPP art. 17 (aviso disponible y accesible).

---

## Parámetros de rentabilidad — documentación interna

Formalizar en `docs/RENTABILIDAD.md`:
- Plazo máximo (hoy 36 meses)
- Cuota máxima objetivo (hoy $5,500 implícito)
- Sobreprecio LEQ (hoy $11)
- Anticipo target (hoy $50,000)
- FG inicial / techo / retención (hoy $8k / $20k / $334)
- **Margen mínimo por unidad** — no formalizado, decisión pendiente
- **Break-even por unidad** — no formalizado, decisión pendiente

Los últimos dos requieren decisión del director y se meterían como validaciones blandas (alerta, no bloqueo) en el motor.

---

## Convenio con NATGAS / red de recaudo

Revisar qué contrato regula hoy el flujo bidireccional de datos con NATGAS (cron de recaudo los miércoles):
- ¿Qué acuerdo de tratamiento de datos existe?
- ¿Hay confidencialidad / NDA con Lilia Plata?
- ¿Cobertura del flujo cuando migre a red propia CMU?

---

## Inventario de transferencias internacionales de datos

Para el abogado responsable del aviso de privacidad, armar un solo documento con:
- OpenAI (USA) — datos que cruzan, finalidad, retención
- Anthropic (USA) — datos que cruzan, finalidad, retención
- Twilio (USA) — WhatsApp, OTP Verify
- Mifiel (México pero con infraestructura mixta) — biometría, firma

Permite redactar la sección V del AVP con precisión y tener material ante INAI si llegan a auditar.

---

## Testigos y constancias de entrega física

El CMU-RES conserva 2 testigos (entrega física contenciosa). Evaluar si al ejecutar una rescisión real se necesita:
- Protocolo operativo documentado (quiénes son los testigos aceptables, cómo se identifican, cómo se registra su consentimiento para figurar)
- Plantilla de acta de entrega física con inventario fotográfico
- Protocolo de recuperación del vehículo (quién lo maneja, seguro durante traslado, resguardo)

No urgente hasta que haya un primer caso real de rescisión.

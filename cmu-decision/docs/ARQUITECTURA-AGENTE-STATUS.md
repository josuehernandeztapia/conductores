# Arquitectura del Agente Autónomo — Estado real vs. documento v1

Referencia cruzada del documento `CMU_Arquitectura_Agente_Autonomo_v1.docx` (22-abr-2026)
contra el código desplegado en `cmu-originacion.fly.dev`.

Esto es hoja de ruta interna. Cada sección indica:
- ✅ **LISTO** — ya existe y funciona
- 🟡 **PARCIAL** — existe pero incompleto
- 🔴 **PENDIENTE** — no existe, hay que construirlo
- ❌ **INCORRECTO EN DOC** — el documento v1 dice algo que no es cierto

---

## Errores factuales del documento v1

| Documento dice | Realidad |
|---|---|
| "Mifiel simulado (mock IDs)" | ❌ Mifiel pendiente de credenciales productivas, código ya integrado |
| "OTP simulado (acepta cualquier código)" | ❌ Twilio Verify `VAb7b31cdc560d238ed2bd90da259b9a12` activo, fail-loud habilitado |
| "Conekta webhook roto" | ❌ Arreglado: `/api/webhooks/conekta` con 7 eventos |
| "Vision/OCR: Claude Sonnet" | ❌ Es OpenAI GPT-4o primario + Anthropic Claude fallback |
| "9 templates DOCX" | ❌ Son 10 en repo (9 originales + CMU-AVP). ACC aprobado textualmente, pendiente template |
| "Lilia proveedora NatGas" | ❌ Lilia es proveedora interna CMU (PIN 000000, blocked PWA). No de NatGas |
| "Cuota $7,200 capital fijo" | ❌ Calculada dinámicamente por motor CMU según PV y plazo |
| "Ingesta NatGas 23:30 diario" | ❌ Semanal los miércoles (cron `f53e8ddc`), vía Excel de Lilia — no API directa |
| "NatGas" mencionado explícitamente | ❌ Contradice AVP v3: usar "red de estaciones con convenio CMU" y "tercero integrador de recaudo" |

---

## Por agente — Status actual

### Agente Originación

| Función | Status | Notas |
|---|---|---|
| Flujo de 22 estados | ✅ LISTO | `orchestrator.ts` idle → completed |
| 15 docs OCR con cross-check | ✅ LISTO | `vision.ts` + `post-ocr-validation.ts` |
| Entrevista 8 preguntas WhatsApp | ✅ LISTO | `entrevista-whatsapp.ts` |
| Motor CMU (P70, IQR, alemán) | ✅ LISTO | `corrida-estimada.ts`, `evaluation-engine.ts` |
| Generación TSR + PAG dual | ✅ LISTO | `contract-engine.ts`, `/api/originations/:id/contract` |
| AVP aceptación v3 | ✅ LISTO | `avp-engine.ts` + endpoints públicos |
| Trazabilidad OCR LFPDPPP | ✅ LISTO | `ocr-provenance.ts` |
| Mifiel (firma legal) | 🟡 PARCIAL | Código integrado, falta credenciales productivas |
| Conekta anticipo | ✅ LISTO | Webhook arreglado, 7 eventos |
| OTP Twilio Verify | ✅ LISTO | Fail-loud activado |
| Auth por rol | ✅ LISTO | `requireRole()` middleware |
| Asignación vehículo auto-match | 🔴 PENDIENTE | Hoy manual en Airtable |
| Notificación post-firma | 🔴 PENDIENTE | TODO marcado |
| UI modal AVP en PWA | 🔴 PENDIENTE | Backlog (decisión del director) |
| Proactividad (expediente estancado 3d/7d) | 🔴 PENDIENTE | Cron `f3d2c962` solo hace followup prospectos, no expedientes abiertos |

### Agente Recaudo

| Función | Status | Notas |
|---|---|---|
| Ingesta Excel NatGas via Gmail | ✅ LISTO | Cron miércoles `f53e8ddc` + `natgas-gmail-recaudo.py` |
| Parseo + dedup SHA-256 | ✅ LISTO | `recaudo-engine.ts` |
| Match placa → folio (Airtable) | ✅ LISTO | Con log de placas sin match |
| Recaudo acumulado del mes | ✅ LISTO | Reconciliación desde Pagos |
| Multi-producto (TSR / Joylong / Kit) | ✅ LISTO | Rutea via `TABLE_PLACAS.Producto` |
| Reminder si Lilia no manda Excel | ✅ LISTO | Cron `38fbee4d` miércoles 18h |
| API directa NatGas (sin Excel) | 🔴 PENDIENTE | Requiere integración con tercero |
| Detección 0 litros 3-7 días | 🔴 PENDIENTE | Hoy no se detecta abandono por placa |
| Reconciliación vs depósito bancario | 🔴 PENDIENTE | Manual |

### Agente Cierre Mensual

| Función | Status | Notas |
|---|---|---|
| Cierre mensual día 1 | ✅ LISTO | Cron `23758cb8` 14 UTC primer día mes |
| Amortización alemana | ✅ LISTO | `corrida-estimada.ts` |
| Cálculo diferencial + FG | ✅ LISTO | `cierre-mensual.ts` |
| Aplicar FG si mora día 6+ | ✅ LISTO | Cron `9ab4d224` día 6 |
| Generar link Conekta | ✅ LISTO | `conekta-client.ts` |
| WhatsApp estado cuenta conductor | ✅ LISTO | Integrado en cierre |
| Resumen consolidado a director | ✅ LISTO | Cron `6977561f`, `a6668788` |

### Agente Cobranza

| Función | Status | Notas |
|---|---|---|
| Recordatorio día 5 | ✅ LISTO | Cron `a6668788` |
| FG día 6 | ✅ LISTO | Cron `9ab4d224` |
| Mora día 3 (recordatorio) | ✅ LISTO | Cron `6977561f` |
| Mora día 14 (escalamiento) | ✅ LISTO | Cron `436da6e1` diario |
| Reporte semanal cartera (semáforo) | ✅ LISTO | Cron `dbf8e475` miércoles |
| Análisis LLM día 10 (recomendación a director) | 🔴 PENDIENTE | Hoy es regla fija, no contextual |
| Rescisión asistida | 🔴 PENDIENTE | Generación manual con plantillas |

### Agente Atención al Conductor

| Función | Status | Notas |
|---|---|---|
| Keywords WhatsApp (saldo, pagar, contrato) | ✅ LISTO | `orchestrator.ts` + `client-menu.ts` |
| Comandos universales (finalizar, ya no tengo más) | ✅ LISTO | `message-router.ts` |
| Pregunta libre con LLM | 🟡 PARCIAL | RAG activo, pero limitado a knowledge base estático |
| Factura CFDI on-demand (Odoo) | 🔴 PENDIENTE | Sin integración Odoo |
| Contrato PDF por demanda | 🟡 PARCIAL | Se genera, falta exponer a conductor por WhatsApp |
| Proactividad día 25 mes | 🔴 PENDIENTE | |
| Mensajes de milestone (mes 12/24/36) | 🔴 PENDIENTE | |

### Agente Flota

| Función | Status | Notas |
|---|---|---|
| Inventario vehículos | ✅ LISTO | Airtable + `/api/inventory` |
| Tracking por estado | 🟡 PARCIAL | Estados existen, alertas no |
| Match auto vehículo ↔ folio FIRMADO | 🔴 PENDIENTE | Hoy manual |
| Alerta seguro por vencer | 🔴 PENDIENTE | |
| Alerta concesión por vencer | 🔴 PENDIENTE | |
| Alerta tanque GNV (vigencia 5 años) | 🔴 PENDIENTE | |

### Agente Compliance

| Función | Status | Notas |
|---|---|---|
| Vigencia concesión diaria | 🔴 PENDIENTE | Ya se captura pero no se monitorea cron |
| Renovación INE anual | 🔴 PENDIENTE | |
| Integridad contratos mensual | 🔴 PENDIENTE | |
| CFDI automático (Odoo) | 🔴 PENDIENTE | Sin integración |
| Verificación firma Mifiel | 🟡 PARCIAL | Lo hace ad-hoc, no hay verificación mensual |
| Reporte regulatorio mensual | 🔴 PENDIENTE | |
| **OCR provenance log (LFPDPPP)** | ✅ LISTO | Agregado hoy, `ocr_processing_log` |
| **AVP aceptaciones (LFPDPPP)** | ✅ LISTO | Agregado hoy, `avp_acceptances` |

### Agente Reportes e Inteligencia

| Función | Status | Notas |
|---|---|---|
| Reporte semanal originación PDF | ✅ LISTO | Cron `46d36c08` lunes |
| Reporte semanal cartera | ✅ LISTO | Cron `dbf8e475` miércoles |
| Alertas de mora | ✅ LISTO | Cron `436da6e1` diario |
| Bulk update market prices | ✅ LISTO | Cron `0431efc2` diario |
| Pipeline followup cold prospects | ✅ LISTO | Cron `f3d2c962` diario |
| Cierre mensual P&L PDF | 🟡 PARCIAL | Resumen en WhatsApp, no PDF consolidado |
| Forecast 3 meses | 🔴 PENDIENTE | |
| Pregunta libre en lenguaje natural | 🔴 PENDIENTE | |
| Estado flota semanal | 🔴 PENDIENTE | |

### Orquestador

| Función | Status | Notas |
|---|---|---|
| Dedup mensajes (router + state machine) | 🟡 PARCIAL | Existe dedup de inbound, falta dedup outbound cross-agente |
| Ventana silencio 22-06h | 🔴 PENDIENTE | |
| Rate limiting conductor max 2/día | 🔴 PENDIENTE | |
| Rate limiting director max 5/día | 🔴 PENDIENTE | |
| Resumen matutino 07:00 consolidado | 🔴 PENDIENTE | Hoy cada cron dispara su propia notificación |
| Resumen vespertino 20:00 | 🔴 PENDIENTE | |
| Prioridad cobranza > cierre > otros | 🔴 PENDIENTE | |

---

## Lo que realmente falta para "financiera que opera sola"

Priorizado por impacto y dependencias:

### P0 — Cerrar Fase 1 (ya iniciada)
1. **UI modal AVP en PWA + WhatsApp** — backlog activo, decisiones de producto pendientes
2. **Credenciales productivas Mifiel** — bloqueo externo
3. **Proactividad expedientes estancados 3d/7d** — cron nuevo similar a `f3d2c962`

### P1 — Orquestación real
4. **Rate limiting por destinatario** (conductor max 2/día, director max 5/día)
5. **Ventana silencio 22-06h** con cola diferida
6. **Resumen matutino + vespertino consolidado** a director (reemplaza N notificaciones separadas)
7. **Dedup cross-agente** de mensajes outbound

### P2 — Autonomía total
8. **Match auto vehículo ↔ folio FIRMADO**
9. **Detección 0 litros por placa (abandono temprano)**
10. **Análisis LLM día 10 para recomendación de reestructura/prórroga**
11. **Alertas flota**: seguro, concesión, tanque GNV
12. **Notificación post-firma** (TSR + PAG firmados → WhatsApp consolidado)

### P3 — Integraciones externas
13. **Odoo CFDI automático** (facturación post-pago)
14. **API directa NatGas** (reemplaza Excel Lilia)
15. **Reconciliación bancaria** (recaudo Airtable ↔ depósitos Bancrea)

### P4 — Inteligencia
16. **Pregunta libre NL para director** ("cuánto recaudo llevamos este mes")
17. **Forecast 3 meses**
18. **Factura CFDI on-demand para conductor**

---

## Notas operativas permanentes

- **11 contratos en paquete v4**, no 9. Faltan CMU-AVP y CMU-ACC en `server/templates/` como .docx con placeholders (AVP ya está, ACC pendiente)
- **Producto vivo hoy en cartera: Joylong Ahorro (4 contratos) + Kit Conversión (1)**. TSR documentado pero sin folios firmados todavía
- **OCR es GPT-4o primario + Claude fallback**, declarado en AVP v3 Cláusula V bis
- **Red de recaudo siempre como "red de estaciones con convenio CMU" o "tercero integrador"**, nunca "NatGas" explícito en comunicación externa
- **Lenguaje: promotor_uno, no Ángeles**, en páginas públicas

---

*Documento de referencia para el agente IA. Actualizar cuando cambien decisiones o se completen pendientes.*

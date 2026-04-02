# CMU — Roadmap Q2 2026 (Abril–Junio)
## Foco: Cobranza Perfecta para Venta a Plazos Taxi

---

## MES 1: Abril 2026 — "Cobranza Perfecta"
> El ciclo completo de un crédito taxi debe funcionar sin intervención humana.

### Semana 1: Cierre Mensual Automático

- [ ] **Cron de cierre mensual (día 1 de cada mes)**
  - Para cada crédito taxi activo:
    1. Sumar todo el recaudo GNV del mes (de RecaudoGNV en Airtable)
    2. Comparar vs cuota del mes (amortización alemana — capital fijo + interés decreciente)
    3. Si recaudo >= cuota → mes pagado, abonar $334 al FG, avanzar mes
    4. Si recaudo < cuota → calcular diferencial = cuota - recaudo
    5. Aplicar FG si hay saldo: diferencial_neto = max(0, diferencial - saldo_FG)
    6. Si diferencial_neto > 0 → generar cobro
  - Notificación a Josué: resumen de cierre de todos los créditos
  - Notificación a cada taxista: "Tu recaudo GNV cubrió $X de tu cuota de $Y. Diferencial: $Z"

- [ ] **Tabla Airtable "Cierres Mensuales"**
  - Folio, Mes, Cuota, Recaudo GNV, FG Aplicado, Diferencial, Método Pago Diferencial, Estatus Cierre (Pagado / Pendiente / Mora), Fecha Cierre, Fecha Pago Diferencial

### Semana 2: Conekta — Cobro del Diferencial

- [ ] **Integración Conekta (links de pago)**
  - Generar link de pago único por folio+mes: "Paga tu diferencial de $2,450 — Folio CMU-VAL-001 Mes 3"
  - Métodos: tarjeta débito/crédito, OXXO, transferencia SPEI
  - Link con monto fijo (el diferencial exacto), vigencia 5 días hábiles
  - El agente WhatsApp envía el link al taxista junto con la notificación de diferencial

- [ ] **Webhook Conekta → CMU**
  - Cuando el taxista paga, Conekta notifica al webhook
  - El sistema registra el pago en tabla Pagos, actualiza Cierre Mensual a "Pagado"
  - El agente manda confirmación al taxista: "Pago recibido. Tu mes 3 está al corriente."
  - Notifica a Josué si es un pago que estaba en mora

- [ ] **CLABE dedicada (respaldo)**
  - CLABE Bancrea: 152680120000787681
  - Referencia = folio del crédito
  - Conciliación manual por ahora (Josué confirma), automática en mes 2

### Semana 3: Escalamiento de Mora Automático

- [ ] **Protocolo de mora por WhatsApp (sin intervención humana)**

  | Día | Acción | Tono | Quién ejecuta |
  |-----|--------|------|----------------|
  | 0 | Cierre: "Tu diferencial es $X. Paga aquí [link Conekta]" | Informativo | Agente automático |
  | 3 | "Recordatorio: tu diferencial de $X vence en 2 días. [link]" | Amigable | Agente automático |
  | 5 | "Hoy vence el plazo. Si no pagas, se aplica recargo de $250 + 2% mensual." | Firme | Agente automático |
  | 8 | "Tu pago tiene 3 días de atraso. Recargo aplicado: $X. Total: $Y. [link]" | Urgente | Agente automático |
  | 15 | Alerta a Josué: "Folio X tiene 15 días de mora. Diferencial $Y + recargos $Z." | Escalamiento | Agente → Josué |
  | 15 | Al taxista: "Contactaremos a tu aval. Para evitarlo, paga hoy: [link]" | Serio | Agente automático |
  | 30 | Alerta a Josué: "Folio X — 30 días mora. Iniciar proceso de recuperación." | Crítico | Agente → Josué |

- [ ] **Campo "Dias Atraso" auto-calculado**
  - Cron diario revisa cierres con estatus "Pendiente" → incrementa días atraso
  - Aplica recargos automáticos según contrato ($250 fijo + 2% mensual)
  - Actualiza Airtable: Dias Atraso, Recargos Acumulados

- [ ] **Bloqueo de nueva originación si está en mora**
  - Taxista en mora >15 días no puede iniciar nuevos trámites

### Semana 4: Conciliación y Reportes

- [ ] **Conciliación de pagos multi-vía**
  - Conekta (webhook automático) → registro inmediato
  - Transferencia SPEI a CLABE → Josué confirma por WhatsApp: "confirmar pago folio X" + PIN → registra
  - OXXO via Conekta → webhook automático
  - Pago en efectivo a promotora → Josué registra por WhatsApp: "pago efectivo folio X 2450" + PIN

- [ ] **Reporte semanal de cartera al director**
  - Cron dominical: resumen de todos los créditos
  - Por crédito: cuota, recaudo acumulado del mes, diferencial pendiente, días atraso
  - Totales: cartera vigente, cartera en mora, % morosidad, FG total

- [ ] **Estado de cuenta por WhatsApp para taxista**
  - Taxista escribe "estado de cuenta" o "cuánto debo"
  - Agente: "Mes 5 de 36. Saldo capital: $X. Cuota este mes: $Y. Recaudo GNV: $Z. Diferencial: $W. FG: $V."

---

## MES 2: Mayo 2026 — "Máquina de Ventas"
> Que un prospecto pueda llegar a firma con mínima intervención humana.

### Semana 1-2: Flujo prospecto → venta

- [ ] **Inventario público por WhatsApp**: prospecto ve unidades reales con cuota estimada
- [ ] **Corrida personalizada**: "quiero el aveo" → corrida con diferencial estimado según LEQ/mes del prospecto
- [ ] **Simulador "cuánto LEQ cargas"**: el agente pregunta consumo mensual → calcula diferencial real → "Con 800 LEQ/mes, tu pago extra sería ~$2,800/mes"
- [ ] **Pre-registro por WhatsApp**: nombre, teléfono, INE (foto) → crea folio automático

### Semana 3-4: Operación de venta

- [ ] **Asignar vehículo a folio** por WhatsApp + PIN y en PWA
- [ ] **Agregar vehículos al inventario** por WhatsApp + PIN
- [ ] **Checklist de documentos por WhatsApp**: el taxista puede mandar docs uno a uno, el agente trackea cuáles faltan
- [ ] **Contrato digital**: generar contrato con datos del folio + vehículo + corrida. PDF listo para firma.

---

## MES 3: Junio 2026 — "Máquina de Datos"
> Dashboard para decisiones y pitch a inversionistas.

### Semana 1-2: Dashboard cartera PWA

- [ ] **Panel de cartera**: recaudo semanal vs esperado (gráfica), % morosidad, FG agregado
- [ ] **Proyección gatillo Joylong**: estimación de cuándo llega cada cliente al 50% basado en promedio
- [ ] **Score de consistencia**: verde/amarillo/rojo por cliente, calculado automáticamente
- [ ] **Historial de recaudo**: tabla por cliente con semana, LEQ, monto (últimas 12 semanas)

### Semana 3-4: Reportes y automatización

- [ ] **Reporte mensual automático** (cron día 1): cartera, recaudo, morosidad, nuevos clientes, vehículos vendidos
- [ ] **Exportar a Excel** por WhatsApp: "exportar cartera" → Excel con todos los datos para reuniones
- [ ] **Mantenimiento preventivo**: alertas por LEQ acumulados (revisión regulador, filtros, bujías)
- [ ] **Conciliación SPEI automática** (si el volumen lo justifica): webhook bancario o scraping de estado de cuenta

---

## Arquitectura de Cobranza (Flujo Completo)

```
NATGAS Excel (semanal)
    │
    ▼
Recaudo Engine v2 ──→ Airtable (RecaudoGNV, Ahorro Joylong, Kit, Pagos)
    │
    ▼
Cierre Mensual (cron día 1)
    │
    ├─ Recaudo >= Cuota ──→ Mes pagado ✅ → FG +$334 → WhatsApp taxista
    │
    └─ Recaudo < Cuota ──→ Diferencial
         │
         ├─ FG cubre ──→ FG aplicado → WhatsApp taxista
         │
         └─ FG no cubre ──→ Diferencial neto
              │
              ▼
         Generar link Conekta ──→ WhatsApp taxista con link
              │
              ├─ Paga (webhook) ──→ Registrar pago → Cerrar mes → WhatsApp confirmación
              │
              └─ No paga ──→ Escalamiento automático
                   │
                   ├─ Día 3: recordatorio
                   ├─ Día 5: último aviso + recargo
                   ├─ Día 8: recargo aplicado
                   ├─ Día 15: escalar a Josué + advertencia aval
                   └─ Día 30: proceso recuperación
```

---

## Métricas objetivo Q2

| Métrica | Hoy (Abr 1) | Meta Jun 30 |
|---|---|---|
| Créditos taxi activos | 0 | 3-5 |
| Contratos Joylong | 3 | 5-6 |
| Kit Conversión | 1 | 1 (no escala) |
| Recaudo mensual | ~$68k | $120k+ |
| Morosidad taxi | N/A | <10% |
| Diferencial cobrado Conekta | N/A | >90% |
| Cierre mensual automático | Manual | 100% automático |
| Tiempo de cobro diferencial | N/A | <5 días |

---

## Integraciones requeridas

| Servicio | Para qué | Prioridad | Mes |
|---|---|---|---|
| **Conekta** | Links de pago diferencial (tarjeta/OXXO/SPEI) | CRÍTICA | Abril S2 |
| **Conekta Webhook** | Confirmar pagos automáticamente | CRÍTICA | Abril S2 |
| **Cron cierre mensual** | Ejecutar cierre día 1 | CRÍTICA | Abril S1 |
| **Cron mora diario** | Calcular días atraso + escalar | ALTA | Abril S3 |
| **Cron reporte semanal** | Resumen dominical a Josué | MEDIA | Abril S4 |
| **OCR INE** | Pre-registro digital | MEDIA | Mayo S1 |
| **Contrato PDF** | Generación automática | MEDIA | Mayo S4 |

## Lo que NO hacemos en Q2

- No app móvil nativa
- No Kubernetes/Kafka/microservicios
- No ML scoring (reglas simples bastan con <50 clientes)
- No expansión a otra ciudad
- No integración Buró de Crédito (scoring manual)
- No SPEI automático (Conekta cubre las vías de cobro)

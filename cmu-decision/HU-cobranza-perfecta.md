# HU — Cobranza Perfecta (Abril 2026)
## Venta a Plazos Taxi — Ciclo completo sin intervención humana

---

## Reglas de Negocio (definidas con Josué)

### Fechas
- Corte: día 1 de cada mes, TODOS los créditos (no por fecha de contrato)
- Mes 1: prorrateado según fecha de firma (días_activos / días_del_mes × cuota)
- Meses 2-36: cuota completa (amortización alemana: capital fijo + interés decreciente)
- Fecha límite de pago: día 5
- FG se aplica: día 6 si no pagó
- Recaudo GNV tope: ~$4,400/mes por vehículo

### Fondo de Garantía
- FG Inicial: $8,000 (depósito antes de entrega, pago directo a Bancrea/Santander)
- FG Mensual: $334 (incluido en link Conekta junto con diferencial)
- FG Techo: $20,000
- FG es RESPALDO, no primera línea de cobro
- Se aplica día 6 SOLO si el taxista no pagó el link Conekta
- Mes 37: devolver saldo remanente por SPEI
- Si FG = $20,000 y taxista paga al corriente: no cobra $334

### Mora
- Penalidad: $250 fijo + 2% mensual sobre el diferencial no pagado
- 3 meses consecutivos sin pagar = rescisión de contrato
- No hay aval

### Pagos
- Pagos mensuales (diferencial + FG): Conekta (principal), Bancrea/Santander (respaldo)
- Pagos especiales (anticipo a capital, FG inicial): siempre Bancrea o Santander
- Pago completo o nada — no hay pagos parciales
- Links Conekta: monto fijo + vigencia. Si vence, se genera nueva liga con monto actualizado
- Conciliación manual: taxista manda comprobante por WhatsApp → Josué confirma con PIN

### Cuentas bancarias
- Bancrea CLABE: 152680120000787681
- Santander: (pendiente CLABE)
- Conekta: cuenta activa, pendiente validación producción (~48h al 2 abr 2026)

---

## Flujo Completo de Cobranza

```
NATGAS Excel (martes semanal)
    │
    ▼
Recaudo Engine v2 → acumula en RecaudoGNV por folio
    │
    ▼
Cierre Mensual (cron día 1)
    │
    ├── cuota = amortización alemana del mes
    ├── recaudo = suma RecaudoGNV del mes
    ├── diferencial = cuota - recaudo
    │
    ▼
Liga Conekta 1: diferencial + $334 FG (vigencia 5 días)
    → WhatsApp taxista: desglose + link
    │
    ├── Día 1-5: taxista puede pagar
    │   ├── Paga (webhook Conekta) → Pagado ✅ → FG +$334
    │   └── Paga (SPEI/efectivo) → comprobante WhatsApp → Josué confirma + PIN
    │
    ├── Día 3: recordatorio WhatsApp (misma liga)
    ├── Día 5: "Mañana se aplica tu FG. Aún puedes pagar: [link]"
    │
    ├── Día 6 — Liga 1 vence, no pagó:
    │   ├── FG tiene saldo >= diferencial → FG absorbe → NO mora
    │   │   └── WhatsApp: "FG cubrió $X. Saldo FG: $Y"
    │   │
    │   ├── FG cubre parcial → FG absorbe lo que puede → resta va a MORA
    │   │   └── Liga 2: deuda restante (vigencia 2 días)
    │   │
    │   └── FG agotado → todo va a MORA
    │       └── Liga 2: diferencial completo (vigencia 2 días)
    │
    ├── Día 8 — Liga 2 vence, recargo aplicado:
    │   └── Liga 3: deuda + $250 + 2% (vigencia 7 días)
    │       └── WhatsApp: "Recargo aplicado. Total: $X. [link]"
    │
    ├── Día 15 — Liga 3 vence:
    │   ├── WhatsApp Josué: "Folio X — 15 días mora. Deuda $X"
    │   └── Liga 4: recalculada con mora acumulada
    │
    └── Día 30 — Josué decide proceso de recuperación
        (3 meses consecutivos = rescisión)
```

---

## HU-COB-01: Cierre Mensual Automático

**Como** director, **quiero** que el día 1 se ejecute el cierre de todos los créditos taxi, **para** saber cuánto debe cada taxista sin calcularlo yo.

### Lógica
1. Para cada crédito activo en tabla Creditos:
   - Si es mes 1: cuota = cuota_normal × (días_desde_firma / días_del_mes)
   - Si es mes 2-36: cuota = amortización alemana del mes
   - Recaudo = SUM(RecaudoGNV) del mes para ese folio
   - Diferencial = cuota - recaudo
2. Crear registro en tabla **Cierres Mensuales**
3. Generar liga Conekta (HU-COB-02)
4. Mandar WhatsApp al taxista con desglose + link
5. Mandar resumen de todos los cierres a Josué

### Tabla Airtable "Cierres Mensuales"
| Campo | Tipo | Descripción |
|---|---|---|
| Folio | Text | CMU-VAL-XXXXXX |
| Mes | Number | 1-36 |
| Cuota | Currency | Cuota alemana (prorrateada si mes 1) |
| Recaudo GNV | Currency | Total recaudado NATGAS del mes |
| Diferencial | Currency | Cuota - Recaudo |
| Cobro FG | Currency | $334 (si no ha llegado a $20k) |
| Total Link | Currency | Diferencial + Cobro FG |
| FG Aplicado | Currency | Solo si no pagó en plazo (día 6) |
| Recargos | Currency | $250 + 2% si mora |
| Estatus | Select | Pendiente Pago / Pagado / FG Aplicado / Mora / Rescisión |
| Fecha Cierre | Date | Día 1 del mes |
| Fecha Límite | Date | Día 5 del mes |
| Fecha Pago | Date | Cuando pagó |
| Método Pago | Text | Conekta / SPEI / Efectivo |
| Link Conekta | URL | Liga activa |
| Link Vigencia | Date | Fecha expiración de la liga |
| Días Atraso | Number | 0-30+ |

### Cron
- Día 1 de cada mes, 8:00 AM CST
- `schedule_cron`: "Cierre mensual CMU"

---

## HU-COB-02: Cobro de Diferencial vía Conekta

**Como** taxista, **quiero** recibir un link de pago por WhatsApp con el monto exacto, **para** pagar fácil.

### Liga Conekta
- Conekta Orders API: crear Order con line_items
  - Line 1: "Diferencial cuota mes X" — $2,800
  - Line 2: "Fondo de Garantía" — $334
  - Total: $3,134
- Métodos: tarjeta, OXXO, SPEI, red de cobro (farmacias, tiendas)
- Vigencia: según etapa de escalamiento (5 días, 2 días, 7 días)
- Referencia: folio + mes

### Webhook Conekta
- Endpoint: `/api/conekta/webhook` (PUBLIC_PATH, no auth)
- Al recibir pago confirmado:
  1. Buscar Cierre Mensual por referencia (folio + mes)
  2. Actualizar Estatus → "Pagado"
  3. Registrar en tabla Pagos
  4. FG += $334
  5. WhatsApp taxista: "Pago recibido. Mes X al corriente. FG: $Y"
  6. Si estaba en mora → limpiar días atraso, notificar Josué

### WhatsApp al taxista (día 1):
```
Cierre mes 3 — Pedro López

Tu recaudo GNV cubrió $4,400 de tu cuota de $7,200.
Diferencial: $2,800
Fondo de Garantía: $334
Total: $3,134

Paga aquí: [link Conekta]
Fecha límite: 5 de mayo

Métodos: tarjeta, OXXO, SPEI, tiendas de conveniencia.
```

### Conekta Config
- Test key: ya en Fly.io como CONEKTA_API_KEY
- Producción: crear key privada cuando validen cuenta (~48h)
- Public key prod: key_Sreosnglwi5lO7j7xF3LQ55

---

## HU-COB-03: FG como Respaldo (Día 6)

**Como** director, **quiero** que el FG se aplique SOLO cuando el taxista no pagó en plazo, **para** no gastar el colchón innecesariamente.

### Cron día 6
Para cada Cierre con Estatus="Pendiente Pago":
1. Liga Conekta 1 ya venció
2. Calcular FG disponible del crédito
3. Si FG >= diferencial:
   - FG absorbe completo
   - Estatus → "FG Aplicado"
   - WhatsApp taxista: "Se aplicó tu FG por $2,800. Saldo FG: $9,200. No caes en mora."
   - WhatsApp Josué: "Folio X — FG aplicado $2,800. Saldo FG: $9,200"
4. Si FG < diferencial (parcial):
   - FG absorbe lo que tiene
   - Resto → Mora
   - Estatus → "Mora"
   - Generar Liga 2: monto restante, vigencia 2 días
   - WhatsApp taxista: "Tu FG cubrió $1,500 pero faltaron $1,300. Paga aquí: [liga 2]"
5. Si FG = $0:
   - Todo a Mora
   - Generar Liga 2: diferencial completo, vigencia 2 días
   - WhatsApp taxista: "Tu FG está agotado. Deuda pendiente: $2,800. [liga 2]"

### Día 5 — Recordatorio preventivo (antes de FG)
- WhatsApp: "Mañana se aplica tu Fondo de Garantía. Aún puedes pagar: [link original]"

---

## HU-COB-04: Escalamiento de Mora Automático

**Como** director, **quiero** que la mora se escale sola, **para** no perseguir pagos manualmente.

### Protocolo (solo si FG no cubre)

| Día | Acción | Liga Conekta |
|-----|--------|-------------|
| 1 | Cierre + liga | Liga 1: diferencial + $334. Vigencia 5 días |
| 3 | Recordatorio | Misma liga 1 |
| 5 | "Mañana se aplica tu FG" | Misma liga 1 |
| 6 | FG aplicado / Mora activada | Liga 2: deuda post-FG. Vigencia 2 días |
| 8 | Recargo: $250 + 2% sobre deuda | Liga 3: deuda + recargo. Vigencia 7 días |
| 15 | Escalar a Josué | Liga 4: recalculada. Josué decide |
| 30 | Proceso de recuperación | Josué decide manualmente |

### Cron diario de mora (8:00 AM)
- Revisa todos los Cierres con Estatus="Mora"
- Calcula días desde Fecha Límite
- Ejecuta acción correspondiente según tabla
- Genera nueva liga Conekta cuando la anterior vence
- Actualiza Días Atraso y Recargos

### Recargo
- $250 fijo + 2% mensual sobre diferencial no pagado
- Ejemplo: deuda $1,300 → recargo $250 + $26 = $276 → total $1,576

### Rescisión
- 3 meses consecutivos sin pagar = rescisión automática
- Notificación a Josué para ejecutar

---

## HU-COB-05: Conciliación Multi-vía

**Como** director, **quiero** que los pagos se registren sin importar cómo pague el taxista.

### Pagos mensuales (diferencial + FG)

| Vía | Registro | Automático |
|-----|----------|-----------|
| Conekta (tarjeta/OXXO/SPEI/tiendas) | Webhook automático | ✅ |
| Transferencia SPEI a Bancrea/Santander | Taxista manda comprobante por WhatsApp → Josué: "confirmar pago folio X" + PIN | ❌ Manual |
| Depósito ventanilla Bancrea/Santander | Taxista manda foto ticket por WhatsApp → Josué confirma + PIN | ❌ Manual |

### Pagos especiales (no Conekta)
- Anticipo a capital: depósito/transferencia a Bancrea o Santander
- FG inicial $8,000: depósito/transferencia a Bancrea o Santander
- Taxista manda comprobante → Josué confirma + PIN

### Comprobante por WhatsApp
- Taxista manda foto del ticket/comprobante
- Agente detecta que es foto + contexto de pago pendiente
- OCR básico: extrae monto, referencia, fecha
- Josué confirma: "confirmar pago folio 001" + PIN → registra pago

### Cuentas
- Bancrea CLABE: 152680120000787681
- Santander: pendiente CLABE

---

## HU-COB-06: Estado de Cuenta por WhatsApp

**Como** taxista, **quiero** preguntar "cuánto debo" y ver mi situación completa con recaudo parcial del mes.

### Respuesta del agente:
```
Estado de cuenta — Pedro López
Folio CMU-VAL-260415-001 | Mes 5 de 36
Próximo corte: 1 de junio

RECAUDO DEL MES (3 de 4 semanas procesadas)
  Semana 1: $1,100 (110 LEQ)
  Semana 2: $1,050 (105 LEQ)
  Semana 3: $1,050 (105 LEQ)
  Acumulado: $3,200 | Estimado mes: ~$4,267

CUOTA Y DIFERENCIAL
  Cuota mes 5: $6,900
  Diferencial estimado: ~$2,633
  + FG $334
  Link estimado: ~$2,967

SALDOS
  Capital pendiente: $148,000
  Fondo de Garantía: $9,670 de $20,000
  Días atraso: 0

ÚLTIMOS 3 MESES
  Mes 4: GNV $4,100 | dif $2,950 → Pagado ✅
  Mes 3: GNV $4,400 | dif $2,800 → Pagado ✅
  Mes 2: GNV $4,200 | dif $3,150 → Pagado ✅

¿Necesitas tu liga de pago o tienes alguna duda?
```

### Datos
- Recaudo parcial: de tabla RecaudoGNV, semanas procesadas del mes en curso
- Estimado mes: (acumulado / semanas_procesadas) × 4
- Historial: de tabla Cierres Mensuales últimos 3

---

## HU-COB-07: Reporte Semanal de Cartera

**Como** director, **quiero** recibir cada miércoles un resumen de salud de cartera.

### Cron: miércoles 10:00 AM CST (después de procesar NATGAS del martes)

### Contenido WhatsApp:
```
CARTERA CMU — Semana 14 (31 mar - 6 abr 2026)

SEMÁFORO
  🟢 Pedro López (001) — al corriente, FG $9,670
  🟢 Juan Reyes (002) — al corriente, FG $8,334
  🟡 María Soto (003) — recaudo bajo 2 semanas, FG $8,000

CRÉDITOS TAXI (3 activos)
  001 Pedro | mes 5/36 | sem $1,050 | acum $3,200/$6,900 | FG $9,670
  002 Juan | mes 2/36 | sem $900 | acum $1,800/$7,400 | FG $8,334
  003 María | mes 1/36 | sem $0 | acum $0/$3,700 | FG $8,000

  Cuotas mes: $18,000 | Recaudo acum: $5,000 | Dif estimado: $13,000
  Mora: 0 | Morosidad: 0%

AHORRO JOYLONG (3)
  Capetillo $7,918 (1.0%) | Obed $6,421 (0.8%) | Zavala $2,700 (0.3%)
  Total: $17,039 | Sem: +$3,995

KIT CONVERSION (1)
  Elvira | saldo $54,259 | mes 1/12 | sem +$310

INVENTARIO DISPONIBLE (5 unidades)
  Aveo 2022 $200k | March Sense $195k | March Adv $224k
  Kwid 2024 $202k | i10 2022 $260k
```

### Semáforo por cliente
- 🟢 Verde: recaudo consistente (>80% del promedio), sin atrasos
- 🟡 Amarillo: recaudo bajo 2+ semanas (<60% del promedio) O FG usado el mes anterior
- 🔴 Rojo: en mora activa O recaudo $0 por 2+ semanas

### Guardado
- Tabla Airtable "Reportes Semanales": fecha, contenido, semáforos, totales

---

## Orden de Implementación

| HU | Qué | Semana | Dependencia |
|----|-----|--------|-------------|
| COB-01 | Cierre mensual automático | S1 | Tabla Cierres en Airtable |
| COB-02 | Conekta links de pago + webhook | S2 | API key Conekta (test) |
| COB-03 | FG respaldo día 6 + recordatorio día 5 | S2 | COB-01 + COB-02 |
| COB-04 | Escalamiento mora + ligas rotativas | S3 | COB-03 |
| COB-05 | Conciliación multi-vía + comprobante WhatsApp | S3 | COB-02 |
| COB-06 | Estado de cuenta taxista | S4 | COB-01 + RecaudoGNV |
| COB-07 | Reporte semanal miércoles | S4 | COB-01 + RecaudoGNV |

# Historias de Usuario — Inventario v2

## HU-1: Limpiar inventario dummy
**Como** director, **quiero** que solo existan los 5 vehículos reales en inventario, **para** que los datos sean confiables.
- Eliminar registros 1-4 (dummies)
- Corregir PV CMU del Kwid ($202,000) e i10 ($260,126)
- Ambos March son 2021, ambos TM
- Criterio de aceptación: `inventario` en WhatsApp muestra 5 unidades reales

## HU-2: Edición de inventario por WhatsApp con PIN
**Como** director, **quiero** editar costos reales de un vehículo por WhatsApp con autenticación PIN, **para** ajustar reparación, compra o GNV sin entrar a la PWA.
- Flujo: "reparación aveo 30k" → "Necesito tu clave" → "123456" → "Actualizado. Aveo: rep $25k→$30k. Margen: $X"
- PIN = 123456 (el mismo del login PWA)
- Campos editables: reparación real, precio aseguradora, cmu_valor, kit_gnv_costo, tanque_costo, notas
- Recalcula margen automáticamente al editar
- Criterio de aceptación: editar reparación por WhatsApp y verificar cambio en PWA

## HU-3: Edición de inventario en PWA
**Como** director, **quiero** editar los mismos campos desde la pantalla de Inventario en la PWA, **para** tener una opción visual.
- En el detalle expandible de cada vehículo, campos editables: reparación real, precio aseguradora, CMU, GNV
- Botón "Guardar" llama PATCH /api/vehicles/:id
- Muestra margen recalculado en tiempo real
- Criterio de aceptación: editar reparación en PWA y verificar cambio

## HU-4: Modalidad GNV por vehículo
**Como** director, **quiero** definir la modalidad de GNV por vehículo, **para** manejar promociones y descuentos.
- Campo `gnv_modalidad`: "kit_solo" ($18k — entrega cilindro) | "kit_tanque" ($27.4k — completo) | "incluido" (absorbe CMU)
- Campo `descuento_gnv`: monto de descuento cuando entrega cilindro u otra promo
- El costo GNV efectivo = kit_gnv_costo + tanque_costo - descuento_gnv
- Afecta cálculo de margen y corrida financiera
- Editable por WhatsApp y PWA
- Criterio de aceptación: "aveo gnv incluido" → margen se recalcula absorbiendo GNV

## HU-5: Prospecto consulta inventario real
**Como** prospecto (WhatsApp), **quiero** ver los vehículos disponibles reales, **para** elegir uno y ver su corrida.
- "qué carros tienen" → lista de unidades reales con status "disponible"
- Muestra: marca/modelo/año, precio de venta CMU, cuota estimada mes 3+
- NO muestra costos internos (compra, reparación, margen)
- Criterio de aceptación: prospecto ve 5 unidades con precios reales

## HU-6: Prospecto elige vehículo y ve corrida
**Como** prospecto, **quiero** elegir un vehículo del inventario y ver la corrida personalizada, **para** saber cuánto pagaría.
- Prospecto dice "quiero el aveo" o "1" (número de lista)
- Agente genera corrida con datos del vehículo real (no del catálogo genérico)
- Muestra: precio contado, precio a plazos, cuota mes 1-2, cuota mes 3+, diferencial, FG
- Si le interesa: "cuando estés listo, escribe 'quiero registrarme'"
- Criterio de aceptación: prospecto ve corrida personalizada del Aveo 2022 a $176k

## Orden de implementación
1. HU-1 (limpiar datos) — 10 min
2. HU-2 (edición WhatsApp + PIN) — 30 min
3. HU-3 (edición PWA) — 20 min
4. HU-5 (prospecto ve inventario) — 20 min
5. HU-6 (prospecto elige + corrida) — 30 min
6. HU-4 (modalidad GNV/promos) — 20 min

# Fase 3: Plan de Migración a State Machine Unificada

## Resumen Ejecutivo

La Fase 3 unifica las dos state machines actuales (ProspectState v4 y ConversationState v9) en una sola `UnifiedState` que maneja todo el ciclo de vida del usuario: desde prospecto → cliente → post-venta.

## Arquitectura Actual (Problema)

```
routes.ts (router)
    ├── Sin rol → handleProspectMessage() [orchestrator.ts v4]
    │   └── ProspectState: idle → prospect_name → ... → completed
    │
    └── Con rol → WhatsAppAgent.handleMessage() [whatsapp-agent.ts v9]
        └── ConversationState: idle → evaluating → active_client → ...
```

**Problemas:**
1. **Handoff complejo**: Cuando un prospecto completa registro, debe transferirse de v4 a v9
2. **Estado duplicado**: Ambos sistemas escriben a `conversation_sessions` pero con diferentes esquemas
3. **Routing frágil**: El router en routes.ts tiene lógica compleja para decidir qué agent usar
4. **Mantenimiento difícil**: Cambios en el flujo requieren modificar 2 sistemas

## Arquitectura Propuesta (Solución)

```
routes.ts (router simplificado)
    └── UnifiedAgent.handleMessage() [unified-agent.ts]
        └── UnifiedState: idle → prospect_* → docs_* → active_client → ...
```

## Plan de Implementación

### Paso 1: Crear UnifiedAgent (2-3 horas)
```typescript
// server/unified-agent/index.ts
export class UnifiedAgent {
  constructor(
    private storage: StorageService,
    private openaiKey: string
  ) {}

  async handleMessage(
    phone: string,
    body: string,
    mediaUrl?: string,
    mediaType?: string
  ): Promise<string> {
    // 1. Load unified context from DB
    const context = await this.loadContext(phone);

    // 2. Determine current state
    const state = context.state || "idle";

    // 3. Route to appropriate handler
    const handler = this.getHandler(state, context.role);

    // 4. Process message
    const result = await handler(context, body, mediaUrl);

    // 5. Save updated context
    await this.saveContext(phone, {
      ...context,
      ...result.contextUpdates,
      state: result.nextState
    });

    // 6. Return response
    return result.response;
  }
}
```

### Paso 2: Migración de Base de Datos (1 hora)

```sql
-- Add migration columns to conversation_sessions
ALTER TABLE conversation_sessions
ADD COLUMN unified_state VARCHAR(50),
ADD COLUMN unified_context JSONB,
ADD COLUMN migrated_at TIMESTAMP;

-- Migration query (run once)
UPDATE conversation_sessions
SET
  unified_state = CASE
    WHEN state LIKE 'prospect_%' THEN state
    WHEN state = 'idle' AND context->>'agentState' IS NOT NULL
      THEN context->>'agentState'
    WHEN state IN ('evaluating', 'browsing_prices', 'asking_info')
      THEN state
    ELSE 'active_client'
  END,
  unified_context = JSONB_BUILD_OBJECT(
    'role', COALESCE(context->>'role', 'prospect'),
    'phone', phone,
    'name', context->>'name',
    'folio', context->'folio'->>'folio',
    'originationId', context->'folio'->>'id',
    'fuelType', context->>'fuelType',
    'consumoLeq', context->>'leqMes',
    'eval', context->'eval',
    'lastModel', last_model,
    'createdAt', created_at,
    'updatedAt', updated_at
  ),
  migrated_at = NOW()
WHERE migrated_at IS NULL;
```

### Paso 3: Transición Gradual (2-3 días)

**Día 1: Shadow Mode**
```typescript
// routes.ts
if (ENABLE_UNIFIED_AGENT) {
  // New unified flow
  const reply = await unifiedAgent.handleMessage(phone, body, mediaUrl);

  // But also run old flow in parallel for comparison
  const oldReply = await (role.role === "prospecto"
    ? handleProspectMessage(...)
    : waAgent.handleMessage(...));

  // Log differences for monitoring
  if (reply !== oldReply) {
    console.log(`[Migration] Response diff for ${phone}`);
  }

  await sendWa(From, reply);
} else {
  // Old flow
  // ... existing code
}
```

**Día 2: Canary Deployment**
- 10% de usuarios nuevos → UnifiedAgent
- 90% → Sistema actual
- Monitorear métricas

**Día 3: Full Migration**
- 100% → UnifiedAgent
- Mantener flag para rollback rápido

### Paso 4: Cleanup (1 hora)
- Remover orchestrator.ts (v4)
- Remover handleMessage de whatsapp-agent.ts
- Simplificar routes.ts
- Archivar columnas viejas de DB

## Riesgos y Mitigaciones

### Riesgo 1: Pérdida de Estado
**Problema**: Usuario a mitad de flujo durante migración
**Mitigación**: Migration script preserva estado actual y lo mapea al equivalente unificado

### Riesgo 2: Comportamiento Diferente
**Problema**: UnifiedAgent responde distinto que sistema actual
**Mitigación**: Shadow mode compara respuestas antes de activar

### Riesgo 3: Rollback Complejo
**Problema**: Si falla, difícil volver atrás
**Mitigación**: Feature flag + columnas DB separadas permiten rollback instantáneo

## Beneficios Esperados

1. **Simplicidad**: Un solo flujo, un solo agent
2. **Mantenibilidad**: Cambios en un solo lugar
3. **Performance**: Sin handoff entre sistemas
4. **Visibilidad**: Estado unificado fácil de debuggear
5. **Escalabilidad**: Fácil agregar nuevos estados/roles

## Métricas de Éxito

- [ ] 0 errores de handoff prospecto → cliente
- [ ] Reducción 50% en líneas de código de routing
- [ ] 100% de estados migrados sin pérdida de datos
- [ ] Tiempo respuesta <2s para todos los mensajes

## Timeline Estimado

- **Día 1**: Implementar UnifiedAgent + types (3 hrs)
- **Día 2**: Migration script + testing (2 hrs)
- **Día 3-4**: Shadow mode + monitoring
- **Día 5**: Canary deployment
- **Día 6**: Full migration
- **Día 7**: Cleanup + documentación

**Total**: ~1 semana con rollout gradual
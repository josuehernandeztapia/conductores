import { StorageService } from "../storage-service";

export class InventoryHandler {
  constructor(private storage: StorageService) {}

  async getAvailableInventory(): Promise<string> {
    const vehicles = await this.storage.listVehicles({ status: "disponible" });
    if (!vehicles.length) {
      // Fallback: try all vehicles and filter
      const all = await this.storage.listVehicles();
      const available = all.filter((v: any) => v.status === "disponible");
      if (!available.length) {
        return "🚗 Por el momento no hay vehículos disponibles. Próximamente tendremos unidades listas.";
      }
      return this.formatInventoryList(available);
    }
    return this.formatInventoryList(vehicles);
  }

  private formatInventoryList(vehicles: any[]): string {
    const lines = [`🚗 *Vehículos Disponibles* (${vehicles.length})\n`];
    for (let idx = 0; idx < Math.min(10, vehicles.length); idx++) {
      const vv = vehicles[idx] as any;
      const marca = vv.marca || vv.brand || "";
      const modelo = vv.modelo || vv.model || "";
      const variante = vv.variante || vv.variant || "";
      const anio = vv.anio || vv.year || "";
      const cmu = vv.cmu_valor || vv.cmuValor || 0;
      const color = vv.color ? ` ${vv.color}` : "";
      lines.push(`${idx + 1}. *${marca} ${modelo} ${variante} ${anio}*${color}`);
      if (cmu) lines.push(`   Precio: $${cmu.toLocaleString()} contado | 36 meses`);
    }
    if (vehicles.length > 10) {
      lines.push(`\n... y ${vehicles.length - 10} más.`);
    }
    lines.push(`\n¿Te interesa alguno? Pregunta por modelo y te doy la corrida.`);
    return lines.join("\n");
  }

  async handleInventoryEdit(
    phone: string,
    body: string,
    editState: any,
    updateStateFn: (phone: string, updates: any) => Promise<void>,
    parseEvalLineFn: (line: string) => any
  ): Promise<{ handled: boolean; response?: string }> {
    const lower = body.toLowerCase().trim();

    // Step 2: PIN response
    if (editState.state === "awaiting_inventory_pin") {
      const pin = body.trim();
      if (pin === "123456") {
        const pending = editState.context.pendingEdit as any;
        if (pending) {
          try {
            const updated = await this.storage.updateVehicle(pending.vehicleId, pending.fields);
            await updateStateFn(phone, { state: "idle", context: {} });
            if (updated) {
              const vv = updated as any;
              const adq = vv.costo_adquisicion || 0;
              const rep = vv.costo_reparacion || 0;
              const kit = vv.kit_gnv_costo || 0;
              const tanque = vv.tanque_costo || 0;
              const cmu = vv.cmu_valor || 0;
              const total = adq + rep + kit + tanque;
              const margen = cmu > 0 ? cmu - total : 0;
              return {
                handled: true,
                response: `Actualizado *${vv.marca} ${vv.modelo} ${vv.variante || ""} ${vv.anio}*:\n${pending.description}\nCosto total: $${total.toLocaleString()} | PV: $${cmu.toLocaleString()} | Margen: $${margen.toLocaleString()}`
              };
            }
            return { handled: true, response: "Actualizado." };
          } catch (e: any) {
            await updateStateFn(phone, { state: "idle", context: {} });
            return { handled: true, response: `Error al actualizar: ${e.message}` };
          }
        }
        await updateStateFn(phone, { state: "idle", context: {} });
        return { handled: true, response: "No hay edicion pendiente." };
      } else {
        await updateStateFn(phone, { state: "idle", context: {} });
        return { handled: true, response: "Clave incorrecta. Edicion cancelada." };
      }
    }

    // Step 1: Detect edit command
    const looksLikeEval = (() => {
      const p = parseEvalLineFn(lower);
      return p.cost !== null && p.repair !== null && p.modelQuery !== null && p.modelQuery.length >= 2;
    })();

    const editFieldMatch = looksLikeEval ? null : lower.match(
      /(?:reparaci[oó]n|rep(?:aracion)?|cmu|precio\s*(?:de\s*)?(?:venta|cmu)|precio\s*aseguradora|costo\s*(?:de\s*)?(?:compra|adquisicion|reparaci[oó]n)|compra|kit|tanque|gnv)/i
    );

    let editValueMatch = lower.match(/(\d[\d,.]*k)\s*$/i) || lower.match(/(?:a|en)\s+(\d[\d,.]*k?)\b/i);
    if (!editValueMatch) {
      const endNum = lower.match(/(\d[\d,.]*)\s*$/i);
      if (endNum && !/^20[12]\d$/.test(endNum[1])) editValueMatch = endNum;
    }

    // If field detected but no value, ask for amount
    if (editFieldMatch && !editValueMatch) {
      const fieldRaw2 = editFieldMatch[0] || "";
      const restOfMsg = lower.slice(lower.indexOf(fieldRaw2) + fieldRaw2.length)
        .replace(/\b(del|de|la|el|a|en|cambiar|editar|ajustar|actualizar|costo|voy|quiero|valor|20[12]\d)\b/gi, "").trim();
      const vehicles2 = await this.storage.listVehicles();
      const match2 = vehicles2.find((v: any) => {
        const fullName = `${v.marca} ${v.modelo} ${v.variante || ""} ${v.anio}`.toLowerCase();
        return restOfMsg.split(/\s+/).some((w: string) => w.length >= 2 && fullName.includes(w));
      });
      if (match2) {
        const vv = match2 as any;
        const fl2 = fieldRaw2.toLowerCase();
        let label2 = "";
        let current2 = 0;
        if (/reparaci|rep/.test(fl2)) { label2 = "Reparacion"; current2 = vv.costo_reparacion || 0; }
        else if (/cmu|precio.*venta/.test(fl2)) { label2 = "PV CMU"; current2 = vv.cmu_valor || 0; }
        else if (/aseguradora|compra|adquisicion/.test(fl2)) { label2 = "Precio compra"; current2 = vv.costo_adquisicion || 0; }
        else if (/kit/.test(fl2)) { label2 = "Kit GNV"; current2 = vv.kit_gnv_costo || 0; }
        else if (/tanque/.test(fl2)) { label2 = "Tanque"; current2 = vv.tanque_costo || 0; }
        return {
          handled: true,
          response: `*${vv.marca} ${vv.modelo} ${vv.variante || ""} ${vv.anio}*\n${label2} actual: $${current2.toLocaleString()}\n\n¿A cuanto lo cambio? (ej: 15k o 15000)`
        };
      }
    }

    if (editFieldMatch && editValueMatch) {
      const fieldRaw = editFieldMatch[0] || "";
      const afterField = lower.slice(lower.indexOf(fieldRaw) + fieldRaw.length);
      const beforeValue = afterField.slice(0, afterField.lastIndexOf(editValueMatch[1]));
      const vehicleHint = beforeValue.replace(/\b(del|de|la|el|a|en|cambiar|editar|ajustar|actualizar|costo|voy|quiero|valor|quiero\s+cambiar)\b/gi, "").trim();
      const valueStr = editValueMatch[1];
      let value = parseFloat(valueStr.replace(/,/g, "").replace(/k$/i, "")) * (valueStr.toLowerCase().endsWith("k") ? 1000 : 1);

      const vehicles = await this.storage.listVehicles();
      const match = vehicles.find((v: any) => {
        const fullName = `${v.marca} ${v.modelo} ${v.variante || ""} ${v.anio}`.toLowerCase();
        return vehicleHint.split(/\s+/).every((w: string) => w.length >= 2 && fullName.includes(w));
      });

      if (!match) {
        return {
          handled: true,
          response: `No encontre "${vehicleHint}" en inventario. Vehiculos: ${vehicles.map((v: any) => `${v.marca} ${v.modelo} ${v.anio}`).join(", ")}`
        };
      }

      // Map field
      let dbField = "";
      let fieldLabel = "";
      const fl = fieldRaw.toLowerCase();
      if (/reparaci|rep/.test(fl)) { dbField = "costo_reparacion"; fieldLabel = "Reparacion"; }
      else if (/cmu|precio.*venta/.test(fl)) { dbField = "cmu_valor"; fieldLabel = "PV CMU"; }
      else if (/aseguradora|compra|adquisicion/.test(fl)) { dbField = "costo_adquisicion"; fieldLabel = "Precio compra"; }
      else if (/kit/.test(fl)) { dbField = "kit_gnv_costo"; fieldLabel = "Kit GNV"; }
      else if (/tanque/.test(fl)) { dbField = "tanque_costo"; fieldLabel = "Tanque"; }
      else if (/gnv/.test(fl)) { dbField = "kit_gnv_costo"; fieldLabel = "Kit GNV"; }

      if (!dbField) {
        return { handled: true, response: "Campo no reconocido. Usa: reparacion, cmu, compra, kit, tanque." };
      }

      const vv = match as any;
      const oldValue = vv[dbField] || 0;
      const description = `- ${fieldLabel}: $${oldValue.toLocaleString()} -> $${value.toLocaleString()}`;

      // Save pending edit and ask for PIN
      await updateStateFn(phone, {
        state: "awaiting_inventory_pin",
        context: {
          pendingEdit: {
            vehicleId: vv.id,
            fields: { [dbField]: value },
            description,
          }
        }
      });

      return {
        handled: true,
        response: `Editar *${vv.marca} ${vv.modelo} ${vv.anio}*:\n${description}\n\nPara confirmar, dime la clave de director:`
      };
    }

    return { handled: false };
  }
}
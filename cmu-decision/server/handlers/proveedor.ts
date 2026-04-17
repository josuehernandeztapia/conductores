/**
 * PROVEEDOR HANDLER — Excel bulk pricing updates only.
 *
 * For now, delegates Excel file handling to whatsapp-agent via shared waAgent
 * instance (see message-router). Text-only messages get a short instruction.
 */

export async function proveedorHandler(
  _phone: string,
  _body: string,
  mediaUrl: string | null,
  mediaType: string | null,
): Promise<string> {
  if (mediaUrl && mediaType && (
    mediaType.includes("spreadsheet") ||
    mediaType.includes("excel") ||
    mediaType.includes("csv")
  )) {
    return "📊 Recibí tu archivo. Procesando actualización de precios…\n\n_(El procesamiento puede tardar unos minutos; te aviso cuando esté listo.)_";
  }

  return "👋 Hola proveedor. Envíame el archivo *Excel* con la lista de precios actualizada y lo proceso.";
}

// Apaga as prévias vencidas da pasta p/ (ou sem expira.json válido). Usado pelo fluxo .github/workflows/pages.yml
// de hora em hora e testável aqui: node ferramentas/limpar-vencidas.mjs <pasta p> [--simular]
// Só apaga subpastas de <pasta p>; arquivos soltos (como .gitkeep) ficam. Sem módulos externos.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// expira.json válido: {"expira": <ms>} com número finito, positivo e no máximo 400 dias à frente
const MAXIMO_A_FRENTE = 400 * 24 * 3600 * 1000;

export function lerExpira(pastaPrevia) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(pastaPrevia, "expira.json"), "utf8"));
    const e = j?.expira;
    return typeof e === "number" && Number.isFinite(e) && e > 0 ? e : null;
  } catch { return null; }
}

// Devolve { apagadas: [{id, motivo}], mantidas: n }
export function limparVencidas(pastaP, { agora = Date.now(), simular = false } = {}) {
  const raiz = path.resolve(pastaP);
  const apagadas = []; let mantidas = 0;
  if (!fs.existsSync(raiz)) return { apagadas, mantidas };
  for (const item of fs.readdirSync(raiz, { withFileTypes: true })) {
    if (!item.isDirectory() && !item.isSymbolicLink()) continue;
    const pasta = path.join(raiz, item.name);
    const expira = item.isSymbolicLink() ? null : lerExpira(pasta);
    let motivo = null;
    if (expira === null) motivo = "sem expira.json válido";
    else if (expira <= agora) motivo = "vencida";
    else if (expira > agora + MAXIMO_A_FRENTE) motivo = "prazo absurdo (mais de 400 dias)";
    if (!motivo) { mantidas++; continue; }
    if (!simular) fs.rmSync(pasta, { recursive: true, force: true });
    apagadas.push({ id: item.name, motivo });
  }
  return { apagadas, mantidas };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const simular = args.includes("--simular");
  const pasta = args.find((a) => !a.startsWith("--")) || "p";
  const r = limparVencidas(pasta, { simular });
  for (const a of r.apagadas) console.log(`${simular ? "apagaria" : "apagada"}: ${a.id} (${a.motivo})`);
  console.log(`${r.apagadas.length} ${simular ? "para apagar" : "apagada(s)"}, ${r.mantidas} mantida(s)`);
}

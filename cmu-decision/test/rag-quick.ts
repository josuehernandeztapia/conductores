import { answerQuestion } from "../server/agent/rag";

async function main() {
  const tests = [
    { q: "Gas natural", expectNull: true },
    { q: "gas", expectNull: true },
    { q: "gasolina", expectNull: true },
    { q: "Ok", expectNull: true },
    { q: "Si ya los tengo", expectNull: true },
    { q: "qué requisitos necesito", expectNull: false },
    { q: "cuánto cuesta el programa", expectNull: false },
    { q: "necesito aval", expectNull: false },
    { q: "qué pasa si no pago", expectNull: false },
  ];

  let pass = 0;
  let fail = 0;
  for (const t of tests) {
    const answer = await answerQuestion(t.q);
    const isNull = !answer;
    const ok = t.expectNull ? isNull : !isNull;
    console.log(`${ok ? "✓" : "✗"} "${t.q}" → ${isNull ? "NULL" : answer!.slice(0, 60)}`);
    if (ok) pass++;
    else fail++;
  }
  console.log(`\n${pass}/${pass + fail} passed`);
}
main();

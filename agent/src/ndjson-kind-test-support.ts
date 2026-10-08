import { parser } from "typescript-eslint";

type Node = { type: string; [key: string]: unknown };
function unwrapped(node: Node): Node {
  while (["TSSatisfiesExpression", "TSAsExpression", "TSNonNullExpression"].includes(node.type)) node = node.expression as Node;
  return node;
}

export function emittedNdjsonKinds(source: string): string[] {
  const { ast, visitorKeys } = parser.parseForESLint(source) as { ast: unknown; visitorKeys?: Record<string, string[]> };
  const kinds = new Set<string>(); const sinks = new Set(["sendLine"]);
  const walk = (node: Node, visit: (node: Node) => void) => {
    visit(node);
    for (const key of visitorKeys?.[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) for (const value of child) { if (value && typeof value === "object") walk(value as Node, visit); }
      else if (child && typeof child === "object") walk(child as Node, visit);
    }
  };
  walk(ast as Node, (node) => {
    if (node.type === "ImportSpecifier" && ((node.imported as Node).name === "sendLine" || (node.imported as Node).value === "sendLine")) sinks.add(String((node.local as Node).name));
  });
  walk(ast as Node, (node) => {
    if (node.type === "CallExpression") {
      const callee = unwrapped(node.callee as Node);
      const sink = callee.type === "Identifier" ? callee.name : callee.type === "MemberExpression" ? ((callee.property as Node).name ?? (callee.property as Node).value) : null;
      if (typeof sink === "string" && sinks.has(sink)) {
        const argument = (node.arguments as Node[])[1];
        if (!argument) throw new Error("Missing stream payload");
        const payload = unwrapped(argument);
        if (payload.type !== "ObjectExpression") throw new Error("Unresolved stream payload");
        const properties = payload.properties as Node[];
        const discriminator = properties.find((property) => {
          const key = property.key as Node | undefined;
          return property.type === "Property" && (key?.name === "kind" || key?.value === "kind");
        });
        if (discriminator) {
          const value = unwrapped(discriminator.value as Node);
          if (value.type !== "Literal" || typeof value.value !== "string") throw new Error("Unresolved streamed kind");
          kinds.add(value.value);
        } else if (properties.some((property) => property.type === "SpreadElement")) throw new Error("Unresolved stream discriminator");
      }
    }
  });
  return [...kinds].sort();
}
